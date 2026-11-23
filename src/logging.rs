// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::fmt::{self, Write as _};
#[cfg(test)]
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Once, RwLock};

use napi::Status;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use tracing::field::{Field, Visit};
use tracing::span;
use tracing::subscriber::Interest;
use tracing::{Level, Metadata};

pub const NS_ADAPTER: &str = "zh:zerostack";
pub const NS_MT: &str = "zh:zerostack:mt";
pub const NS_TRANSPORT: &str = "zh:zerostack:transport";
pub const LOG_QUEUE: usize = 512;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Off = 0,
    Error = 1,
    Warning = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl LogLevel {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "none" => Ok(Self::Off),
            "error" => Ok(Self::Error),
            "warning" | "warn" => Ok(Self::Warning),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            "trace" => Ok(Self::Trace),
            other => Err(format!("invalid log level {other:?}")),
        }
    }

    pub const fn as_js_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
            Self::Info => "info",
            Self::Debug | Self::Trace => "debug",
            Self::Off => "error",
        }
    }

    const fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Off,
            1 => Self::Error,
            2 => Self::Warning,
            3 => Self::Info,
            4 => Self::Debug,
            _ => Self::Trace,
        }
    }

    const fn to_filter(self) -> tracing::level_filters::LevelFilter {
        match self {
            Self::Off => tracing::level_filters::LevelFilter::OFF,
            Self::Error => tracing::level_filters::LevelFilter::ERROR,
            Self::Warning => tracing::level_filters::LevelFilter::WARN,
            Self::Info => tracing::level_filters::LevelFilter::INFO,
            Self::Debug => tracing::level_filters::LevelFilter::DEBUG,
            Self::Trace => tracing::level_filters::LevelFilter::TRACE,
        }
    }
}

