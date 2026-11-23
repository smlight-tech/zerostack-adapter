// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

mod cobs_link;
mod convert;
mod logging;
mod mt_trace;
mod transport;
mod zs_backup;
mod zs_protocol;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use napi::bindgen_prelude::{
    Buffer, Either, Either4, Function, JsObjectValue, Null, PromiseRaw, ToNapiValue,
};
use napi::threadsafe_function::{ThreadsafeFunction, UnknownReturnValue};
use napi::{Env, JsValue, Status};
use napi_derive::napi;
use tokio::sync::{Notify, OnceCell, mpsc};
use tokio::task::JoinHandle;

use convert::{Failure, format_eui64, parse_eui64, to_u8, to_u16, to_u32};
use zs_backup as bk;
use zs_protocol as zp;

#[napi(object, object_to_js = false)]
pub struct OpenOptions {
    pub backend: String,
    pub transport: String,
    pub baud_rate: f64,
    pub rtscts: bool,
}

#[napi(object)]
pub struct NetworkOptions {
    pub pan_id: f64,
    pub extended_pan_id: String,
    pub channel_list: Vec<f64>,
    pub network_key: Buffer,
    pub network_key_distribute: bool,
}

#[napi(object)]
pub struct BackupLinkKey {
    pub key: Buffer,
    pub rx_counter: f64,
    pub tx_counter: f64,
}

#[napi(object)]
pub struct BackupDevice {
    pub network_address: Either<f64, Null>,
    pub ieee_address: String,
    pub is_direct_child: bool,
    pub link_key: Either<BackupLinkKey, Null>,
}

#[napi(object)]
pub struct NativeBackup {
    pub network: NetworkOptions,
    pub logical_channel: f64,
    pub network_key_sequence: f64,
    pub network_key_frame_counter: f64,
    pub security_level: f64,
    pub network_update_id: f64,
    pub coordinator_ieee_address: String,
    pub devices: Vec<BackupDevice>,
    pub trust_center_link_key_seed: Either<Buffer, Null>,
}

#[napi(object, object_from_js = false)]
pub struct NetworkParameters {
    pub pan_id: u16,
    pub extended_pan_id: String,
    pub channel: u8,
    pub nwk_update_id: u8,
}

#[napi(object, object_from_js = false)]
pub struct CoordinatorVersion {
    #[napi(js_name = "type")]
    pub kind: String,
    pub meta: HashMap<String, Either<f64, String>>,
}

#[napi(object, object_from_js = false)]
pub struct ApsFrame {
    pub src_nwk: u16,
    pub src_ieee: Either<String, Null>,
    pub src_endpoint: u8,
    pub dst_endpoint: u8,
    pub cluster_id: u16,
    pub profile_id: u16,
    pub group_id: Either<u16, Null>,
    pub was_broadcast: bool,
    pub linkquality: Either<u8, Null>,
    pub rssi: Either<i8, Null>,
    pub data: Buffer,
}

#[napi(object, object_from_js = false)]
pub struct ApsEvent {
    pub kind: &'static str,
    pub frame: ApsFrame,
}

#[napi(object, object_from_js = false)]
pub struct DeviceJoinedEvent {
    pub kind: &'static str,
    pub network_address: u16,
    pub ieee_addr: String,
}

#[napi(object, object_from_js = false)]
pub struct DeviceLeaveEvent {
    pub kind: &'static str,
    pub network_address: Either<u16, Null>,
    pub ieee_addr: Either<String, Null>,
}

#[napi(object, object_from_js = false)]
pub struct DisconnectedEvent {
    pub kind: &'static str,
    pub reason: String,
}

#[napi(object, object_from_js = false)]
pub struct NativeLogRecord {
    pub level: &'static str,
    pub namespace: &'static str,
    pub message: String,
}

