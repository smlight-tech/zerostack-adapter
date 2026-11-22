// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use subtle::ConstantTimeEq;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until, timeout_at};

use crate::cobs_link::{
    Frame, Handshake, Inbound, Indications, Kind, Link, SREQ, ZsError, negotiate,
};
use crate::transport::{self, Port};
use crate::zs_backup::{self, Backup};

pub const SYS: u8 = SREQ | 0x01;
const AF: u8 = SREQ | 0x04;
pub const ZDO: u8 = SREQ | 0x05;
const APP_CNF: u8 = SREQ | 0x0F;
const AF_AREQ: u8 = 0x44;
const ZDO_AREQ: u8 = 0x45;
const AF_SLOTS: usize = 8;
const INTERPAN_ENDPOINT: u8 = 12;
const STUB_APS_ENDPOINT: u8 = 0xFE;
const TID_REST: Duration = Duration::from_secs(5);
const AF_HOLD: Duration = Duration::from_secs(12);
pub const EVENT_QUEUE: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub pan_id: u16,
    pub extended_pan_id: u64,
    pub channels: Vec<u8>,
    pub key: [u8; 16],
    pub distribute: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartResult {
    Resumed,
    Reset,
    Restored,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResetKind {
    Soft,
    Hard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApsFrame {
    pub src_nwk: u16,
    pub src_ieee: Option<u64>,
    pub src_endpoint: u8,
    pub dst_endpoint: u8,
    pub cluster: u16,
    pub profile: u16,
    pub group: Option<u16>,
    pub broadcast: bool,
    pub lqi: Option<u8>,
    pub rssi: Option<i8>,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Aps(ApsFrame),
    Joined { nwk: u16, ieee: u64 },
    Left { nwk: Option<u16>, ieee: Option<u64> },
    Disconnected { reason: String },
}

pub enum VersionValue {
    Number(i64),
    Text(String),
}

pub struct CoordinatorVersion {
    pub kind: String,
    pub meta: Vec<(String, VersionValue)>,
}

pub struct NetworkParameters {
    pub pan_id: u16,
    pub extended_pan_id: u64,
    pub channel: u8,
    pub nwk_update_id: u8,
}

pub struct NwkInfo {
    pub nwk: u16,
    pub state: u8,
    pub pan_id: u16,
    pub extended_pan_id: u64,
    pub channel: u8,
}

pub struct Unicast {
    pub nwk: u16,
    pub dst_endpoint: u8,
    pub src_endpoint: u8,
    pub cluster: u16,
    pub profile: u16,
    pub radius: u8,
    pub aps_ack: bool,
    pub payload: Vec<u8>,
}

pub struct Groupcast {
    pub group: u16,
    pub src_endpoint: u8,
    pub cluster: u16,
    pub profile: u16,
    pub radius: u8,
    pub payload: Vec<u8>,
}

pub struct Broadcast {
    pub destination: u16,
    pub dst_endpoint: u8,
    pub src_endpoint: u8,
    pub cluster: u16,
    pub profile: u16,
    pub radius: u8,
    pub payload: Vec<u8>,
}

struct Endpoint {
    id: u8,
    profile: u16,
    device: u16,
    input: &'static [u16],
    output: &'static [u16],
}

const fn ep(id: u8, profile: u16) -> Endpoint {
    Endpoint {
        id,
        profile,
        device: 0x0005,
        input: &[],
        output: &[],
    }
}

const ENDPOINTS: [Endpoint; 15] = [
    ep(1, 0x0104),
    ep(2, 0x0101),
    ep(3, 0x0104),
    ep(4, 0x0107),
    ep(5, 0x0108),
    ep(6, 0x0109),
    ep(8, 0x0104),
    ep(10, 0x0104),
    Endpoint {
        id: 11,
        profile: 0x0104,
        device: 0x0400,
        input: &[0x0501, 0x000A],
        output: &[0x0500, 0x0502],
    },
    ep(110, 0x0104),
    ep(INTERPAN_ENDPOINT, 0xC05E),
    Endpoint {
        id: 13,
        profile: 0x0104,
        device: 0x0005,
        input: &[0x0019],
        output: &[],
    },
    ep(47, 0x0104),
    ep(239, 0xC001),
    Endpoint {
        id: 242,
        profile: 0xA1E0,
        device: 0x0066,
        input: &[0x0021],
        output: &[0x0021],
    },
];

fn profile_of(endpoint: u8) -> Option<u16> {
    ENDPOINTS
        .iter()
        .find(|e| e.id == endpoint)
        .map(|e| e.profile)
}

fn u16_at(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}

fn status(data: &[u8], what: &str) -> Result<u8, ZsError> {
    match data {
        [s] => Ok(*s),
        _ => Err(ZsError::Rejected(format!(
            "{what} answer is not 1 status byte"
        ))),
    }
}

fn require(what: &str, s: u8) -> Result<(), ZsError> {
    if s == 0 {
        Ok(())
    } else {
        Err(ZsError::Rejected(format!(
            "{what} answered status 0x{s:02x}"
        )))
    }
}

fn delivered(s: u8) -> Result<(), ZsError> {
    if s == 0 {
        Ok(())
    } else {
        Err(ZsError::Delivery(s))
    }
}

pub fn decode_event(f: &Frame, registered: bool) -> Option<Event> {
    let d = &f.data;
    let aps =
        |src_nwk, cluster, src_ep, dst_ep: u8, group, broadcast, lqi, rssi, payload: &[u8]| {
            // Stub APS (inter-PAN) frames carry no endpoints; ZNP reports them as 0xFE.
            let profile = if src_ep == STUB_APS_ENDPOINT || dst_ep == STUB_APS_ENDPOINT {
                profile_of(INTERPAN_ENDPOINT)
            } else {
                profile_of(dst_ep)
            }
            .filter(|_| registered)?;
            Some(Event::Aps(ApsFrame {
                src_nwk,
                src_ieee: None,
                src_endpoint: src_ep,
                dst_endpoint: dst_ep,
                cluster,
                profile,
                group: (group != 0).then_some(group),
                broadcast,
                lqi: Some(lqi),
                rssi,
                payload: payload.to_vec(),
            }))
        };
    match (f.cmd0, f.cmd1) {
        (AF_AREQ, 0x81) if d.len() >= 17 && d.len() >= 17 + usize::from(d[16]) => {
            let n = usize::from(d[16]);
            aps(
                u16_at(d, 4),
                u16_at(d, 2),
                d[6],
                d[7],
                u16_at(d, 0),
                d[8] != 0,
                d[9],
                None,
                &d[17..17 + n],
            )
        }
        (AF_AREQ, 0x84) if d.len() >= 25 && d.len() == 25 + usize::from(d[24]) => aps(
            u16_at(d, 4),
            u16_at(d, 2),
            d[14],
            d[15],
            u16_at(d, 0),
            d[16] & 1 != 0,
            d[17],
            Some(d[18] as i8),
            &d[25..],
        ),
        (AF_AREQ, 0x82) if d.len() >= 27 && d.len() >= 27 + usize::from(u16_at(d, 25)) => {
            let n = usize::from(u16_at(d, 25));
            let (nwk, ieee) = match d[4] {
                3 => (0xFFFE, Some(u64_at(d, 5))),
                2 => (u16_at(d, 5), None),
                _ => return None,
            };
            let mut event = aps(
                nwk,
                u16_at(d, 2),
                d[13],
                d[16],
                u16_at(d, 0),
                d[17] != 0,
                d[18],
                None,
                &d[27..27 + n],
            )?;
            if let Event::Aps(frame) = &mut event {
                frame.src_ieee = ieee;
            }
            Some(event)
        }
        (ZDO_AREQ, 0xFF) if d.len() >= 9 => {
            let mut payload = vec![d[6]];
            payload.extend_from_slice(&d[9..]);
            Some(zdo_event(u16_at(d, 0), u16_at(d, 3), d[2] != 0, payload))
        }
        (ZDO_AREQ, 0xC8) if d.len() == 11 => {
            let mut payload = vec![0, 0];
            payload.extend_from_slice(&d[2..10]);
            payload.extend_from_slice(&d[0..2]);
            Some(zdo_event(u16_at(d, 0), 0x8000, false, payload))
        }
        (ZDO_AREQ, 0xCA) if d.len() >= 12 => Some(Event::Joined {
            nwk: u16_at(d, 0),
            ieee: u64_at(d, 2),
        }),
        (ZDO_AREQ, 0xC9) if d.len() == 13 && d[12] == 0 => Some(Event::Left {
            nwk: Some(u16_at(d, 0)),
            ieee: Some(u64_at(d, 2)),
        }),
        _ => None,
    }
}

fn zdo_event(src_nwk: u16, cluster: u16, broadcast: bool, payload: Vec<u8>) -> Event {
    Event::Aps(ApsFrame {
        src_nwk,
        src_ieee: None,
        src_endpoint: 0,
        dst_endpoint: 0,
        cluster,
        profile: 0,
        group: None,
        broadcast,
        lqi: None,
        rssi: None,
        payload,
    })
}

pub fn zdo_request(cluster: u16, nwk: u16, payload: &[u8]) -> Result<(u8, Vec<u8>), ZsError> {
    let (_, body) = payload
        .split_first()
        .ok_or_else(|| ZsError::Invalid("ZDO payload lacks its sequence byte".into()))?;
    let need = |n: usize| {
        if body.len() == n {
            Ok(())
        } else {
            Err(ZsError::Invalid(format!(
                "ZDO cluster 0x{cluster:04x} body must be {n} bytes, got {}",
                body.len()
            )))
        }
    };
    let dst = nwk.to_le_bytes();
    let prefixed = |cmd: u8| (cmd, [&dst[..], body].concat());
    let mode = if nwk >= 0xFFF8 { 0x0F } else { 0x02 };
    Ok(match cluster {
        0x0000 => need(10).map(|()| (0x00, body.to_vec()))?,
        0x0001 => {
            need(4)?;
            if body[..2] != dst {
                return Err(ZsError::Invalid(
                    "IEEE_addr_req address of interest is not the destination".into(),
                ));
            }
            (0x01, body.to_vec())
        }
        0x0002 | 0x0003 | 0x0005 => need(2).map(|()| prefixed(cluster as u8))?,
        0x0004 => need(3).map(|()| prefixed(0x04))?,
        0x0006 => {
            let n_in = usize::from(*body.get(4).unwrap_or(&0));
            let n_out = usize::from(*body.get(5 + 2 * n_in).unwrap_or(&0));
            need(6 + 2 * n_in + 2 * n_out).map(|()| prefixed(0x06))?
        }
        0x0021 | 0x0022 => match (body.len(), body.get(11)) {
            (21, Some(3)) => prefixed(cluster as u8),
            (14, Some(1)) => {
                let (cmd, mut data) = prefixed(cluster as u8);
                data.extend_from_slice(&[0; 7]);
                (cmd, data)
            }
            _ => {
                return Err(ZsError::Invalid(
                    "bind request must use group or 64-bit mode".into(),
                ));
            }
        },
        0x0030 => need(6).map(|()| prefixed(0x30))?,
        0x0031..=0x0033 => need(1).map(|()| prefixed(cluster as u8))?,
        0x0034 => {
            need(9)?;
            let options = body[8];
            if options & !0xC0 != 0 {
                return Err(ZsError::Invalid(format!(
                    "Mgmt_Leave_req options 0x{options:02x}"
                )));
            }
            let flags = u8::from(options & 0x80 != 0) | (u8::from(options & 0x40 != 0) << 1);
            let mut data = [&dst[..], &body[..8]].concat();
            data.push(flags);
            (0x34, data)
        }
        0x0036 => need(2).map(|()| (0x36, vec![mode, dst[0], dst[1], body[0], body[1]]))?,
        0x0038 => {
            need(6)?;
            let count = match body[4] {
                0..=5 => body[5],
                0xFE => 0,
                0xFF => {
                    return Err(ZsError::Unsupported(
                        "Mgmt_NWK_Update_req manager change".into(),
                    ));
                }
                d => {
                    return Err(ZsError::Invalid(format!(
                        "Mgmt_NWK_Update_req duration 0x{d:02x}"
                    )));
                }
            };
            let mut data = vec![dst[0], dst[1], mode];
            data.extend_from_slice(&body[..5]);
            data.extend_from_slice(&[count, 0, 0]);
            (0x37, data)
        }
        _ => {
            return Err(ZsError::Unsupported(format!(
                "ZDO request cluster 0x{cluster:04x} has no MT ZDO command"
            )));
        }
    })
}

#[derive(Clone, Copy)]
enum TidState {
    Free,
    Busy,
    Rest(Instant),
}

struct AfPool {
    slots: Arc<Semaphore>,
    tids: Mutex<(u8, [TidState; 256])>,
    generation: watch::Sender<u64>,
}

struct Tid {
    pool: Arc<AfPool>,
    id: u8,
}

impl Drop for Tid {
    fn drop(&mut self) {
        let mut tids = self
            .pool
            .tids
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        tids.1[usize::from(self.id)] = TidState::Rest(Instant::now() + TID_REST);
    }
}

impl AfPool {
    fn take(&self) -> Result<Result<u8, Option<Instant>>, ZsError> {
        let mut tids = self
            .tids
            .lock()
            .map_err(|_| ZsError::Transport("AF ID lock poisoned".into()))?;
        let now = Instant::now();
        let mut earliest = None;
        for k in 0..=255u8 {
            let id = tids.0.wrapping_add(k);
            match tids.1[usize::from(id)] {
                TidState::Rest(t) if t > now => {
                    earliest = Some(earliest.map_or(t, |e: Instant| e.min(t)))
                }
                TidState::Busy => {}
                TidState::Free | TidState::Rest(_) => {
                    tids.1[usize::from(id)] = TidState::Busy;
                    tids.0 = id.wrapping_add(1);
                    return Ok(Ok(id));
                }
            }
        }
        Ok(Err(earliest))
    }

    async fn tid(self: &Arc<Self>, deadline: Instant) -> Result<Tid, ZsError> {
        loop {
            match self.take()? {
                Ok(id) => {
                    return Ok(Tid {
                        pool: Arc::clone(self),
                        id,
                    });
                }
                Err(Some(t)) if t <= deadline => sleep_until(t).await,
                Err(Some(_)) => return Err(ZsError::Timeout("a free AF transaction ID".into())),
                Err(None) => {
                    return Err(ZsError::Rejected(
                        "all 256 AF transaction IDs are in flight".into(),
                    ));
                }
            }
        }
    }
}

async fn wait_confirm(
    confirms: &mut Indications,
    src_ep: u8,
    tid: u8,
    dst: u16,
    seq: Option<u8>,
    deadline: Instant,
) -> Result<(), ZsError> {
    loop {
        let f = confirms.next(deadline, "AF_DATA_CONFIRM").await?;
        let d = &f.data;
        if (f.cmd0, f.cmd1) != (AF_AREQ, 0x80) || d.len() < 3 || d[1] != src_ep || d[2] != tid {
            continue;
        }
        match d.len() {
            3 => {}
            10 if u16_at(d, 3) == dst && seq.is_none_or(|s| d[5] == s) => {}
            10 => continue,
            n => return Err(ZsError::Rejected(format!("AF_DATA_CONFIRM of {n} bytes"))),
        }
        return delivered(d[0]);
    }
}

pub struct Coordinator {
    link: Link,
    hs: Mutex<Handshake>,
    registered: Arc<AtomicBool>,
    af: Arc<AfPool>,
    tasks: [JoinHandle<()>; 2],
}

impl Coordinator {
    pub async fn open(
        address: &str,
        baud: u32,
        rtscts: bool,
        events: mpsc::Sender<Event>,
        deadline: Instant,
    ) -> Result<Self, ZsError> {
        let port = transport::open(address, baud, rtscts, deadline).await?;
        Self::over(port, events, deadline).await
    }

    pub async fn over<P: Port + 'static>(
        port: P,
        events: mpsc::Sender<Event>,
        deadline: Instant,
    ) -> Result<Self, ZsError> {
        let (link, inbound, link_task) = Link::spawn(port);
        let hs = match negotiate(&link, deadline).await {
            Ok(hs) => hs,
            Err(e) => {
                link.close().await;
                return Err(e);
            }
        };
        let registered = Arc::new(AtomicBool::new(false));
        let events_task = tokio::spawn(forward(inbound, events, Arc::clone(&registered)));
        Ok(Self {
            link,
            hs: Mutex::new(hs),
            registered,
            af: Arc::new(AfPool {
                slots: Arc::new(Semaphore::new(AF_SLOTS)),
                tids: Mutex::new((0, [TidState::Free; 256])),
                generation: watch::Sender::new(0),
            }),
            tasks: [link_task, events_task],
        })
    }

    pub fn handshake(&self) -> Result<Handshake, ZsError> {
        Ok(self
            .hs
            .lock()
            .map_err(|_| ZsError::Transport("handshake lock poisoned".into()))?
            .clone())
    }

    pub async fn stop(&self) {
        self.link.close().await;
    }

    pub fn close(&self) {
        for task in &self.tasks {
            task.abort();
        }
    }

    pub(crate) fn link(&self) -> &Link {
        &self.link
    }

    pub(crate) async fn sreq(
        &self,
        cmd0: u8,
        cmd1: u8,
        data: Vec<u8>,
        deadline: Instant,
    ) -> Result<Vec<u8>, ZsError> {
        self.link.sreq(cmd0, cmd1, data, deadline).await
    }

    pub(crate) async fn nv_read(&self, item: u16, deadline: Instant) -> Result<Vec<u8>, ZsError> {
        let id = item.to_le_bytes();
        let d = self.sreq(SYS, 0x13, id.to_vec(), deadline).await?;
        let length = match d.as_slice() {
            [lo, hi] => usize::from(u16::from_le_bytes([*lo, *hi])),
            _ => {
                return Err(ZsError::Rejected(
                    "SYS_OSAL_NV_LENGTH answer is not 2 bytes".into(),
                ));
            }
        };
        let mut out = Vec::with_capacity(length);
        while out.len() < length {
            let at = (out.len() as u16).to_le_bytes();
            let d = self
                .sreq(SYS, 0x1C, vec![id[0], id[1], at[0], at[1]], deadline)
                .await?;
            match d.as_slice() {
                [0, n, rest @ ..] if *n > 0 && *n <= 247 && rest.len() == usize::from(*n) => {
                    out.extend_from_slice(rest)
                }
                _ => {
                    return Err(ZsError::Rejected(format!(
                        "NV item 0x{item:04x} read failed: {d:02x?}"
                    )));
                }
            }
        }
        if out.len() != length {
            return Err(ZsError::Rejected(format!(
                "NV item 0x{item:04x} is longer than announced"
            )));
        }
        Ok(out)
    }

    pub async fn nwk_info(&self, deadline: Instant) -> Result<NwkInfo, ZsError> {
        let d = self.sreq(ZDO, 0x50, vec![], deadline).await?;
        if d.len() != 24 {
            return Err(ZsError::Rejected(format!(
                "ZDO_EXT_NWK_INFO answer of {} bytes",
                d.len()
            )));
        }
        Ok(NwkInfo {
            nwk: u16_at(&d, 0),
            state: d[2],
            pan_id: u16_at(&d, 3),
            extended_pan_id: u64_at(&d, 7),
            channel: d[23],
        })
    }

    pub async fn ieee(&self, deadline: Instant) -> Result<u64, ZsError> {
        let d = self.sreq(SYS, 0x04, vec![], deadline).await?;
        if d.len() != 8 {
            return Err(ZsError::Rejected(
                "SYS_GET_EXTADDR answer is not 8 bytes".into(),
            ));
        }
        Ok(u64_at(&d, 0))
    }

    pub async fn coordinator_version(
        &self,
        deadline: Instant,
    ) -> Result<CoordinatorVersion, ZsError> {
        let d = self.sreq(SYS, 0x02, vec![], deadline).await?;
        if d.len() < 5 {
            return Err(ZsError::Rejected(
                "SYS_VERSION answer is shorter than 5 bytes".into(),
            ));
        }
        let kind = match d[1] {
            0 => "zStack12",
            1 => "zStack3x0",
            2 => "zStack30x",
            p => {
                return Err(ZsError::Rejected(format!(
                    "unknown SYS_VERSION product {p}"
                )));
            }
        };
        let hs = self.handshake()?;
        let num = |k: &str, v: i64| (k.to_owned(), VersionValue::Number(v));
        let mut meta = vec![
            num("transportrev", d[0].into()),
            num("product", d[1].into()),
            num("majorrel", d[2].into()),
            num("minorrel", d[3].into()),
            num("maintrel", d[4].into()),
        ];
        if d.len() >= 9 {
            meta.push(num(
                "revision",
                u32::from_le_bytes([d[5], d[6], d[7], d[8]]).into(),
            ));
        }
        meta.push((
            "framing".to_owned(),
            VersionValue::Text("cobs-mux".to_owned()),
        ));
        meta.push(num("mt_capabilities", hs.capabilities.into()));
        meta.push(num("zs_granted", hs.caps.have.into()));
        meta.push(num("zs_features", hs.caps.features.into()));
        meta.push(num("zs_nodes", hs.caps.nodes.into()));
        meta.push(num("zs_rx_budget", hs.caps.rx_budget.into()));
        Ok(CoordinatorVersion {
            kind: kind.to_owned(),
            meta,
        })
    }

    pub async fn network_parameters(
        &self,
        deadline: Instant,
    ) -> Result<NetworkParameters, ZsError> {
        let info = self.nwk_info(deadline).await?;
        let nib = self.nv_read(0x0021, deadline).await?;
        let nwk_update_id = *nib
            .get(114)
            .ok_or_else(|| ZsError::Rejected("the coordinator holds no NIB".into()))?;
        Ok(NetworkParameters {
            pan_id: info.pan_id,
            extended_pan_id: info.extended_pan_id,
            channel: info.channel,
            nwk_update_id,
        })
    }

    pub async fn reset(&self, kind: ResetKind, deadline: Instant) -> Result<(), ZsError> {
        match kind {
            ResetKind::Hard => Err(ZsError::Unsupported("hard reset".into())),
            ResetKind::Soft => self.renegotiate(deadline).await,
        }
    }

    // Soft reset on the same link; a coordinator that does not come back ends the session.
    pub(crate) async fn renegotiate(&self, deadline: Instant) -> Result<(), ZsError> {
        self.registered.store(false, Ordering::Release);
        self.af.generation.send_modify(|g| *g += 1);
        let outcome = async {
            self.link.reset(deadline).await?;
            negotiate(&self.link, deadline).await
        }
        .await;
        match outcome {
            Ok(hs) => {
                *self
                    .hs
                    .lock()
                    .map_err(|_| ZsError::Transport("handshake lock poisoned".into()))? = hs;
                Ok(())
            }
            Err(e) => {
                self.link
                    .fail(&format!(
                        "the coordinator did not come back after a reset: {e}"
                    ))
                    .await;
                Err(e)
            }
        }
    }

    async fn held_network(
        &self,
        deadline: Instant,
    ) -> Result<Option<(u16, u64, [u8; 16])>, ZsError> {
        let nib = self.nv_read(0x0021, deadline).await?;
        if nib.is_empty() {
            return Ok(None);
        }
        if !(116..=117).contains(&nib.len()) {
            return Err(ZsError::Rejected(format!("NIB of {} bytes", nib.len())));
        }
        let pan = u16_at(&nib, 36);
        if u16_at(&nib, 22) != 0 || pan == 0xFFFF {
            return Ok(None);
        }
        let info = self.nv_read(0x003A, deadline).await?;
        if info.len() != 17 {
            return Err(ZsError::Rejected(format!(
                "active key info of {} bytes",
                info.len()
            )));
        }
        let mut key = [0u8; 16];
        key.copy_from_slice(&info[1..]);
        Ok((key != [0; 16]).then_some((pan, u64_at(&nib, 57), key)))
    }

    pub async fn start(
        &self,
        net: &Network,
        backup: Option<&Backup>,
        deadline: Instant,
    ) -> Result<StartResult, ZsError> {
        if net.channels.is_empty() || net.channels.iter().any(|c| !(11..=26).contains(c)) {
            return Err(ZsError::Invalid(
                "channelList must hold channels 11..26".into(),
            ));
        }
        if net.pan_id == 0xFFFF || net.extended_pan_id == 0 || net.extended_pan_id == u64::MAX {
            return Err(ZsError::Invalid(
                "panId or extendedPanId is reserved".into(),
            ));
        }
        let product = self.handshake()?.version[1];
        if !(1..=2).contains(&product) {
            return Err(ZsError::Unsupported(format!(
                "SYS_VERSION product {product}"
            )));
        }
        let backup = backup.map(zs_backup::normalize);
        if let Some(b) = &backup {
            zs_backup::validate(b)?;
        }
        let same = |pan: u16, ext: u64, key: &[u8; 16], other: &Network| {
            pan == other.pan_id && ext == other.extended_pan_id && bool::from(key.ct_eq(&other.key))
        };
        let held = self.held_network(deadline).await?;
        let result = match (held, backup.as_ref()) {
            (Some((p, e, k)), _) if same(p, e, &k, net) => StartResult::Resumed,
            (Some((p, e, k)), Some(b)) if same(p, e, &k, &b.network) => {
                return Err(ZsError::Rejected(
                    "coordinator runs the backup's network, which differs from the requested network".into(),
                ));
            }
            (_, Some(b))
                if same(
                    b.network.pan_id,
                    b.network.extended_pan_id,
                    &b.network.key,
                    net,
                ) =>
            {
                no_distribution(net)?;
                zs_backup::restore(self, b, deadline).await?;
                StartResult::Restored
            }
            _ => {
                no_distribution(net)?;
                if net.channels.len() != 1 {
                    return Err(ZsError::Invalid(
                        "forming a network needs exactly one channel".into(),
                    ));
                }
                zs_backup::form(self, net, deadline).await?;
                StartResult::Reset
            }
        };
        self.start_network(net, deadline).await?;
        Ok(result)
    }

    async fn start_network(&self, net: &Network, deadline: Instant) -> Result<(), ZsError> {
        match self.nwk_info(deadline).await?.state {
            9 => {}
            0 => {
                let mut ind = self.link.subscribe();
                let r = self
                    .link
                    .call(Kind::Startup, Frame::new(ZDO, 0x40, vec![100, 0]), deadline)
                    .await?;
                require(
                    "ZDO_STARTUP_FROM_APP",
                    status(&r.data, "ZDO_STARTUP_FROM_APP")?,
                )?;
                loop {
                    let f = ind.next(deadline, "ZDO_STATE_CHANGE_IND 9").await?;
                    match (f.cmd0, f.cmd1, f.data.as_slice()) {
                        (ZDO_AREQ, 0xC0, [9]) => break,
                        (0x4F, 0x80, [8, 2, ..]) => {
                            return Err(ZsError::Rejected("network formation failed".into()));
                        }
                        _ => {}
                    }
                }
            }
            s => {
                return Err(ZsError::Rejected(format!(
                    "coordinator in device state {s} cannot be started"
                )));
            }
        }
        let info = self.nwk_info(deadline).await?;
        if info.nwk != 0 || info.pan_id != net.pan_id || info.extended_pan_id != net.extended_pan_id
        {
            return Err(ZsError::Rejected(
                "started network differs from the requested one".into(),
            ));
        }
        for e in &ENDPOINTS {
            let mut data = vec![e.id];
            data.extend_from_slice(&e.profile.to_le_bytes());
            data.extend_from_slice(&e.device.to_le_bytes());
            data.extend_from_slice(&[0, 0]);
            for list in [e.input, e.output] {
                data.push(list.len() as u8);
                list.iter()
                    .for_each(|c| data.extend_from_slice(&c.to_le_bytes()));
            }
            let mut s = status(
                &self.sreq(AF, 0x00, data.clone(), deadline).await?,
                "AF_REGISTER",
            )?;
            if s == 0xB8 {
                let d = self.sreq(AF, 0x04, vec![e.id], deadline).await?;
                if status(&d, "AF_DELETE")? != 0 {
                    return Err(ZsError::Rejected(format!(
                        "endpoint {} kept an earlier registration",
                        e.id
                    )));
                }
                s = status(&self.sreq(AF, 0x00, data, deadline).await?, "AF_REGISTER")?;
            }
            require("AF_REGISTER", s)?;
        }
        let d = self.sreq(ZDO, 0x3E, vec![0xFF, 0xFF], deadline).await?;
        require("ZDO_MSG_CB_REGISTER", status(&d, "ZDO_MSG_CB_REGISTER")?)?;
        self.registered.store(true, Ordering::Release);
        Ok(())
    }

    fn check_source(&self, endpoint: u8, profile: u16) -> Result<(), ZsError> {
        match profile_of(endpoint) {
            Some(p) if p == profile && self.registered.load(Ordering::Acquire) => Ok(()),
            _ => Err(ZsError::Invalid(format!(
                "source endpoint {endpoint} is not registered with profile 0x{profile:04x}"
            ))),
        }
    }

    async fn af_send(
        &self,
        cmd1: u8,
        mut data: Vec<u8>,
        tid_at: usize,
        src_ep: u8,
        dst: u16,
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let permit: OwnedSemaphorePermit =
            timeout_at(deadline, Arc::clone(&self.af.slots).acquire_owned())
                .await
                .map_err(|_| ZsError::Timeout("a free AF slot".into()))?
                .map_err(|_| ZsError::Transport("AF slots closed".into()))?;
        let tid = self.af.tid(deadline).await?;
        data[tid_at] = tid.id;
        let mut backoff = Duration::from_millis(40);
        let (sent, mut confirms) = loop {
            // Subscribed per attempt so no receiver idles through a busy backoff.
            let confirms = self.link.subscribe();
            let r = self
                .link
                .call(Kind::Normal, Frame::new(AF, cmd1, data.clone()), deadline)
                .await;
            let r = match r {
                Err(ZsError::Timeout(w)) => break (Err((ZsError::Timeout(w), None)), confirms),
                other => other?,
            };
            match status(&r.data, "AF_DATA_REQUEST")? {
                0 => break (Ok(r.seq), confirms),
                s @ (0x10 | 0x11) if Instant::now() + backoff < deadline => {
                    tracing::debug!("AF request busy (0x{s:02x}), retrying");
                    // Coordinator-specified busy backoff.
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_millis(320));
                }
                s => return Err(ZsError::Delivery(s)),
            }
        };
        let (error, seq) = match sent {
            Ok(seq) => {
                match wait_confirm(&mut confirms, src_ep, tid.id, dst, Some(seq), deadline).await {
                    Err(ZsError::Timeout(w)) => (ZsError::Timeout(w), Some(seq)),
                    done => return done,
                }
            }
            Err(pending) => pending,
        };
        // Keeps the slot and ID until the late confirm, a reset, the link end or the hold bound.
        let mut generation = self.af.generation.subscribe();
        tokio::spawn(async move {
            let id = tid.id;
            let held = (permit, tid);
            tokio::select! {
                r = wait_confirm(&mut confirms, src_ep, id, dst, seq, Instant::now() + AF_HOLD) => {
                    tracing::debug!("late AF confirm for ID {id}: {r:?}");
                }
                _ = generation.changed() => {}
            }
            drop(held);
        });
        Err(error)
    }

    pub async fn unicast(&self, u: Unicast, deadline: Instant) -> Result<(), ZsError> {
        self.check_source(u.src_endpoint, u.profile)?;
        let options = if u.aps_ack { 0x10 } else { 0 };
        let data = af_request(
            u.nwk,
            u.dst_endpoint,
            u.src_endpoint,
            u.cluster,
            options,
            u.radius,
            &u.payload,
        )?;
        self.af_send(0x01, data, 6, u.src_endpoint, u.nwk, deadline)
            .await
    }

    pub async fn broadcast(&self, b: Broadcast, deadline: Instant) -> Result<(), ZsError> {
        self.check_source(b.src_endpoint, b.profile)?;
        let data = af_request(
            b.destination,
            b.dst_endpoint,
            b.src_endpoint,
            b.cluster,
            0,
            b.radius,
            &b.payload,
        )?;
        self.af_send(0x01, data, 6, b.src_endpoint, b.destination, deadline)
            .await
    }

    pub async fn groupcast(&self, g: Groupcast, deadline: Instant) -> Result<(), ZsError> {
        self.check_source(g.src_endpoint, g.profile)?;
        let data = af_request_ext(
            1,
            u64::from(g.group),
            0xFF,
            0,
            g.src_endpoint,
            g.cluster,
            g.radius,
            &g.payload,
        )?;
        self.af_send(0x02, data, 15, g.src_endpoint, g.group, deadline)
            .await
    }

    pub async fn interpan_send(
        &self,
        ieee: Option<u64>,
        payload: &[u8],
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let (mode, address, dst) = match ieee {
            Some(ieee) => (3, ieee, 0xFFFE),
            None => (2, 0xFFFF, 0xFFFF),
        };
        let data = af_request_ext(
            mode,
            address,
            STUB_APS_ENDPOINT,
            0xFFFF,
            INTERPAN_ENDPOINT,
            0x1000,
            30,
            payload,
        )?;
        self.af_send(0x02, data, 15, INTERPAN_ENDPOINT, dst, deadline)
            .await
    }

    pub async fn interpan_channel(
        &self,
        channel: Option<u8>,
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let ops: Vec<Vec<u8>> = match channel {
            Some(c) if (11..=26).contains(&c) => vec![vec![2, INTERPAN_ENDPOINT], vec![1, c]],
            Some(c) => return Err(ZsError::Invalid(format!("channel {c} is not 11..26"))),
            None => vec![vec![0]],
        };
        for op in ops {
            require(
                "AF_INTER_PAN_CTL",
                status(
                    &self.sreq(AF, 0x10, op, deadline).await?,
                    "AF_INTER_PAN_CTL",
                )?,
            )?;
        }
        Ok(())
    }

    pub async fn zdo(
        &self,
        nwk: u16,
        cluster: u16,
        payload: &[u8],
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let (cmd1, data) = zdo_request(cluster, nwk, payload)?;
        delivered(status(
            &self.sreq(ZDO, cmd1, data, deadline).await?,
            "ZDO request",
        )?)
    }

    pub async fn permit_join(
        &self,
        seconds: u8,
        nwk: Option<u16>,
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let dst = nwk.unwrap_or(0xFFFC);
        let mode = if dst >= 0xFFF8 { 0x0F } else { 0x02 };
        let mut ind = self.link.subscribe();
        let [lo, hi] = dst.to_le_bytes();
        delivered(status(
            &self
                .sreq(ZDO, 0x36, vec![mode, lo, hi, seconds, 1], deadline)
                .await?,
            "ZDO_MGMT_PERMIT_JOIN_REQ",
        )?)?;
        let Some(addr) = nwk else { return Ok(()) };
        loop {
            let f = ind.next(deadline, "Mgmt_Permit_Joining_rsp").await?;
            let d = &f.data;
            let s = match (f.cmd0, f.cmd1) {
                (ZDO_AREQ, 0xFF)
                    if d.len() >= 10 && u16_at(d, 0) == addr && u16_at(d, 3) == 0x8036 =>
                {
                    d[9]
                }
                (ZDO_AREQ, 0xB6) if d.len() >= 3 && u16_at(d, 0) == addr => d[2],
                _ => continue,
            };
            return require("Mgmt_Permit_Joining_rsp", s);
        }
    }

    pub async fn add_install_code(
        &self,
        ieee: u64,
        code: &[u8],
        hashed: bool,
        deadline: Instant,
    ) -> Result<(), ZsError> {
        let (format, len) = if hashed { (2, 16) } else { (1, 18) };
        if code.len() != len {
            return Err(ZsError::Invalid(format!(
                "install code must be {len} bytes, got {}",
                code.len()
            )));
        }
        let mut data = vec![format];
        data.extend_from_slice(&ieee.to_le_bytes());
        data.extend_from_slice(code);
        require(
            "APP_CNF_BDB_ADD_INSTALLCODE",
            status(
                &self.sreq(APP_CNF, 0x04, data, deadline).await?,
                "APP_CNF_BDB_ADD_INSTALLCODE",
            )?,
        )
    }
}

