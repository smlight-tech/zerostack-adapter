// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::collections::VecDeque;
use std::fmt;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout_at};

use crate::transport::Port;

pub const SREQ: u8 = 0x20;
pub const AREQ: u8 = 0x40;
pub const SRSP: u8 = 0x60;
const TYPE_MASK: u8 = 0xE0;
const SOF: u8 = 0xFE;
const MAX_DATA: usize = 250;
// COBS-Mux frame: seq, CMD0, CMD1, data, CRC-16 = at most 254 decoded bytes, 257 on the wire
// with its delimiter. ZeroStack 0.9.11 dropped a 255-byte decoded frame unanswered.
const MAX_COBS_DATA: usize = 249;
const MAX_RAW: usize = 255;
const DEFAULT_BUDGET: usize = 766;
const COBS_WINDOW: usize = 16;
const RESPONSE_BOUND: Duration = Duration::from_secs(5);
const STARTUP_BOUND: Duration = Duration::from_secs(40);
const IDLE_PREFIX: Duration = Duration::from_millis(50);
const LEGACY_QUIET: Duration = Duration::from_millis(100);
const GARBAGE_LIMIT: usize = 1024;
const FANOUT: usize = 1024;
pub const INBOUND_QUEUE: usize = 256;
pub const CAPS_WANT: u8 = 0x0F;
pub const CAP_COBS: u8 = 0x01;
const MT_CAP_AF_ZDO: u16 = 0x0018;
const MT_CAP_ZS: u16 = 0x2000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZsError {
    Transport(String),
    Timeout(String),
    Delivery(u8),
    Rejected(String),
    Unsupported(String),
    Invalid(String),
    Rpc { code: u8, cmd0: u8, cmd1: u8 },
}

impl fmt::Display for ZsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "transport: {m}"),
            Self::Timeout(m) => write!(f, "timeout waiting for {m}"),
            Self::Delivery(s) => write!(f, "delivery failed with status 0x{s:02x}"),
            Self::Rejected(m) => write!(f, "rejected: {m}"),
            Self::Unsupported(m) => write!(f, "unsupported: {m}"),
            Self::Invalid(m) => write!(f, "invalid: {m}"),
            Self::Rpc { code, cmd0, cmd1 } => write!(
                f,
                "coordinator RPC error {code} for command 0x{cmd0:02x} 0x{cmd1:02x}"
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub cmd0: u8,
    pub cmd1: u8,
    pub data: Vec<u8>,
}

impl Frame {
    pub fn new(cmd0: u8, cmd1: u8, data: Vec<u8>) -> Self {
        Self { cmd0, cmd1, data }
    }
}

// CRC-16/X-25 and CRC-32/ISO-HDLC, reflected, table driven.
const CRC16_TABLE: [u16; 256] = {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u16;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x8408
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

fn crc16_register(bytes: &[u8]) -> u16 {
    bytes.iter().fold(0xFFFF, |crc, &b| {
        (crc >> 8) ^ CRC16_TABLE[usize::from((crc ^ u16::from(b)) as u8)]
    })
}

pub fn crc16_x25(bytes: &[u8]) -> u16 {
    !crc16_register(bytes)
}

pub fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(0xFFFF_FFFF, |crc, &b| {
        (crc >> 8) ^ CRC32_TABLE[usize::from((crc ^ u32::from(b)) as u8)]
    })
}

fn xor(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0, |a, b| a ^ b)
}

pub fn unpi_encode(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.data.len() + 5);
    out.push(SOF);
    out.push(frame.data.len() as u8);
    out.push(frame.cmd0);
    out.push(frame.cmd1);
    out.extend_from_slice(&frame.data);
    out.push(xor(&out[1..]));
    out
}

pub fn cobs_encode(raw: &[u8], out: &mut Vec<u8>) {
    let mut code_at = out.len();
    out.push(0);
    let mut code = 1u8;
    for &b in raw {
        if b != 0 {
            out.push(b);
            code += 1;
        }
        if b == 0 || code == 0xFF {
            out[code_at] = code;
            code_at = out.len();
            out.push(0);
            code = 1;
        }
    }
    out[code_at] = code;
    out.push(0);
}

// Raw COBS-Mux frame: seq, CMD0, CMD1, data, CRC-16 LE.
pub fn mux_encode(seq: u8, frame: &Frame) -> Vec<u8> {
    let mut raw = Vec::with_capacity(frame.data.len() + 5);
    raw.extend_from_slice(&[seq, frame.cmd0, frame.cmd1]);
    raw.extend_from_slice(&frame.data);
    raw.extend_from_slice(&crc16_x25(&raw).to_le_bytes());
    let mut out = Vec::with_capacity(raw.len() + 3);
    cobs_encode(&raw, &mut out);
    out
}

#[derive(Default)]
pub struct CobsRx {
    out: Vec<u8>,
    code: u8,
    left: u8,
    overflow: bool,
}

impl CobsRx {
    pub fn feed(&mut self, b: u8) -> Option<Result<(u8, Frame), &'static str>> {
        if b == 0 {
            if self.code == 0 {
                return None;
            }
            let done = std::mem::take(self);
            return Some(if done.left > 0 {
                Err("COBS")
            } else if done.overflow {
                Err("length")
            } else if done.out.len() < 5 {
                Err("truncated")
            } else if crc16_register(&done.out) != 0xF0B8 {
                Err("CRC")
            } else {
                let n = done.out.len();
                Ok((
                    done.out[0],
                    Frame::new(done.out[1], done.out[2], done.out[3..n - 2].to_vec()),
                ))
            });
        }
        if self.left == 0 {
            if self.code != 0 && self.code < 0xFF {
                self.push(0);
            }
            self.code = b;
            self.left = b - 1;
        } else {
            self.push(b);
            self.left -= 1;
        }
        None
    }

    fn push(&mut self, b: u8) {
        if self.out.len() >= MAX_RAW {
            self.overflow = true;
        } else {
            self.out.push(b);
        }
    }
}

// Legacy frame recogniser run beside the COBS decoder (host side).
#[derive(Default)]
struct Shadow {
    bytes: Vec<u8>,
}

enum ShadowStep {
    Idle,
    Armed,
    Accept(Frame),
    Fail,
}

impl Shadow {
    fn feed(&mut self, b: u8) -> ShadowStep {
        if b == SOF && (self.bytes.is_empty() || self.bytes.len() < self.fcs_at()) {
            self.bytes = vec![SOF];
            return ShadowStep::Armed;
        }
        if self.bytes.is_empty() {
            return ShadowStep::Idle;
        }
        self.bytes.push(b);
        let n = self.bytes.len();
        if n == 2 && b > 16 {
            return self.fail();
        }
        if n == 3 {
            let (kind, sub) = (b & TYPE_MASK, b & 0x1F);
            if !(kind == SRSP || (kind == AREQ && (1..=21).contains(&sub))) {
                return self.fail();
            }
        }
        if n < 3 || n <= self.fcs_at() {
            return ShadowStep::Armed;
        }
        let bytes = std::mem::take(&mut self.bytes);
        let len = bytes[1];
        let body = &bytes[1..n - 1];
        let startup = matches!((len, bytes[2], bytes[3]), (2, 0x61, 0x01) | (6, 0x41, 0x80));
        if xor(body) == bytes[n - 1] && (body.contains(&0) || startup) {
            ShadowStep::Accept(Frame::new(bytes[2], bytes[3], bytes[4..n - 1].to_vec()))
        } else {
            ShadowStep::Fail
        }
    }

