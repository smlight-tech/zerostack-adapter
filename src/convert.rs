// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::time::Duration;

use crate::cobs_link::ZsError;
use crate::zs_protocol::{ResetKind, StartResult};
use tokio::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Transport,
    Timeout,
    Delivery,
    Rejected,
    Unsupported,
    Invalid,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transport => "transport",
            Self::Timeout => "timeout",
            Self::Delivery => "delivery",
            Self::Rejected => "rejected",
            Self::Unsupported => "unsupported",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
    pub message: String,
    pub status: Option<u8>,
}

impl Failure {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: Code::Invalid,
            message: message.into(),
            status: None,
        }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            code: Code::Transport,
            message: message.into(),
            status: None,
        }
    }

    pub fn stopped() -> Self {
        Self::transport("stopped")
    }
}

impl From<ZsError> for Failure {
    fn from(error: ZsError) -> Self {
        // The code names the kind; the message carries only the detail, so JS never repeats it.
        let message = match &error {
            ZsError::Transport(m)
            | ZsError::Rejected(m)
            | ZsError::Unsupported(m)
            | ZsError::Invalid(m) => m.clone(),
            ZsError::Timeout(m) => format!("waiting for {m}"),
            ZsError::Delivery(_) => "not delivered".to_owned(),
            ZsError::Rpc { .. } => error.to_string(),
        };
        let (code, status) = match error {
            ZsError::Transport(_) => (Code::Transport, None),
            ZsError::Timeout(_) => (Code::Timeout, None),
            ZsError::Delivery(status) => (Code::Delivery, Some(status)),
            ZsError::Unsupported(_) | ZsError::Rpc { code: 1 | 2, .. } => (Code::Unsupported, None),
            ZsError::Rejected(_) | ZsError::Rpc { .. } => (Code::Rejected, None),
            ZsError::Invalid(_) => (Code::Invalid, None),
        };
        Self {
            code,
            message,
            status,
        }
    }
}

pub fn parse_eui64(field: &str, text: &str) -> Result<u64, Failure> {
    let digits = text
        .strip_prefix("0x")
        .filter(|d| d.len() == 16 && d.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| Failure::invalid(format!("{field} must be 0x and 16 hexadecimal digits")))?;
    u64::from_str_radix(digits, 16)
        .map_err(|e| Failure::invalid(format!("{field} is not hexadecimal: {e}")))
}

pub fn format_eui64(value: u64) -> String {
    format!("0x{value:016x}")
}

pub fn integer(field: &str, value: f64, max: u32) -> Result<u32, Failure> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > f64::from(max) {
        return Err(Failure::invalid(format!(
            "{field} must be an integer in 0..={max}, got {value}"
        )));
    }
    // Integral and within 0..=u32::MAX, so the cast is exact.
    Ok(value as u32)
}

pub fn to_u8(field: &str, value: f64) -> Result<u8, Failure> {
    let n = integer(field, value, u8::MAX.into())?;
    u8::try_from(n).map_err(|e| Failure::invalid(format!("{field}: {e}")))
}

pub fn to_u16(field: &str, value: f64) -> Result<u16, Failure> {
    let n = integer(field, value, u16::MAX.into())?;
    u16::try_from(n).map_err(|e| Failure::invalid(format!("{field}: {e}")))
}

pub fn to_u32(field: &str, value: f64) -> Result<u32, Failure> {
    integer(field, value, u32::MAX)
}

pub fn deadline(timeout_ms: f64) -> Result<Instant, Failure> {
    let ms = to_u32("timeoutMs", timeout_ms)?;
    if ms == 0 {
        return Err(Failure::invalid("timeoutMs must be at least 1"));
    }
    Instant::now()
        .checked_add(Duration::from_millis(u64::from(ms)))
        .ok_or_else(|| Failure::invalid(format!("timeoutMs {ms} overflows the clock")))
}

pub fn backend(text: &str) -> Result<(), Failure> {
    match text {
        "zs" => Ok(()),
        other => Err(Failure::invalid(format!(
            "backend must be zs, got {other:?}"
        ))),
    }
}

pub fn reset_kind(text: &str) -> Result<ResetKind, Failure> {
    match text {
        "soft" => Ok(ResetKind::Soft),
        "hard" => Ok(ResetKind::Hard),
        other => Err(Failure::invalid(format!(
            "reset kind must be soft or hard, got {other:?}"
        ))),
    }
}