fn no_distribution(net: &Network) -> Result<(), ZsError> {
    if net.distribute {
        return Err(ZsError::Unsupported(
            "pre-configured network key distribution".into(),
        ));
    }
    Ok(())
}

fn af_request(
    dst: u16,
    dst_ep: u8,
    src_ep: u8,
    cluster: u16,
    options: u8,
    radius: u8,
    payload: &[u8],
) -> Result<Vec<u8>, ZsError> {
    if payload.len() > 239 {
        return Err(ZsError::Invalid(format!(
            "payload of {} bytes exceeds 239",
            payload.len()
        )));
    }
    let mut d = Vec::with_capacity(10 + payload.len());
    d.extend_from_slice(&dst.to_le_bytes());
    d.extend_from_slice(&[dst_ep, src_ep]);
    d.extend_from_slice(&cluster.to_le_bytes());
    d.extend_from_slice(&[0, options, radius, payload.len() as u8]);
    d.extend_from_slice(payload);
    Ok(d)
}

// Mirrors the 8 wire fields of MT AF_DATA_REQUEST_EXT (subsystem AF, cmd 0x02) directly.
#[allow(clippy::too_many_arguments)]
fn af_request_ext(
    mode: u8,
    address: u64,
    dst_ep: u8,
    pan: u16,
    src_ep: u8,
    cluster: u16,
    radius: u8,
    payload: &[u8],
) -> Result<Vec<u8>, ZsError> {
    if payload.len() > 229 {
        return Err(ZsError::Invalid(format!(
            "payload of {} bytes exceeds 229",
            payload.len()
        )));
    }
    let mut d = vec![mode];
    d.extend_from_slice(&address.to_le_bytes());
    d.push(dst_ep);
    d.extend_from_slice(&pan.to_le_bytes());
    d.push(src_ep);
    d.extend_from_slice(&cluster.to_le_bytes());
    d.extend_from_slice(&[0, 0, radius]);
    d.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    d.extend_from_slice(payload);
    Ok(d)
}