#[napi(catch_unwind)]
pub fn set_log_handler(
    on_log: Either<Function<'_, NativeLogRecord, UnknownReturnValue>, Null>,
) -> napi::Result<()> {
    let callback = match on_log {
        Either::A(func) => Some(
            func.build_threadsafe_function::<logging::LogEntry>()
                .callee_handled::<false>()
                .weak::<true>()
                .max_queue_size::<{ logging::LOG_QUEUE }>()
                .build_callback(|ctx| {
                    Ok(NativeLogRecord {
                        level: ctx.value.level.as_js_str(),
                        namespace: ctx.value.namespace,
                        message: ctx.value.message,
                    })
                })?,
        ),
        Either::B(Null) => None,
    };
    logging::set_napi_handler(callback);
    Ok(())
}

#[napi(catch_unwind)]
pub fn set_log_level(level: String) -> napi::Result<()> {
    let parsed = logging::LogLevel::parse(&level).map_err(napi::Error::from_reason)?;
    logging::set_level(parsed);
    Ok(())
}

pub type NativeEvent = Either4<ApsEvent, DeviceJoinedEvent, DeviceLeaveEvent, DisconnectedEvent>;

#[napi(object, object_to_js = false)]
pub struct Unicast {
    pub ieee_addr: String,
    pub network_address: f64,
    pub dst_endpoint: f64,
    pub src_endpoint: f64,
    pub cluster_id: f64,
    pub profile_id: f64,
    pub radius: f64,
    pub aps_ack: bool,
    pub data: Buffer,
    pub timeout_ms: f64,
}

#[napi(object, object_to_js = false)]
pub struct Groupcast {
    pub group_id: f64,
    pub src_endpoint: f64,
    pub cluster_id: f64,
    pub profile_id: f64,
    pub radius: f64,
    pub data: Buffer,
    pub timeout_ms: f64,
}

#[napi(object, object_to_js = false)]
pub struct Broadcast {
    pub destination: f64,
    pub dst_endpoint: f64,
    pub src_endpoint: f64,
    pub cluster_id: f64,
    pub profile_id: f64,
    pub radius: f64,
    pub data: Buffer,
    pub timeout_ms: f64,
}

#[napi(object, object_to_js = false)]
pub struct ZdoSend {
    pub ieee_addr: String,
    pub network_address: f64,
    pub cluster_id: f64,
    pub data: Buffer,
    pub timeout_ms: f64,
}

// Calls `onEvent` on the Node event loop with the events queued so far, in link order; weak, so
// it never keeps Node alive by itself.
type EventCallback = ThreadsafeFunction<
    Vec<zp::Event>,
    UnknownReturnValue,
    Vec<NativeEvent>,
    Status,
    false,
    true,
    { zp::EVENT_QUEUE },
>;

fn native_event(event: zp::Event) -> NativeEvent {
    match event {
        zp::Event::Aps(aps) => Either4::A(ApsEvent {
            kind: "aps",
            frame: ApsFrame {
                src_nwk: aps.src_nwk,
                src_ieee: nullable(aps.src_ieee.map(format_eui64)),
                src_endpoint: aps.src_endpoint,
                dst_endpoint: aps.dst_endpoint,
                cluster_id: aps.cluster,
                profile_id: aps.profile,
                group_id: nullable(aps.group),
                was_broadcast: aps.broadcast,
                linkquality: nullable(aps.lqi),
                rssi: nullable(aps.rssi),
                data: Buffer::from(aps.payload),
            },
        }),
        zp::Event::Joined { nwk, ieee } => Either4::B(DeviceJoinedEvent {
            kind: "deviceJoined",
            network_address: nwk,
            ieee_addr: format_eui64(ieee),
        }),
        zp::Event::Left { nwk, ieee } => Either4::C(DeviceLeaveEvent {
            kind: "deviceLeave",
            network_address: nullable(nwk),
            ieee_addr: nullable(ieee.map(format_eui64)),
        }),
        zp::Event::Disconnected { reason } => Either4::D(DisconnectedEvent {
            kind: "disconnected",
            reason,
        }),
    }
}

fn nullable<T>(value: Option<T>) -> Either<T, Null> {
    match value {
        Some(v) => Either::A(v),
        None => Either::B(Null),
    }
}

fn optional<T>(value: Either<T, Null>) -> Option<T> {
    match value {
        Either::A(v) => Some(v),
        Either::B(Null) => None,
    }
}