const fn from_tracing(level: &Level) -> LogLevel {
    if matches!(*level, Level::ERROR) {
        LogLevel::Error
    } else if matches!(*level, Level::WARN) {
        LogLevel::Warning
    } else if matches!(*level, Level::INFO) {
        LogLevel::Info
    } else if matches!(*level, Level::DEBUG) {
        LogLevel::Debug
    } else {
        LogLevel::Trace
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub level: LogLevel,
    pub namespace: &'static str,
    pub message: String,
}

pub type LogCallback = ThreadsafeFunction<
    LogEntry,
    UnknownReturnValue,
    crate::NativeLogRecord,
    Status,
    false,
    true,
    LOG_QUEUE,
>;

enum Sink {
    Napi(LogCallback),
    #[cfg(test)]
    Custom(Arc<dyn Fn(LogEntry) + Send + Sync>),
}

static MAX_LEVEL: AtomicU8 = AtomicU8::new(LogLevel::Info as u8);
static HAS_SINK: AtomicBool = AtomicBool::new(false);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static SINK: RwLock<Option<Sink>> = RwLock::new(None);
static SUBSCRIBER_INIT: Once = Once::new();

fn ensure_subscriber() {
    SUBSCRIBER_INIT.call_once(|| {
        drop(tracing::subscriber::set_global_default(BridgeSubscriber));
    });
}

#[inline]
pub fn enabled(level: LogLevel) -> bool {
    let raw = level as u8;
    raw > 0 && raw <= MAX_LEVEL.load(Ordering::Relaxed) && HAS_SINK.load(Ordering::Relaxed)
}

pub fn set_level(level: LogLevel) {
    MAX_LEVEL.store(level as u8, Ordering::Relaxed);
    ensure_subscriber();
    tracing::callsite::rebuild_interest_cache();
}

pub fn set_napi_handler(callback: Option<LogCallback>) {
    ensure_subscriber();
    let next = callback.map(Sink::Napi);
    let active = next.is_some();
    let old = {
        let mut guard = SINK
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let prev = std::mem::replace(&mut *guard, next);
        HAS_SINK.store(active, Ordering::Release);
        prev
    };
    drop(old);
    tracing::callsite::rebuild_interest_cache();
}

pub fn emit(level: LogLevel, namespace: &'static str, message: String) {
    if !enabled(level) {
        return;
    }
    let entry = LogEntry {
        level,
        namespace,
        message,
    };
    #[cfg(test)]
    let custom = {
        let guard = SINK
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match guard.as_ref() {
            Some(Sink::Napi(tsfn)) => {
                if tsfn.call(entry, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok {
                    DROPPED.fetch_add(1, Ordering::Relaxed);
                }
                return;
            }
            Some(Sink::Custom(cb)) => Arc::clone(cb),
            None => return,
        }
    };
    #[cfg(test)]
    custom(entry);

    #[cfg(not(test))]
    {
        let guard = SINK
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(Sink::Napi(tsfn)) = guard.as_ref()
            && tsfn.call(entry, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok
        {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
pub fn dropped_count() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

fn namespace_for_target(target: &str) -> Option<&'static str> {
    match target {
        NS_ADAPTER => Some(NS_ADAPTER),
        NS_MT => Some(NS_MT),
        NS_TRANSPORT => Some(NS_TRANSPORT),
        _ if target == "zerostack_adapter::cobs_link"
            || target.starts_with("zerostack_adapter::cobs_link::")
            || target == "zerostack_adapter::transport"
            || target.starts_with("zerostack_adapter::transport::") =>
        {
            Some(NS_TRANSPORT)
        }
        _ if target == "zerostack_adapter" || target.starts_with("zerostack_adapter::") => {
            Some(NS_ADAPTER)
        }
        _ => None,
    }
}

struct BridgeSubscriber;

impl tracing::Subscriber for BridgeSubscriber {
    fn register_callsite(&self, metadata: &'static Metadata<'static>) -> Interest {
        if self.enabled(metadata) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        namespace_for_target(metadata.target()).is_some() && enabled(from_tracing(metadata.level()))
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        if !HAS_SINK.load(Ordering::Relaxed) {
            Some(tracing::level_filters::LevelFilter::OFF)
        } else {
            Some(LogLevel::from_u8(MAX_LEVEL.load(Ordering::Relaxed)).to_filter())
        }
    }

    fn new_span(&self, _span: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }

    fn record(&self, _span: &span::Id, _values: &span::Record<'_>) {}

    fn record_follows_from(&self, _span: &span::Id, _follows: &span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let Some(namespace) = namespace_for_target(event.metadata().target()) else {
            return;
        };
        let level = from_tracing(event.metadata().level());
        if !enabled(level) {
            return;
        }
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        emit(level, namespace, visitor.finish());
    }

    fn enter(&self, _span: &span::Id) {}

    fn exit(&self, _span: &span::Id) {}
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: String,
}

impl MessageVisitor {
    fn push_field(&mut self, name: &str, value: impl fmt::Display) {
        if name == "message" {
            if self.message.is_empty() {
                let _ = write!(self.message, "{value}");
            }
            return;
        }
        if !self.fields.is_empty() {
            self.fields.push(' ');
        }
        let _ = write!(self.fields, "{name}={value}");
    }

    fn finish(mut self) -> String {
        if self.fields.is_empty() {
            self.message
        } else if self.message.is_empty() {
            self.fields
        } else {
            self.message.push(' ');
            self.message.push_str(&self.fields);
            self.message
        }
    }
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.push_field(field.name(), value);
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            if self.message.is_empty() {
                let _ = write!(self.message, "{value:?}");
            }
            return;
        }
        if !self.fields.is_empty() {
            self.fields.push(' ');
        }
        let _ = write!(self.fields, "{}={value:?}", field.name());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) struct TestLogGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl TestLogGuard {
        pub(crate) fn install(
            level: LogLevel,
            tag: &'static str,
        ) -> (Self, Arc<Mutex<Vec<LogEntry>>>) {
            let lock = TEST_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let captured = Arc::new(Mutex::new(Vec::new()));
            let out = Arc::clone(&captured);
            ensure_subscriber();
            {
                let mut guard = SINK
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *guard = Some(Sink::Custom(Arc::new(move |entry| {
                    if entry.message.contains(tag) {
                        out.lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(entry);
                    }
                })));
                HAS_SINK.store(true, Ordering::Release);
            }
            MAX_LEVEL.store(level as u8, Ordering::Relaxed);
            tracing::callsite::rebuild_interest_cache();
            (Self { _lock: lock }, captured)
        }
    }

    impl Drop for TestLogGuard {
        fn drop(&mut self) {
            {
                let mut guard = SINK
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                *guard = None;
                HAS_SINK.store(false, Ordering::Release);
            }
            MAX_LEVEL.store(LogLevel::Info as u8, Ordering::Relaxed);
            tracing::callsite::rebuild_interest_cache();
        }
    }

    #[test]
    fn level_gating_short_circuits_debug_and_trace_when_at_info() {
        let tag = "[gate-test]";
        let (_guard, captured) = TestLogGuard::install(LogLevel::Info, tag);
        let drops_before = dropped_count();

        assert!(!enabled(LogLevel::Debug));
        assert!(!enabled(LogLevel::Trace));
        assert!(enabled(LogLevel::Info));
        assert!(enabled(LogLevel::Warning));
        assert!(enabled(LogLevel::Error));

        emit(LogLevel::Debug, NS_MT, format!("{tag} should not fire"));
        emit(LogLevel::Trace, NS_MT, format!("{tag} should not fire"));
        tracing::debug!(target: "zh:zerostack:mt", "{tag} tracing debug blocked");
        tracing::info!(target: "zh:zerostack:transport", "{tag} link ready");
        tracing::warn!(target: "zh:zerostack", "{tag} warning message");
        tracing::error!(target: "zh:zerostack", "{tag} error message");

        {
            let entries = captured.lock().unwrap();
            assert_eq!(
                *entries,
                vec![
                    LogEntry {
                        level: LogLevel::Info,
                        namespace: NS_TRANSPORT,
                        message: format!("{tag} link ready"),
                    },
                    LogEntry {
                        level: LogLevel::Warning,
                        namespace: NS_ADAPTER,
                        message: format!("{tag} warning message"),
                    },
                    LogEntry {
                        level: LogLevel::Error,
                        namespace: NS_ADAPTER,
                        message: format!("{tag} error message"),
                    },
                ]
            );
        }

        // Raising the level dynamically rebuilds the tracing callsite cache too.
        set_level(LogLevel::Debug);
        assert!(enabled(LogLevel::Debug));
        assert!(!enabled(LogLevel::Trace));

        emit(LogLevel::Debug, NS_MT, format!("{tag} direct debug"));
        tracing::debug!(target: "zh:zerostack:mt", "{tag} tracing debug now enabled");
        tracing::trace!(target: "zh:zerostack:mt", "{tag} trace still blocked");

        let entries = captured.lock().unwrap();
        assert_eq!(entries.len(), 5);
        assert_eq!(
            entries[3],
            LogEntry {
                level: LogLevel::Debug,
                namespace: NS_MT,
                message: format!("{tag} direct debug"),
            }
        );
        assert_eq!(
            entries[4],
            LogEntry {
                level: LogLevel::Debug,
                namespace: NS_MT,
                message: format!("{tag} tracing debug now enabled"),
            }
        );
        assert_eq!(dropped_count(), drops_before);
    }

    #[test]
    fn targets_route_to_expected_namespaces_and_ignore_foreign_crates() {
        let tag = "[route-test]";
        let (_guard, captured) = TestLogGuard::install(LogLevel::Debug, tag);

        assert_eq!(
            namespace_for_target("zerostack_adapter::cobs_link"),
            Some(NS_TRANSPORT)
        );
        assert_eq!(
            namespace_for_target("zerostack_adapter::transport::serial"),
            Some(NS_TRANSPORT)
        );
        assert_eq!(
            namespace_for_target("zerostack_adapter::zs_protocol"),
            Some(NS_ADAPTER)
        );
        assert_eq!(
            namespace_for_target("zerostack_adapter::zs_backup"),
            Some(NS_ADAPTER)
        );
        assert_eq!(namespace_for_target("zh:zerostack:mt"), Some(NS_MT));
        assert_eq!(namespace_for_target("tokio::net"), None);

        tracing::info!(target: "zerostack_adapter::cobs_link", "{tag} cobs info");
        tracing::warn!(target: "zerostack_adapter::zs_backup", "{tag} backup warn");
        tracing::debug!(target: "zh:zerostack:mt", "{tag} mt line");
        tracing::error!(target: "tokio::net", "{tag} foreign error ignored");

        let entries = captured.lock().unwrap();
        assert_eq!(
            *entries,
            vec![
                LogEntry {
                    level: LogLevel::Info,
                    namespace: NS_TRANSPORT,
                    message: format!("{tag} cobs info"),
                },
                LogEntry {
                    level: LogLevel::Warning,
                    namespace: NS_ADAPTER,
                    message: format!("{tag} backup warn"),
                },
                LogEntry {
                    level: LogLevel::Debug,
                    namespace: NS_MT,
                    message: format!("{tag} mt line"),
                },
            ]
        );
    }

    #[test]
    fn log_level_parser_accepts_known_levels_and_rejects_unknown() {
        assert_eq!(LogLevel::parse("off"), Ok(LogLevel::Off));
        assert_eq!(LogLevel::parse("NONE"), Ok(LogLevel::Off));
        assert_eq!(LogLevel::parse("error"), Ok(LogLevel::Error));
        assert_eq!(LogLevel::parse("warn"), Ok(LogLevel::Warning));
        assert_eq!(LogLevel::parse("warning"), Ok(LogLevel::Warning));
        assert_eq!(LogLevel::parse("info"), Ok(LogLevel::Info));
        assert_eq!(LogLevel::parse("debug"), Ok(LogLevel::Debug));
        assert_eq!(LogLevel::parse("trace"), Ok(LogLevel::Trace));
        assert!(LogLevel::parse("verbose").is_err());
        assert!(LogLevel::parse("").is_err());
    }
}