    // Index of the FCS byte once LEN is known.
    fn fcs_at(&self) -> usize {
        self.bytes
            .get(1)
            .map_or(usize::MAX, |&len| 4 + usize::from(len))
    }

    fn fail(&mut self) -> ShadowStep {
        self.bytes.clear();
        ShadowStep::Fail
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Normal,
    Startup,
    Handshake,
    Caps,
}

#[derive(Debug)]
pub struct Response {
    pub seq: u8,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    pub have: u8,
    pub rx_budget: u16,
    pub nodes: u16,
    pub features: u32,
}

#[derive(Clone, Debug)]
pub struct Handshake {
    pub capabilities: u16,
    pub version: Vec<u8>,
    pub caps: Caps,
}

type Reply<T> = oneshot::Sender<Result<T, ZsError>>;

struct Request {
    kind: Kind,
    frame: Frame,
    reply: Reply<Response>,
}

enum Outgoing {
    Sreq(Request),
    Reset(Reply<Vec<u8>>),
}

impl Outgoing {
    fn gone(&self) -> bool {
        match self {
            Self::Sreq(r) => r.reply.is_closed(),
            Self::Reset(r) => r.is_closed(),
        }
    }

    fn handshake(&self) -> bool {
        matches!(
            self,
            Self::Reset(_)
                | Self::Sreq(Request {
                    kind: Kind::Handshake | Kind::Caps,
                    ..
                })
        )
    }
}

struct InFlight {
    seq: u8,
    kind: Kind,
    cmd0: u8,
    cmd1: u8,
    redacted_read: bool,
    wire: usize,
    bound: Instant,
    reply: Reply<Response>,
}

enum Cmd {
    Send(Outgoing),
    Release,
    Fail(String),
    Close(oneshot::Sender<()>),
}

pub enum Inbound {
    Areq(Frame),
    Down(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Legacy,
    Cobs,
}

// Hands a result to a caller that may already have given up.
fn answer<T>(reply: Reply<T>, result: Result<T, ZsError>) {
    drop(reply.send(result));
}

struct Engine<P: Port> {
    port: P,
    mode: Mode,
    waiting: VecDeque<Outgoing>,
    inflight: VecDeque<InFlight>,
    reset_wait: Option<Reply<Vec<u8>>>,
    hold: bool,
    seen_srsp: bool,
    next_seq: u8,
    used: usize,
    budget: usize,
    legacy: Vec<u8>,
    cobs: CobsRx,
    shadow: Shadow,
    deferred: Vec<(u8, Frame)>,
    garbage: usize,
    last_rx: Instant,
    last_tx: Option<Instant>,
    fanout: broadcast::Sender<Frame>,
    inbound: mpsc::Sender<Inbound>,
}

enum Exit {
    Closed(oneshot::Sender<()>),
    Dropped,
}

impl<P: Port> Engine<P> {
    async fn run(mut self, mut cmds: mpsc::Receiver<Cmd>) {
        let outcome = self.serve(&mut cmds).await;
        let reason = match &outcome {
            Ok(_) => "stopped".to_owned(),
            Err(e) => e.to_string(),
        };
        self.fail_all(&ZsError::Transport(reason.clone()));
        if let Err(e) = self.port.discard_output() {
            tracing::warn!("discarding unsent output failed: {e}");
        }
        match outcome {
            Ok(Exit::Closed(ack)) => {
                tracing::debug!(target: "zh:zerostack:transport", "link closed");
                let _ = ack.send(());
            }
            Ok(Exit::Dropped) => {}
            Err(_) => {
                tracing::debug!(target: "zh:zerostack:transport", "link ended: {reason}");
                drop(self.inbound.send(Inbound::Down(reason)).await);
            }
        }
    }

    async fn serve(&mut self, cmds: &mut mpsc::Receiver<Cmd>) -> Result<Exit, ZsError> {
        let mut buf = [0u8; 512];
        loop {
            self.pump().await?;
            let bound = self.inflight.iter().map(|p| p.bound).min();
            let quiet = (!self.legacy.is_empty()).then(|| self.last_rx + LEGACY_QUIET);
            tokio::select! {
                read = self.port.read(&mut buf) => {
                    let n = read.map_err(|e| ZsError::Transport(format!("read: {e}")))?;
                    if n == 0 {
                        return Err(ZsError::Transport("the transport closed".into()));
                    }
                    self.last_rx = Instant::now();
                    self.ingest(&buf[..n]).await?;
                }
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::Send(out)) => self.waiting.push_back(out),
                    Some(Cmd::Release) => self.hold = false,
                    Some(Cmd::Fail(reason)) => return Err(ZsError::Transport(reason)),
                    Some(Cmd::Close(ack)) => return Ok(Exit::Closed(ack)),
                    None => return Ok(Exit::Dropped),
                },
                () = sleep_until(bound.unwrap_or_else(far)), if bound.is_some() => {
                    return Err(ZsError::Transport("no SRSP within the response bound".into()));
                }
                () = sleep_until(quiet.unwrap_or_else(far)), if quiet.is_some() => {
                    self.discard(1)?;
                    let rest = self.drain_legacy().await?;
                    self.ingest(&rest).await?;
                }
            }
        }
    }

    fn fail_all(&mut self, error: &ZsError) {
        for p in self.inflight.drain(..) {
            answer(p.reply, Err(error.clone()));
        }
        for out in self.waiting.drain(..) {
            match out {
                Outgoing::Sreq(r) => answer(r.reply, Err(error.clone())),
                Outgoing::Reset(r) => answer(r, Err(error.clone())),
            }
        }
        if let Some(r) = self.reset_wait.take() {
            answer(r, Err(error.clone()));
        }
    }

    fn may_send(&self, out: &Outgoing) -> bool {
        if self.reset_wait.is_some() || self.inflight.iter().any(|p| p.kind == Kind::Caps) {
            return false;
        }
        match out {
            Outgoing::Reset(_) => self.inflight.is_empty(),
            Outgoing::Sreq(r) => {
                let window = if self.mode == Mode::Cobs {
                    COBS_WINDOW
                } else {
                    1
                };
                let wire = r.frame.data.len() + 8;
                (r.kind != Kind::Caps || self.inflight.is_empty())
                    && self.inflight.len() < window
                    && (self.inflight.is_empty() || self.used + wire <= self.budget)
            }
        }
    }

    async fn pump(&mut self) -> Result<(), ZsError> {
        loop {
            self.waiting.retain(|o| !o.gone());
            let pick = if self.hold {
                self.waiting.iter().position(Outgoing::handshake)
            } else if self.waiting.is_empty() {
                None
            } else {
                Some(0)
            };
            let Some(i) = pick.filter(|&i| self.may_send(&self.waiting[i])) else {
                return Ok(());
            };
            match self.waiting.remove(i) {
                Some(Outgoing::Sreq(r)) => self.send_sreq(r).await?,
                Some(Outgoing::Reset(reply)) => {
                    self.write(0, &Frame::new(AREQ | 0x01, 0x00, vec![1]))
                        .await?;
                    self.reset_wait = Some(reply);
                    self.hold = true;
                }
                None => return Ok(()),
            }
        }
    }