pub fn start_result(result: StartResult) -> &'static str {
    match result {
        StartResult::Resumed => "resumed",
        StartResult::Reset => "reset",
        StartResult::Restored => "restored",
    }
}

pub fn broadcast_destination(value: f64) -> Result<u16, Failure> {
    match to_u16("destination", value)? {
        d @ (0xffff | 0xfffd | 0xfffc) => Ok(d),
        d => Err(Failure::invalid(format!(
            "destination must be 0xffff, 0xfffd or 0xfffc, got 0x{d:04x}"
        ))),
    }
}

pub fn key16(field: &str, bytes: &[u8]) -> Result<[u8; 16], Failure> {
    <[u8; 16]>::try_from(bytes)
        .map_err(|_| Failure::invalid(format!("{field} must be 16 bytes, got {}", bytes.len())))
}

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

pub fn version_number(key: &str, value: i64) -> Result<f64, Failure> {
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(Failure {
            code: Code::Unsupported,
            message: format!(
                "version field {key} = {value} exceeds JavaScript's exact integer range"
            ),
            status: None,
        });
    }
    // Within ±(2^53 - 1), so exact.
    Ok(value as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eui64_round_trips_and_accepts_either_case() {
        assert_eq!(
            parse_eui64("ieeeAddr", "0x00124b0012345678"),
            Ok(0x0012_4b00_1234_5678)
        );
        assert_eq!(
            parse_eui64("ieeeAddr", "0xDEADBEEF00C0FFEE"),
            Ok(0xdead_beef_00c0_ffee)
        );
        assert_eq!(format_eui64(0x0012_4b00_1234_5678), "0x00124b0012345678");
        assert_eq!(format_eui64(1), "0x0000000000000001");
        assert_eq!(parse_eui64("x", &format_eui64(u64::MAX)), Ok(u64::MAX));
    }

    #[test]
    fn eui64_rejects_every_other_shape() {
        for bad in [
            "",
            "0x",
            "00124b0012345678",
            "0X00124b0012345678",
            "0x00124b001234567",
            "0x00124b00123456789",
            "0x00124b001234567g",
            "0x+0124b0012345678",
            " 0x00124b0012345678",
            "0x00124b0012345678 ",
            "0x00124b00-2345678",
        ] {
            let error = parse_eui64("ieeeAddr", bad).expect_err(bad);
            assert_eq!(error.code, Code::Invalid, "{bad}");
            assert!(error.message.starts_with("ieeeAddr "), "{}", error.message);
        }
    }

    #[test]
    fn integers_are_range_checked_never_truncated() {
        assert_eq!(to_u8("radius", 0.0), Ok(0));
        assert_eq!(to_u8("radius", 255.0), Ok(255));
        assert_eq!(to_u8("radius", -0.0), Ok(0));
        assert_eq!(to_u16("clusterId", 65535.0), Ok(0xffff));
        assert_eq!(to_u32("rxCounter", 4_294_967_295.0), Ok(u32::MAX));
        for bad in [
            256.0,
            -1.0,
            1.5,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            1e300,
        ] {
            assert_eq!(
                to_u8("radius", bad).map_err(|e| e.code),
                Err(Code::Invalid),
                "{bad}"
            );
        }
        for bad in [65536.0, -0.5, 0.1] {
            assert_eq!(
                to_u16("clusterId", bad).map_err(|e| e.code),
                Err(Code::Invalid),
                "{bad}"
            );
        }
        assert_eq!(
            to_u32("rxCounter", 4_294_967_296.0).map_err(|e| e.code),
            Err(Code::Invalid)
        );
    }

    #[test]
    fn deadline_needs_a_positive_integer_timeout() {
        let before = Instant::now();
        let deadline = deadline(1500.0).expect("valid timeout");
        let ahead = deadline.duration_since(before);
        assert!(ahead >= Duration::from_millis(1500), "{ahead:?}");
        assert!(ahead < Duration::from_millis(1500 + 60_000), "{ahead:?}");
        for bad in [0.0, -1.0, 2.5, f64::NAN, 4_294_967_296.0] {
            assert_eq!(
                super::deadline(bad).map_err(|e| e.code),
                Err(Code::Invalid),
                "{bad}"
            );
        }
    }

    #[test]
    fn names_map_both_ways() {
        assert_eq!(backend("zs"), Ok(()));
        for bad in ["ZS", "znp", "zhs", "espzb", "ezsp", "zstack", ""] {
            assert_eq!(
                backend(bad).map_err(|e| e.code),
                Err(Code::Invalid),
                "{bad:?}"
            );
        }
        assert_eq!(reset_kind("soft"), Ok(ResetKind::Soft));
        assert_eq!(reset_kind("hard"), Ok(ResetKind::Hard));
        assert_eq!(reset_kind("warm").map_err(|e| e.code), Err(Code::Invalid));
        assert_eq!(start_result(StartResult::Resumed), "resumed");
        assert_eq!(start_result(StartResult::Reset), "reset");
        assert_eq!(start_result(StartResult::Restored), "restored");
    }

    #[test]
    fn broadcast_destination_is_one_of_three() {
        assert_eq!(broadcast_destination(65535.0), Ok(0xffff));
        assert_eq!(broadcast_destination(65533.0), Ok(0xfffd));
        assert_eq!(broadcast_destination(65532.0), Ok(0xfffc));
        for bad in [65534.0, 65531.0, 0.0, 65536.0] {
            assert_eq!(
                broadcast_destination(bad).map_err(|e| e.code),
                Err(Code::Invalid),
                "{bad}"
            );
        }
    }

    #[test]
    fn key16_takes_exactly_sixteen_bytes() {
        let key: Vec<u8> = (1..=16).collect();
        assert_eq!(
            key16("networkKey", &key),
            Ok([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
        );
        assert_eq!(
            key16("networkKey", &key[..15]).map_err(|e| e.message),
            Err("networkKey must be 16 bytes, got 15".to_owned())
        );
        assert_eq!(
            key16("networkKey", &[0; 17]).map_err(|e| e.code),
            Err(Code::Invalid)
        );
        assert_eq!(
            key16("networkKey", &[]).map_err(|e| e.code),
            Err(Code::Invalid)
        );
    }

    #[test]
    fn raw_errors_keep_their_code_and_status() {
        let cases = [
            (
                ZsError::Transport("closed".into()),
                Code::Transport,
                None,
                "closed",
            ),
            (
                ZsError::Timeout("SRSP".into()),
                Code::Timeout,
                None,
                "waiting for SRSP",
            ),
            (
                ZsError::Rpc {
                    code: 2,
                    cmd0: 0x21,
                    cmd1: 0x73,
                },
                Code::Unsupported,
                None,
                "coordinator RPC error 2 for command 0x21 0x73",
            ),
            (
                ZsError::Rpc {
                    code: 3,
                    cmd0: 0x21,
                    cmd1: 0x73,
                },
                Code::Rejected,
                None,
                "coordinator RPC error 3 for command 0x21 0x73",
            ),
            (
                ZsError::Delivery(0xe9),
                Code::Delivery,
                Some(0xe9),
                "not delivered",
            ),
            (
                ZsError::Rejected("busy".into()),
                Code::Rejected,
                None,
                "busy",
            ),
            (
                ZsError::Unsupported("interpan".into()),
                Code::Unsupported,
                None,
                "interpan",
            ),
            (
                ZsError::Invalid("radius".into()),
                Code::Invalid,
                None,
                "radius",
            ),
        ];
        for (error, code, status, message) in cases {
            let failure = Failure::from(error);
            assert_eq!(
                failure,
                Failure {
                    code,
                    message: message.to_owned(),
                    status
                }
            );
        }
        let names: Vec<&str> = [
            Code::Transport,
            Code::Timeout,
            Code::Delivery,
            Code::Rejected,
            Code::Unsupported,
            Code::Invalid,
        ]
        .into_iter()
        .map(Code::as_str)
        .collect();
        assert_eq!(
            names,
            [
                "transport",
                "timeout",
                "delivery",
                "rejected",
                "unsupported",
                "invalid"
            ]
        );
        assert_eq!(
            Failure::stopped(),
            Failure {
                code: Code::Transport,
                message: "stopped".to_owned(),
                status: None
            }
        );
    }

    #[test]
    fn version_numbers_stay_exact() {
        assert_eq!(version_number("revision", 20_240_710), Ok(20_240_710.0));
        assert_eq!(
            version_number("revision", -MAX_SAFE_INTEGER),
            Ok(-9_007_199_254_740_991.0)
        );
        assert_eq!(
            version_number("revision", MAX_SAFE_INTEGER),
            Ok(9_007_199_254_740_991.0)
        );
        assert_eq!(
            version_number("revision", MAX_SAFE_INTEGER + 1).map_err(|e| e.code),
            Err(Code::Unsupported)
        );
        assert_eq!(
            version_number("revision", i64::MIN).map_err(|e| e.code),
            Err(Code::Unsupported)
        );
    }
}