fn open_request(options: &OpenOptions) -> Result<(String, u32, bool), Failure> {
    convert::backend(&options.backend)?;
    Ok((
        options.transport.clone(),
        to_u32("baudRate", options.baud_rate)?,
        options.rtscts,
    ))
}

fn raw_network(network: &NetworkOptions) -> Result<zp::Network, Failure> {
    Ok(zp::Network {
        pan_id: to_u16("panId", network.pan_id)?,
        extended_pan_id: parse_eui64("extendedPanId", &network.extended_pan_id)?,
        channels: network
            .channel_list
            .iter()
            .map(|&c| to_u8("channelList[]", c))
            .collect::<Result<_, _>>()?,
        key: convert::key16("networkKey", &network.network_key)?,
        distribute: network.network_key_distribute,
    })
}

fn raw_device(device: &BackupDevice) -> Result<bk::Device, Failure> {
    let nwk = match &device.network_address {
        Either::A(n) => Some(to_u16("devices[].networkAddress", *n)?),
        Either::B(Null) => None,
    };
    let link_key = match &device.link_key {
        Either::A(k) => Some(bk::LinkKey {
            key: convert::key16("devices[].linkKey.key", &k.key)?,
            rx_counter: to_u32("devices[].linkKey.rxCounter", k.rx_counter)?,
            tx_counter: to_u32("devices[].linkKey.txCounter", k.tx_counter)?,
        }),
        Either::B(Null) => None,
    };
    Ok(bk::Device {
        nwk,
        ieee: parse_eui64("devices[].ieeeAddress", &device.ieee_address)?,
        direct_child: device.is_direct_child,
        link_key,
    })
}

fn raw_backup(backup: &NativeBackup) -> Result<bk::Backup, Failure> {
    Ok(bk::Backup {
        network: raw_network(&backup.network)?,
        channel: to_u8("logicalChannel", backup.logical_channel)?,
        key_sequence: to_u8("networkKeySequence", backup.network_key_sequence)?,
        frame_counter: to_u32("networkKeyFrameCounter", backup.network_key_frame_counter)?,
        security_level: to_u8("securityLevel", backup.security_level)?,
        nwk_update_id: to_u8("networkUpdateId", backup.network_update_id)?,
        coordinator_ieee: parse_eui64("coordinatorIeeeAddress", &backup.coordinator_ieee_address)?,
        devices: backup
            .devices
            .iter()
            .map(raw_device)
            .collect::<Result<_, _>>()?,
        tclk_seed: match &backup.trust_center_link_key_seed {
            Either::A(seed) => Some(convert::key16("trustCenterLinkKeySeed", seed)?),
            Either::B(Null) => None,
        },
    })
}

fn native_network(network: zp::Network) -> NetworkOptions {
    NetworkOptions {
        pan_id: f64::from(network.pan_id),
        extended_pan_id: format_eui64(network.extended_pan_id),
        channel_list: network.channels.into_iter().map(f64::from).collect(),
        network_key: Buffer::from(network.key.to_vec()),
        network_key_distribute: network.distribute,
    }
}

fn native_backup(backup: bk::Backup) -> NativeBackup {
    NativeBackup {
        network: native_network(backup.network),
        logical_channel: f64::from(backup.channel),
        network_key_sequence: f64::from(backup.key_sequence),
        network_key_frame_counter: f64::from(backup.frame_counter),
        security_level: f64::from(backup.security_level),
        network_update_id: f64::from(backup.nwk_update_id),
        coordinator_ieee_address: format_eui64(backup.coordinator_ieee),
        devices: backup
            .devices
            .into_iter()
            .map(|d| BackupDevice {
                network_address: nullable(d.nwk.map(f64::from)),
                ieee_address: format_eui64(d.ieee),
                is_direct_child: d.direct_child,
                link_key: nullable(d.link_key.map(|k| BackupLinkKey {
                    key: Buffer::from(k.key.to_vec()),
                    rx_counter: f64::from(k.rx_counter),
                    tx_counter: f64::from(k.tx_counter),
                })),
            })
            .collect(),
        trust_center_link_key_seed: nullable(backup.tclk_seed.map(|s| Buffer::from(s.to_vec()))),
    }
}