    async fn send_sreq(&mut self, r: Request) -> Result<(), ZsError> {
        let max = if self.mode == Mode::Cobs {
            MAX_COBS_DATA
        } else {
            MAX_DATA
        };
        if r.frame.data.len() > max {
            answer(
                r.reply,
                Err(ZsError::Invalid(format!("MT data exceeds {max} bytes"))),
            );
            return Ok(());
        }
        let seq = if self.mode == Mode::Cobs {
            let mut seq = self.next_seq;
            while seq == 0 || self.inflight.iter().any(|p| p.seq == seq) {
                seq = seq.wrapping_add(1);
            }
            self.next_seq = seq.wrapping_add(1);
            seq
        } else {
            0
        };
        let redacted_read = crate::mt_trace::request_reads_sensitive(&r.frame);
        let wire = self.write(seq, &r.frame).await?;
        let bound = if r.kind == Kind::Startup {
            STARTUP_BOUND
        } else {
            RESPONSE_BOUND
        };
        self.used += wire;
        self.inflight.push_back(InFlight {
            seq,
            kind: r.kind,
            cmd0: r.frame.cmd0,
            cmd1: r.frame.cmd1,
            redacted_read,
            wire,
            bound: Instant::now() + bound,
            reply: r.reply,
        });
        Ok(())
    }

    async fn write(&mut self, seq: u8, frame: &Frame) -> Result<usize, ZsError> {
        let now = Instant::now();
        let bytes = match self.mode {
            Mode::Legacy => unpi_encode(frame),
            Mode::Cobs => {
                let idle = self.last_tx.is_none_or(|t| now - t >= IDLE_PREFIX);
                let mut out = if idle { vec![0] } else { Vec::new() };
                out.extend(mux_encode(seq, frame));
                out
            }
        };
        if crate::logging::enabled(crate::logging::LogLevel::Debug) {
            crate::logging::emit(
                crate::logging::LogLevel::Debug,
                crate::logging::NS_MT,
                crate::mt_trace::format_tx(frame),
            );
        }
        self.port
            .write_all(&bytes)
            .await
            .map_err(|e| ZsError::Transport(format!("write: {e}")))?;
        self.last_tx = Some(now);
        Ok(bytes.len())
    }

    async fn ingest(&mut self, input: &[u8]) -> Result<(), ZsError> {
        let mut queue: VecDeque<u8> = input.iter().copied().collect();
        while !queue.is_empty() {
            if self.mode == Mode::Legacy {
                self.legacy.extend(queue.drain(..));
                queue.extend(self.drain_legacy().await?);
                continue;
            }
            let Some(b) = queue.pop_front() else { break };
            if let Some(frame) = self.cobs_byte(b)? {
                self.mode = Mode::Legacy;
                self.cobs = CobsRx::default();
                self.garbage = 0;
                self.on_frame(None, frame).await?;
            } else {
                self.deliver_deferred().await?;
            }
        }
        Ok(())
    }

    // One COBS-mode byte; returns a legacy frame the shadow accepted.
    fn cobs_byte(&mut self, b: u8) -> Result<Option<Frame>, ZsError> {
        self.count_garbage(1)?;
        let step = self.shadow.feed(b);
        match self.cobs.feed(b) {
            // A CRC-checked COBS frame proves its delimiter a frame boundary: no legacy candidate spans it.
            Some(Ok(frame)) => {
                self.deferred.push(frame);
                self.shadow.bytes.clear();
                return Ok(None);
            }
            Some(Err(why)) => tracing::debug!("dropped a COBS frame: {why}"),
            None => {}
        }
        if let ShadowStep::Accept(frame) = step {
            self.deferred.clear();
            return Ok(Some(frame));
        }
        Ok(None)
    }

    // Completes legacy frames; returns the bytes after a switch to COBS-Mux.
    async fn drain_legacy(&mut self) -> Result<Vec<u8>, ZsError> {
        while let Some(start) = self.legacy.iter().position(|&b| b == SOF) {
            self.discard(start)?;
            while self.legacy.get(1) == Some(&SOF) {
                self.discard(1)?;
            }
            let Some(&len) = self.legacy.get(1) else {
                return Ok(Vec::new());
            };
            let total = usize::from(len) + 5;
            if usize::from(len) > MAX_DATA {
                self.discard(1)?;
                continue;
            }
            if self.legacy.len() < total {
                return Ok(Vec::new());
            }
            let kind = self.legacy[2] & TYPE_MASK;
            if xor(&self.legacy[1..total - 1]) != self.legacy[total - 1]
                || !(kind == AREQ || kind == SRSP)
            {
                self.discard(1)?;
                continue;
            }
            let raw: Vec<u8> = self.legacy.drain(..total).collect();
            self.garbage = 0;
            let frame = Frame::new(raw[2], raw[3], raw[4..total - 1].to_vec());
            self.on_frame(None, frame).await?;
            if self.mode == Mode::Cobs {
                return Ok(std::mem::take(&mut self.legacy));
            }
        }
        let n = self.legacy.len();
        self.discard(n)?;
        Ok(Vec::new())
    }

    fn discard(&mut self, n: usize) -> Result<(), ZsError> {
        self.legacy.drain(..n);
        self.count_garbage(n)
    }

    fn count_garbage(&mut self, n: usize) -> Result<(), ZsError> {
        self.garbage += n;
        if self.garbage > GARBAGE_LIMIT {
            return Err(ZsError::Transport("input unsynchronized".into()));
        }
        Ok(())
    }

    // Frames decoded while the shadow was armed wait for its verdict.
    async fn deliver_deferred(&mut self) -> Result<(), ZsError> {
        if !self.shadow.bytes.is_empty() {
            return Ok(());
        }
        for (seq, frame) in std::mem::take(&mut self.deferred) {
            self.garbage = 0;
            let kind = frame.cmd0 & TYPE_MASK;
            if kind == AREQ || kind == SRSP {
                self.on_frame(Some(seq), frame).await?;
            }
            if self.mode == Mode::Legacy {
                break;
            }
        }
        Ok(())
    }

    async fn on_frame(&mut self, seq: Option<u8>, frame: Frame) -> Result<(), ZsError> {
        if frame.cmd0 & TYPE_MASK == SRSP {
            return self.on_srsp(seq, frame);
        }
        if crate::logging::enabled(crate::logging::LogLevel::Debug) {
            crate::logging::emit(
                crate::logging::LogLevel::Debug,
                crate::logging::NS_MT,
                crate::mt_trace::format_areq(&frame),
            );
        }
        if (frame.cmd0, frame.cmd1) == (AREQ | 0x01, 0x80) {
            return self.on_reset_ind(frame.data);
        }
        // Lagging subscribers see Lagged; no subscriber is not an error.
        drop(self.fanout.send(frame.clone()));
        self.inbound
            .send(Inbound::Areq(frame))
            .await
            .map_err(|_| ZsError::Transport("the indication consumer ended".into()))
    }

