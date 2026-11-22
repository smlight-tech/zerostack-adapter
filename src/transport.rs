// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::io;
use std::net::IpAddr;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::{Instant, timeout_at};
use tokio_serial::{
    DataBits, FlowControl, Parity, SerialPort, SerialPortBuilderExt, SerialStream, StopBits,
};

use crate::cobs_link::ZsError;

const BAUD_RATES: [u32; 10] = [
    9600, 19200, 38400, 57600, 115_200, 230_400, 460_800, 921_600, 1_000_000, 2_000_000,
];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub trait Port: AsyncRead + AsyncWrite + Send + Unpin {
    // Drops unsent output so closing never waits on a held CTS line.
    fn discard_output(&mut self) -> io::Result<()>;
}

impl Port for TcpStream {
    fn discard_output(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Port for tokio::io::DuplexStream {
    fn discard_output(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Port for SerialStream {
    fn discard_output(&mut self) -> io::Result<()> {
        self.clear(tokio_serial::ClearBuffer::Output)?;
        self.set_flow_control(FlowControl::None)?;
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Address {
    Serial(String),
    Tcp(String, u16),
}

pub fn parse(address: &str) -> Result<Address, ZsError> {
    if let Some(path) = address.strip_prefix("serial:") {
        return serial_path(path).map(|p| Address::Serial(p.to_owned()));
    }
    if address.starts_with("tls:") {
        return Err(ZsError::Unsupported(
            "tls: transports are not supported".into(),
        ));
    }
    let rest = address
        .strip_prefix("tcp://")
        .or_else(|| address.strip_prefix("tcp:"))
        .ok_or_else(|| {
            ZsError::Invalid(format!("transport {address:?} is not serial: or tcp://"))
        })?;
    let (host, port) = rest
        .rsplit_once(':')
        .ok_or_else(|| ZsError::Invalid(format!("transport {address:?} lacks a port")))?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| ZsError::Invalid(format!("transport port {port:?} is not 1..65535")))?;
    let host = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(v6) => match v6.parse::<IpAddr>() {
            Ok(ip @ IpAddr::V6(_)) => ip,
            _ => return Err(ZsError::Invalid(format!("{host:?} is not an IPv6 literal"))),
        },
        None => match host.parse::<IpAddr>() {
            Ok(ip @ IpAddr::V4(_)) => ip,
            _ if dns_name(host) => return Ok(Address::Tcp(host.to_owned(), port)),
            _ => {
                return Err(ZsError::Invalid(format!(
                    "{host:?} is not a host name or IP"
                )));
            }
        },
    };
    if host.is_unspecified() || host.is_multicast() {
        return Err(ZsError::Invalid(format!("{host} is not a unicast address")));
    }
    Ok(Address::Tcp(host.to_string(), port))
}

fn serial_path(path: &str) -> Result<&str, ZsError> {
    let ok = if cfg!(windows) {
        let name = path.strip_prefix(r"\\.\").unwrap_or(path);
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    } else {
        path.starts_with('/') && !path.contains('\0')
    };
    if ok {
        Ok(path)
    } else {
        Err(ZsError::Invalid(format!(
            "serial path {path:?} is not valid"
        )))
    }
}

fn dns_name(host: &str) -> bool {
    let name = host.strip_suffix('.').unwrap_or(host);
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

pub async fn open(
    address: &str,
    baud: u32,
    rtscts: bool,
    deadline: Instant,
) -> Result<Box<dyn Port>, ZsError> {
    match parse(address)? {
        Address::Serial(path) => {
            if !BAUD_RATES.contains(&baud) {
                return Err(ZsError::Invalid(format!(
                    "baud rate {baud} is not supported"
                )));
            }
            let flow = if rtscts {
                FlowControl::Hardware
            } else {
                FlowControl::None
            };
            let mut port = tokio_serial::new(&path, baud)
                .data_bits(DataBits::Eight)
                .parity(Parity::None)
                .stop_bits(StopBits::One)
                .flow_control(flow)
                .preserve_dtr_on_open()
                .open_native_async()
                .map_err(|e| ZsError::Transport(format!("opening {path}: {e}")))?;
            #[cfg(unix)]
            port.set_exclusive(true)
                .map_err(|e| ZsError::Transport(format!("locking {path}: {e}")))?;
            Ok(Box::new(port))
        }
        Address::Tcp(host, port) => {
            let bound = deadline.min(Instant::now() + CONNECT_TIMEOUT);
            let stream = timeout_at(bound, TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| ZsError::Timeout(format!("connecting to {host}:{port}")))?
                .map_err(|e| ZsError::Transport(format!("connecting to {host}:{port}: {e}")))?;
            stream
                .set_nodelay(true)
                .map_err(|e| ZsError::Transport(format!("TCP_NODELAY: {e}")))?;
            Ok(Box::new(stream))
        }
    }
}

impl Port for Box<dyn Port> {
    fn discard_output(&mut self) -> io::Result<()> {
        (**self).discard_output()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_parse_or_fail_with_their_code() {
        assert_eq!(
            parse("tcp://192.0.2.5:6638"),
            Ok(Address::Tcp("192.0.2.5".into(), 6638))
        );
        assert_eq!(
            parse("tcp:[fd00::1]:6638"),
            Ok(Address::Tcp("fd00::1".into(), 6638))
        );
        assert_eq!(
            parse("tcp://coordinator.example:1"),
            Ok(Address::Tcp("coordinator.example".into(), 1))
        );
        assert!(matches!(
            parse("tls:host:6638"),
            Err(ZsError::Unsupported(_))
        ));
        for bad in [
            "tcp://0.0.0.0:1",
            "tcp://224.0.0.1:1",
            "tcp://host:0",
            "tcp://-bad:1",
            "udp://host:1",
            "tcp://host",
        ] {
            assert!(matches!(parse(bad), Err(ZsError::Invalid(_))), "{bad}");
        }
        #[cfg(unix)]
        {
            assert_eq!(
                parse("serial:/dev/ttyUSB0"),
                Ok(Address::Serial("/dev/ttyUSB0".into()))
            );
            assert!(matches!(parse("serial:ttyUSB0"), Err(ZsError::Invalid(_))));
        }
    }
}