fn native_version(version: zp::CoordinatorVersion) -> Result<CoordinatorVersion, Failure> {
    let mut meta = HashMap::with_capacity(version.meta.len());
    for (key, value) in version.meta {
        let value = match value {
            zp::VersionValue::Number(n) => Either::A(convert::version_number(&key, n)?),
            zp::VersionValue::Text(t) => Either::B(t),
        };
        meta.insert(key, value);
    }
    Ok(CoordinatorVersion {
        kind: version.kind,
        meta,
    })
}

fn js_error(env: &Env, failure: &Failure) -> napi::Error {
    let built = (|| -> napi::Result<napi::Error> {
        let mut error =
            env.create_error(napi::Error::new(Status::GenericFailure, &failure.message))?;
        error.set_named_property("code", failure.code.as_str())?;
        if let Some(status) = failure.status {
            error.set_named_property("status", u32::from(status))?;
        }
        Ok(napi::Error::from(error.to_unknown()))
    })();
    built.unwrap_or_else(|e| {
        napi::Error::new(
            e.status,
            format!(
                "{} ({}); building its error object failed: {}",
                failure.message,
                failure.code.as_str(),
                e.reason
            ),
        )
    })
}

fn settle<'env, V, F>(env: &'env Env, work: F) -> napi::Result<PromiseRaw<'env, V>>
where
    V: ToNapiValue + Send + 'static,
    F: Future<Output = Result<V, Failure>> + Send + 'static,
{
    env.spawn_future_with_callback(async move { Ok(work.await) }, |env, outcome| {
        outcome.map_err(|failure| js_error(env, &failure))
    })
}

struct Shared {
    /// `None` once stopped. Locked only to clone or take the handle, never across `.await`.
    coordinator: Mutex<Option<Arc<zp::Coordinator>>>,
    supports_backup: bool,
    close: Arc<Notify>,
    pump: Mutex<Option<JoinHandle<Result<(), Failure>>>>,
    stopped: OnceCell<Result<(), Failure>>,
}

impl Shared {
    fn coordinator(&self) -> Result<Arc<zp::Coordinator>, Failure> {
        self.coordinator
            .lock()
            .map_err(|_| Failure::transport("coordinator state lock poisoned"))?
            .clone()
            .ok_or_else(Failure::stopped)
    }

    fn take_coordinator(&self) -> Result<Option<Arc<zp::Coordinator>>, Failure> {
        Ok(self
            .coordinator
            .lock()
            .map_err(|_| Failure::transport("coordinator state lock poisoned"))?
            .take())
    }

    fn take_pump(&self) -> Result<Option<JoinHandle<Result<(), Failure>>>, Failure> {
        Ok(self
            .pump
            .lock()
            .map_err(|_| Failure::transport("event pump lock poisoned"))?
            .take())
    }

    async fn shutdown(&self) -> Result<(), Failure> {
        self.stopped
            .get_or_init(|| async {
                let stopped = match self.take_coordinator() {
                    Ok(Some(c)) => {
                        c.stop().await;
                        Ok(())
                    }
                    Ok(None) => Ok(()),
                    Err(f) => Err(f),
                };
                self.close.notify_one();
                let pumped = match self.take_pump() {
                    Ok(Some(pump)) => match pump.await {
                        Ok(result) => result,
                        Err(e) => Err(Failure::transport(format!(
                            "event pump ended abnormally: {e}"
                        ))),
                    },
                    Ok(None) => Ok(()),
                    Err(f) => Err(f),
                };
                stopped.and(pumped)
            })
            .await
            .clone()
    }
}

async fn deliver(
    events: &mut mpsc::Receiver<zp::Event>,
    on_event: &EventCallback,
    close: &Notify,
) -> Result<(), Failure> {
    let mut closing = false;
    loop {
        tokio::select! {
            biased;
            () = close.notified(), if !closing => {
                closing = true;
                events.close();
            }
            event = events.recv() => match event {
                Some(event) => {
                    let batch = next_batch(event, events, zp::EVENT_QUEUE);
                    on_event.call_async_catch(batch).await.map_err(|e| {
                        Failure::transport(format!("event delivery to JavaScript failed: {e}"))
                    })?;
                }
                None => return Ok(()),
            }
        }
    }
}

