// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

use std::fmt::Write as _;

use crate::cobs_link::{AREQ, Frame, SREQ};
use crate::convert::format_eui64;

const TYPE_MASK: u8 = 0xE0;
const SUBSYS_MASK: u8 = 0x1F;

const SUB_RPC_ERROR: u8 = 0x00;
const SUB_SYS: u8 = 0x01;
const SUB_AF: u8 = 0x04;
const SUB_ZDO: u8 = 0x05;
const SUB_APP_CNF: u8 = 0x0F;

fn u16_le(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

fn u32_le(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

fn u64_le(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}

pub const fn is_sensitive_osal_nv(id: u16) -> bool {
    matches!(
        id,
        0x003A
            | 0x003B
            | 0x004C
            | 0x0062
            | 0x0069
            | 0x006A
            | 0x006F
            | 0x0070
            | 0x0075..=0x007F
            | 0x0082
            | 0x00C2
            | 0x00C3
            | 0x00C5
            | 0x00D1..=0x00D3
            | 0x0100..=0x01FF
            | 0x0201..=0x02FF
    )
}

pub const fn is_sensitive_ex_nv(sysid: u8, itemid: u16, subid: u16) -> bool {
    sysid == 0x01
        && ((itemid == 0x0000 && is_sensitive_osal_nv(subid)) || matches!(itemid, 0x0004..=0x0007))
}

pub fn request_reads_sensitive(frame: &Frame) -> bool {
    if frame.cmd0 & TYPE_MASK != SREQ || frame.cmd0 & SUBSYS_MASK != SUB_SYS {
        return false;
    }
    let d = &frame.data;
    match frame.cmd1 {
        // SYS_OSAL_NV_READ / SYS_OSAL_NV_READ_EXT: fail-closed when short.
        0x08 | 0x1C => d.len() < 2 || is_sensitive_osal_nv(u16_le(d, 0)),
        // SYS_NV_READ: fail-closed when short.
        0x33 => d.len() < 5 || is_sensitive_ex_nv(d[0], u16_le(d, 1), u16_le(d, 3)),
        0x70 => true,
        _ => false,
    }
}

pub fn format_tx(frame: &Frame) -> String {
    let dir = match frame.cmd0 & TYPE_MASK {
        SREQ => "--> SREQ",
        AREQ => "--> AREQ",
        _ => "--> FRAME",
    };
    let subsys = frame.cmd0 & SUBSYS_MASK;
    let (sub_name, cmd_name, payload) = match (subsys, frame.cmd1) {
        (SUB_SYS, _) => (
            "SYS",
            sys_name(frame.cmd1),
            format_sys_tx(frame.cmd1, &frame.data),
        ),
        (SUB_AF, _) => (
            "AF",
            af_name(frame.cmd1),
            format_af_tx(frame.cmd1, &frame.data),
        ),
        (SUB_ZDO, _) => (
            "ZDO",
            zdo_name(frame.cmd1),
            format_zdo_tx(frame.cmd1, &frame.data),
        ),
        (SUB_APP_CNF, _) => (
            "APP_CNF",
            app_cnf_name(frame.cmd1),
            format_app_cnf_tx(frame.cmd1, &frame.data),
        ),
        _ => return format_unknown(dir, subsys, frame.cmd1, frame.data.len()),
    };
    format!("{dir}: {sub_name} - {cmd_name} - {payload}")
}

pub fn format_srsp(frame: &Frame, redacted_read: Option<bool>) -> String {
    let subsys = frame.cmd0 & SUBSYS_MASK;
    if subsys == SUB_RPC_ERROR && frame.cmd1 == 0x00 {
        let d = &frame.data;
        let payload = if d.len() >= 3 {
            format!(
                "{{\"status\":{},\"cmd0\":{},\"cmd1\":{}}}",
                d[0], d[1], d[2]
            )
        } else {
            format!("{{\"len\":{}}}", d.len())
        };
        return format!("<-- SRSP: RPC_ERROR - error - {payload}");
    }
    let (sub_name, cmd_name, payload) = match subsys {
        SUB_SYS => (
            "SYS",
            sys_name(frame.cmd1),
            format_sys_srsp(frame.cmd1, &frame.data, redacted_read),
        ),
        SUB_AF => ("AF", af_name(frame.cmd1), format_status_or_len(&frame.data)),
        SUB_ZDO => (
            "ZDO",
            zdo_name(frame.cmd1),
            format_zdo_srsp(frame.cmd1, &frame.data),
        ),
        SUB_APP_CNF => (
            "APP_CNF",
            app_cnf_name(frame.cmd1),
            format_status_or_len(&frame.data),
        ),
        _ => return format_unknown("<-- SRSP", subsys, frame.cmd1, frame.data.len()),
    };
    format!("<-- SRSP: {sub_name} - {cmd_name} - {payload}")
}

pub fn format_areq(frame: &Frame) -> String {
    let subsys = frame.cmd0 & SUBSYS_MASK;
    let (sub_name, cmd_name, payload) = match subsys {
        SUB_SYS => (
            "SYS",
            sys_name(frame.cmd1),
            format_sys_areq(frame.cmd1, &frame.data),
        ),
        SUB_AF => (
            "AF",
            af_name(frame.cmd1),
            format_af_areq(frame.cmd1, &frame.data),
        ),
        SUB_ZDO => (
            "ZDO",
            zdo_name(frame.cmd1),
            format_zdo_areq(frame.cmd1, &frame.data),
        ),
        SUB_APP_CNF => (
            "APP_CNF",
            app_cnf_name(frame.cmd1),
            format_app_cnf_areq(frame.cmd1, &frame.data),
        ),
        _ => return format_unknown("<-- AREQ", subsys, frame.cmd1, frame.data.len()),
    };
    format!("<-- AREQ: {sub_name} - {cmd_name} - {payload}")
}

fn format_unknown(prefix: &str, subsys: u8, cmd1: u8, len: usize) -> String {
    format!("{prefix}: SUBSYS_0x{subsys:02x} - cmd_0x{cmd1:02x} - {{\"len\":{len}}}")
}

fn format_status_or_len(d: &[u8]) -> String {
    if let Some(&status) = d.first() {
        format!("{{\"status\":{status}}}")
    } else {
        "{\"len\":0}".to_owned()
    }
}

fn sys_name(cmd1: u8) -> String {
    match cmd1 {
        0x00 => "resetReq".to_owned(),
        0x01 => "ping".to_owned(),
        0x02 => "version".to_owned(),
        0x04 => "getExtAddr".to_owned(),
        0x07 => "osalNvItemInit".to_owned(),
        0x08 => "osalNvRead".to_owned(),
        0x09 => "osalNvWrite".to_owned(),
        0x13 => "osalNvLength".to_owned(),
        0x1C => "osalNvReadExt".to_owned(),
        0x1D => "osalNvWriteExt".to_owned(),
        0x30 => "nvCreate".to_owned(),
        0x32 => "nvLength".to_owned(),
        0x33 => "nvRead".to_owned(),
        0x34 => "nvWrite".to_owned(),
        0x35 => "nvUpdate".to_owned(),
        0x70 => "zsBackupExport".to_owned(),
        0x71 => "zsBackupImport".to_owned(),
        0x73 => "zsCaps".to_owned(),
        0x80 => "resetInd".to_owned(),
        other => format!("cmd_0x{other:02x}"),
    }
}

fn af_name(cmd1: u8) -> String {
    match cmd1 {
        0x00 => "register".to_owned(),
        0x01 => "dataRequest".to_owned(),
        0x02 => "dataRequestExt".to_owned(),
        0x04 => "delete".to_owned(),
        0x10 => "interPanCtl".to_owned(),
        0x80 => "dataConfirm".to_owned(),
        // Both legacy 0x81 and extended 0x84 report as `incomingMsg` for trace parity.
        0x81 | 0x84 => "incomingMsg".to_owned(),
        0x82 => "incomingMsgExt".to_owned(),
        other => format!("cmd_0x{other:02x}"),
    }
}

fn zdo_name(cmd1: u8) -> String {
    match cmd1 {
        0x00 => "nwkAddrReq".to_owned(),
        0x01 => "ieeeAddrReq".to_owned(),
        0x02 => "nodeDescReq".to_owned(),
        0x03 => "powerDescReq".to_owned(),
        0x04 => "simpleDescReq".to_owned(),
        0x05 => "activeEpReq".to_owned(),
        0x06 => "matchDescReq".to_owned(),
        0x21 => "bindReq".to_owned(),
        0x22 => "unbindReq".to_owned(),
        0x30 => "mgmtNwkDiscReq".to_owned(),
        0x31 => "mgmtLqiReq".to_owned(),
        0x32 => "mgmtRtgReq".to_owned(),
        0x33 => "mgmtBindReq".to_owned(),
        0x34 => "mgmtLeaveReq".to_owned(),
        0x36 => "mgmtPermitJoinReq".to_owned(),
        0x37 => "mgmtNwkUpdateReq".to_owned(),
        0x3E => "msgCbRegister".to_owned(),
        0x40 => "startupFromApp".to_owned(),
        0x50 => "extNwkInfo".to_owned(),
        0xB6 => "mgmtPermitJoinRsp".to_owned(),
        0xC0 => "stateChangeInd".to_owned(),
        0xC1 => "endDeviceAnnceInd".to_owned(),
        0xC4 => "srcRtgInd".to_owned(),
        0xC8 => "concentratorIndCb".to_owned(),
        0xC9 => "leaveInd".to_owned(),
        0xCA => "tcDeviceInd".to_owned(),
        0xFF => "msgCbIncoming".to_owned(),
        other => format!("cmd_0x{other:02x}"),
    }
}

fn app_cnf_name(cmd1: u8) -> String {
    match cmd1 {
        0x04 => "bdbAddInstallCode".to_owned(),
        0x80 => "bdbComissioningNotifcation".to_owned(),
        other => format!("cmd_0x{other:02x}"),
    }
}

fn format_sys_tx(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x00 if !d.is_empty() => format!("{{\"type\":{}}}", d[0]),
        0x01 | 0x02 | 0x04 => "{}".to_owned(),
        0x07 if d.len() >= 5 => {
            let id = u16_le(d, 0);
            let len = u16_le(d, 2);
            let initlen = d[4];
            if is_sensitive_osal_nv(id) {
                format!(
                    "{{\"id\":{id},\"len\":{len},\"initlen\":{initlen},\"initvalue\":\"[REDACTED]\"}}"
                )
            } else {
                format!("{{\"id\":{id},\"len\":{len},\"initlen\":{initlen}}}")
            }
        }
        0x08 if d.len() >= 3 => {
            format!("{{\"id\":{},\"offset\":{}}}", u16_le(d, 0), d[2])
        }
        0x09 if d.len() >= 4 => {
            let id = u16_le(d, 0);
            if is_sensitive_osal_nv(id) {
                format!(
                    "{{\"id\":{id},\"offset\":{},\"len\":{},\"value\":\"[REDACTED]\"}}",
                    d[2], d[3]
                )
            } else {
                format!("{{\"id\":{id},\"offset\":{},\"len\":{}}}", d[2], d[3])
            }
        }
        0x13 if d.len() >= 2 => format!("{{\"id\":{}}}", u16_le(d, 0)),
        0x1C if d.len() >= 4 => {
            format!("{{\"id\":{},\"offset\":{}}}", u16_le(d, 0), u16_le(d, 2))
        }
        0x1D if d.len() >= 6 => {
            let id = u16_le(d, 0);
            let offset = u16_le(d, 2);
            let len = u16_le(d, 4);
            if is_sensitive_osal_nv(id) {
                format!(
                    "{{\"id\":{id},\"offset\":{offset},\"len\":{len},\"value\":\"[REDACTED]\"}}"
                )
            } else {
                format!("{{\"id\":{id},\"offset\":{offset},\"len\":{len}}}")
            }
        }
        0x30 if d.len() >= 9 => format!(
            "{{\"sysid\":{},\"itemid\":{},\"subid\":{},\"len\":{}}}",
            d[0],
            u16_le(d, 1),
            u16_le(d, 3),
            u32_le(d, 5)
        ),
        0x32 if d.len() >= 5 => format!(
            "{{\"sysid\":{},\"itemid\":{},\"subid\":{}}}",
            d[0],
            u16_le(d, 1),
            u16_le(d, 3)
        ),
        0x33 if d.len() >= 8 => format!(
            "{{\"sysid\":{},\"itemid\":{},\"subid\":{},\"offset\":{},\"len\":{}}}",
            d[0],
            u16_le(d, 1),
            u16_le(d, 3),
            u16_le(d, 5),
            d[7]
        ),
        0x34 if d.len() >= 8 => {
            let sysid = d[0];
            let itemid = u16_le(d, 1);
            let subid = u16_le(d, 3);
            let offset = u16_le(d, 5);
            let len = d[7];
            if is_sensitive_ex_nv(sysid, itemid, subid) {
                format!(
                    "{{\"sysid\":{sysid},\"itemid\":{itemid},\"subid\":{subid},\"offset\":{offset},\"len\":{len},\"value\":\"[REDACTED]\"}}"
                )
            } else {
                format!(
                    "{{\"sysid\":{sysid},\"itemid\":{itemid},\"subid\":{subid},\"offset\":{offset},\"len\":{len}}}"
                )
            }
        }
        0x35 if d.len() >= 6 => {
            let sysid = d[0];
            let itemid = u16_le(d, 1);
            let subid = u16_le(d, 3);
            let len = d[5];
            if is_sensitive_ex_nv(sysid, itemid, subid) {
                format!(
                    "{{\"sysid\":{sysid},\"itemid\":{itemid},\"subid\":{subid},\"len\":{len},\"value\":\"[REDACTED]\"}}"
                )
            } else {
                format!("{{\"sysid\":{sysid},\"itemid\":{itemid},\"subid\":{subid},\"len\":{len}}}")
            }
        }
        0x70 if d.len() >= 4 => {
            format!("{{\"cursor\":{},\"gen\":{}}}", u16_le(d, 0), u16_le(d, 2))
        }
        0x71 if !d.is_empty() => format!(
            "{{\"op\":{},\"data\":\"[REDACTED]\",\"len\":{}}}",
            d[0],
            d.len().saturating_sub(1)
        ),
        0x73 if d.len() >= 3 => {
            format!(
                "{{\"version\":{},\"want\":{},\"window\":{}}}",
                d[0], d[1], d[2]
            )
        }
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_nv_read_srsp(d: &[u8], redacted: Option<bool>) -> String {
    if d.len() < 2 {
        return format_status_or_len(d);
    }
    if redacted.unwrap_or(true) {
        format!(
            "{{\"status\":{},\"len\":{},\"value\":\"[REDACTED]\"}}",
            d[0], d[1]
        )
    } else {
        format!("{{\"status\":{},\"len\":{}}}", d[0], d[1])
    }
}

fn format_sys_srsp(cmd1: u8, d: &[u8], redacted_read: Option<bool>) -> String {
    match cmd1 {
        0x01 if d.len() >= 2 => format!("{{\"capabilities\":{}}}", u16_le(d, 0)),
        0x02 if d.len() >= 9 => format!(
            "{{\"transportrev\":{},\"product\":{},\"majorrel\":{},\"minorrel\":{},\"maintrel\":{},\"revision\":{}}}",
            d[0],
            d[1],
            d[2],
            d[3],
            d[4],
            u32_le(d, 5)
        ),
        0x02 if d.len() >= 5 => format!(
            "{{\"transportrev\":{},\"product\":{},\"majorrel\":{},\"minorrel\":{},\"maintrel\":{}}}",
            d[0], d[1], d[2], d[3], d[4]
        ),
        0x04 if d.len() >= 8 => format!("{{\"extaddress\":\"{}\"}}", format_eui64(u64_le(d, 0))),
        0x08 | 0x1C | 0x33 => format_nv_read_srsp(d, redacted_read),
        0x13 if d.len() >= 2 => format!("{{\"length\":{}}}", u16_le(d, 0)),
        0x32 => match d.len() {
            n if n >= 4 => format!("{{\"len\":{}}}", u32_le(d, 0)),
            2 | 3 => format!("{{\"len\":{}}}", u16_le(d, 0)),
            1 => format!("{{\"len\":{}}}", d[0]),
            _ => "{\"len\":0}".to_owned(),
        },
        0x70 if d.len() >= 5 => format!(
            "{{\"status\":{},\"gen\":{},\"next\":{},\"data\":\"[REDACTED]\",\"len\":{}}}",
            d[0],
            u16_le(d, 1),
            u16_le(d, 3),
            d.len().saturating_sub(5)
        ),
        0x70 if !d.is_empty() => format!(
            "{{\"status\":{},\"data\":\"[REDACTED]\",\"len\":{}}}",
            d[0],
            d.len().saturating_sub(1)
        ),
        0x71 if d.len() >= 4 => format!(
            "{{\"status\":{},\"op\":{},\"accepted\":{}}}",
            d[0],
            d[1],
            u16_le(d, 2)
        ),
        0x73 if d.len() >= 11 => format!(
            "{{\"status\":{},\"version\":{},\"have\":{},\"rxBudget\":{},\"nodes\":{},\"features\":{}}}",
            d[0],
            d[1],
            d[2],
            u16_le(d, 3),
            u16_le(d, 5),
            u32_le(d, 7)
        ),
        _ => format_status_or_len(d),
    }
}

fn format_sys_areq(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x71 if d.len() >= 2 => format!("{{\"op\":{},\"status\":{}}}", d[0], d[1]),
        0x80 if d.len() >= 6 => format!(
            "{{\"reason\":{},\"transportrev\":{},\"productid\":{},\"majorrel\":{},\"minorrel\":{},\"hwrev\":{}}}",
            d[0], d[1], d[2], d[3], d[4], d[5]
        ),
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_af_tx(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x00 if d.len() >= 5 => format!(
            "{{\"endpoint\":{},\"appprofid\":{},\"appdeviceid\":{}}}",
            d[0],
            u16_le(d, 1),
            u16_le(d, 3)
        ),
        0x01 if d.len() >= 10 => format!(
            "{{\"dstaddr\":{},\"destendpoint\":{},\"srcendpoint\":{},\"clusterid\":{},\"transid\":{},\"options\":{},\"radius\":{},\"len\":{}}}",
            u16_le(d, 0),
            d[2],
            d[3],
            u16_le(d, 4),
            d[6],
            d[7],
            d[8],
            d[9]
        ),
        0x02 if d.len() >= 20 => {
            let mode = d[0];
            let dst = if mode == 1 || mode == 2 {
                u16_le(d, 1).to_string()
            } else {
                format!("\"{}\"", format_eui64(u64_le(d, 1)))
            };
            format!(
                "{{\"dstaddrmode\":{mode},\"dstaddr\":{dst},\"destendpoint\":{},\"dstpanid\":{},\"srcendpoint\":{},\"clusterid\":{},\"transid\":{},\"options\":{},\"radius\":{},\"len\":{}}}",
                d[9],
                u16_le(d, 10),
                d[12],
                u16_le(d, 13),
                d[15],
                d[16],
                d[17],
                u16_le(d, 18)
            )
        }
        0x04 if !d.is_empty() => format!("{{\"endpoint\":{}}}", d[0]),
        0x10 if !d.is_empty() => {
            format!("{{\"cmd\":{},\"len\":{}}}", d[0], d.len().saturating_sub(1))
        }
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_af_areq(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x80 if d.len() >= 10 => format!(
            "{{\"status\":{},\"endpoint\":{},\"transid\":{},\"dstaddr\":{},\"seq\":{}}}",
            d[0],
            d[1],
            d[2],
            u16_le(d, 3),
            d[5]
        ),
        0x80 if d.len() >= 3 => format!(
            "{{\"status\":{},\"endpoint\":{},\"transid\":{}}}",
            d[0], d[1], d[2]
        ),
        0x81 if d.len() >= 17 => format!(
            "{{\"groupid\":{},\"clusterid\":{},\"srcaddr\":{},\"srcendpoint\":{},\"dstendpoint\":{},\"wasbroadcast\":{},\"linkquality\":{},\"len\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2),
            u16_le(d, 4),
            d[6],
            d[7],
            d[8],
            d[9],
            d[16]
        ),
        0x84 if d.len() >= 25 => format!(
            "{{\"groupid\":{},\"clusterid\":{},\"srcaddr\":{},\"srcendpoint\":{},\"dstendpoint\":{},\"wasbroadcast\":{},\"linkquality\":{},\"rssi\":{},\"len\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2),
            u16_le(d, 4),
            d[14],
            d[15],
            u8::from(d[16] & 1 != 0),
            d[17],
            d[18] as i8,
            d[24]
        ),
        0x82 if d.len() >= 27 => {
            let mode = d[4];
            let src = if mode == 2 {
                u16_le(d, 5).to_string()
            } else {
                format!("\"{}\"", format_eui64(u64_le(d, 5)))
            };
            format!(
                "{{\"groupid\":{},\"clusterid\":{},\"srcaddrmode\":{mode},\"srcaddr\":{src},\"srcendpoint\":{},\"dstendpoint\":{},\"wasbroadcast\":{},\"linkquality\":{},\"len\":{}}}",
                u16_le(d, 0),
                u16_le(d, 2),
                d[13],
                d[16],
                d[17],
                d[18],
                u16_le(d, 25)
            )
        }
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_zdo_tx(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x00 if d.len() >= 10 => format!(
            "{{\"ieeeaddr\":\"{}\",\"reqtype\":{},\"startindex\":{}}}",
            format_eui64(u64_le(d, 0)),
            d[8],
            d[9]
        ),
        0x01 if d.len() >= 4 => format!(
            "{{\"shortaddr\":{},\"reqtype\":{},\"startindex\":{}}}",
            u16_le(d, 0),
            d[2],
            d[3]
        ),
        0x02 | 0x03 | 0x05 if d.len() >= 4 => format!(
            "{{\"dstaddr\":{},\"nwkaddrofinterest\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2)
        ),
        0x04 if d.len() >= 5 => format!(
            "{{\"dstaddr\":{},\"nwkaddrofinterest\":{},\"endpoint\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2),
            d[4]
        ),
        0x06 if d.len() >= 6 => format!(
            "{{\"dstaddr\":{},\"nwkaddrofinterest\":{},\"profileid\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2),
            u16_le(d, 4)
        ),
        0x21 | 0x22 if d.len() >= 13 => format!(
            "{{\"dstaddr\":{},\"clusterid\":{}}}",
            u16_le(d, 0),
            u16_le(d, 11)
        ),
        0x30 if d.len() >= 8 => format!(
            "{{\"dstaddr\":{},\"scanchannels\":{},\"scanduration\":{},\"startindex\":{}}}",
            u16_le(d, 0),
            u32_le(d, 2),
            d[6],
            d[7]
        ),
        0x31..=0x33 if d.len() >= 3 => {
            format!("{{\"dstaddr\":{},\"startindex\":{}}}", u16_le(d, 0), d[2])
        }
        0x34 if d.len() >= 11 => format!(
            "{{\"dstaddr\":{},\"deviceaddress\":\"{}\",\"removechildren_rejoin\":{}}}",
            u16_le(d, 0),
            format_eui64(u64_le(d, 2)),
            d[10]
        ),
        0x36 if d.len() >= 5 => format!(
            "{{\"addrmode\":{},\"dstaddr\":{},\"duration\":{},\"tcsignificance\":{}}}",
            d[0],
            u16_le(d, 1),
            d[3],
            d[4]
        ),
        0x37 if d.len() >= 8 => format!(
            "{{\"dstaddr\":{},\"dstaddrmode\":{},\"channelmask\":{},\"scanduration\":{},\"scancount\":{}}}",
            u16_le(d, 0),
            d[2],
            u32_le(d, 3),
            d[7],
            d.get(8).copied().unwrap_or(0)
        ),
        0x3E if d.len() >= 2 => format!("{{\"clusterid\":{}}}", u16_le(d, 0)),
        0x40 if d.len() >= 2 => format!("{{\"startdelay\":{}}}", u16_le(d, 0)),
        0x50 => "{}".to_owned(),
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_zdo_srsp(cmd1: u8, d: &[u8]) -> String {
    if cmd1 == 0x50 && d.len() >= 24 {
        return format!(
            "{{\"shortaddr\":{},\"devstate\":{},\"panid\":{},\"parentaddr\":{},\"extendedpanid\":\"{}\",\"parentextaddr\":\"{}\",\"channel\":{}}}",
            u16_le(d, 0),
            d[2],
            u16_le(d, 3),
            u16_le(d, 5),
            format_eui64(u64_le(d, 7)),
            format_eui64(u64_le(d, 15)),
            d[23]
        );
    }
    format_status_or_len(d)
}

fn format_zdo_areq(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0xB6 if d.len() >= 3 => {
            format!("{{\"srcaddr\":{},\"status\":{}}}", u16_le(d, 0), d[2])
        }
        0xC0 if !d.is_empty() => format!("{{\"state\":{}}}", d[0]),
        0xC1 if d.len() >= 13 => format!(
            "{{\"srcaddr\":{},\"nwkaddr\":{},\"ieeeaddr\":\"{}\",\"capabilities\":{}}}",
            u16_le(d, 0),
            u16_le(d, 2),
            format_eui64(u64_le(d, 4)),
            d[12]
        ),
        0xC4 if d.len() >= 3 => {
            let dstaddr = u16_le(d, 0);
            let count = usize::from(d[2]);
            let avail = d.len().saturating_sub(3) / 2;
            let n = count.min(avail);
            let mut relays = String::with_capacity(n * 6);
            for i in 0..n {
                if i > 0 {
                    relays.push(',');
                }
                let _ = write!(relays, "{}", u16_le(d, 3 + i * 2));
            }
            format!(
                "{{\"dstaddr\":{dstaddr},\"relaycount\":{},\"relaylist\":[{relays}]}}",
                d[2]
            )
        }
        0xC8 if d.len() >= 11 => format!(
            "{{\"srcaddr\":{},\"extaddr\":\"{}\",\"pktCost\":{}}}",
            u16_le(d, 0),
            format_eui64(u64_le(d, 2)),
            d[10]
        ),
        0xC9 if d.len() >= 13 => format!(
            "{{\"srcaddr\":{},\"extaddr\":\"{}\",\"request\":{},\"removechildren\":{},\"rejoin\":{}}}",
            u16_le(d, 0),
            format_eui64(u64_le(d, 2)),
            d[10],
            d[11],
            d[12]
        ),
        0xCA if d.len() >= 12 => format!(
            "{{\"nwkaddr\":{},\"extaddr\":\"{}\",\"parentaddr\":{}}}",
            u16_le(d, 0),
            format_eui64(u64_le(d, 2)),
            u16_le(d, 10)
        ),
        0xFF if d.len() >= 9 => format!(
            "{{\"srcaddr\":{},\"wasbroadcast\":{},\"clusterid\":{},\"securityuse\":{},\"seqnum\":{},\"macdstaddr\":{},\"len\":{}}}",
            u16_le(d, 0),
            d[2],
            u16_le(d, 3),
            d[5],
            d[6],
            u16_le(d, 7),
            d.len().saturating_sub(9)
        ),
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_app_cnf_tx(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x04 if d.len() >= 9 => format!(
            "{{\"installCodeFormat\":{},\"ieeeaddr\":\"{}\",\"installCode\":\"[REDACTED]\",\"len\":{}}}",
            d[0],
            format_eui64(u64_le(d, 1)),
            d.len().saturating_sub(9)
        ),
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

fn format_app_cnf_areq(cmd1: u8, d: &[u8]) -> String {
    match cmd1 {
        0x80 if d.len() >= 3 => format!(
            "{{\"status\":{},\"commissioningmode\":{},\"remainingmodes\":{}}}",
            d[0], d[1], d[2]
        ),
        0x80 if !d.is_empty() => format!("{{\"status\":{}}}", d[0]),
        _ => format!("{{\"len\":{}}}", d.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cobs_link::SRSP;

    const SECRET: [u8; 16] = [
        0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88,
    ];

    fn assert_no_secret_bytes(line: &str) {
        let lower = line.to_ascii_lowercase();
        assert!(!lower.contains("deadbeef"), "leaked secret in: {line}");
        assert!(!lower.contains("cafebabe"), "leaked secret in: {line}");
        assert!(!lower.contains("11223344"), "leaked secret in: {line}");
        assert!(
            !lower.contains("222,"),
            "leaked decimal secret byte in: {line}"
        );
        assert!(
            !lower.contains("173,"),
            "leaked decimal secret byte in: {line}"
        );
    }

    #[test]
    fn formats_core_sreq_srsp_areq_and_rpc_error_lines() {
        let data_req = Frame::new(
            SREQ | SUB_AF,
            0x01,
            vec![
                0x34, 0x12, 0x01, 0x01, 0x06, 0x00, 0x2A, 0x10, 0x1E, 0x03, 0xAA, 0xBB, 0xCC,
            ],
        );
        assert_eq!(
            format_tx(&data_req),
            "--> SREQ: AF - dataRequest - {\"dstaddr\":4660,\"destendpoint\":1,\"srcendpoint\":1,\"clusterid\":6,\"transid\":42,\"options\":16,\"radius\":30,\"len\":3}"
        );
        assert_eq!(
            format_srsp(&Frame::new(SRSP | SUB_AF, 0x01, vec![0]), None),
            "<-- SRSP: AF - dataRequest - {\"status\":0}"
        );

        let confirm = Frame::new(
            AREQ | SUB_AF,
            0x80,
            vec![0x00, 0x01, 0x2A, 0x34, 0x12, 0x07, 0, 0, 0, 0],
        );
        assert_eq!(
            format_areq(&confirm),
            "<-- AREQ: AF - dataConfirm - {\"status\":0,\"endpoint\":1,\"transid\":42,\"dstaddr\":4660,\"seq\":7}"
        );

        let incoming_p2 = Frame::new(
            AREQ | SUB_AF,
            0x84,
            vec![
                0x00, 0x00, 0x06, 0x00, 0x34, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x01, 0x01, 0x90,
                0xD8, 0, 0, 0, 0, 0, 0x02, 0x18, 0x00,
            ],
        );
        assert_eq!(
            format_areq(&incoming_p2),
            "<-- AREQ: AF - incomingMsg - {\"groupid\":0,\"clusterid\":6,\"srcaddr\":4660,\"srcendpoint\":1,\"dstendpoint\":1,\"wasbroadcast\":1,\"linkquality\":144,\"rssi\":-40,\"len\":2}"
        );

        let tc_ind = Frame::new(
            AREQ | SUB_ZDO,
            0xCA,
            vec![
                0x34, 0x12, 0x01, 0x00, 0x00, 0x00, 0x00, 0x8D, 0x15, 0x00, 0x00, 0x00,
            ],
        );
        assert_eq!(
            format_areq(&tc_ind),
            "<-- AREQ: ZDO - tcDeviceInd - {\"nwkaddr\":4660,\"extaddr\":\"0x00158d0000000001\",\"parentaddr\":0}"
        );

        let reset_req = Frame::new(AREQ | SUB_SYS, 0x00, vec![1]);
        assert_eq!(
            format_tx(&reset_req),
            "--> AREQ: SYS - resetReq - {\"type\":1}"
        );

        let rpc_err = Frame::new(SRSP | SUB_RPC_ERROR, 0x00, vec![2, 0x21, 0x73]);
        assert_eq!(
            format_srsp(&rpc_err, None),
            "<-- SRSP: RPC_ERROR - error - {\"status\":2,\"cmd0\":33,\"cmd1\":115}"
        );
    }

    #[test]
    fn redacts_all_sensitive_nv_backup_and_install_code_payloads_at_source() {
        for nv_id in [0x003Au16, 0x003B, 0x0062, 0x0082, 0x0101, 0x0201] {
            let [lo, hi] = nv_id.to_le_bytes();
            let mut osal_write = vec![lo, hi, 0, 16];
            osal_write.extend_from_slice(&SECRET);
            let line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x09, osal_write));
            assert!(line.contains("\"value\":\"[REDACTED]\""), "{line}");
            assert_no_secret_bytes(&line);

            let mut osal_write_ext = vec![lo, hi, 0, 0, 16, 0];
            osal_write_ext.extend_from_slice(&SECRET);
            let ext_line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x1D, osal_write_ext));
            assert!(ext_line.contains("\"value\":\"[REDACTED]\""), "{ext_line}");
            assert_no_secret_bytes(&ext_line);

            let mut item_init = vec![lo, hi, 16, 0, 16];
            item_init.extend_from_slice(&SECRET);
            let init_line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x07, item_init));
            assert!(
                init_line.contains("\"initvalue\":\"[REDACTED]\""),
                "{init_line}"
            );
            assert_no_secret_bytes(&init_line);

            let read_req = Frame::new(SREQ | SUB_SYS, 0x08, vec![lo, hi, 0]);
            assert!(request_reads_sensitive(&read_req));
        }

        for (itemid, subid) in [
            (0x0000u16, 0x0062u16),
            (0x0004, 0),
            (0x0006, 0),
            (0x0007, 0),
        ] {
            let [i0, i1] = itemid.to_le_bytes();
            let [s0, s1] = subid.to_le_bytes();
            let mut nv_write = vec![1, i0, i1, s0, s1, 0, 0, 16];
            nv_write.extend_from_slice(&SECRET);
            let w_line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x34, nv_write));
            assert!(w_line.contains("\"value\":\"[REDACTED]\""), "{w_line}");
            assert_no_secret_bytes(&w_line);

            let mut nv_update = vec![1, i0, i1, s0, s1, 16];
            nv_update.extend_from_slice(&SECRET);
            let u_line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x35, nv_update));
            assert!(u_line.contains("\"value\":\"[REDACTED]\""), "{u_line}");
            assert_no_secret_bytes(&u_line);

            let read_req = Frame::new(SREQ | SUB_SYS, 0x33, vec![1, i0, i1, s0, s1, 0, 0, 16]);
            assert!(request_reads_sensitive(&read_req));
        }

        let mut nv_read_srsp_bytes = vec![0, 16];
        nv_read_srsp_bytes.extend_from_slice(&SECRET);
        let srsp_sensitive = format_srsp(
            &Frame::new(SRSP | SUB_SYS, 0x1C, nv_read_srsp_bytes.clone()),
            Some(true),
        );
        assert!(
            srsp_sensitive.contains("\"value\":\"[REDACTED]\""),
            "{srsp_sensitive}"
        );
        assert_no_secret_bytes(&srsp_sensitive);

        // Uncorrelated NV reads fail closed.
        let srsp_unknown = format_srsp(
            &Frame::new(SRSP | SUB_SYS, 0x33, nv_read_srsp_bytes.clone()),
            None,
        );
        assert!(
            srsp_unknown.contains("\"value\":\"[REDACTED]\""),
            "{srsp_unknown}"
        );
        assert_no_secret_bytes(&srsp_unknown);

        // Non-sensitive reads still omit raw bytes.
        let non_sens_read = Frame::new(SREQ | SUB_SYS, 0x1C, vec![0x21, 0x00, 0, 0]);
        assert!(!request_reads_sensitive(&non_sens_read));
        let srsp_nib = format_srsp(
            &Frame::new(SRSP | SUB_SYS, 0x1C, nv_read_srsp_bytes),
            Some(false),
        );
        assert_eq!(
            srsp_nib,
            "<-- SRSP: SYS - osalNvReadExt - {\"status\":0,\"len\":16}"
        );
        assert_no_secret_bytes(&srsp_nib);

        let mut export_srsp = vec![0, 1, 0, 0xFF, 0xFF];
        export_srsp.extend_from_slice(&SECRET);
        let exp_line = format_srsp(&Frame::new(SRSP | SUB_SYS, 0x70, export_srsp), Some(true));
        assert!(exp_line.contains("\"data\":\"[REDACTED]\""), "{exp_line}");
        assert_no_secret_bytes(&exp_line);

        let mut import_sreq = vec![1, 0, 0];
        import_sreq.extend_from_slice(&SECRET);
        let imp_line = format_tx(&Frame::new(SREQ | SUB_SYS, 0x71, import_sreq));
        assert!(imp_line.contains("\"data\":\"[REDACTED]\""), "{imp_line}");
        assert_no_secret_bytes(&imp_line);

        let mut install_sreq = vec![2, 0xC4, 0xB3, 0xA2, 0x01, 0x00, 0x8D, 0x15, 0x00];
        install_sreq.extend_from_slice(&SECRET);
        let ic_line = format_tx(&Frame::new(SREQ | SUB_APP_CNF, 0x04, install_sreq));
        assert!(
            ic_line.contains("\"installCode\":\"[REDACTED]\""),
            "{ic_line}"
        );
        assert_no_secret_bytes(&ic_line);
    }

    #[test]
    fn truncated_frames_never_panic() {
        for subsys in [SUB_RPC_ERROR, SUB_SYS, SUB_AF, SUB_ZDO, SUB_APP_CNF, 0x15] {
            for cmd1 in [
                0x00u8, 0x01, 0x02, 0x04, 0x07, 0x08, 0x09, 0x13, 0x1C, 0x1D, 0x30, 0x32, 0x33,
                0x34, 0x35, 0x36, 0x37, 0x50, 0x70, 0x71, 0x73, 0x80, 0x81, 0x82, 0x84, 0xB6, 0xC1,
                0xC4, 0xC8, 0xC9, 0xCA, 0xFF,
            ] {
                for len in [0usize, 1, 2, 3, 5] {
                    let payload = vec![0xAA; len];
                    let _ = format_tx(&Frame::new(SREQ | subsys, cmd1, payload.clone()));
                    let _ = format_srsp(&Frame::new(SRSP | subsys, cmd1, payload.clone()), None);
                    let _ = format_areq(&Frame::new(AREQ | subsys, cmd1, payload));
                }
            }
        }
    }
}