    fn on_srsp(&mut self, seq: Option<u8>, frame: Frame) -> Result<(), ZsError> {
        let at = match seq {
            Some(s) => self.inflight.iter().position(|p| p.seq == s),
            None => (!self.inflight.is_empty()).then_some(0),
        };
        let Some(p) = at.and_then(|i| self.inflight.remove(i)) else {
            if crate::logging::enabled(crate::logging::LogLevel::Debug) {
                crate::logging::emit(
                    crate::logging::LogLevel::Debug,
                    crate::logging::NS_MT,
                    crate::mt_trace::format_srsp(&frame, None),
                );
            }
            return Err(ZsError::Transport(format!(
                "SRSP 0x{:02x} 0x{:02x} answers no request in flight",
                frame.cmd0, frame.cmd1
            )));
        };
        if crate::logging::enabled(crate::logging::LogLevel::Debug) {
            let redacted = (frame.cmd0 == ((p.cmd0 & 0x1F) | SRSP) && frame.cmd1 == p.cmd1)
                .then_some(p.redacted_read);
            crate::logging::emit(
                crate::logging::LogLevel::Debug,
                crate::logging::NS_MT,
                crate::mt_trace::format_srsp(&frame, redacted),
            );
        }
        self.used -= p.wire;
        self.seen_srsp = true;
        if (frame.cmd0, frame.cmd1) == (SRSP, 0x00) {
            let d = &frame.data;
            let error = match d.as_slice() {
                [code, cmd0, cmd1, ..] => ZsError::Rpc {
                    code: *code,
                    cmd0: *cmd0,
                    cmd1: *cmd1,
                },
                _ => ZsError::Rejected("RPC error SRSP shorter than 3 bytes".into()),
            };
            answer(p.reply, Err(error));
            return Ok(());
        }
        if frame.cmd0 != (p.cmd0 & 0x1F) | SRSP || frame.cmd1 != p.cmd1 {
            let msg = format!(
                "SRSP 0x{:02x} 0x{:02x} answers SREQ 0x{:02x} 0x{:02x}",
                frame.cmd0, frame.cmd1, p.cmd0, p.cmd1
            );
            answer(p.reply, Err(ZsError::Transport(msg.clone())));
            return Err(ZsError::Transport(msg));
        }
        let d = &frame.data;
        if p.kind == Kind::Caps && d.len() == 11 && d[0] == 0 && d[2] & CAP_COBS != 0 {
            self.mode = Mode::Cobs;
            self.cobs = CobsRx::default();
            self.shadow = Shadow::default();
            self.budget = usize::from(u16::from_le_bytes([d[3], d[4]])).max(1);
            tracing::info!(
                target: "zh:zerostack:transport",
                "COBS-Mux negotiated (have=0x{:02x}, rx_budget={}, nodes={})",
                d[2],
                self.budget,
                u16::from_le_bytes([d[5], d[6]]),
            );
        }
        answer(
            p.reply,
            Ok(Response {
                seq: p.seq,
                data: frame.data,
            }),
        );
        Ok(())
    }

    fn on_reset_ind(&mut self, data: Vec<u8>) -> Result<(), ZsError> {
        self.mode = Mode::Legacy;
        self.cobs = CobsRx::default();
        self.shadow = Shadow::default();
        self.budget = DEFAULT_BUDGET;
        tracing::debug!(
            target: "zh:zerostack:transport",
            "link returned to legacy framing after SYS_RESET_IND"
        );
        if let Some(waiter) = self.reset_wait.take() {
            answer(waiter, Ok(data));
            Ok(())
        } else if !self.seen_srsp {
            Ok(())
        } else {
            Err(ZsError::Transport(
                "unexpected coordinator restart (SYS_RESET_IND)".into(),
            ))
        }
    }
}

fn far() -> Instant {
    Instant::now() + Duration::from_secs(86_400)
}

#[derive(Clone)]
pub struct Link {
    cmds: mpsc::Sender<Cmd>,
    fanout: broadcast::Sender<Frame>,
}

pub struct Indications {
    rx: broadcast::Receiver<Frame>,
    link: Link,
}

impl Indications {
    pub async fn next(&mut self, deadline: Instant, what: &str) -> Result<Frame, ZsError> {
        match timeout_at(deadline, self.rx.recv()).await {
            Err(_) => Err(ZsError::Timeout(what.to_owned())),
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                self.link.fail("indication overflow").await;
                Err(ZsError::Transport("indication overflow".into()))
            }
            Ok(Err(broadcast::error::RecvError::Closed)) => Err(ended()),
        }
    }
}

fn ended() -> ZsError {
    ZsError::Transport("the coordinator session ended".into())
}

impl Link {
    pub fn spawn<P: Port + 'static>(port: P) -> (Link, mpsc::Receiver<Inbound>, JoinHandle<()>) {
        let (cmds, cmd_rx) = mpsc::channel(64);
        let (inbound, inbound_rx) = mpsc::channel(INBOUND_QUEUE);
        let (fanout, _) = broadcast::channel(FANOUT);
        let engine = Engine {
            port,
            mode: Mode::Legacy,
            waiting: VecDeque::new(),
            inflight: VecDeque::new(),
            reset_wait: None,
            hold: false,
            seen_srsp: false,
            next_seq: 1,
            used: 0,
            budget: DEFAULT_BUDGET,
            legacy: Vec::new(),
            cobs: CobsRx::default(),
            shadow: Shadow::default(),
            deferred: Vec::new(),
            garbage: 0,
            last_rx: Instant::now(),
            last_tx: None,
            fanout: fanout.clone(),
            inbound,
        };
        let task = tokio::spawn(engine.run(cmd_rx));
        (Link { cmds, fanout }, inbound_rx, task)
    }

    pub fn subscribe(&self) -> Indications {
        Indications {
            rx: self.fanout.subscribe(),
            link: self.clone(),
        }
    }

    async fn submit<T>(
        &self,
        out: Outgoing,
        rx: oneshot::Receiver<Result<T, ZsError>>,
        deadline: Instant,
        what: &str,
    ) -> Result<T, ZsError> {
        self.cmds.send(Cmd::Send(out)).await.map_err(|_| ended())?;
        match timeout_at(deadline, rx).await {
            Err(_) => Err(ZsError::Timeout(what.to_owned())),
            Ok(Err(_)) => Err(ended()),
            Ok(Ok(result)) => result,
        }
    }

    pub async fn call(
        &self,
        kind: Kind,
        frame: Frame,
        deadline: Instant,
    ) -> Result<Response, ZsError> {
        let what = format!("SRSP to 0x{:02x} 0x{:02x}", frame.cmd0, frame.cmd1);
        let (reply, rx) = oneshot::channel();
        self.submit(
            Outgoing::Sreq(Request { kind, frame, reply }),
            rx,
            deadline,
            &what,
        )
        .await
    }

    pub async fn sreq(
        &self,
        cmd0: u8,
        cmd1: u8,
        data: Vec<u8>,
        deadline: Instant,
    ) -> Result<Vec<u8>, ZsError> {
        Ok(self
            .call(Kind::Normal, Frame::new(cmd0, cmd1, data), deadline)
            .await?
            .data)
    }

    // Soft reset; resolves with SYS_RESET_IND data, the link held for renegotiation.
    pub async fn reset(&self, deadline: Instant) -> Result<Vec<u8>, ZsError> {
        let (reply, rx) = oneshot::channel();
        self.submit(Outgoing::Reset(reply), rx, deadline, "SYS_RESET_IND")
            .await
    }

    pub async fn release(&self) -> Result<(), ZsError> {
        self.cmds.send(Cmd::Release).await.map_err(|_| ended())
    }

    pub async fn fail(&self, reason: &str) {
        drop(self.cmds.send(Cmd::Fail(reason.to_owned())).await);
    }

    pub async fn close(&self) {
        let (ack, done) = oneshot::channel();
        if self.cmds.send(Cmd::Close(ack)).await.is_ok() {
            drop(done.await);
        }
    }
}