fn next_batch<T>(first: T, events: &mut mpsc::Receiver<T>, max: usize) -> Vec<T> {
    let mut batch = vec![first];
    while batch.len() < max {
        match events.try_recv() {
            Ok(event) => batch.push(event),
            Err(_) => break,
        }
    }
    batch
}

async fn pump(
    mut events: mpsc::Receiver<zp::Event>,
    on_event: EventCallback,
    close: Arc<Notify>,
    shared: Weak<Shared>,
) -> Result<(), Failure> {
    let delivered = deliver(&mut events, &on_event, &close).await;
    // Closed before the stop below, so the link reader never waits on a queue nobody reads.
    drop(events);
    drop(on_event);
    let Err(failure) = delivered else {
        return Ok(());
    };
    let coordinator = match shared.upgrade() {
        Some(shared) => shared.take_coordinator()?,
        None => None,
    };
    if let Some(coordinator) = coordinator {
        coordinator.stop().await;
    }
    Err(failure)
}

#[napi]
pub struct ZsCoordinator {
    shared: Arc<Shared>,
}

impl ZsCoordinator {
    fn running(
        coordinator: zp::Coordinator,
        events: mpsc::Receiver<zp::Event>,
        on_event: EventCallback,
    ) -> Result<Self, Failure> {
        let close = Arc::new(Notify::new());
        let shared = Arc::new(Shared {
            supports_backup: true,
            coordinator: Mutex::new(Some(Arc::new(coordinator))),
            close: Arc::clone(&close),
            pump: Mutex::new(None),
            stopped: OnceCell::new(),
        });
        let handle = tokio::spawn(pump(events, on_event, close, Arc::downgrade(&shared)));
        *shared
            .pump
            .lock()
            .map_err(|_| Failure::transport("event pump lock poisoned"))? = Some(handle);
        Ok(Self { shared })
    }

    fn with<R>(
        &self,
        request: impl FnOnce() -> Result<R, Failure>,
    ) -> Result<(Arc<zp::Coordinator>, R), Failure> {
        let coordinator = self.shared.coordinator()?;
        Ok((coordinator, request()?))
    }
}

impl Drop for ZsCoordinator {
    fn drop(&mut self) {
        let pump = self
            .shared
            .pump
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(pump) = pump {
            pump.abort();
        }
        let coordinator = self
            .shared
            .coordinator
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        // Runs from a finalizer, possibly after napi has shut its runtime down: `close` only aborts
        // tasks and signals the link, which needs no runtime context.
        if let Some(coordinator) = coordinator {
            coordinator.close();
        }
    }
}

