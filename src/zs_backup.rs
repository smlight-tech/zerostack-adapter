// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tokio::time::Instant;

use crate::cobs_link::{ZsError, crc32};
use crate::zs_protocol::{Coordinator, Network, SYS};

// Op and index take 3 of the 249 COBS-Mux data bytes.
const CHUNK_BODY: usize = 246;
const COUNTER_MARGIN: u32 = 2500;
const ABORT_BOUND: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkKey {
    pub key: [u8; 16],
    pub rx_counter: u32,
    pub tx_counter: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub nwk: Option<u16>,
    pub ieee: u64,
    pub direct_child: bool,
    pub link_key: Option<LinkKey>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backup {
    pub network: Network,
    pub channel: u8,
    pub key_sequence: u8,
    pub frame_counter: u32,
    pub security_level: u8,
    pub nwk_update_id: u8,
    pub coordinator_ieee: u64,
    pub devices: Vec<Device>,
    pub tclk_seed: Option<[u8; 16]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKey {
    None,
    Derived(u8),
    Explicit([u8; 16]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub ieee: u64,
    pub nwk: u16,
    pub relationship: u8,
    pub key_state: u8,
    pub caps: u8,
    pub aps_rx: u32,
    pub nwk_rx: u32,
    pub key: NodeKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    Header {
        capacity: u16,
        count: u16,
        ieee: u64,
        revision: u32,
    },
    Nib {
        pan_id: u16,
        ext: u64,
        channel: u8,
        update_id: u8,
        nwk: u16,
        level: u8,
        channels: u32,
    },
    NwkKey {
        seq: u8,
        key: [u8; 16],
        alt: Option<(u8, [u8; 16])>,
    },
    Counters {
        nwk: u32,
        aps: u32,
    },
    TclkSeed([u8; 16]),
    Node(Node),
}

fn key16(b: &[u8]) -> [u8; 16] {
    let mut k = [0u8; 16];
    k.copy_from_slice(&b[..16]);
    k
}

fn le_u16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}

fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn le_u64(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_le_bytes(a)
}

impl Record {
    pub fn encode(&self, out: &mut Vec<u8>) {
        let mut v = Vec::with_capacity(36);
        let kind = match self {
            Self::Header {
                capacity,
                count,
                ieee,
                revision,
            } => {
                v.push(1);
                v.extend_from_slice(&capacity.to_le_bytes());
                v.extend_from_slice(&count.to_le_bytes());
                v.extend_from_slice(&ieee.to_le_bytes());
                v.extend_from_slice(&revision.to_le_bytes());
                0x01
            }
            Self::Nib {
                pan_id,
                ext,
                channel,
                update_id,
                nwk,
                level,
                channels,
            } => {
                v.extend_from_slice(&pan_id.to_le_bytes());
                v.extend_from_slice(&ext.to_le_bytes());
                v.extend_from_slice(&[*channel, *update_id]);
                v.extend_from_slice(&nwk.to_le_bytes());
                v.push(*level);
                v.extend_from_slice(&channels.to_le_bytes());
                0x02
            }
            Self::NwkKey { seq, key, alt } => {
                v.push(*seq);
                v.extend_from_slice(key);
                match alt {
                    Some((s, k)) => {
                        v.push(*s);
                        v.extend_from_slice(k);
                    }
                    None => v.push(0xFF),
                }
                0x03
            }
            Self::Counters { nwk, aps } => {
                v.extend_from_slice(&nwk.to_le_bytes());
                v.extend_from_slice(&aps.to_le_bytes());
                0x04
            }
            Self::TclkSeed(seed) => {
                v.extend_from_slice(seed);
                0x05
            }
            Self::Node(n) => {
                let flag = match n.key {
                    NodeKey::None => 0,
                    NodeKey::Explicit(_) => 0x40,
                    NodeKey::Derived(_) => 0x80,
                };
                v.extend_from_slice(&n.ieee.to_le_bytes());
                v.extend_from_slice(&n.nwk.to_le_bytes());
                v.extend_from_slice(&[flag | (n.key_state << 3) | n.relationship, n.caps]);
                v.extend_from_slice(&n.aps_rx.to_le_bytes());
                v.extend_from_slice(&n.nwk_rx.to_le_bytes());
                match n.key {
                    NodeKey::None => {}
                    NodeKey::Derived(shift) => v.push(shift),
                    NodeKey::Explicit(k) => v.extend_from_slice(&k),
                }
                0x10
            }
        };
        out.extend_from_slice(&[kind, v.len() as u8]);
        out.extend_from_slice(&v);
    }

    fn decode(kind: u8, v: &[u8]) -> Result<Self, ZsError> {
        let bad = || {
            ZsError::Rejected(format!(
                "malformed backup record 0x{kind:02x} of {} bytes",
                v.len()
            ))
        };
        Ok(match (kind, v.len()) {
            (0x01, 17) if v[0] == 1 => Self::Header {
                capacity: le_u16(&v[1..]),
                count: le_u16(&v[3..]),
                ieee: le_u64(&v[5..]),
                revision: le_u32(&v[13..]),
            },
            (0x02, 19) => Self::Nib {
                pan_id: le_u16(v),
                ext: le_u64(&v[2..]),
                channel: v[10],
                update_id: v[11],
                nwk: le_u16(&v[12..]),
                level: v[14],
                channels: le_u32(&v[15..]),
            },
            (0x03, 18) if v[17] == 0xFF => Self::NwkKey {
                seq: v[0],
                key: key16(&v[1..]),
                alt: None,
            },
            (0x03, 34) if v[17] != 0xFF => Self::NwkKey {
                seq: v[0],
                key: key16(&v[1..]),
                alt: Some((v[17], key16(&v[18..]))),
            },
            (0x04, 8) => Self::Counters {
                nwk: le_u32(v),
                aps: le_u32(&v[4..]),
            },
            (0x05, 16) => Self::TclkSeed(key16(v)),
            (0x10, 20..) => {
                let flags = v[10];
                let key = match (flags & 0xC0, v.len()) {
                    (0, 20) => NodeKey::None,
                    (0x80, 21) if v[20] < 16 => NodeKey::Derived(v[20]),
                    (0x40, 36) => NodeKey::Explicit(key16(&v[20..])),
                    _ => return Err(bad()),
                };
                let (relationship, key_state) = (flags & 0x07, (flags >> 3) & 0x07);
                if relationship > 5 || key_state > 4 {
                    return Err(bad());
                }
                Self::Node(Node {
                    ieee: le_u64(v),
                    nwk: le_u16(&v[8..]),
                    relationship,
                    key_state,
                    caps: v[11],
                    aps_rx: le_u32(&v[12..]),
                    nwk_rx: le_u32(&v[16..]),
                    key,
                })
            }
            _ => return Err(bad()),
        })
    }
}

pub fn decode_records(mut bytes: &[u8]) -> Result<Vec<Record>, ZsError> {
    let mut out = Vec::new();
    while let [kind, len, rest @ ..] = bytes {
        let len = usize::from(*len);
        let value = rest
            .get(..len)
            .ok_or_else(|| ZsError::Rejected("truncated backup record".into()))?;
        out.push(Record::decode(*kind, value)?);
        bytes = &rest[len..];
    }
    if !bytes.is_empty() {
        return Err(ZsError::Rejected(
            "trailing byte after backup records".into(),
        ));
    }
    Ok(out)
}

// Z-Stack TCLK derivation: seed rotated by `shift`, XOR the IEEE address.
pub fn derive_key(seed: &[u8; 16], ieee: u64, shift: u8) -> [u8; 16] {
    let ieee = ieee.to_le_bytes();
    std::array::from_fn(|i| seed[(i + usize::from(shift)) % 16] ^ ieee[i % 8])
}

fn node_key(seed: Option<&[u8; 16]>, ieee: u64, key: &[u8; 16]) -> NodeKey {
    seed.and_then(|s| (0..16).find(|&shift| derive_key(s, ieee, shift) == *key))
        .map_or(NodeKey::Explicit(*key), NodeKey::Derived)
}

// Drops the coordinator's own entry; 0x0000 and 0xFFF8..=0xFFFF (Z-Stack's 0xFFFE, herdsman's
// NULL_NODE_ID 0xFFFF) mark a device without an address.
pub fn normalize(b: &Backup) -> Backup {
    let mut out = b.clone();
    out.devices.retain(|d| d.ieee != b.coordinator_ieee);
    for d in &mut out.devices {
        if matches!(d.nwk, Some(0x0000 | 0xFFF8..=0xFFFF)) {
            d.nwk = None;
        }
    }
    out
}

pub fn validate(b: &Backup) -> Result<(), ZsError> {
    let bad = |m: String| Err(ZsError::Invalid(m));
    let reserved = |v: u64| v == 0 || v == u64::MAX;
    if reserved(b.coordinator_ieee)
        || reserved(b.network.extended_pan_id)
        || b.network.pan_id == 0xFFFF
    {
        return bad("backup coordinator IEEE, extended PAN ID or PAN ID is reserved".into());
    }
    if !(11..=26).contains(&b.channel) || b.security_level > 7 {
        return bad(format!(
            "backup channel {} or security level {}",
            b.channel, b.security_level
        ));
    }
    let list: HashSet<u8> = b.network.channels.iter().copied().collect();
    if list.len() != b.network.channels.len()
        || list.iter().any(|c| !(11..=26).contains(c))
        || !list.contains(&b.channel)
    {
        return bad(
            "backup channelList must hold distinct channels 11..26 including the channel".into(),
        );
    }
    if b.devices.len() > 1000 {
        return bad("backup holds more than 1000 devices".into());
    }
    let mut seen = HashSet::new();
    for d in &b.devices {
        if reserved(d.ieee) || d.ieee == b.coordinator_ieee || !seen.insert(d.ieee) {
            return bad(format!(
                "backup device 0x{:016x} is reserved or repeated",
                d.ieee
            ));
        }
        if d.nwk.is_some_and(|n| n == 0 || n >= 0xFFF8) {
            return bad(format!(
                "backup device 0x{:016x} has a reserved address",
                d.ieee
            ));
        }
    }
    Ok(())
}

// Export records to a backup; networkKeyDistribute is filled in by the caller.
pub fn to_backup(records: &[Record]) -> Result<Backup, ZsError> {
    let missing = |what: &str| ZsError::Rejected(format!("backup export lacks its {what} record"));
    let (mut header, mut nib, mut key, mut counters, mut seed) = (None, None, None, None, None);
    let mut nodes = Vec::new();
    for r in records {
        match r {
            Record::Header { ieee, .. } => header = Some(*ieee),
            Record::Nib { .. } => nib = Some(r),
            Record::NwkKey { seq, key: k, .. } => key = Some((*seq, *k)),
            Record::Counters { nwk, aps } => counters = Some((*nwk, *aps)),
            Record::TclkSeed(s) => seed = (*s != [0; 16]).then_some(*s),
            Record::Node(n) => nodes.push(n),
        }
    }
    let ieee = header.ok_or_else(|| missing("HEADER"))?;
    let Some(&Record::Nib {
        pan_id,
        ext,
        channel,
        update_id,
        nwk,
        level,
        channels: _,
    }) = nib
    else {
        return Err(missing("NIB"));
    };
    if nwk != 0 {
        return Err(ZsError::Rejected(
            "radio is not its network's coordinator".into(),
        ));
    }
    let (key_sequence, network_key) = key.ok_or_else(|| missing("NWK_KEY"))?;
    let (frame_counter, aps_tx) = counters.ok_or_else(|| missing("COUNTERS"))?;
    let devices = nodes
        .into_iter()
        .map(|n| {
            let key = match (n.key, seed.as_ref()) {
                (NodeKey::None, _) => None,
                (NodeKey::Explicit(k), _) => Some(k),
                (NodeKey::Derived(shift), Some(s)) if n.key_state != 0 => {
                    Some(derive_key(s, n.ieee, shift))
                }
                (NodeKey::Derived(_), _) => {
                    return Err(ZsError::Rejected(format!(
                        "node 0x{:016x} has a derived key without seed or key state",
                        n.ieee
                    )));
                }
            };
            let nwk = (n.nwk != 0 && n.nwk < 0xFFF8).then_some(n.nwk);
            Ok(Device {
                nwk,
                ieee: n.ieee,
                // An unaddressed direct child is restored as a previous child (4); one with an
                // address left this coordinator.
                direct_child: n.relationship == 1 || (n.relationship == 4 && nwk.is_none()),
                link_key: key.map(|key| LinkKey {
                    key,
                    rx_counter: n.aps_rx,
                    tx_counter: aps_tx,
                }),
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(Backup {
        network: Network {
            pan_id,
            extended_pan_id: ext,
            // herdsman configures one channel; the NIB mask may hold all 16 or predate a channel change
            channels: vec![channel],
            key: network_key,
            distribute: false,
        },
        channel,
        key_sequence,
        frame_counter,
        security_level: level,
        nwk_update_id: update_id,
        coordinator_ieee: ieee,
        devices,
        tclk_seed: seed,
    })
}

// Restore records for `b` and the backup expected on readback.
pub fn plan_restore(b: &Backup, nodes: u16) -> (Vec<Record>, Backup) {
    let mut last: HashMap<u16, usize> = HashMap::new();
    for (i, d) in b.devices.iter().enumerate() {
        if let Some(n) = d.nwk {
            last.insert(n, i);
        }
    }
    let mut expected = b.clone();
    for (i, d) in expected.devices.iter_mut().enumerate() {
        if d.nwk.is_some_and(|n| last[&n] != i) {
            d.nwk = None;
        }
    }
    let count = expected.devices.len() as u16;
    let aps = expected
        .devices
        .iter()
        .filter_map(|d| d.link_key.as_ref())
        .map(|k| k.tx_counter.saturating_add(COUNTER_MARGIN))
        .max();
    let mut records = vec![
        Record::Header {
            capacity: nodes.max(count),
            count,
            ieee: b.coordinator_ieee,
            revision: 0,
        },
        Record::Nib {
            pan_id: b.network.pan_id,
            ext: b.network.extended_pan_id,
            channel: b.channel,
            update_id: b.nwk_update_id,
            nwk: 0,
            level: b.security_level,
            channels: b.network.channels.iter().fold(0, |m, c| m | (1 << c)),
        },
        Record::NwkKey {
            seq: b.key_sequence,
            key: b.network.key,
            alt: None,
        },
        Record::Counters {
            nwk: b.frame_counter.saturating_add(COUNTER_MARGIN),
            aps: aps.unwrap_or(0),
        },
    ];
    records.extend(b.tclk_seed.map(Record::TclkSeed));
    for (d, original) in expected.devices.iter().zip(&b.devices) {
        // As zerostack's AddrMgr import: a non-child is no neighbor until its Link Status is
        // heard, which also sets its router capabilities.
        let relationship = match (d.nwk, original.direct_child) {
            (Some(_), true) => 1,
            (None, true) => 4,
            _ => 3,
        };
        let (key_state, aps_rx, key) = match &d.link_key {
            Some(k) => (
                3,
                k.rx_counter,
                node_key(b.tclk_seed.as_ref(), d.ieee, &k.key),
            ),
            None => (0, 0, NodeKey::None),
        };
        records.push(Record::Node(Node {
            ieee: d.ieee,
            nwk: d.nwk.unwrap_or(0xFFFE),
            relationship,
            key_state,
            caps: 0,
            aps_rx,
            nwk_rx: 0,
            key,
        }));
    }
    (records, expected)
}

pub fn compare(expected: &Backup, got: &Backup) -> Result<(), ZsError> {
    let same_network = got.coordinator_ieee == expected.coordinator_ieee
        && got.network.pan_id == expected.network.pan_id
        && got.network.extended_pan_id == expected.network.extended_pan_id
        && got.network.key == expected.network.key
        && got.channel == expected.channel
        && got.nwk_update_id == expected.nwk_update_id
        && got.key_sequence == expected.key_sequence
        && got.frame_counter >= expected.frame_counter
        && got.tclk_seed == expected.tclk_seed
        && got.devices.len() == expected.devices.len();
    let by_ieee: HashMap<u64, &Device> = got.devices.iter().map(|d| (d.ieee, d)).collect();
    let same_devices = expected.devices.iter().all(|e| {
        by_ieee.get(&e.ieee).is_some_and(|g| {
            g.direct_child == e.direct_child
                && g.nwk == e.nwk
                && match (&g.link_key, &e.link_key) {
                    (None, None) => true,
                    (Some(g), Some(e)) => {
                        g.key == e.key
                            && g.rx_counter >= e.rx_counter
                            && g.tx_counter >= e.tx_counter
                    }
                    _ => false,
                }
        })
    });
    if same_network && same_devices {
        Ok(())
    } else {
        Err(ZsError::Rejected(
            "restored coordinator readback differs from the backup".into(),
        ))
    }
}

pub async fn export(c: &Coordinator, deadline: Instant) -> Result<Vec<Record>, ZsError> {
    'restart: loop {
        if Instant::now() >= deadline {
            return Err(ZsError::Timeout("a consistent backup export".into()));
        }
        let (mut cursor, mut generation, mut records) = (0u16, 0u16, Vec::new());
        loop {
            let [c0, c1] = cursor.to_le_bytes();
            let [g0, g1] = generation.to_le_bytes();
            let d = c.sreq(SYS, 0x70, vec![c0, c1, g0, g1], deadline).await?;
            if d.len() < 5 {
                return Err(ZsError::Rejected(
                    "SYS_ZS_BACKUP_EXPORT answer shorter than 5 bytes".into(),
                ));
            }
            match d[0] {
                0 => {}
                0xB0 => continue 'restart,
                0x09 => {
                    return Err(ZsError::Rejected(
                        "the coordinator holds no network to export".into(),
                    ));
                }
                s => {
                    return Err(ZsError::Rejected(format!(
                        "SYS_ZS_BACKUP_EXPORT status 0x{s:02x}"
                    )));
                }
            }
            if cursor == 0 {
                generation = le_u16(&d[1..]);
            }
            records.extend(decode_records(&d[5..])?);
            let next = le_u16(&d[3..]);
            if next == 0xFFFF {
                return Ok(records);
            }
            if next <= cursor {
                return Err(ZsError::Rejected(
                    "SYS_ZS_BACKUP_EXPORT cursor did not advance".into(),
                ));
            }
            cursor = next;
        }
    }
}

pub async fn backup(c: &Coordinator, deadline: Instant) -> Result<Backup, ZsError> {
    let info = c.nwk_info(deadline).await?;
    let ieee = c.ieee(deadline).await?;
    let mut b = to_backup(&export(c, deadline).await?)?;
    validate(&b).map_err(|e| ZsError::Rejected(e.to_string()))?;
    if (
        b.coordinator_ieee,
        b.network.extended_pan_id,
        b.network.pan_id,
    ) != (ieee, info.extended_pan_id, info.pan_id)
    {
        return Err(ZsError::Rejected(
            "coordinator identity changed during the backup".into(),
        ));
    }
    b.network.distribute = match c.nv_read(0x0063, deadline).await?.as_slice() {
        [v] => *v == 1,
        other => {
            return Err(ZsError::Rejected(format!(
                "ZCD_NV_PRECFGKEYS_ENABLE of {} bytes",
                other.len()
            )));
        }
    };
    Ok(b)
}

fn import_status(d: &[u8], op: u8) -> Result<u16, ZsError> {
    match d {
        [0, o, lo, hi] if *o == op => Ok(u16::from_le_bytes([*lo, *hi])),
        _ => Err(ZsError::Rejected(format!(
            "SYS_ZS_BACKUP_IMPORT op {op} answered {d:02x?}"
        ))),
    }
}

pub async fn import(
    c: &Coordinator,
    records: &[Record],
    node_count: u16,
    deadline: Instant,
) -> Result<(), ZsError> {
    let mut chunks: Vec<(Vec<u8>, u16)> = Vec::new();
    for r in records {
        let mut bytes = Vec::new();
        r.encode(&mut bytes);
        match chunks.last_mut() {
            Some((body, n)) if body.len() + bytes.len() <= CHUNK_BODY => {
                body.extend_from_slice(&bytes);
                *n += 1;
            }
            _ => chunks.push((bytes, 1)),
        }
    }
    let total: usize = chunks.iter().map(|(b, _)| b.len()).sum();
    let mut start = vec![0, 1];
    start.extend_from_slice(&node_count.to_le_bytes());
    start.extend_from_slice(&(total as u32).to_le_bytes());
    import_status(&c.sreq(SYS, 0x71, start, deadline).await?, 0)?;
    let outcome = async {
        let mut all = Vec::with_capacity(total);
        for (i, (body, n)) in chunks.iter().enumerate() {
            let mut d = vec![1];
            d.extend_from_slice(&(i as u16).to_le_bytes());
            d.extend_from_slice(body);
            let accepted = import_status(&c.sreq(SYS, 0x71, d, deadline).await?, 1)?;
            if accepted != *n {
                return Err(ZsError::Rejected(format!(
                    "import chunk {i} accepted {accepted} of {n} records"
                )));
            }
            all.extend_from_slice(body);
        }
        let mut ind = c.link().subscribe();
        let mut commit = vec![2];
        commit.extend_from_slice(&crc32(&all).to_le_bytes());
        if import_status(&c.sreq(SYS, 0x71, commit, deadline).await?, 2)? == 0 {
            return Ok(());
        }
        loop {
            let f = ind.next(deadline, "the backup import completion").await?;
            match (f.cmd0, f.cmd1, f.data.as_slice()) {
                (0x41, 0x71, [2, 0, ..]) => return Ok(()),
                (0x41, 0x71, [2, s, ..]) => {
                    return Err(ZsError::Rejected(format!(
                        "backup import failed with status 0x{s:02x}"
                    )));
                }
                _ => {}
            }
        }
    }
    .await;
    if let Err(e) = &outcome {
        // The caller's deadline may be spent; the abort gets its own response bound.
        match c
            .sreq(SYS, 0x71, vec![3], Instant::now() + ABORT_BOUND)
            .await
        {
            Ok(d) => tracing::warn!("import failed ({e}); abort answered {d:02x?}"),
            Err(abort) => tracing::warn!("import failed ({e}); abort failed: {abort}"),
        }
    }
    outcome
}

async fn require_hold(c: &Coordinator, deadline: Instant) -> Result<(), ZsError> {
    match c.nwk_info(deadline).await?.state {
        0 => Ok(()),
        s => Err(ZsError::Rejected(format!(
            "coordinator in device state {s}, not DEV_HOLD, after reset"
        ))),
    }
}

pub async fn restore(c: &Coordinator, b: &Backup, deadline: Instant) -> Result<(), ZsError> {
    let (records, expected) = plan_restore(b, c.handshake()?.caps.nodes);
    c.renegotiate(deadline).await?;
    require_hold(c, deadline).await?;
    import(c, &records, expected.devices.len() as u16, deadline).await?;
    c.renegotiate(deadline).await?;
    compare(&expected, &to_backup(&export(c, deadline).await?)?)
}

async fn nv_byte(c: &Coordinator, item: u16, name: &str, deadline: Instant) -> Result<u8, ZsError> {
    match c.nv_read(item, deadline).await?.as_slice() {
        [v] => Ok(*v),
        other => Err(ZsError::Rejected(format!(
            "{name} of {} bytes",
            other.len()
        ))),
    }
}

pub async fn form(c: &Coordinator, net: &Network, deadline: Instant) -> Result<(), ZsError> {
    let ieee = c.ieee(deadline).await?;
    let startup = nv_byte(c, 0x0003, "ZCD_NV_STARTUP_OPTION", deadline).await?;
    if startup & 0x02 != 0 {
        return Err(ZsError::Rejected(
            "ZCD_NV_STARTUP_OPTION has the clear-state bit set; the next start would replace an imported network".into(),
        ));
    }
    let logical = nv_byte(c, 0x0087, "ZCD_NV_LOGICAL_TYPE", deadline).await?;
    if logical != 0 {
        return Err(ZsError::Rejected(format!(
            "ZCD_NV_LOGICAL_TYPE {logical} is not coordinator"
        )));
    }
    c.renegotiate(deadline).await?;
    require_hold(c, deadline).await?;
    let channel = net.channels[0];
    let records = [
        Record::Header {
            capacity: c.handshake()?.caps.nodes,
            count: 0,
            ieee,
            revision: 0,
        },
        Record::Nib {
            pan_id: net.pan_id,
            ext: net.extended_pan_id,
            channel,
            update_id: 0,
            nwk: 0,
            level: 5,
            channels: 1 << channel,
        },
        Record::NwkKey {
            seq: 0,
            key: net.key,
            alt: None,
        },
        Record::Counters { nwk: 0, aps: 0 },
    ];
    import(c, &records, 0, deadline).await?;
    c.renegotiate(deadline).await?;
    let got = to_backup(&export(c, deadline).await?)?;
    if got.network.pan_id != net.pan_id
        || got.network.extended_pan_id != net.extended_pan_id
        || got.channel != channel
        || got.network.key != net.key
        || !got.devices.is_empty()
    {
        return Err(ZsError::Rejected(
            "formed network readback differs from the request".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cobs_link::Frame;
    use crate::cobs_link::test_peer::Peer;
    use crate::zs_protocol::ZDO;
    use crate::zs_protocol::tests::{session, soon};

    const SEED: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    fn sample() -> Backup {
        let key = |k: [u8; 16], rx, tx| {
            Some(LinkKey {
                key: k,
                rx_counter: rx,
                tx_counter: tx,
            })
        };
        let dev = |nwk, ieee, direct_child, link_key| Device {
            nwk,
            ieee,
            direct_child,
            link_key,
        };
        Backup {
            network: Network {
                pan_id: 0x1A62,
                extended_pan_id: 0xDDDD_DDDD_DDDD_DDDD,
                channels: vec![15, 20],
                key: [0x11; 16],
                distribute: false,
            },
            channel: 20,
            key_sequence: 1,
            frame_counter: 1000,
            security_level: 5,
            nwk_update_id: 3,
            coordinator_ieee: 0x0012_4B00_0000_0001,
            devices: vec![
                dev(
                    Some(0x1111),
                    0xA1,
                    true,
                    key(derive_key(&SEED, 0xA1, 5), 10, 20),
                ),
                dev(Some(0x2222), 0xB2, false, key([0x42; 16], 11, 30)),
                dev(Some(0x3333), 0xC3, true, None),
                dev(Some(0x3333), 0xD4, false, None),
                dev(None, 0xE5, true, None),
            ],
            tclk_seed: Some(SEED),
        }
    }

    #[test]
    fn tclk_derivation_matches_the_spec_example() {
        let key = derive_key(&SEED, 0x0012_4B00_1234_5678, 3);
        assert_eq!(
            key,
            [
                0x7B, 0x52, 0x31, 0x14, 0x07, 0x43, 0x1B, 0x0A, 0x73, 0x5A, 0x39, 0x1C, 0x0F, 0x4B,
                0x13, 0x02
            ]
        );
        assert_eq!(
            node_key(Some(&SEED), 0x0012_4B00_1234_5678, &key),
            NodeKey::Derived(3)
        );
        assert_eq!(
            node_key(None, 0x0012_4B00_1234_5678, &key),
            NodeKey::Explicit(key)
        );
    }

    #[test]
    fn records_round_trip_through_tlv_and_readback() {
        let backup = sample();
        validate(&backup).expect("valid sample");
        let (records, expected) = plan_restore(&backup, 200);
        let mut wire = Vec::new();
        records.iter().for_each(|r| r.encode(&mut wire));
        let decoded = decode_records(&wire).expect("decode");
        assert_eq!(decoded, records);
        let Record::Counters { nwk, aps } = records[3] else {
            panic!("COUNTERS fourth")
        };
        assert_eq!((nwk, aps), (3500, 2530));
        let nodes: Vec<(u16, u8, u8, NodeKey)> = records
            .iter()
            .filter_map(|r| match r {
                Record::Node(n) => Some((n.nwk, n.relationship, n.caps, n.key)),
                _ => None,
            })
            .collect();
        assert_eq!(
            nodes,
            [
                (0x1111, 1, 0, NodeKey::Derived(5)),
                (0x2222, 3, 0, NodeKey::Explicit([0x42; 16])),
                (0xFFFE, 4, 0, NodeKey::None),
                (0x3333, 3, 0, NodeKey::None),
                (0xFFFE, 4, 0, NodeKey::None),
            ]
        );
        assert_eq!(expected.devices[2].nwk, None);
        assert!(
            expected.devices[2].direct_child,
            "an unaddressed child stays a child"
        );
        // The export lists only the channel in use, whatever the NIB mask holds.
        let mut readback = to_backup(&decoded).expect("to_backup");
        assert_eq!(readback.network.channels, [20]);
        assert_eq!(compare(&expected, &readback), Ok(()));
        readback.devices[0].link_key.as_mut().expect("key").key[0] ^= 1;
        assert!(compare(&expected, &readback).is_err());
        assert!(matches!(
            decode_records(&[0x10, 21, 0, 0]),
            Err(ZsError::Rejected(_))
        ));
        assert!(matches!(
            decode_records(&[0x06, 0]),
            Err(ZsError::Rejected(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn import_chunks_commits_crc_and_waits_for_completion() {
        let (c, _events, mut peer) = session().await;
        let records = [
            Record::Header {
                capacity: 200,
                count: 0,
                ieee: 1,
                revision: 0,
            },
            Record::Nib {
                pan_id: 0x1A62,
                ext: 7,
                channel: 11,
                update_id: 0,
                nwk: 0,
                level: 5,
                channels: 1 << 11,
            },
            Record::NwkKey {
                seq: 0,
                key: [9; 16],
                alt: None,
            },
            Record::Counters { nwk: 0, aps: 0 },
        ];
        let script = async {
            let start = peer.answer(SYS, 0x71, &[0, 0, 0, 0]).await;
            assert_eq!(start, [0x00, 0x01, 0x00, 0x00, 0x46, 0x00, 0x00, 0x00]);
            let chunk = peer.answer(SYS, 0x71, &[0, 1, 4, 0]).await;
            assert_eq!((&chunk[..3], chunk.len()), (&[1, 0, 0][..], 73));
            let commit = peer.answer(SYS, 0x71, &[0, 2, 1, 0]).await;
            assert_eq!(commit[1..], crc32(&chunk[3..]).to_le_bytes());
            peer.send(0, Frame::new(0x41, 0x71, vec![2, 0])).await;
        };
        let (r, ()) = tokio::join!(import(&c, &records, 0, soon()), script);
        assert_eq!(r, Ok(()));
        let script = async {
            peer.answer(SYS, 0x71, &[0, 0, 0, 0]).await;
            peer.answer(SYS, 0x71, &[0, 1, 3, 0]).await;
            assert_eq!(peer.answer(SYS, 0x71, &[0, 3, 0, 0]).await, [3]);
        };
        let (r, ()) = tokio::join!(import(&c, &records, 0, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("accepted 3 of 4")));
    }

    #[tokio::test(start_paused = true)]
    async fn import_chunks_fit_249_cobs_mux_data_bytes() {
        let (c, _events, mut peer) = session().await;
        let node = |ieee, key| {
            Record::Node(Node {
                ieee,
                nwk: 0xFFFE,
                relationship: 3,
                key_state: 0,
                caps: 0,
                aps_rx: 0,
                nwk_rx: 0,
                key,
            })
        };
        // 247 record bytes: the largest chunk body before the 249-byte limit.
        let mut records = vec![
            Record::Header {
                capacity: 200,
                count: 8,
                ieee: 1,
                revision: 0,
            },
            Record::Nib {
                pan_id: 0x1A62,
                ext: 7,
                channel: 11,
                update_id: 0,
                nwk: 0,
                level: 5,
                channels: 1 << 11,
            },
            Record::NwkKey {
                seq: 0,
                key: [9; 16],
                alt: None,
            },
            Record::Counters { nwk: 0, aps: 0 },
            node(0x10, NodeKey::Derived(1)),
        ];
        records.extend((0x11..0x18).map(|ieee| node(ieee, NodeKey::None)));
        let mut all = Vec::new();
        records.iter().for_each(|r| r.encode(&mut all));
        assert_eq!(all.len(), 247);
        let script = async {
            peer.answer(SYS, 0x71, &[0, 0, 0, 0]).await;
            let mut body = Vec::new();
            loop {
                let (seq, d) = peer.expect(SYS, 0x71).await;
                if d[0] == 2 {
                    assert_eq!(d[1..], crc32(&body).to_le_bytes());
                    peer.send(seq, Frame::new(0x61, 0x71, vec![0, 2, 0, 0]))
                        .await;
                    return;
                }
                assert!(d.len() <= 249, "import chunk of {} MT data bytes", d.len());
                let [lo, hi] =
                    (decode_records(&d[3..]).expect("records").len() as u16).to_le_bytes();
                body.extend_from_slice(&d[3..]);
                peer.send(seq, Frame::new(0x61, 0x71, vec![0, 1, lo, hi]))
                    .await;
            }
        };
        let (r, ()) = tokio::join!(import(&c, &records, 8, soon()), script);
        assert_eq!(r, Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn export_restarts_on_a_stale_generation() {
        let (c, _events, mut peer) = session().await;
        let mut page0 = vec![0, 5, 0, 1, 0];
        Record::Counters { nwk: 1, aps: 2 }.encode(&mut page0);
        let mut page1 = vec![0, 5, 0, 0xFF, 0xFF];
        Record::TclkSeed(SEED).encode(&mut page1);
        let script = async {
            assert_eq!(peer.answer(SYS, 0x70, &page0).await, [0, 0, 0, 0]);
            assert_eq!(
                peer.answer(SYS, 0x70, &[0xB0, 6, 0, 0xFF, 0xFF]).await,
                [1, 0, 5, 0]
            );
            assert_eq!(peer.answer(SYS, 0x70, &page0).await, [0, 0, 0, 0]);
            assert_eq!(peer.answer(SYS, 0x70, &page1).await, [1, 0, 5, 0]);
        };
        let (r, ()) = tokio::join!(export(&c, soon()), script);
        assert_eq!(
            r,
            Ok(vec![
                Record::Counters { nwk: 1, aps: 2 },
                Record::TclkSeed(SEED)
            ])
        );
    }

    #[test]
    fn a_multi_channel_backup_passes_single_channel_readback() {
        let mut backup = sample();
        backup.network.channels = vec![11, 15, 20, 25];
        backup.channel = 15;
        validate(&backup).expect("valid backup");
        let (records, expected) = plan_restore(&backup, 200);
        let mut readback = to_backup(&records).expect("to_backup");
        assert_eq!(readback.network.channels, [15]);
        assert_eq!(compare(&expected, &readback), Ok(()));
        readback.channel = 20;
        readback.network.channels = vec![20];
        assert!(compare(&expected, &readback).is_err());
    }

    #[test]
    fn a_nib_mask_of_all_16_channels_exports_only_the_channel_in_use() {
        let mut backup = sample();
        backup.network.channels = (11..=26).collect();
        backup.channel = 25;
        validate(&backup).expect("valid backup");
        let (records, expected) = plan_restore(&backup, 200);
        assert!(records.iter().any(|r| matches!(
            r,
            Record::Nib {
                channel: 25,
                channels: 0x07FF_F800,
                ..
            }
        )));
        let readback = to_backup(&records).expect("to_backup");
        assert_eq!(readback.network.channels, [25]);
        assert_eq!(compare(&expected, &readback), Ok(()));
    }

    #[test]
    fn a_coordinator_self_entry_is_dropped_before_validation() {
        let mut b = sample();
        let own = b.coordinator_ieee;
        b.devices.insert(
            2,
            Device {
                nwk: Some(0x0000),
                ieee: own,
                direct_child: false,
                link_key: None,
            },
        );
        b.devices.push(Device {
            nwk: None,
            ieee: own,
            direct_child: false,
            link_key: None,
        });
        assert!(validate(&b).is_err());
        let n = normalize(&b);
        assert_eq!(n.devices, sample().devices);
        assert_eq!(validate(&n), Ok(()));
        let (records, _) = plan_restore(&n, 200);
        assert!(
            !records
                .iter()
                .any(|r| matches!(r, Record::Node(node) if node.ieee == own))
        );
    }

    #[test]
    fn sparse_devices_at_0xfffe_or_0x0000_restore_without_an_address() {
        let mut b = sample();
        b.devices.push(Device {
            nwk: Some(0xFFFE),
            ieee: 0xF6,
            direct_child: true,
            link_key: None,
        });
        b.devices.push(Device {
            nwk: Some(0x0000),
            ieee: 0xA7,
            direct_child: false,
            link_key: None,
        });
        assert!(validate(&b).is_err());
        let n = normalize(&b);
        assert_eq!(validate(&n), Ok(()));
        assert_eq!(n.devices[5].nwk, None);
        assert_eq!(n.devices[6].nwk, None);
        let (records, expected) = plan_restore(&n, 200);
        let nodes: Vec<_> = records
            .iter()
            .filter_map(|r| match r {
                Record::Node(node) if [0xF6, 0xA7].contains(&node.ieee) => {
                    Some((node.ieee, node.nwk, node.relationship))
                }
                _ => None,
            })
            .collect();
        assert_eq!(nodes, [(0xF6, 0xFFFE, 4), (0xA7, 0xFFFE, 3)]);
        let readback = to_backup(&records).expect("to_backup");
        assert_eq!(compare(&expected, &readback), Ok(()));
        let child = |b: &Backup, ieee| {
            b.devices
                .iter()
                .find(|d| d.ieee == ieee)
                .map(|d| d.direct_child)
        };
        assert_eq!(
            child(&readback, 0xF6),
            Some(true),
            "an unaddressed child stays a child"
        );
        assert_eq!(child(&readback, 0xA7), Some(false));
        // validate() alone still refuses reserved addresses; normalize() maps them to none.
        for reserved in [0xFFF8, 0xFFFD, 0xFFFF] {
            let mut b = sample();
            b.devices[0].nwk = Some(reserved);
            assert!(validate(&b).is_err());
            assert_eq!(normalize(&b).devices[0].nwk, None);
            assert_eq!(validate(&normalize(&b)), Ok(()));
        }
    }

    #[test]
    fn a_stock_ti_backup_with_null_node_id_0xffff_round_trips_without_an_address() {
        // herdsman's zstack adapter writes NULL_NODE_ID (0xFFFF) for unaddressed devices and
        // exports them as "nwk_address": "ffff".
        let mut b = sample();
        b.devices[0].nwk = Some(0xFFFF);
        b.devices[0].direct_child = true;
        b.devices[1].nwk = Some(0xFFFF);
        b.devices[1].direct_child = false;
        let n = normalize(&b);
        assert_eq!(validate(&n), Ok(()));
        let (records, expected) = plan_restore(&n, 200);
        let readback = to_backup(&records).expect("to_backup");
        assert_eq!(compare(&expected, &readback), Ok(()));
        for want in &n.devices[..2] {
            let got = readback
                .devices
                .iter()
                .find(|d| d.ieee == want.ieee)
                .expect("restored");
            assert_eq!((got.nwk, got.direct_child), (None, want.direct_child));
            assert_eq!(
                got.link_key.as_ref().map(|k| k.key),
                want.link_key.as_ref().map(|k| k.key)
            );
        }
    }

    #[test]
    fn a_previous_child_with_an_address_exports_as_no_child() {
        let (mut records, _) = plan_restore(&sample(), 200);
        let Some(Record::Node(node)) = records
            .iter_mut()
            .find(|r| matches!(r, Record::Node(n) if n.nwk != 0xFFFE))
        else {
            panic!("an addressed node");
        };
        node.relationship = 4;
        let ieee = node.ieee;
        let readback = to_backup(&records).expect("to_backup");
        let d = readback
            .devices
            .iter()
            .find(|d| d.ieee == ieee)
            .expect("exported");
        assert!(d.nwk.is_some());
        assert!(!d.direct_child, "a child that left is not one");
    }

    #[test]
    fn non_children_restore_as_no_neighbor_without_caps_and_children_as_children() {
        let mut b = sample();
        let k = b.devices[1].link_key.clone();
        let dev = |nwk, ieee, direct_child, link_key| Device {
            nwk,
            ieee,
            direct_child,
            link_key,
        };
        b.devices = vec![
            dev(Some(0x1111), 0xA1, true, None),
            dev(None, 0xB2, true, k.clone()),
            dev(Some(0x2222), 0xC3, false, k.clone()),
            dev(Some(0x3333), 0xD4, false, None),
            dev(None, 0xE5, false, k),
            dev(None, 0xF6, false, None),
        ];
        validate(&b).expect("valid");
        let (records, expected) = plan_restore(&b, 200);
        let nodes: Vec<(u64, u8, u8)> = records
            .iter()
            .filter_map(|r| match r {
                Record::Node(n) => Some((n.ieee, n.relationship, n.caps)),
                _ => None,
            })
            .collect();
        // Child 1, PreviousChild 4 (unaddressed child), NotNeighbor 3; no caps until heard.
        assert_eq!(
            nodes,
            [
                (0xA1, 1, 0),
                (0xB2, 4, 0),
                (0xC3, 3, 0),
                (0xD4, 3, 0),
                (0xE5, 3, 0),
                (0xF6, 3, 0)
            ]
        );
        let mut wire = Vec::new();
        records.iter().for_each(|r| r.encode(&mut wire));
        let readback = to_backup(&decode_records(&wire).expect("decode")).expect("to_backup");
        assert_eq!(compare(&expected, &readback), Ok(()));
        let children: Vec<(u64, bool)> = readback
            .devices
            .iter()
            .map(|d| (d.ieee, d.direct_child))
            .collect();
        assert_eq!(
            children,
            [
                (0xA1, true),
                (0xB2, true),
                (0xC3, false),
                (0xD4, false),
                (0xE5, false),
                (0xF6, false)
            ]
        );
    }

    #[test]
    fn readback_accepts_raised_counters_and_refuses_lower_ones() {
        let (records, expected) = plan_restore(&sample(), 200);
        let readback = to_backup(&records).expect("to_backup");
        let mut raised = readback.clone();
        raised.frame_counter += 0x1000;
        for k in raised
            .devices
            .iter_mut()
            .filter_map(|d| d.link_key.as_mut())
        {
            k.rx_counter += 262_144;
            k.tx_counter += 262_144;
        }
        assert_eq!(compare(&expected, &raised), Ok(()));
        let mut nwk_low = readback.clone();
        nwk_low.frame_counter = expected.frame_counter - 1;
        assert!(compare(&expected, &nwk_low).is_err());
        let mut aps_low = readback;
        aps_low.devices[0]
            .link_key
            .as_mut()
            .expect("key")
            .rx_counter = 9;
        assert!(compare(&expected, &aps_low).is_err());
    }

    // ZDO_EXT_NWK_INFO answer: NWK, state, PAN, parent, extended PAN at 7, channel at 23.
    fn nwk_info(state: u8, pan: u16, ext: u64) -> Vec<u8> {
        let mut d = vec![0u8; 24];
        d[2] = state;
        d[3..5].copy_from_slice(&pan.to_le_bytes());
        d[7..15].copy_from_slice(&ext.to_le_bytes());
        d[23] = 20;
        d
    }

    // Answers SYS_OSAL_NV_LENGTH and one SYS_OSAL_NV_READ_EXT for `item`.
    async fn answer_nv(peer: &mut Peer, item: u16, value: &[u8]) {
        let id = item.to_le_bytes();
        let length = (value.len() as u16).to_le_bytes();
        assert_eq!(peer.answer(SYS, 0x13, &length).await, id);
        let mut d = vec![0, value.len() as u8];
        d.extend_from_slice(value);
        assert_eq!(peer.answer(SYS, 0x1C, &d).await, [id[0], id[1], 0, 0]);
    }

    // Serves `records` as SYS_ZS_BACKUP_EXPORT pages of one record each.
    async fn serve_export(peer: &mut Peer, records: &[Record]) {
        for (i, r) in records.iter().enumerate() {
            let next: u16 = if i + 1 == records.len() {
                0xFFFF
            } else {
                i as u16 + 1
            };
            let mut page = vec![0, 5, 0];
            page.extend_from_slice(&next.to_le_bytes());
            r.encode(&mut page);
            let gen_ = if i == 0 { 0 } else { 5 };
            assert_eq!(
                peer.answer(SYS, 0x70, &page).await,
                [(i as u16).to_le_bytes(), [gen_, 0]].concat()
            );
        }
    }

    #[test]
    fn malformed_backup_records_are_rejected() {
        let alt = Record::NwkKey {
            seq: 1,
            key: [0x11; 16],
            alt: Some((2, [0x22; 16])),
        };
        let mut wire = Vec::new();
        alt.encode(&mut wire);
        assert_eq!(wire.len(), 36);
        assert_eq!(decode_records(&wire), Ok(vec![alt]));
        // an alternate key whose sequence says "none", and a 1-key record that claims one
        wire[2 + 17] = 0xFF;
        assert!(decode_records(&wire).is_err());
        let mut single = Vec::new();
        Record::NwkKey {
            seq: 1,
            key: [0x11; 16],
            alt: None,
        }
        .encode(&mut single);
        single[2 + 17] = 2;
        assert!(decode_records(&single).is_err());
        // node: IEEE, NWK, flags (key kind << 6 | key state << 3 | relationship), caps, APS rx, NWK rx, key
        let node = |flags: u8, key: &[u8]| {
            let mut v = vec![0x10, (20 + key.len()) as u8];
            v.extend_from_slice(&0xA1u64.to_le_bytes());
            v.extend_from_slice(&[0x11, 0x11, flags, 0]);
            v.extend_from_slice(&[0; 8]);
            v.extend_from_slice(key);
            v
        };
        assert!(decode_records(&node(0x01, &[])).is_ok());
        assert!(decode_records(&node(0x80 | 0x08 | 1, &[15])).is_ok());
        assert!(decode_records(&node(0x40 | 1, &[7; 16])).is_ok());
        for (bad, why) in [
            (node(0x06, &[]), "relationship 6"),
            (node(0x28, &[]), "key state 5"),
            (node(0x80, &[16]), "derived key shift 16"),
            (node(0x80, &[]), "derived key without its shift"),
            (node(0x40, &[7; 15]), "explicit key of 15 bytes"),
            (node(0xC0, &[]), "both key kinds"),
            (node(0x00, &[1]), "key byte without a key kind"),
        ] {
            assert!(decode_records(&bad).is_err(), "{why}");
        }
        assert!(matches!(
            decode_records(&[0x04, 8, 1, 2, 3]),
            Err(ZsError::Rejected(m)) if m.contains("truncated")
        ));
        let mut trailing = Vec::new();
        Record::Counters { nwk: 1, aps: 2 }.encode(&mut trailing);
        trailing.push(0x05);
        assert!(matches!(
            decode_records(&trailing),
            Err(ZsError::Rejected(m)) if m.contains("trailing")
        ));
        assert!(decode_records(&[0x7F, 0]).is_err());
    }

    #[test]
    fn validation_rejects_reserved_identities_channels_and_devices() {
        validate(&sample()).expect("valid sample");
        type Case = (&'static str, fn(&mut Backup));
        let cases: [Case; 16] = [
            ("coordinator IEEE 0", |b| b.coordinator_ieee = 0),
            ("coordinator IEEE all ones", |b| {
                b.coordinator_ieee = u64::MAX
            }),
            ("extended PAN ID 0", |b| b.network.extended_pan_id = 0),
            ("PAN ID 0xFFFF", |b| b.network.pan_id = 0xFFFF),
            ("channel 10", |b| b.channel = 10),
            ("channel 27", |b| {
                b.channel = 27;
                b.network.channels = vec![27];
            }),
            ("security level 8", |b| b.security_level = 8),
            ("repeated channel", |b| b.network.channels = vec![20, 20]),
            ("channel outside the list", |b| {
                b.network.channels = vec![15]
            }),
            ("list channel 27", |b| b.network.channels = vec![20, 27]),
            ("device IEEE 0", |b| b.devices[0].ieee = 0),
            ("repeated device", |b| b.devices[1].ieee = b.devices[0].ieee),
            ("device is the coordinator", |b| {
                b.devices[0].ieee = b.coordinator_ieee
            }),
            ("device at 0x0000", |b| b.devices[0].nwk = Some(0)),
            ("device at 0xFFF8", |b| b.devices[0].nwk = Some(0xFFF8)),
            ("1001 devices", |b| {
                b.devices = (1..=1001)
                    .map(|ieee| Device {
                        nwk: None,
                        ieee,
                        direct_child: false,
                        link_key: None,
                    })
                    .collect()
            }),
        ];
        for (why, mutate) in cases {
            let mut b = sample();
            mutate(&mut b);
            assert!(matches!(validate(&b), Err(ZsError::Invalid(_))), "{why}");
        }
    }

    #[test]
    fn an_export_without_a_coordinator_nib_or_seed_is_refused() {
        let (records, _) = plan_restore(&sample(), 200);
        let refused = |records: Vec<Record>, what: &str| {
            assert!(
                matches!(to_backup(&records), Err(ZsError::Rejected(m)) if m.contains(what)),
                "{what}"
            );
        };
        refused(
            records
                .iter()
                .filter(|r| !matches!(r, Record::Nib { .. }))
                .cloned()
                .collect(),
            "NIB",
        );
        refused(
            records
                .iter()
                .cloned()
                .map(|r| match r {
                    Record::Nib {
                        pan_id,
                        ext,
                        channel,
                        update_id,
                        level,
                        channels,
                        ..
                    } => Record::Nib {
                        pan_id,
                        ext,
                        channel,
                        update_id,
                        nwk: 0x1234,
                        level,
                        channels,
                    },
                    other => other,
                })
                .collect(),
            "not its network's coordinator",
        );
        refused(
            records
                .iter()
                .filter(|r| !matches!(r, Record::TclkSeed(_)))
                .cloned()
                .collect(),
            "derived key without seed",
        );
    }

    #[tokio::test(start_paused = true)]
    async fn export_refuses_no_network_failures_short_pages_and_a_stuck_cursor() {
        let (c, _events, mut peer) = session().await;
        for (answer, what) in [
            (&[0x09, 0, 0, 0, 0][..], "holds no network"),
            (&[0x01, 0, 0, 0, 0][..], "status 0x01"),
            (&[0, 0, 0, 0][..], "shorter than 5"),
        ] {
            let (r, _) = tokio::join!(export(&c, soon()), peer.answer(SYS, 0x70, answer));
            assert!(
                matches!(&r, Err(ZsError::Rejected(m)) if m.contains(what)),
                "{r:?}"
            );
        }
        let mut page = vec![0, 5, 0, 1, 0];
        Record::Counters { nwk: 1, aps: 2 }.encode(&mut page);
        let script = async {
            peer.answer(SYS, 0x70, &page).await;
            assert_eq!(peer.answer(SYS, 0x70, &[0, 5, 0, 1, 0]).await, [1, 0, 5, 0]);
        };
        let (r, ()) = tokio::join!(export(&c, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("did not advance")));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_import_completion_aborts_and_a_refused_start_does_not() {
        let (c, _events, mut peer) = session().await;
        let records = [Record::Counters { nwk: 0, aps: 0 }];
        let script = async {
            peer.answer(SYS, 0x71, &[0, 0, 0, 0]).await;
            peer.answer(SYS, 0x71, &[0, 1, 1, 0]).await;
            peer.answer(SYS, 0x71, &[0, 2, 1, 0]).await;
            peer.send(0, Frame::new(0x41, 0x71, vec![2, 0xC2])).await;
            assert_eq!(peer.answer(SYS, 0x71, &[0, 3, 0, 0]).await, [3]);
        };
        let (r, ()) = tokio::join!(import(&c, &records, 0, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("0xc2")));
        let (r, _) = tokio::join!(
            import(&c, &records, 0, soon()),
            peer.answer(SYS, 0x71, &[1])
        );
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("op 0")));
        // nothing followed the refused start: the next request is the first the peer sees
        let ieee = 7u64.to_le_bytes();
        let (r, _) = tokio::join!(c.ieee(soon()), peer.answer(SYS, 0x04, &ieee));
        assert_eq!(r, Ok(7));
    }

    #[tokio::test(start_paused = true)]
    async fn a_backup_checks_the_coordinator_identity_and_its_key_distribution_flag() {
        let (c, _events, mut peer) = session().await;
        let b = sample();
        let (records, _) = plan_restore(&b, 200);
        let ieee = b.coordinator_ieee.to_le_bytes();
        let ext = b.network.extended_pan_id;
        let script = async {
            peer.answer(ZDO, 0x50, &nwk_info(9, 0x1A62, ext)).await;
            peer.answer(SYS, 0x04, &ieee).await;
            serve_export(&mut peer, &records).await;
            answer_nv(&mut peer, 0x0063, &[1]).await;
        };
        let (r, ()) = tokio::join!(backup(&c, soon()), script);
        let got = r.expect("backup");
        assert!(got.network.distribute);
        assert_eq!(got.devices.len(), b.devices.len());

        let script = async {
            peer.answer(ZDO, 0x50, &nwk_info(9, 0x1A63, ext)).await;
            peer.answer(SYS, 0x04, &ieee).await;
            serve_export(&mut peer, &records).await;
        };
        let (r, ()) = tokio::join!(backup(&c, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("identity changed")));

        let script = async {
            peer.answer(ZDO, 0x50, &nwk_info(9, 0x1A62, ext)).await;
            peer.answer(SYS, 0x04, &ieee).await;
            serve_export(&mut peer, &records).await;
            answer_nv(&mut peer, 0x0063, &[1, 0]).await;
        };
        let (r, ()) = tokio::join!(backup(&c, soon()), script);
        assert!(
            matches!(r, Err(ZsError::Rejected(m)) if m.contains("PRECFGKEYS_ENABLE of 2 bytes"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn formation_is_refused_before_any_reset_on_clear_state_or_a_non_coordinator() {
        let (c, _events, mut peer) = session().await;
        let net = sample().network;
        let ieee = 1u64.to_le_bytes();
        for (startup, logical, what) in [
            (&[0x02][..], None, "clear-state"),
            (&[0x00, 0x00][..], None, "STARTUP_OPTION of 2 bytes"),
            (&[0x00][..], Some(1u8), "is not coordinator"),
        ] {
            let script = async {
                peer.answer(SYS, 0x04, &ieee).await;
                answer_nv(&mut peer, 0x0003, startup).await;
                if let Some(l) = logical {
                    answer_nv(&mut peer, 0x0087, &[l]).await;
                }
            };
            let (r, ()) = tokio::join!(form(&c, &net, soon()), script);
            assert!(
                matches!(&r, Err(ZsError::Rejected(m)) if m.contains(what)),
                "{r:?}"
            );
        }
        // no reset followed: the next request is the first the peer sees
        let (r, _) = tokio::join!(c.ieee(soon()), peer.answer(SYS, 0x04, &ieee));
        assert_eq!(r, Ok(1));
    }

    #[tokio::test(start_paused = true)]
    async fn a_restore_stops_when_the_reset_coordinator_is_not_in_dev_hold() {
        let (c, _events, mut peer) = session().await;
        let script = async {
            peer.expect(0x41, 0x00).await;
            peer.cobs = false;
            peer.send(0, Frame::new(0x41, 0x80, vec![0x00, 2, 1, 2, 7, 1]))
                .await;
            peer.handshake().await;
            peer.answer(ZDO, 0x50, &nwk_info(9, 0x1A62, 1)).await;
        };
        let b = sample();
        let (r, ()) = tokio::join!(restore(&c, &b, soon()), script);
        assert!(matches!(r, Err(ZsError::Rejected(m)) if m.contains("not DEV_HOLD")));
        // nothing was imported: the next request is the first the peer sees
        let ieee = 1u64.to_le_bytes();
        let (r, _) = tokio::join!(c.ieee(soon()), peer.answer(SYS, 0x04, &ieee));
        assert_eq!(r, Ok(1));
    }
}