async fn forward(
    mut inbound: mpsc::Receiver<Inbound>,
    events: mpsc::Sender<Event>,
    registered: Arc<AtomicBool>,
) {
    while let Some(item) = inbound.recv().await {
        let event = match item {
            Inbound::Areq(f) => match decode_event(&f, registered.load(Ordering::Acquire)) {
                Some(event) => event,
                None => continue,
            },
            Inbound::Down(reason) => Event::Disconnected { reason },
        };
        // A closed queue means the consumer stopped; nothing is left to deliver to.
        if events.send(event).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cobs_link::test_peer::Peer;

    pub fn soon() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    pub async fn session() -> (Coordinator, mpsc::Receiver<Event>, Peer) {
        let (host, coordinator) = tokio::io::duplex(4096);
        let (events, rx) = mpsc::channel(EVENT_QUEUE);
        let mut peer = Peer::new(coordinator);
        let (c, ()) = tokio::join!(Coordinator::over(host, events, soon()), peer.handshake());
        (c.expect("open"), rx, peer)
    }

    fn confirm(status: u8, ep: u8, tid: u8, dst: u16, seq: u8) -> Frame {
        let [lo, hi] = dst.to_le_bytes();
        Frame::new(
            AF_AREQ,
            0x80,
            vec![status, ep, tid, lo, hi, seq, 0, 0x7F, 0xFF, 0],
        )
    }

    #[tokio::test(start_paused = true)]
    async fn unicast_resolves_on_its_own_extended_confirm() {
        let (c, _events, mut peer) = session().await;
        let frame = || Unicast {
            nwk: 0x1234,
            dst_endpoint: 1,
            src_endpoint: 1,
            cluster: 6,
            profile: 0x0104,
            radius: 0,
            aps_ack: true,
            payload: vec![0x01, 0x02, 0x00],
        };
        assert!(matches!(
            c.unicast(frame(), soon()).await,
            Err(ZsError::Invalid(_))
        ));
        c.registered.store(true, Ordering::Release);
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            assert_eq!(d, [0x34, 0x12, 1, 1, 6, 0, d[6], 0x10, 0, 3, 1, 2, 0]);
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            // Stale, other destination and other ID: none of these answer the request.
            peer.send(0, confirm(0xE9, 1, d[6], 0x1234, 0)).await;
            peer.send(0, confirm(0xE9, 1, d[6], 0x9999, seq)).await;
            peer.send(0, confirm(0xE9, 1, d[6].wrapping_add(1), 0x1234, seq))
                .await;
            peer.send(0, confirm(0, 1, d[6], 0x1234, seq)).await;
            d[6]
        };
        let (r, first) = tokio::join!(c.unicast(frame(), soon()), script);
        assert_eq!(r, Ok(()));
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            assert_ne!(d[6], first, "a resting transaction ID was reused");
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            peer.send(0, confirm(0xB7, 1, d[6], 0x1234, seq)).await;
        };
        let (r, ()) = tokio::join!(c.unicast(frame(), soon()), script);
        assert_eq!(r, Err(ZsError::Delivery(0xB7)));
        let (r, _) = tokio::join!(c.unicast(frame(), soon()), peer.answer(AF, 0x01, &[0xC2]));
        assert_eq!(r, Err(ZsError::Delivery(0xC2)));
    }

    #[tokio::test(start_paused = true)]
    async fn incoming_frames_become_events() {
        let (c, mut events, mut peer) = session().await;
        let zs_incoming = |payload: &[u8]| {
            let mut d = vec![0, 0, 0x06, 0x00, 0x34, 0x12];
            d.extend_from_slice(&0x00124B0012345678u64.to_le_bytes());
            d.extend_from_slice(&[
                1,
                11,
                0x0B,
                200,
                0xC4,
                0x34,
                0x12,
                29,
                1,
                0,
                payload.len() as u8,
            ]);
            d.extend_from_slice(payload);
            Frame::new(AF_AREQ, 0x84, d)
        };
        // Before endpoints are registered no event is produced.
        assert_eq!(decode_event(&zs_incoming(&[0x18, 0x01, 0x0A]), false), None);
        assert_eq!(
            decode_event(&Frame::new(AF_AREQ, 0x84, vec![0; 26]), true),
            None
        );
        c.registered.store(true, Ordering::Release);
        peer.send(0, zs_incoming(&[0x18, 0x02, 0x0A])).await;
        let mut leave = vec![0x34, 0x12];
        leave.extend_from_slice(&7u64.to_le_bytes());
        leave.extend_from_slice(&[0, 0, 1]);
        peer.send(0, Frame::new(ZDO_AREQ, 0xC9, leave.clone()))
            .await;
        leave[12] = 0;
        peer.send(0, Frame::new(ZDO_AREQ, 0xC9, leave)).await;
        let expected = ApsFrame {
            src_nwk: 0x1234,
            src_ieee: None,
            src_endpoint: 1,
            dst_endpoint: 11,
            cluster: 6,
            profile: 0x0104,
            group: None,
            broadcast: true,
            lqi: Some(200),
            rssi: Some(-60),
            payload: vec![0x18, 0x02, 0x0A],
        };
        assert_eq!(events.recv().await, Some(Event::Aps(expected)));
        assert_eq!(
            events.recv().await,
            Some(Event::Left {
                nwk: Some(0x1234),
                ieee: Some(7)
            })
        );
        drop(c);
    }

    #[tokio::test(start_paused = true)]
    async fn zdo_request_and_response() {
        let (c, mut events, mut peer) = session().await;
        let (r, d) = tokio::join!(
            c.zdo(0x1234, 0x0005, &[0x42, 0x34, 0x12], soon()),
            peer.answer(ZDO, 0x05, &[0])
        );
        assert_eq!(r, Ok(()));
        assert_eq!(d, [0x34, 0x12, 0x34, 0x12]);
        peer.send(
            0,
            Frame::new(
                ZDO_AREQ,
                0xFF,
                vec![
                    0x34, 0x12, 0, 0x05, 0x80, 0, 0x17, 0, 0, 0, 0x34, 0x12, 1, 1,
                ],
            ),
        )
        .await;
        let Some(Event::Aps(rsp)) = events.recv().await else {
            panic!("no ZDO event")
        };
        assert_eq!(
            (rsp.src_nwk, rsp.cluster, rsp.profile, rsp.lqi),
            (0x1234, 0x8005, 0, None)
        );
        assert_eq!(rsp.payload, [0x17, 0, 0x34, 0x12, 1, 1]);
        let (r, _) = tokio::join!(
            c.zdo(0x1234, 0x0005, &[0x42, 0x34, 0x12], soon()),
            peer.answer(ZDO, 0x05, &[0xC2])
        );
        assert_eq!(r, Err(ZsError::Delivery(0xC2)));
    }

    #[test]
    fn zdo_bodies_convert_or_fail_without_sending() {
        let ieee = 0x00124B0012345678u64.to_le_bytes();
        let mut leave = vec![9];
        leave.extend_from_slice(&ieee);
        leave.push(0xC0);
        let (cmd, d) = zdo_request(0x0034, 0x1234, &leave).expect("leave");
        assert_eq!(cmd, 0x34);
        assert_eq!(
            (&d[..2], &d[2..10], d[10]),
            (&[0x34, 0x12][..], &ieee[..], 0x03)
        );
        leave[9] = 0x01;
        assert!(matches!(
            zdo_request(0x0034, 0x1234, &leave),
            Err(ZsError::Invalid(_))
        ));
        let mut bind = vec![1];
        bind.extend_from_slice(&ieee);
        bind.extend_from_slice(&[1, 6, 0, 1, 0x05, 0x00]);
        let (cmd, d) = zdo_request(0x0021, 0x1234, &bind).expect("group bind");
        assert_eq!(
            (cmd, d.len(), &d[14..]),
            (0x21, 23, &[5, 0, 0, 0, 0, 0, 0, 0, 0][..])
        );
        let (cmd, d) =
            zdo_request(0x0038, 0xFFFD, &[1, 0, 0, 0x80, 0, 0xFE, 7]).expect("channel change");
        assert_eq!(
            (cmd, d),
            (0x37, vec![0xFD, 0xFF, 0x0F, 0, 0, 0x80, 0, 0xFE, 0, 0, 0])
        );
        assert!(matches!(
            zdo_request(0x0038, 0, &[1, 0, 0, 0x80, 0, 0xFF, 7]),
            Err(ZsError::Unsupported(_))
        ));
        assert!(matches!(
            zdo_request(0x0001, 0x1234, &[1, 0x35, 0x12, 0, 0]),
            Err(ZsError::Invalid(_))
        ));
        assert!(matches!(
            zdo_request(0x0002, 0x1234, &[1, 0x34]),
            Err(ZsError::Invalid(_))
        ));
        assert!(matches!(
            zdo_request(0x0040, 0x1234, &[1]),
            Err(ZsError::Unsupported(_))
        ));
        assert!(matches!(
            zdo_request(0x0005, 0x1234, &[]),
            Err(ZsError::Invalid(_))
        ));
    }

    #[test]
    fn af_requests_stay_within_249_cobs_mux_data_bytes() {
        assert_eq!(
            af_request(1, 1, 1, 6, 0, 30, &[0; 239]).map(|d| d.len()),
            Ok(249)
        );
        assert!(matches!(
            af_request(1, 1, 1, 6, 0, 30, &[0; 240]),
            Err(ZsError::Invalid(_))
        ));
        assert_eq!(
            af_request_ext(3, 1, 1, 0, 1, 6, 30, &[0; 229]).map(|d| d.len()),
            Ok(249)
        );
        assert!(matches!(
            af_request_ext(3, 1, 1, 0, 1, 6, 30, &[0; 230]),
            Err(ZsError::Invalid(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn startup_fails_fast_on_the_bdb_formation_failure() {
        let (c, _events, mut peer) = session().await;
        let net = Network {
            pan_id: 0x1A62,
            extended_pan_id: 0xDDDD_DDDD_DDDD_DDDD,
            channels: vec![15],
            key: [0x11; 16],
            distribute: false,
        };
        let started = Instant::now();
        let script = async {
            let mut info = [0u8; 24];
            info[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
            peer.answer(ZDO, 0x50, &info).await;
            assert_eq!(peer.answer(ZDO, 0x40, &[0]).await, [100, 0]);
            peer.send(0, Frame::new(0x4F, 0x80, vec![8, 2, 0])).await;
        };
        let (r, ()) = tokio::join!(
            c.start_network(&net, started + Duration::from_secs(40)),
            script
        );
        assert_eq!(r, Err(ZsError::Rejected("network formation failed".into())));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn an_indication_burst_during_busy_backoff_keeps_the_session() {
        let (c, _events, mut peer) = session().await;
        c.registered.store(true, Ordering::Release);
        let unicast = Unicast {
            nwk: 0x1234,
            dst_endpoint: 1,
            src_endpoint: 1,
            cluster: 6,
            profile: 0x0104,
            radius: 0,
            aps_ack: false,
            payload: vec![0x01, 0x02, 0x00],
        };
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            peer.send(seq, Frame::new(0x64, 0x01, vec![0x11])).await;
            for _ in 0..200 {
                peer.send(0, Frame::new(AF_AREQ, 0x84, vec![0; 25])).await;
            }
            let (seq, retry) = peer.expect(AF, 0x01).await;
            assert_eq!(retry, d);
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            peer.send(0, confirm(0, 1, d[6], 0x1234, seq)).await;
        };
        let (r, ()) = tokio::join!(c.unicast(unicast, soon()), script);
        assert_eq!(r, Ok(()));
        // The link is still up: a later request is answered.
        let ieee_bytes = 0x0012_4B00_0000_0001u64.to_le_bytes();
        let (ieee, _) = tokio::join!(c.ieee(soon()), peer.answer(0x21, 0x04, &ieee_bytes));
        assert_eq!(ieee, Ok(0x0012_4B00_0000_0001));
    }

    fn on_off() -> Unicast {
        Unicast {
            nwk: 0x1234,
            dst_endpoint: 1,
            src_endpoint: 1,
            cluster: 6,
            profile: 0x0104,
            radius: 0,
            aps_ack: true,
            payload: vec![0x01, 0x02, 0x00],
        }
    }

    // A unicast whose SREQ succeeds but whose confirm never arrives; returns (MT seq, AF ID).
    async fn unconfirmed_unicast(c: &Coordinator, peer: &mut Peer) -> (u8, u8) {
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            (seq, d[6])
        };
        let (r, sent) = tokio::join!(
            c.unicast(on_off(), Instant::now() + Duration::from_secs(2)),
            script
        );
        assert!(matches!(r, Err(ZsError::Timeout(_))), "{r:?}");
        sent
    }

    // Whether every AF slot is free again within `within`.
    async fn slots_free_within(c: &Coordinator, within: Duration) -> bool {
        tokio::time::timeout(within, c.af.slots.acquire_many(AF_SLOTS as u32))
            .await
            .is_ok()
    }

    #[test]
    fn af_incoming_msg_ext_carries_its_nwk_or_ieee_source() {
        // group, cluster, mode, address(8), src ep, PAN, dst ep, broadcast, LQI, security,
        // timestamp(4), sequence, length(2), data
        let ext = |mode: u8, address: u64, dst_ep: u8, payload: &[u8]| {
            let mut d = vec![0, 0, 0x00, 0x10, mode];
            d.extend_from_slice(&address.to_le_bytes());
            d.extend_from_slice(&[1, 0x62, 0x1A, dst_ep, 0, 180, 0, 0, 0, 0, 0, 7]);
            d.extend_from_slice(&(payload.len() as u16).to_le_bytes());
            d.extend_from_slice(payload);
            Frame::new(AF_AREQ, 0x82, d)
        };
        let ieee = 0x0012_4B00_1234_5678u64;
        let payload = vec![0x5A; 300];
        let expected = |src_nwk, src_ieee, dst_endpoint, profile| {
            Some(Event::Aps(ApsFrame {
                src_nwk,
                src_ieee,
                src_endpoint: 1,
                dst_endpoint,
                cluster: 0x1000,
                profile,
                group: None,
                broadcast: false,
                lqi: Some(180),
                rssi: None,
                payload: payload.clone(),
            }))
        };
        assert_eq!(
            decode_event(&ext(2, 0x1234, 1, &payload), true),
            expected(0x1234, None, 1, 0x0104)
        );
        // inter-PAN: only the EUI64 source, delivered to the inter-PAN endpoint 12
        assert_eq!(
            decode_event(&ext(3, ieee, 12, &payload), true),
            expected(0xFFFE, Some(ieee), 12, 0xC05E)
        );
        // or with the Stub APS endpoint 0xFE, which no AF_REGISTER holds
        assert_eq!(
            decode_event(&ext(3, ieee, 0xFE, &payload), true),
            expected(0xFFFE, Some(ieee), 0xFE, 0xC05E)
        );
        let mut from_stub = ext(3, ieee, 1, &payload);
        from_stub.data[13] = 0xFE;
        let Some(Event::Aps(f)) = decode_event(&from_stub, true) else {
            panic!("an inter-PAN frame from endpoint 0xFE was dropped")
        };
        assert_eq!(
            (f.src_endpoint, f.dst_endpoint, f.profile),
            (0xFE, 1, 0xC05E)
        );
        assert_eq!(decode_event(&ext(3, ieee, 0xFE, &payload), false), None);
        assert_eq!(decode_event(&ext(2, 0x1234, 0xFD, &payload), true), None);
        assert_eq!(decode_event(&ext(2, 0x1234, 1, &payload), false), None);
        assert_eq!(decode_event(&ext(1, 5, 1, &payload), true), None);
        let mut short = ext(2, 0x1234, 1, &payload);
        short.data.pop();
        assert_eq!(decode_event(&short, true), None);
        let mut header_only = ext(2, 0x1234, 1, &[]);
        header_only.data.truncate(26);
        assert_eq!(decode_event(&header_only, true), None);
    }

    #[test]
    fn a_concentrator_indication_becomes_a_nwk_addr_rsp() {
        let ieee = 0x0012_4B00_1234_5678u64.to_le_bytes();
        let mut d = vec![0x34, 0x12];
        d.extend_from_slice(&ieee);
        d.push(3);
        let mut payload = vec![0, 0];
        payload.extend_from_slice(&ieee);
        payload.extend_from_slice(&[0x34, 0x12]);
        assert_eq!(
            decode_event(&Frame::new(ZDO_AREQ, 0xC8, d.clone()), false),
            Some(zdo_event(0x1234, 0x8000, false, payload))
        );
        d.pop();
        assert_eq!(decode_event(&Frame::new(ZDO_AREQ, 0xC8, d), false), None);
    }

    #[test]
    fn zdo_discovery_and_management_requests_map_to_their_mt_commands() {
        let ieee = 0x0012_4B00_1234_5678u64.to_le_bytes();
        let with = |head: &[u8], tail: &[u8]| [head, tail].concat();
        let nwk_addr = with(&ieee, &[0, 0]);
        assert_eq!(
            zdo_request(0x0000, 0xFFFD, &with(&[1], &nwk_addr)),
            Ok((0x00, nwk_addr))
        );
        assert_eq!(
            zdo_request(0x0002, 0x1234, &[1, 0x34, 0x12]),
            Ok((0x02, vec![0x34, 0x12, 0x34, 0x12]))
        );
        assert_eq!(
            zdo_request(0x0004, 0x1234, &[1, 0x34, 0x12, 8]),
            Ok((0x04, vec![0x34, 0x12, 0x34, 0x12, 8]))
        );
        // Match_Desc: NWK, profile, 1 input cluster (0x0019), 0 output clusters
        let match_desc = [0xFD, 0xFF, 0x04, 0x01, 1, 0x19, 0x00, 0];
        assert_eq!(
            zdo_request(0x0006, 0xFFFD, &with(&[1], &match_desc)),
            Ok((0x06, with(&[0xFD, 0xFF], &match_desc)))
        );
        for bad in [
            &match_desc[..7],
            &[0xFD][..],
            &[0xFD, 0xFF, 0x04, 0x01, 2, 0x19, 0x00, 0],
        ] {
            assert!(matches!(
                zdo_request(0x0006, 0xFFFD, &with(&[1], bad)),
                Err(ZsError::Invalid(_))
            ));
        }
        // 64-bit bind and unbind go through as they are
        let mut unicast_bind = ieee.to_vec();
        unicast_bind.extend_from_slice(&[1, 6, 0, 3]);
        unicast_bind.extend_from_slice(&0x0012_4B00_0000_0001u64.to_le_bytes());
        unicast_bind.push(1);
        for cluster in [0x0021u16, 0x0022] {
            assert_eq!(
                zdo_request(cluster, 0x1234, &with(&[1], &unicast_bind)),
                Ok((cluster as u8, with(&[0x34, 0x12], &unicast_bind)))
            );
        }
        let mut nwk_bind = ieee.to_vec();
        nwk_bind.extend_from_slice(&[1, 6, 0, 2, 0x78, 0x56]);
        assert!(matches!(
            zdo_request(0x0021, 0x1234, &with(&[1], &nwk_bind)),
            Err(ZsError::Invalid(_))
        ));
        assert_eq!(
            zdo_request(0x0030, 0x1234, &[1, 0, 0xF8, 0xFF, 0x07, 3, 0]),
            Ok((0x30, vec![0x34, 0x12, 0, 0xF8, 0xFF, 0x07, 3, 0]))
        );
        assert_eq!(
            zdo_request(0x0031, 0x1234, &[1, 2]),
            Ok((0x31, vec![0x34, 0x12, 2]))
        );
        assert_eq!(
            zdo_request(0x0036, 0xFFFC, &[1, 60, 1]),
            Ok((0x36, vec![0x0F, 0xFC, 0xFF, 60, 1]))
        );
        assert_eq!(
            zdo_request(0x0036, 0x1234, &[1, 0, 1]),
            Ok((0x36, vec![0x02, 0x34, 0x12, 0, 1]))
        );
        // energy scan: channel mask, duration 3, count 2
        assert_eq!(
            zdo_request(0x0038, 0x1234, &[1, 0, 0xF8, 0xFF, 0x07, 3, 2]),
            Ok((
                0x37,
                vec![0x34, 0x12, 0x02, 0, 0xF8, 0xFF, 0x07, 3, 2, 0, 0]
            ))
        );
        assert!(matches!(
            zdo_request(0x0038, 0x1234, &[1, 0, 0xF8, 0xFF, 0x07, 6, 2]),
            Err(ZsError::Invalid(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn af_ids_rest_after_use_and_all_256_busy_is_refused() {
        let pool = Arc::new(AfPool {
            slots: Arc::new(Semaphore::new(AF_SLOTS)),
            tids: Mutex::new((0, [TidState::Free; 256])),
            generation: watch::Sender::new(0),
        });
        let mut busy = Vec::new();
        for _ in 0..256 {
            busy.push(pool.tid(soon()).await.expect("a free ID"));
        }
        assert!(busy.iter().map(|t| t.id).eq(0..=255));
        assert!(matches!(
            pool.tid(soon()).await,
            Err(ZsError::Rejected(m)) if m.contains("all 256")
        ));
        let rested = Instant::now();
        drop(busy);
        // every ID rests: a deadline before the first rest ends fails at once
        assert!(matches!(
            pool.tid(rested + TID_REST - Duration::from_millis(1)).await,
            Err(ZsError::Timeout(_))
        ));
        assert_eq!(Instant::now(), rested);
        let next = pool.tid(rested + TID_REST).await.expect("a rested ID");
        assert_eq!((next.id, Instant::now()), (0, rested + TID_REST));
    }

    #[tokio::test(start_paused = true)]
    async fn a_timed_out_unicast_holds_its_slot_and_id_until_the_late_confirm_or_the_bound() {
        let (c, _events, mut peer) = session().await;
        c.registered.store(true, Ordering::Release);
        let (seq, held) = unconfirmed_unicast(&c, &mut peer).await;
        assert_eq!(c.af.slots.available_permits(), AF_SLOTS - 1);
        // the held ID is not reused by the next unicast
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            assert_ne!(d[6], held);
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            peer.send(0, confirm(0, 1, d[6], 0x1234, seq)).await;
        };
        let (r, ()) = tokio::join!(c.unicast(on_off(), soon()), script);
        assert_eq!(r, Ok(()));
        // a confirm for another MT sequence does not release it; its own late confirm does
        peer.send(0, confirm(0, 1, held, 0x1234, seq.wrapping_add(1)))
            .await;
        assert!(!slots_free_within(&c, Duration::from_secs(1)).await);
        peer.send(0, confirm(0, 1, held, 0x1234, seq)).await;
        assert!(slots_free_within(&c, Duration::from_secs(1)).await);

        // without a late confirm the slot is held for AF_HOLD, then released
        unconfirmed_unicast(&c, &mut peer).await;
        assert!(!slots_free_within(&c, AF_HOLD - Duration::from_secs(1)).await);
        assert!(slots_free_within(&c, Duration::from_secs(2)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn a_soft_reset_renegotiates_clears_registration_and_releases_held_slots() {
        let (c, _events, mut peer) = session().await;
        c.registered.store(true, Ordering::Release);
        unconfirmed_unicast(&c, &mut peer).await;
        assert_eq!(
            c.reset(ResetKind::Hard, soon()).await,
            Err(ZsError::Unsupported("hard reset".into()))
        );
        let (r, ()) = tokio::join!(c.reset(ResetKind::Soft, soon()), async {
            assert_eq!(peer.expect(0x41, 0x00).await.1, [1]);
            peer.cobs = false;
            peer.send(0, Frame::new(0x41, 0x80, vec![0x00, 2, 1, 2, 7, 1]))
                .await;
            peer.handshake().await;
        });
        assert_eq!(r, Ok(()));
        assert!(slots_free_within(&c, Duration::from_secs(1)).await);
        // endpoints are gone after a reset: nothing is sent until they are registered again
        assert!(matches!(
            c.unicast(on_off(), soon()).await,
            Err(ZsError::Invalid(_))
        ));
        let ieee = 0x0012_4B00_0000_0001u64;
        let ieee_bytes = ieee.to_le_bytes();
        let (r, _) = tokio::join!(c.ieee(soon()), peer.answer(SYS, 0x04, &ieee_bytes));
        assert_eq!(r, Ok(ieee));
    }

    #[tokio::test(start_paused = true)]
    async fn a_coordinator_that_does_not_come_back_from_a_reset_ends_the_session() {
        let (c, mut events, mut peer) = session().await;
        let (r, _) = tokio::join!(
            c.reset(ResetKind::Soft, Instant::now() + Duration::from_secs(1)),
            peer.expect(0x41, 0x00)
        );
        assert!(matches!(r, Err(ZsError::Timeout(_))), "{r:?}");
        assert!(matches!(
            events.recv().await,
            Some(Event::Disconnected { reason }) if reason.contains("did not come back")
        ));
        assert!(matches!(c.ieee(soon()).await, Err(ZsError::Transport(_))));
    }

    #[tokio::test(start_paused = true)]
    async fn inter_pan_uses_endpoint_12_and_af_inter_pan_ctl() {
        let (c, _events, mut peer) = session().await;
        let (r, ()) = tokio::join!(c.interpan_channel(Some(15), soon()), async {
            assert_eq!(peer.answer(AF, 0x10, &[0]).await, [2, 12]);
            assert_eq!(peer.answer(AF, 0x10, &[0]).await, [1, 15]);
        });
        assert_eq!(r, Ok(()));
        assert!(matches!(
            c.interpan_channel(Some(27), soon()).await,
            Err(ZsError::Invalid(_))
        ));
        // the refused channel sent nothing: the next request is the first the peer sees
        let (r, d) = tokio::join!(
            c.interpan_channel(None, soon()),
            peer.answer(AF, 0x10, &[0])
        );
        assert_eq!((r, d), (Ok(()), vec![0]));
        let (r, _) = tokio::join!(
            c.interpan_channel(None, soon()),
            peer.answer(AF, 0x10, &[1])
        );
        assert!(matches!(r, Err(ZsError::Rejected(_))));

        let ieee = 0x0012_4B00_1234_5678u64;
        let scan = [0x11, 0x01, 0x00];
        for (target, mode, address) in [(Some(ieee), 3, ieee), (None, 2, 0xFFFF)] {
            let script = async {
                let (seq, d) = peer.expect(AF, 0x02).await;
                let mut want = vec![mode];
                want.extend_from_slice(&address.to_le_bytes());
                want.extend_from_slice(&[0xFE, 0xFF, 0xFF, 12, 0x00, 0x10, d[15], 0, 30, 3, 0]);
                want.extend_from_slice(&scan);
                assert_eq!(d, want);
                peer.send(seq, Frame::new(0x64, 0x02, vec![0])).await;
                peer.send(0, Frame::new(AF_AREQ, 0x80, vec![0, 12, d[15]]))
                    .await;
            };
            let (r, ()) = tokio::join!(c.interpan_send(target, &scan, soon()), script);
            assert_eq!(r, Ok(()));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_unicast_permit_join_waits_for_the_targets_response() {
        let (c, _events, mut peer) = session().await;
        let (r, d) = tokio::join!(
            c.permit_join(60, None, soon()),
            peer.answer(ZDO, 0x36, &[0])
        );
        assert_eq!((r, d), (Ok(()), vec![0x0F, 0xFC, 0xFF, 60, 1]));
        // ZDO_MSG_CB_INCOMING Mgmt_Permit_Joining_rsp: src, broadcast, cluster, security, seq, MAC dst, status
        let rsp = |src: u16, status: u8| {
            let [lo, hi] = src.to_le_bytes();
            Frame::new(
                ZDO_AREQ,
                0xFF,
                vec![lo, hi, 0, 0x36, 0x80, 0, 9, 0, 0, status],
            )
        };
        let script = async {
            assert_eq!(
                peer.answer(ZDO, 0x36, &[0]).await,
                [0x02, 0x34, 0x12, 30, 1]
            );
            peer.send(0, rsp(0x9999, 0x8C)).await;
            peer.send(0, rsp(0x1234, 0)).await;
        };
        let (r, ()) = tokio::join!(c.permit_join(30, Some(0x1234), soon()), script);
        assert_eq!(r, Ok(()));
        let script = async {
            peer.answer(ZDO, 0x36, &[0]).await;
            peer.send(0, Frame::new(ZDO_AREQ, 0xB6, vec![0x34, 0x12, 0x8C]))
                .await;
        };
        let (r, ()) = tokio::join!(c.permit_join(30, Some(0x1234), soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("0x8c")));
        let (r, _) = tokio::join!(
            c.permit_join(30, Some(0x1234), soon()),
            peer.answer(ZDO, 0x36, &[0xCD])
        );
        assert_eq!(r, Err(ZsError::Delivery(0xCD)));
    }

    #[tokio::test(start_paused = true)]
    async fn install_codes_are_sent_in_their_mt_format() {
        let (c, _events, mut peer) = session().await;
        let ieee = 0x0012_4B00_1234_5678u64;
        let code: Vec<u8> = (0..18).collect();
        let mut want = vec![1];
        want.extend_from_slice(&ieee.to_le_bytes());
        want.extend_from_slice(&code);
        let (r, d) = tokio::join!(
            c.add_install_code(ieee, &code, false, soon()),
            peer.answer(APP_CNF, 0x04, &[0])
        );
        assert_eq!((r, d), (Ok(()), want));
        assert!(matches!(
            c.add_install_code(ieee, &code[..16], false, soon()).await,
            Err(ZsError::Invalid(_))
        ));
        let (r, d) = tokio::join!(
            c.add_install_code(ieee, &code[..16], true, soon()),
            peer.answer(APP_CNF, 0x04, &[1])
        );
        assert!(matches!(r, Err(ZsError::Rejected(_))));
        assert_eq!((d[0], &d[9..]), (2, &code[..16]));
    }

    fn requested() -> Network {
        Network {
            pan_id: 0x1A62,
            extended_pan_id: 0xDDDD_DDDD_DDDD_DDDD,
            channels: vec![15],
            key: [0x11; 16],
            distribute: false,
        }
    }

    // ZDO_EXT_NWK_INFO answer: NWK, state, PAN, parent, extended PAN at 7, channel at 23.
    fn ext_nwk_info(state: u8, pan: u16, ext: u64) -> Vec<u8> {
        let mut d = vec![0u8; 24];
        d[2] = state;
        d[3..5].copy_from_slice(&pan.to_le_bytes());
        d[7..15].copy_from_slice(&ext.to_le_bytes());
        d[23] = 15;
        d
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_answers_fail_their_request_and_keep_the_session() {
        let (c, _events, mut peer) = session().await;
        let rejected = |r: Result<(), ZsError>, what: &str| {
            assert!(
                matches!(&r, Err(ZsError::Rejected(m)) if m.contains(what)),
                "{what}: {r:?}"
            );
        };
        let (r, _) = tokio::join!(c.nwk_info(soon()), peer.answer(ZDO, 0x50, &[0; 23]));
        rejected(r.map(drop), "ZDO_EXT_NWK_INFO answer of 23 bytes");
        let (r, _) = tokio::join!(c.ieee(soon()), peer.answer(SYS, 0x04, &[0; 7]));
        rejected(r.map(drop), "not 8 bytes");
        let (r, _) = tokio::join!(
            c.coordinator_version(soon()),
            peer.answer(SYS, 0x02, &[2, 1])
        );
        rejected(r.map(drop), "shorter than 5 bytes");
        let (r, _) = tokio::join!(
            c.coordinator_version(soon()),
            peer.answer(SYS, 0x02, &[2, 9, 0, 0, 0])
        );
        rejected(r.map(drop), "unknown SYS_VERSION product 9");
        let (r, _) = tokio::join!(
            c.nv_read(0x0021, soon()),
            peer.answer(SYS, 0x13, &[2, 0, 0])
        );
        rejected(r.map(drop), "NV_LENGTH answer is not 2 bytes");
        // SYS_OSAL_NV_READ_EXT: a failed status, an empty chunk, more than announced
        for (read, what) in [
            (&[1, 2, 7, 7][..], "read failed"),
            (&[0, 0][..], "read failed"),
            (&[0, 3, 7, 7, 7][..], "longer than announced"),
        ] {
            let script = async {
                peer.answer(SYS, 0x13, &[2, 0]).await;
                assert_eq!(peer.answer(SYS, 0x1C, read).await, [0x21, 0, 0, 0]);
            };
            let (r, ()) = tokio::join!(c.nv_read(0x0021, soon()), script);
            rejected(r.map(drop), what);
        }
        // AF_DATA_CONFIRM of neither 3 nor 10 bytes
        c.registered.store(true, Ordering::Release);
        let script = async {
            let (seq, d) = peer.expect(AF, 0x01).await;
            peer.send(seq, Frame::new(0x64, 0x01, vec![0])).await;
            peer.send(0, Frame::new(AF_AREQ, 0x80, vec![0, 1, d[6], 0, 0]))
                .await;
        };
        let (r, ()) = tokio::join!(c.unicast(on_off(), soon()), script);
        rejected(r, "AF_DATA_CONFIRM of 5 bytes");
        let (r, _) = tokio::join!(
            c.ieee(soon()),
            peer.answer(SYS, 0x04, &[1, 0, 0, 0, 0, 0, 0, 0])
        );
        assert_eq!(r, Ok(1));
    }

    #[tokio::test(start_paused = true)]
    async fn start_refuses_invalid_requests_before_any_io() {
        let (c, _events, mut peer) = session().await;
        let with = |change: fn(&mut Network)| {
            let mut net = requested();
            change(&mut net);
            net
        };
        for net in [
            with(|n| n.channels.clear()),
            with(|n| n.channels = vec![15, 27]),
            with(|n| n.pan_id = 0xFFFF),
            with(|n| n.extended_pan_id = 0),
            with(|n| n.extended_pan_id = u64::MAX),
        ] {
            assert!(matches!(
                c.start(&net, None, soon()).await,
                Err(ZsError::Invalid(_))
            ));
        }
        let (r, _) = tokio::join!(
            c.ieee(soon()),
            peer.answer(SYS, 0x04, &[1, 0, 0, 0, 0, 0, 0, 0])
        );
        assert_eq!(r, Ok(1));
    }

    #[tokio::test(start_paused = true)]
    async fn starting_refuses_odd_states_another_network_and_a_stuck_endpoint() {
        let (c, _events, mut peer) = session().await;
        let net = requested();
        let joining = ext_nwk_info(1, 0x1A62, net.extended_pan_id);
        let (r, _) = tokio::join!(
            c.start_network(&net, soon()),
            peer.answer(ZDO, 0x50, &joining)
        );
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("device state 1")));
        let other = ext_nwk_info(9, 0x1A63, net.extended_pan_id);
        let script = async {
            peer.answer(ZDO, 0x50, &other).await;
            peer.answer(ZDO, 0x50, &other).await;
        };
        let (r, ()) = tokio::join!(c.start_network(&net, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("differs from the requested")));
        let running = ext_nwk_info(9, 0x1A62, net.extended_pan_id);
        let script = async {
            peer.answer(ZDO, 0x50, &running).await;
            peer.answer(ZDO, 0x50, &running).await;
            assert_eq!(peer.answer(AF, 0x00, &[0xB8]).await[0], 1);
            assert_eq!(peer.answer(AF, 0x04, &[1]).await, [1]);
        };
        let (r, ()) = tokio::join!(c.start_network(&net, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("endpoint 1 kept")));
        assert!(!c.registered.load(Ordering::Acquire));
    }
}