#[napi]
impl ZsCoordinator {
    #[napi(catch_unwind)]
    pub fn open<'env>(
        env: &'env Env,
        options: OpenOptions,
        on_event: Function<'_, Vec<NativeEvent>, UnknownReturnValue>,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ZsCoordinator>> {
        let on_event: EventCallback = on_event
            .build_threadsafe_function::<Vec<zp::Event>>()
            .callee_handled::<false>()
            .weak::<true>()
            .max_queue_size::<{ zp::EVENT_QUEUE }>()
            .build_callback(|ctx| {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    ctx.value.into_iter().map(native_event).collect()
                }))
                .map_err(|payload| {
                    let reason = payload
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("unknown panic");
                    napi::Error::from_reason(format!("panic converting native events: {reason}"))
                })
            })?;
        let request =
            open_request(&options).and_then(|open| Ok((open, convert::deadline(timeout_ms)?)));
        settle(env, async move {
            let ((transport, baud, rtscts), deadline) = request?;
            let (sender, events) = mpsc::channel(zp::EVENT_QUEUE);
            let coordinator =
                zp::Coordinator::open(&transport, baud, rtscts, sender, deadline).await?;
            ZsCoordinator::running(coordinator, events, on_event)
        })
    }

    #[napi(catch_unwind)]
    pub fn start<'env>(
        &self,
        env: &'env Env,
        network: NetworkOptions,
        backup: Either<NativeBackup, Null>,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, &'static str>> {
        let request = self.with(|| {
            let backup = optional(backup).as_ref().map(raw_backup).transpose()?;
            Ok((
                raw_network(&network)?,
                backup,
                convert::deadline(timeout_ms)?,
            ))
        });
        settle(env, async move {
            let (c, (network, backup, deadline)) = request?;
            let result = c.start(&network, backup.as_ref(), deadline).await?;
            Ok(convert::start_result(result))
        })
    }

    #[napi(catch_unwind)]
    pub fn stop<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let shared = Arc::clone(&self.shared);
        settle(env, async move { shared.shutdown().await })
    }

    #[napi(catch_unwind)]
    pub fn reset<'env>(
        &self,
        env: &'env Env,
        kind: String,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request =
            self.with(|| Ok((convert::reset_kind(&kind)?, convert::deadline(timeout_ms)?)));
        settle(env, async move {
            let (c, (kind, deadline)) = request?;
            Ok(c.reset(kind, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn coordinator_ieee<'env>(
        &self,
        env: &'env Env,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let request = self.with(|| convert::deadline(timeout_ms));
        settle(env, async move {
            let (c, deadline) = request?;
            Ok(format_eui64(c.ieee(deadline).await?))
        })
    }

    #[napi(catch_unwind)]
    pub fn coordinator_version<'env>(
        &self,
        env: &'env Env,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, CoordinatorVersion>> {
        let request = self.with(|| convert::deadline(timeout_ms));
        settle(env, async move {
            let (c, deadline) = request?;
            native_version(c.coordinator_version(deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn network_parameters<'env>(
        &self,
        env: &'env Env,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, NetworkParameters>> {
        let request = self.with(|| convert::deadline(timeout_ms));
        settle(env, async move {
            let (c, deadline) = request?;
            let p = c.network_parameters(deadline).await?;
            Ok(NetworkParameters {
                pan_id: p.pan_id,
                extended_pan_id: format_eui64(p.extended_pan_id),
                channel: p.channel,
                nwk_update_id: p.nwk_update_id,
            })
        })
    }

    #[napi(catch_unwind)]
    pub fn supports_backup(&self) -> bool {
        self.shared.supports_backup
    }

    #[napi(catch_unwind)]
    pub fn backup<'env>(
        &self,
        env: &'env Env,
        known_ieee_addrs: Vec<String>,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, NativeBackup>> {
        let request = self.with(|| {
            for address in &known_ieee_addrs {
                parse_eui64("knownIeeeAddrs[]", address)?;
            }
            convert::deadline(timeout_ms)
        });
        settle(env, async move {
            let (c, deadline) = request?;
            Ok(native_backup(bk::backup(&c, deadline).await?))
        })
    }

    #[napi(catch_unwind)]
    pub fn add_install_code<'env>(
        &self,
        env: &'env Env,
        ieee_addr: String,
        code: Buffer,
        hashed: bool,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            Ok((
                parse_eui64("ieeeAddr", &ieee_addr)?,
                code.to_vec(),
                convert::deadline(timeout_ms)?,
            ))
        });
        settle(env, async move {
            let (c, (ieee, code, deadline)) = request?;
            Ok(c.add_install_code(ieee, &code, hashed, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn permit_join<'env>(
        &self,
        env: &'env Env,
        seconds: f64,
        network_address: Either<f64, Null>,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            let nwk = optional(network_address)
                .map(|n| to_u16("networkAddress", n))
                .transpose()?;
            Ok((
                to_u8("seconds", seconds)?,
                nwk,
                convert::deadline(timeout_ms)?,
            ))
        });
        settle(env, async move {
            let (c, (seconds, nwk, deadline)) = request?;
            Ok(c.permit_join(seconds, nwk, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn unicast<'env>(
        &self,
        env: &'env Env,
        frame: Unicast,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            parse_eui64("ieeeAddr", &frame.ieee_addr)?;
            let raw = zp::Unicast {
                nwk: to_u16("networkAddress", frame.network_address)?,
                dst_endpoint: to_u8("dstEndpoint", frame.dst_endpoint)?,
                src_endpoint: to_u8("srcEndpoint", frame.src_endpoint)?,
                cluster: to_u16("clusterId", frame.cluster_id)?,
                profile: to_u16("profileId", frame.profile_id)?,
                radius: to_u8("radius", frame.radius)?,
                aps_ack: frame.aps_ack,
                payload: frame.data.to_vec(),
            };
            Ok((raw, convert::deadline(frame.timeout_ms)?))
        });
        settle(env, async move {
            let (c, (frame, deadline)) = request?;
            Ok(c.unicast(frame, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn groupcast<'env>(
        &self,
        env: &'env Env,
        frame: Groupcast,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            let raw = zp::Groupcast {
                group: to_u16("groupId", frame.group_id)?,
                src_endpoint: to_u8("srcEndpoint", frame.src_endpoint)?,
                cluster: to_u16("clusterId", frame.cluster_id)?,
                profile: to_u16("profileId", frame.profile_id)?,
                radius: to_u8("radius", frame.radius)?,
                payload: frame.data.to_vec(),
            };
            Ok((raw, convert::deadline(frame.timeout_ms)?))
        });
        settle(env, async move {
            let (c, (frame, deadline)) = request?;
            Ok(c.groupcast(frame, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn broadcast<'env>(
        &self,
        env: &'env Env,
        frame: Broadcast,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            let raw = zp::Broadcast {
                destination: convert::broadcast_destination(frame.destination)?,
                dst_endpoint: to_u8("dstEndpoint", frame.dst_endpoint)?,
                src_endpoint: to_u8("srcEndpoint", frame.src_endpoint)?,
                cluster: to_u16("clusterId", frame.cluster_id)?,
                profile: to_u16("profileId", frame.profile_id)?,
                radius: to_u8("radius", frame.radius)?,
                payload: frame.data.to_vec(),
            };
            Ok((raw, convert::deadline(frame.timeout_ms)?))
        });
        settle(env, async move {
            let (c, (frame, deadline)) = request?;
            Ok(c.broadcast(frame, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn zdo<'env>(&self, env: &'env Env, send: ZdoSend) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            parse_eui64("ieeeAddr", &send.ieee_addr)?;
            let nwk = to_u16("networkAddress", send.network_address)?;
            let cluster = to_u16("clusterId", send.cluster_id)?;
            Ok((
                nwk,
                cluster,
                send.data.to_vec(),
                convert::deadline(send.timeout_ms)?,
            ))
        });
        settle(env, async move {
            let (c, (nwk, cluster, payload, deadline)) = request?;
            Ok(c.zdo(nwk, cluster, &payload, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn interpan_channel<'env>(
        &self,
        env: &'env Env,
        channel: Either<f64, Null>,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            let channel = optional(channel).map(|c| to_u8("channel", c)).transpose()?;
            Ok((channel, convert::deadline(timeout_ms)?))
        });
        settle(env, async move {
            let (c, (channel, deadline)) = request?;
            Ok(c.interpan_channel(channel, deadline).await?)
        })
    }

    #[napi(catch_unwind)]
    pub fn interpan_send<'env>(
        &self,
        env: &'env Env,
        ieee_addr: Either<String, Null>,
        data: Buffer,
        timeout_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let request = self.with(|| {
            let ieee = optional(ieee_addr)
                .map(|a| parse_eui64("ieeeAddr", &a))
                .transpose()?;
            Ok((ieee, data.to_vec(), convert::deadline(timeout_ms)?))
        });
        settle(env, async move {
            let (c, (ieee, payload, deadline)) = request?;
            Ok(c.interpan_send(ieee, &payload, deadline).await?)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_batch_takes_what_is_queued_in_order_up_to_its_bound() {
        let (tx, mut rx) = mpsc::channel(8);
        for i in 1..=5 {
            tx.send(i).await.unwrap();
        }
        assert_eq!(next_batch(0, &mut rx, 4), [0, 1, 2, 3]);
        assert_eq!(next_batch(10, &mut rx, 4), [10, 4, 5]);
        assert_eq!(next_batch(20, &mut rx, 4), [20]);
        drop(tx);
        assert_eq!(next_batch(30, &mut rx, 4), [30]);
    }
}