pub async fn negotiate(link: &Link, deadline: Instant) -> Result<Handshake, ZsError> {
    let hs = |cmd1, data| Frame::new(SREQ | 0x01, cmd1, data);
    let ping = link
        .call(Kind::Handshake, hs(0x01, vec![]), deadline)
        .await?
        .data;
    let capabilities = match ping.as_slice() {
        [lo, hi] => u16::from_le_bytes([*lo, *hi]),
        _ => return Err(ZsError::Rejected("SYS_PING answer is not 2 bytes".into())),
    };
    if capabilities & MT_CAP_AF_ZDO != MT_CAP_AF_ZDO {
        return Err(ZsError::Rejected(
            "coordinator lacks the AF and ZDO MT subsystems".into(),
        ));
    }
    if capabilities & MT_CAP_ZS == 0 {
        return Err(ZsError::Rejected("coordinator is not ZeroStack".into()));
    }
    let version = link
        .call(Kind::Handshake, hs(0x02, vec![]), deadline)
        .await?
        .data;
    if version.len() < 5 {
        return Err(ZsError::Rejected(
            "SYS_VERSION answer is shorter than 5 bytes".into(),
        ));
    }
    let d = match link
        .call(Kind::Caps, hs(0x73, vec![1, CAPS_WANT, 16]), deadline)
        .await
    {
        Ok(r) => r.data,
        Err(ZsError::Rpc { code: 1 | 2, .. }) => {
            return Err(ZsError::Rejected(
                "coordinator advertises MT_CAP_ZS but granted no COBS-Mux".into(),
            ));
        }
        Err(e @ ZsError::Rpc { .. }) => return Err(ZsError::Rejected(e.to_string())),
        Err(e) => return Err(e),
    };
    if d.len() != 11 || d[0] != 0 {
        return Err(ZsError::Rejected(format!("SYS_ZS_CAPS refused: {d:02x?}")));
    }
    let have = d[2];
    if have & !CAPS_WANT != 0 || have & CAP_COBS == 0 {
        return Err(ZsError::Rejected(format!(
            "SYS_ZS_CAPS granted 0x{have:02x} without COBS-Mux"
        )));
    }
    let caps = Caps {
        have,
        rx_budget: u16::from_le_bytes([d[3], d[4]]).max(1),
        nodes: u16::from_le_bytes([d[5], d[6]]),
        features: u32::from_le_bytes([d[7], d[8], d[9], d[10]]),
    };
    link.release().await?;
    Ok(Handshake {
        capabilities,
        version,
        caps,
    })
}

#[cfg(test)]
pub(crate) mod test_peer {
    use super::*;
    use tokio::io::DuplexStream;

    // Scripted coordinator end of a duplex pipe.
    pub struct Peer {
        io: DuplexStream,
        pub cobs: bool,
        buf: VecDeque<u8>,
        rx: CobsRx,
    }

    impl Peer {
        pub fn new(io: DuplexStream) -> Self {
            Self {
                io,
                cobs: false,
                buf: VecDeque::new(),
                rx: CobsRx::default(),
            }
        }

        async fn fill(&mut self) {
            let mut b = [0u8; 512];
            let n = self.io.read(&mut b).await.expect("peer read");
            assert!(n > 0, "the host closed the link");
            self.buf.extend(&b[..n]);
        }

        // Next host frame as (seq, frame), checking its framing.
        pub async fn recv(&mut self) -> (u8, Frame) {
            loop {
                if self.cobs {
                    while let Some(b) = self.buf.pop_front() {
                        if let Some(r) = self.rx.feed(b) {
                            return r.expect("valid COBS frame from the host");
                        }
                    }
                } else if self.buf.len() >= 2 && self.buf.len() >= usize::from(self.buf[1]) + 5 {
                    let raw: Vec<u8> = self.buf.drain(..usize::from(self.buf[1]) + 5).collect();
                    assert_eq!(raw[0], SOF);
                    assert_eq!(xor(&raw[1..raw.len() - 1]), raw[raw.len() - 1], "FCS");
                    return (
                        0,
                        Frame::new(raw[2], raw[3], raw[4..raw.len() - 1].to_vec()),
                    );
                }
                self.fill().await;
            }
        }

        // The next frame's exact bytes up to and including its terminator; leading delimiters skipped.
        pub async fn raw(&mut self, legacy_len: usize) -> Vec<u8> {
            loop {
                while self.cobs && self.buf.front() == Some(&0) {
                    self.buf.pop_front();
                }
                let end = if self.cobs {
                    self.buf.iter().position(|&b| b == 0).map(|i| i + 1)
                } else {
                    Some(legacy_len)
                };
                if let Some(end) = end.filter(|&e| self.buf.len() >= e) {
                    return self.buf.drain(..end).collect();
                }
                self.fill().await;
            }
        }

        pub async fn write(&mut self, bytes: &[u8]) {
            self.io.write_all(bytes).await.expect("peer write");
        }

        pub async fn send(&mut self, seq: u8, frame: Frame) {
            let bytes = if self.cobs {
                mux_encode(seq, &frame)
            } else {
                unpi_encode(&frame)
            };
            self.write(&bytes).await;
        }

        pub async fn expect(&mut self, cmd0: u8, cmd1: u8) -> (u8, Vec<u8>) {
            let (seq, f) = self.recv().await;
            assert_eq!((f.cmd0, f.cmd1), (cmd0, cmd1), "host sent {f:02x?}");
            (seq, f.data)
        }

        // Expects an SREQ and answers it with `data`; returns the request data.
        pub async fn answer(&mut self, cmd0: u8, cmd1: u8, data: &[u8]) -> Vec<u8> {
            let (seq, request) = self.expect(cmd0, cmd1).await;
            self.send(seq, Frame::new((cmd0 & 0x1F) | SRSP, cmd1, data.to_vec()))
                .await;
            request
        }

        pub async fn handshake(&mut self) {
            self.cobs = false;
            self.answer(0x21, 0x01, &[0x59, 0x24]).await;
            self.answer(0x21, 0x02, &[2, 1, 2, 7, 1, 0x4C, 0x2B, 0x35, 0x01])
                .await;
            let caps = self
                .answer(0x21, 0x73, &[0, 1, 0x0F, 0xFE, 0x02, 200, 0, 0x0F, 0, 0, 0])
                .await;
            assert_eq!(caps, [1, CAPS_WANT, 16]);
            self.cobs = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_peer::Peer;
    use super::*;

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    fn decode_all(wire: &[u8]) -> Vec<Result<(u8, Frame), &'static str>> {
        let mut rx = CobsRx::default();
        wire.iter().filter_map(|&b| rx.feed(b)).collect()
    }

    #[test]
    fn crc_check_values() {
        assert_eq!(crc16_x25(b"123456789"), 0x906E);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn legacy_golden_vectors() {
        let f = |c0, c1, d: &[u8]| unpi_encode(&Frame::new(c0, c1, d.to_vec()));
        assert_eq!(f(0x21, 0x01, &[]), [0xFE, 0x00, 0x21, 0x01, 0x20]);
        assert_eq!(
            f(0x61, 0x01, &[0x59, 0x24]),
            [0xFE, 0x02, 0x61, 0x01, 0x59, 0x24, 0x1F]
        );
        assert_eq!(f(0x21, 0x02, &[]), [0xFE, 0x00, 0x21, 0x02, 0x23]);
        assert_eq!(
            f(0x21, 0x73, &[1, 0x0F, 0x10]),
            [0xFE, 0x03, 0x21, 0x73, 0x01, 0x0F, 0x10, 0x4F]
        );
        assert_eq!(f(0x41, 0x00, &[1]), [0xFE, 0x01, 0x41, 0x00, 0x01, 0x41]);
        assert_eq!(
            f(0x60, 0x00, &[2, 0x21, 0x73]),
            [0xFE, 0x03, 0x60, 0x00, 0x02, 0x21, 0x73, 0x33]
        );
    }

    type Golden = (u8, u8, u8, &'static [u8], &'static [u8]);

    #[test]
    fn cobs_mux_golden_vectors() {
        let cases: [Golden; 6] = [
            (
                1,
                0x21,
                0x01,
                &[],
                &[0x06, 0x01, 0x21, 0x01, 0x72, 0xB7, 0x00],
            ),
            (
                1,
                0x61,
                0x01,
                &[0x59, 0x24],
                &[0x08, 0x01, 0x61, 0x01, 0x59, 0x24, 0x79, 0x78, 0x00],
            ),
            (
                1,
                0x21,
                0x73,
                &[0x01, 0x0F, 0x10],
                &[0x09, 0x01, 0x21, 0x73, 0x01, 0x0F, 0x10, 0x6C, 0x2E, 0x00],
            ),
            (
                1,
                0x61,
                0x73,
                &[
                    0x00, 0x01, 0x0F, 0xFE, 0x02, 0xC8, 0x00, 0x0F, 0x00, 0x00, 0x00,
                ],
                &[
                    0x04, 0x01, 0x61, 0x73, 0x06, 0x01, 0x0F, 0xFE, 0x02, 0xC8, 0x02, 0x0F, 0x01,
                    0x01, 0x03, 0xCA, 0x80, 0x00,
                ],
            ),
            (
                0,
                0x41,
                0x00,
                &[0x01],
                &[0x01, 0x02, 0x41, 0x04, 0x01, 0xFD, 0xB1, 0x00],
            ),
            (
                2,
                0x21,
                0x70,
                &[0, 0, 0, 0],
                &[
                    0x04, 0x02, 0x21, 0x70, 0x01, 0x01, 0x01, 0x03, 0x73, 0x2F, 0x00,
                ],
            ),
        ];
        for (seq, c0, c1, data, wire) in cases {
            let frame = Frame::new(c0, c1, data.to_vec());
            assert_eq!(mux_encode(seq, &frame), wire, "encode {c0:02x} {c1:02x}");
            assert_eq!(
                decode_all(wire),
                [Ok((seq, frame))],
                "decode {c0:02x} {c1:02x}"
            );
        }
        let mut corrupt = mux_encode(1, &Frame::new(0x21, 0x01, vec![]));
        corrupt[4] ^= 0x01;
        assert_eq!(decode_all(&corrupt), [Err("CRC")]);
        assert_eq!(
            decode_all(&[0, 0, 0x03, 0x01, 0x02, 0x00]),
            [Err("truncated")]
        );
        assert_eq!(decode_all(&[0x05, 0x01, 0x00]), [Err("COBS")]);
        let long = mux_encode(1, &Frame::new(0x21, 0x01, vec![0x5A; 250]));
        assert_eq!(long.len(), 258);
        assert_eq!(decode_all(&long).len(), 1);
        assert!(decode_all(&long)[0].is_ok());
    }

    async fn opened() -> (Link, mpsc::Receiver<Inbound>, Peer, Handshake) {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (link, inbound, _task) = Link::spawn(host);
        let mut peer = Peer::new(coordinator);
        let (hs, ()) = tokio::join!(negotiate(&link, soon()), peer.handshake());
        (link, inbound, peer, hs.expect("handshake"))
    }

    #[tokio::test(start_paused = true)]
    async fn bootstrap_switches_to_cobs_mux_at_the_caps_srsp() {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (link, _inbound, _task) = Link::spawn(host);
        let mut peer = Peer::new(coordinator);
        let script = async {
            assert_eq!(peer.raw(5).await, [0xFE, 0x00, 0x21, 0x01, 0x20]);
            peer.write(&[0xFE, 0x02, 0x61, 0x01, 0x59, 0x24, 0x1F])
                .await;
            assert_eq!(peer.raw(5).await, [0xFE, 0x00, 0x21, 0x02, 0x23]);
            peer.send(0, Frame::new(0x61, 0x02, vec![2, 1, 2, 7, 1]))
                .await;
            assert_eq!(
                peer.raw(8).await,
                [0xFE, 0x03, 0x21, 0x73, 0x01, 0x0F, 0x10, 0x4F]
            );
            // Caps SRSP and a COBS AREQ in one write: the switch happens at the SRSP's FCS.
            let mut bytes = unpi_encode(&Frame::new(
                0x61,
                0x73,
                vec![0, 1, 0x0F, 0xFE, 0x02, 200, 0, 0x0F, 0, 0, 0],
            ));
            bytes.extend(mux_encode(0, &Frame::new(0x45, 0xC0, vec![0])));
            peer.write(&bytes).await;
        };
        let (hs, ()) = tokio::join!(negotiate(&link, soon()), script);
        let hs = hs.expect("handshake");
        assert_eq!(hs.capabilities, 0x2459);
        assert_eq!(
            hs.caps,
            Caps {
                have: 0x0F,
                rx_budget: 766,
                nodes: 200,
                features: 0x0F
            }
        );
        peer.cobs = true;
        let (ping, ()) = tokio::join!(link.sreq(0x21, 0x01, vec![], soon()), async {
            assert_eq!(
                peer.raw(0).await,
                [0x06, 0x01, 0x21, 0x01, 0x72, 0xB7, 0x00]
            );
            peer.write(&[0x08, 0x01, 0x61, 0x01, 0x59, 0x24, 0x79, 0x78, 0x00])
                .await;
        });
        assert_eq!(ping, Ok(vec![0x59, 0x24]));
    }

    #[tokio::test(start_paused = true)]
    async fn caps_refusals_are_rejected() {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (link, _inbound, _task) = Link::spawn(host);
        let mut peer = Peer::new(coordinator);
        let script = async {
            peer.answer(0x21, 0x01, &[0x59, 0x24]).await;
            peer.answer(0x21, 0x02, &[2, 1, 2, 7, 1]).await;
            peer.expect(0x21, 0x73).await;
            peer.write(&[0xFE, 0x03, 0x60, 0x00, 0x02, 0x21, 0x73, 0x33])
                .await;
        };
        let (r, ()) = tokio::join!(negotiate(&link, soon()), script);
        assert_eq!(
            r.map(|_| ()),
            Err(ZsError::Rejected(
                "coordinator advertises MT_CAP_ZS but granted no COBS-Mux".into()
            ))
        );
        let script = async {
            peer.answer(0x21, 0x01, &[0x59, 0x24]).await;
            peer.answer(0x21, 0x02, &[2, 1, 2, 7, 1]).await;
            peer.answer(0x21, 0x73, &[0, 1, 0x0E, 0xFE, 0x02, 200, 0, 0x0F, 0, 0, 0])
                .await;
        };
        let (r, _) = tokio::join!(negotiate(&link, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("without COBS-Mux")));
        // Without COBS granted the link stays legacy-framed.
        let (r, _) = tokio::join!(
            link.sreq(0x21, 0x02, vec![], soon()),
            peer.answer(0x21, 0x02, &[2, 1])
        );
        assert_eq!(r, Ok(vec![2, 1]));
        let script = peer.answer(0x21, 0x01, &[0x59, 0x04]);
        let (r, _) = tokio::join!(negotiate(&link, soon()), script);
        assert_eq!(
            r.map(|_| ()),
            Err(ZsError::Rejected("coordinator is not ZeroStack".into()))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn own_reset_renegotiates_and_a_spontaneous_one_ends_the_link() {
        let (link, mut inbound, mut peer, _) = opened().await;
        let reset_ind = Frame::new(0x41, 0x80, vec![0x20, 2, 1, 2, 7, 1]);
        let (ind, ()) = tokio::join!(link.reset(soon()), async {
            assert_eq!(
                peer.raw(0).await,
                [0x01, 0x02, 0x41, 0x04, 0x01, 0xFD, 0xB1, 0x00]
            );
            peer.cobs = false;
            peer.send(0, reset_ind.clone()).await;
        });
        assert_eq!(ind, Ok(reset_ind.data.clone()));
        // Held: a normal request waits until the renegotiation releases the link.
        let held = link.sreq(0x25, 0x50, vec![], soon());
        let (r, hs, ()) = tokio::join!(held, negotiate(&link, soon()), async {
            peer.handshake().await;
            peer.answer(0x25, 0x50, &[1]).await;
        });
        assert!(hs.is_ok());
        assert_eq!(r, Ok(vec![1]));
        // Legacy SYS_RESET_IND while in COBS-Mux: the host shadow recognises it.
        let pending = link.sreq(0x21, 0x04, vec![], soon());
        let (r, ()) = tokio::join!(pending, async {
            peer.expect(0x21, 0x04).await;
            peer.write(&unpi_encode(&reset_ind)).await;
        });
        assert!(
            matches!(r, Err(ZsError::Transport(m)) if m.contains("unexpected coordinator restart"))
        );
        assert!(
            matches!(inbound.recv().await, Some(Inbound::Down(m)) if m.contains("unexpected coordinator restart"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn caller_timeout_leaves_the_request_to_the_link_bound() {
        let (link, mut inbound, mut peer, _) = opened().await;
        let start = Instant::now();
        let (r, _) = tokio::join!(
            link.sreq(0x21, 0x04, vec![], start + Duration::from_secs(1)),
            peer.expect(0x21, 0x04)
        );
        assert!(matches!(r, Err(ZsError::Timeout(_))));
        assert!(
            matches!(inbound.recv().await, Some(Inbound::Down(m)) if m.contains("response bound"))
        );
        assert!(Instant::now() - start >= RESPONSE_BOUND);
        assert!(matches!(
            link.sreq(0x21, 0x04, vec![], soon()).await,
            Err(ZsError::Transport(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn srsps_match_by_sequence_and_rpc_errors_fail_one_request() {
        let (link, _inbound, mut peer, _) = opened().await;
        let a = link.sreq(0x21, 0x04, vec![], soon());
        let b = link.sreq(0x25, 0x50, vec![], soon());
        let script = async {
            let (sa, _) = peer.expect(0x21, 0x04).await;
            let (sb, _) = peer.expect(0x25, 0x50).await;
            assert_ne!(sa, sb);
            peer.send(sb, Frame::new(0x65, 0x50, vec![7])).await;
            peer.send(sa, Frame::new(0x60, 0x00, vec![2, 0x21, 0x04]))
                .await;
        };
        let (ra, rb, ()) = tokio::join!(a, b, script);
        assert_eq!(
            ra,
            Err(ZsError::Rpc {
                code: 2,
                cmd0: 0x21,
                cmd1: 0x04
            })
        );
        assert_eq!(rb, Ok(vec![7]));
    }

    // Whether the legacy shadow still holds a candidate once `wire` ends.
    fn shadow_holds(wire: &[u8]) -> bool {
        let mut shadow = Shadow::default();
        for &b in wire {
            shadow.feed(b);
        }
        !shadow.bytes.is_empty()
    }

    // Answers ZDO_EXT_NWK_INFO with `reply(seq)` and returns what the host received.
    async fn ext_nwk_info(
        link: &Link,
        peer: &mut Peer,
        reply: impl FnOnce(u8) -> Vec<u8>,
    ) -> (u8, Result<Vec<u8>, ZsError>) {
        let (r, seq) = tokio::join!(link.sreq(0x25, 0x50, vec![], soon()), async {
            let (seq, _) = peer.expect(0x25, 0x50).await;
            peer.write(&reply(seq)).await;
            seq
        });
        (seq, r)
    }

    #[tokio::test(start_paused = true)]
    async fn the_captured_srsp_ending_in_fe_00_is_delivered() {
        let (link, mut inbound, mut peer, _) = opened().await;
        // ZDO_EXT_NWK_INFO SRSP captured from a ZeroStack 0.9.11 coordinator, sequence 0x35.
        let wire = [
            0x04, 0x35, 0x65, 0x50, 0x01, 0x07, 0x09, 0x7C, 0x2B, 0xFE, 0xFF, 0x01, 0x03, 0x7C,
            0x2B, 0x01, 0x01, 0x02, 0xDD, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x04, 0x0F,
            0x16, 0xFE, 0x00,
        ];
        let data = [
            0x00, 0x00, 0x09, 0x7C, 0x2B, 0xFE, 0xFF, 0x01, 0x00, 0x7C, 0x2B, 0x00, 0x00, 0x00,
            0xDD, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0F,
        ];
        assert!(shadow_holds(&wire));
        loop {
            let (seq, r) = ext_nwk_info(&link, &mut peer, |seq| {
                if seq == 0x35 {
                    wire.to_vec()
                } else {
                    mux_encode(seq, &Frame::new(0x65, 0x50, vec![seq]))
                }
            })
            .await;
            if seq == 0x35 {
                assert_eq!(r, Ok(data.to_vec()));
                break;
            }
            assert_eq!(r, Ok(vec![seq]));
        }
        assert!(inbound.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn srsps_whose_tail_arms_the_legacy_shadow_are_delivered() {
        let (link, mut inbound, mut peer, _) = opened().await;
        // CRC high byte 0xFE: the frame ends FE 00, a legacy SOF with LEN 0.
        let fe_00 = |seq: u8| {
            (0..=u16::MAX)
                .map(|x| x.to_le_bytes().to_vec())
                .find(|d| mux_encode(seq, &Frame::new(0x65, 0x50, d.clone())).ends_with(&[0xFE, 0]))
                .expect("a payload whose CRC high byte is 0xFE")
        };
        // FE 10 61 02 inside the data: a legacy SRSP header whose 16 bytes never arrive.
        let fe_len = |seq: u8| {
            (1..=u8::MAX)
                .map(|x| vec![0xFE, 0x10, 0x61, 0x02, x])
                .find(|d| {
                    let wire = mux_encode(seq, &Frame::new(0x65, 0x50, d.clone()));
                    shadow_holds(&wire) && wire[wire.len() - 2] != 0xFE
                })
                .expect("a mid-frame FE <len> payload")
        };
        for build in [fe_00, fe_len, fe_00, fe_len] {
            let mut sent = Vec::new();
            let (_, r) = ext_nwk_info(&link, &mut peer, |seq| {
                sent = build(seq);
                let wire = mux_encode(seq, &Frame::new(0x65, 0x50, sent.clone()));
                assert!(shadow_holds(&wire));
                wire
            })
            .await;
            assert_eq!(r, Ok(sent));
        }
        assert!(inbound.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn cobs_mux_refuses_more_than_249_data_bytes_without_sending() {
        let (link, _inbound, mut peer, _) = opened().await;
        let refused = link.sreq(0x27, 0x10, vec![0x55; 250], soon()).await;
        assert_eq!(
            refused,
            Err(ZsError::Invalid("MT data exceeds 249 bytes".into()))
        );
        let (r, request) = tokio::join!(
            link.sreq(0x27, 0x10, vec![0x55; 249], soon()),
            peer.answer(0x27, 0x10, &[0x55; 249])
        );
        assert_eq!(request, vec![0x55; 249]);
        assert_eq!(r, Ok(vec![0x55; 249]));
    }

    #[tokio::test(start_paused = true)]
    async fn a_crc_checked_frame_clears_a_shadow_armed_by_an_earlier_corrupt_frame() {
        let (link, mut inbound, mut peer, _) = opened().await;
        // Corrupt COBS frame carrying FE 10 61 02, then a valid SYS_PING SRSP for sequence 1.
        let corrupt = [0x07, 0x01, 0xFE, 0x10, 0x61, 0x02, 0x01, 0x00];
        let ping = [0x08, 0x01, 0x61, 0x01, 0x59, 0x24, 0x79, 0x78, 0x00];
        assert!(shadow_holds(&[&corrupt[..], &ping[..]].concat()));
        loop {
            let (r, seq) = tokio::join!(link.sreq(0x21, 0x01, vec![], soon()), async {
                let (seq, _) = peer.expect(0x21, 0x01).await;
                if seq == 1 {
                    peer.write(&corrupt).await;
                    peer.write(&ping).await;
                } else {
                    peer.send(seq, Frame::new(0x61, 0x01, vec![0x59, 0x24]))
                        .await;
                }
                seq
            });
            assert_eq!(r, Ok(vec![0x59, 0x24]));
            if seq == 1 {
                break;
            }
        }
        assert!(inbound.try_recv().is_err());
    }

    // The link's Down reason, skipping indications queued before it.
    async fn down_reason(inbound: &mut mpsc::Receiver<Inbound>) -> String {
        loop {
            match inbound.recv().await {
                Some(Inbound::Down(reason)) => return reason,
                Some(Inbound::Areq(_)) => {}
                None => panic!("the link ended without a reason"),
            }
        }
    }

    #[test]
    fn an_overlong_cobs_frame_is_dropped_within_its_bound_and_the_next_is_decoded() {
        let mut rx = CobsRx::default();
        // complete 0xFF blocks of 254 data bytes each: 508 decoded bytes, over the 255 bound
        for _ in 0..2 {
            assert_eq!(rx.feed(0xFF), None);
            for _ in 0..254 {
                assert_eq!(rx.feed(0x11), None);
            }
        }
        assert!(rx.out.len() <= MAX_RAW);
        assert_eq!(rx.feed(0), Some(Err("length")));
        let ping = Frame::new(0x61, 0x01, vec![0x59, 0x24]);
        let decoded = mux_encode(1, &ping)
            .into_iter()
            .find_map(|b| rx.feed(b))
            .expect("a frame");
        assert_eq!(decoded, Ok((1, ping)));
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_input_skips_oversize_lengths_bad_fcs_and_sreq_echoes() {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (link, mut inbound, _task) = Link::spawn(host);
        let mut peer = Peer::new(coordinator);
        let (ping, ()) = tokio::join!(link.sreq(0x21, 0x01, vec![], soon()), async {
            assert_eq!(peer.raw(5).await, [0xFE, 0x00, 0x21, 0x01, 0x20]);
            peer.write(&[
                0xFE, 0xFF, // LEN 255 is over 250
                0xFE, 0xFE, 0x02, 0x61, 0x01, 0x59, 0x24,
                0x00, // doubled SOF, FCS 0x00 not 0x1F
                0xFE, 0x00, 0x21, 0x01, 0x20, // an SREQ is neither AREQ nor SRSP
                0xFE, 0x02, 0x61, 0x01, 0x59, 0x24, 0x1F,
            ])
            .await;
        });
        assert_eq!(ping, Ok(vec![0x59, 0x24]));
        assert!(inbound.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn legacy_input_without_a_frame_for_1024_bytes_ends_the_link() {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (_link, mut inbound, _task) = Link::spawn(host);
        let mut peer = Peer::new(coordinator);
        peer.write(&[0x11; 1100]).await;
        assert!(
            down_reason(&mut inbound)
                .await
                .contains("input unsynchronized")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn srsps_that_answer_nothing_or_the_wrong_command_end_the_link() {
        let (_link, mut inbound, mut peer, _) = opened().await;
        peer.send(0x77, Frame::new(0x61, 0x04, vec![0; 8])).await;
        assert!(
            down_reason(&mut inbound)
                .await
                .contains("answers no request in flight")
        );

        let (link, mut inbound, mut peer, _) = opened().await;
        let (r, ()) = tokio::join!(link.sreq(0x21, 0x04, vec![], soon()), async {
            let (seq, _) = peer.expect(0x21, 0x04).await;
            peer.send(seq, Frame::new(0x65, 0x50, vec![0])).await;
        });
        assert!(
            matches!(&r, Err(ZsError::Transport(m)) if m.contains("answers SREQ 0x21 0x04")),
            "{r:?}"
        );
        assert!(
            down_reason(&mut inbound)
                .await
                .contains("answers SREQ 0x21 0x04")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_short_rpc_error_fails_only_its_request() {
        let (link, mut inbound, mut peer, _) = opened().await;
        let (r, ()) = tokio::join!(link.sreq(0x21, 0x04, vec![], soon()), async {
            let (seq, _) = peer.expect(0x21, 0x04).await;
            peer.send(seq, Frame::new(0x60, 0x00, vec![2])).await;
        });
        assert_eq!(
            r,
            Err(ZsError::Rejected(
                "RPC error SRSP shorter than 3 bytes".into()
            ))
        );
        let (r, _) = tokio::join!(
            link.sreq(0x25, 0x50, vec![], soon()),
            peer.answer(0x25, 0x50, &[7])
        );
        assert_eq!(r, Ok(vec![7]));
        assert!(inbound.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_subscriber_that_falls_behind_by_the_fanout_ends_the_link() {
        let (link, mut inbound, mut peer, _) = opened().await;
        let mut slow = link.subscribe();
        let drained = tokio::spawn(async move { down_reason(&mut inbound).await });
        for _ in 0..=FANOUT {
            peer.send(0, Frame::new(0x45, 0xC0, vec![9])).await;
        }
        // the link handles input in order: once this SRSP is answered every indication was fanned out
        let (r, _) = tokio::join!(
            link.sreq(0x25, 0x50, vec![], soon()),
            peer.answer(0x25, 0x50, &[7])
        );
        assert_eq!(r, Ok(vec![7]));
        let r = slow.next(soon(), "an indication").await;
        assert_eq!(r, Err(ZsError::Transport("indication overflow".into())));
        assert_eq!(
            drained.await.expect("drain task"),
            "transport: indication overflow"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn mismatched_nv_read_srsp_fails_closed_redacted() {
        let (_guard, captured) = crate::logging::tests::TestLogGuard::install(
            crate::logging::LogLevel::Debug,
            "osalNvReadExt",
        );
        let (link, _inbound, mut peer, _) = opened().await;
        // Send a non-sensitive SREQ (`SYS_GET_EXTADDR`), so `redacted_read` is `false`.
        let (r, ()) = tokio::join!(link.sreq(0x21, 0x04, vec![], soon()), async {
            let (seq, _) = peer.expect(0x21, 0x04).await;
            // Reply with a mismatched `SYS_OSAL_NV_READ_EXT` (`0x61 0x1C`) carrying secret bytes.
            peer.send(
                seq,
                Frame::new(0x61, 0x1C, vec![0, 4, 0xC1, 0x99, 0xE7, 0x5A]),
            )
            .await;
        });
        assert!(matches!(r, Err(ZsError::Transport(m)) if m.contains("answers SREQ 0x21 0x04")));

        let entries = captured.lock().unwrap();
        let line = entries
            .iter()
            .find(|e| e.message.contains("osalNvReadExt"))
            .expect("expected mismatched SRSP trace");
        assert_eq!(
            line.message,
            "<-- SRSP: SYS - osalNvReadExt - {\"status\":0,\"len\":4,\"value\":\"[REDACTED]\"}"
        );
        let lower = line.message.to_ascii_lowercase();
        for needle in ["c1", "99", "e7", "5a"] {
            assert!(
                !lower.contains(needle),
                "leaked {needle} in: {}",
                line.message
            );
        }
    }
}
