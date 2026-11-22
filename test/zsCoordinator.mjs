// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// Stateful fake ZeroStack coordinator on loopback TCP for test/controller.test.mjs. It serves the MT
// requests the addon sends (README "Behaviour"; MT is TI's public Z-Stack Monitor and Test spec) with
// one simulated router, keeps its network across host connections like a powered coordinator, and
// records every request in `audit`. Anything it does not serve is recorded in `errors`.
import {createServer} from "node:net";
import {
    encodeCobsMuxResponse,
    encodeUnpi,
    encodeZsCapsResponse,
    MT_SREQ,
    MT_SRSP,
    MT_SYS,
    sysPingPayload,
    sysVersionPayload,
    takeCobsMux,
    takeUnpi,
    takeZsCapsRequest,
    zsPingCapabilities,
} from "./zsPeer.mjs";

const MT_AREQ = 0x40;
const AF = 0x04;
const ZDO = 0x05;
const APP_CNF = 0x0f;

const DEV_HOLD = 0;
const DEV_ZB_COORD = 9;

/** Backup record kinds (SYS_ZS_BACKUP_EXPORT/IMPORT TLVs). */
const REC_HEADER = 0x01;
const REC_NIB = 0x02;
const REC_NWK_KEY = 0x03;
const REC_NODE = 0x10;

/** Largest SYS_ZS_BACKUP_EXPORT page of whole records this coordinator returns. */
const EXPORT_PAGE = 200;
/** Largest COBS-Mux SREQ data: seq, CMD0, CMD1, data and CRC-16 in 254 decoded bytes. */
const COBS_MUX_MAX_DATA = 249;
/** Neighbor and routing table entries per Mgmt_Lqi_rsp / Mgmt_Rtg_rsp. */
const TABLE_PAGE = 2;

const NAMES = {
    [`${MT_SYS}:1`]: "SYS_PING",
    [`${MT_SYS}:2`]: "SYS_VERSION",
    [`${MT_SYS}:4`]: "SYS_GET_EXTADDR",
    [`${MT_SYS}:19`]: "SYS_OSAL_NV_LENGTH",
    [`${MT_SYS}:28`]: "SYS_OSAL_NV_READ_EXT",
    [`${MT_SYS}:112`]: "SYS_ZS_BACKUP_EXPORT",
    [`${MT_SYS}:113`]: "SYS_ZS_BACKUP_IMPORT",
    [`${MT_SYS}:115`]: "SYS_ZS_CAPS",
    [`${AF}:0`]: "AF_REGISTER",
    [`${AF}:1`]: "AF_DATA_REQUEST",
    [`${AF}:2`]: "AF_DATA_REQUEST_EXT",
    [`${AF}:4`]: "AF_DELETE",
    [`${AF}:16`]: "AF_INTER_PAN_CTL",
    [`${ZDO}:1`]: "ZDO_IEEE_ADDR_REQ",
    [`${ZDO}:2`]: "ZDO_NODE_DESC_REQ",
    [`${ZDO}:4`]: "ZDO_SIMPLE_DESC_REQ",
    [`${ZDO}:5`]: "ZDO_ACTIVE_EP_REQ",
    [`${ZDO}:49`]: "ZDO_MGMT_LQI_REQ",
    [`${ZDO}:50`]: "ZDO_MGMT_RTG_REQ",
    [`${ZDO}:52`]: "ZDO_MGMT_LEAVE_REQ",
    [`${ZDO}:54`]: "ZDO_MGMT_PERMIT_JOIN_REQ",
    [`${ZDO}:62`]: "ZDO_MSG_CB_REGISTER",
    [`${ZDO}:64`]: "ZDO_STARTUP_FROM_APP",
    [`${ZDO}:80`]: "ZDO_EXT_NWK_INFO",
    [`${APP_CNF}:4`]: "APP_CNF_BDB_ADD_INSTALLCODE",
};

function nameOf(subsystem, command) {
    return NAMES[`${subsystem}:${command}`] ?? `0x${subsystem.toString(16)}/0x${command.toString(16)}`;
}

const CRC32_TABLE = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Splits backup TLVs into `[{kind, value, bytes}]`. */
export function splitRecords(buffer) {
    const records = [];
    let at = 0;
    while (at < buffer.length) {
        if (at + 2 > buffer.length || at + 2 + buffer[at + 1] > buffer.length) {
            throw new Error(`backup record at ${at} overruns ${buffer.length} bytes`);
        }
        const end = at + 2 + buffer[at + 1];
        records.push({kind: buffer[at], value: buffer.subarray(at + 2, end), bytes: buffer.subarray(at, end)});
        at = end;
    }
    return records;
}

/** The key kind in a node record's flags: none, explicit or derived. */
function keyKindOf(flags) {
    switch (flags & 0xc0) {
        case 0x00:
            return "none";
        case 0x40:
            return "explicit";
        case 0x80:
            return "derived";
        default:
            throw new Error(`node record key flags 0x${(flags & 0xc0).toString(16)}`);
    }
}

/** Node records (`{ieee, nwk, relationship, keyKind}`) of a backup TLV stream; keyKind none, explicit or derived. */
export function nodeRecords(buffer) {
    return splitRecords(buffer)
        .filter((r) => r.kind === REC_NODE)
        .map((r) => ({
            ieee: r.value.readBigUInt64LE(0),
            nwk: r.value.readUInt16LE(8),
            relationship: r.value[10] & 0x07,
            keyKind: keyKindOf(r.value[10]),
        }));
}

function record(kind, value) {
    return Buffer.concat([Buffer.from([kind, value.length]), value]);
}

/** Backup records of a formed network with no devices. */
export function networkRecords({ieee, panId, extendedPanId, channel, networkKey, channelMask = 2 ** channel}) {
    const header = Buffer.alloc(17);
    header[0] = 1;
    header.writeUInt16LE(200, 1);
    header.writeBigUInt64LE(ieee, 5);
    const nib = Buffer.alloc(19);
    nib.writeUInt16LE(panId, 0);
    nib.writeBigUInt64LE(extendedPanId, 2);
    nib[10] = channel;
    nib[14] = 5;
    nib.writeUInt32LE(channelMask, 15);
    const key = Buffer.concat([Buffer.from([0]), networkKey, Buffer.from([0xff])]);
    return Buffer.concat([record(REC_HEADER, header), record(REC_NIB, nib), record(REC_NWK_KEY, key), record(0x04, Buffer.alloc(8))]);
}

function frame(type, subsystem, command, payload) {
    return {type, subsystem, command, payload: Buffer.from(payload)};
}

function u16(value) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
}

function u64(value) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    return b;
}

function zclString(text) {
    return Buffer.concat([Buffer.from([0x42, text.length]), Buffer.from(text, "latin1")]);
}

/** The simulated router: three HA endpoints, a member of group ROUTER.group on endpoint 1. */
export const ROUTER = {
    ieee: 0x00124b00a1b2c3d4n,
    nwk: 0x4a21,
    group: 0x0005,
    manufacturerCode: 0x1234,
    modelId: "ZS-LOOPBACK-ROUTER",
    manufacturerName: "zerostack-adapter test",
    endpoints: [
        {id: 1, profile: 0x0104, device: 0x0100, input: [0x0000, 0x0006], output: []},
        {id: 2, profile: 0x0104, device: 0x0100, input: [0x0006], output: []},
        {id: 3, profile: 0x0104, device: 0x0302, input: [0x0402], output: [0x0003]},
    ],
};

/** Basic and On/Off attribute values of ROUTER as ZCL type + value bytes. */
function routerAttribute(cluster, attribute, onOff) {
    if (cluster === 0x0000) {
        switch (attribute) {
            case 0x0000:
                return Buffer.from([0x20, 8]);
            case 0x0001:
                return Buffer.from([0x20, 1]);
            case 0x0002:
                return Buffer.from([0x20, 2]);
            case 0x0003:
                return Buffer.from([0x20, 1]);
            case 0x0004:
                return zclString(ROUTER.manufacturerName);
            case 0x0005:
                return zclString(ROUTER.modelId);
            case 0x0006:
                return zclString("20261118");
            case 0x0007:
                return Buffer.from([0x30, 1]);
            case 0x4000:
                return zclString("1.0.0");
            default:
                return undefined;
        }
    }
    if (cluster === 0x0006 && attribute === 0x0000) {
        return Buffer.from([0x10, onOff ? 1 : 0]);
    }
    return undefined;
}

class Coordinator {
    constructor({ieee, version, records, state, neighbors}) {
        this.ieee = ieee;
        this.version = version;
        this.records = records;
        this.state = state;
        this.neighbors = neighbors;
        this.endpoints = new Map();
        this.router = {joined: false, nwk: ROUTER.nwk, onOff: false};
        this.import = undefined;
        this.zdoSeq = 0;
        this.audit = [];
        this.errors = [];
        this.session = undefined;
        /** AF requests as `{command, dst, mode, dstEp, cluster, payload, seq}`; AF_DATA_REQUEST_EXT adds `address` and `pan`. */
        this.afRequests = [];
        /** AF_INTER_PAN_CTL payloads and APP_CNF_BDB_ADD_INSTALLCODE requests, in order. */
        this.interpanCtl = [];
        this.installCodes = [];
        /** `{ieee, zcl}`: a touchlink device that answers inter-PAN broadcasts. */
        this.interpanReply = undefined;
        /** COBS-Mux frames sent whose wire bytes end FE 00. */
        this.feTailFrames = 0;
        /** Export SREQs answered and records in each committed import (chunk counts). */
        this.exportPages = 0;
        this.importChunks = [];
        /** Test controls. */
        this.busy = 0;
        this.failConfirms = [];
        this.holdAf = false;
        this.heldAf = [];
        this.mutedZdo = new Set();
        this.onAudit = [];
    }

    record(entry) {
        this.audit.push(entry);
        this.notify();
    }

    /** Runs the waiters of `audited()` and `holdAf()`. */
    notify() {
        for (const waiter of [...this.onAudit]) {
            waiter();
        }
    }

    network() {
        if (this.records === undefined) {
            return undefined;
        }
        const recs = splitRecords(this.records);
        const nib = recs.find((r) => r.kind === REC_NIB)?.value;
        const key = recs.find((r) => r.kind === REC_NWK_KEY)?.value;
        if (nib === undefined || key === undefined) {
            throw new Error("stored backup lacks its NIB or network key record");
        }
        return {
            panId: nib.readUInt16LE(0),
            extendedPanId: nib.readBigUInt64LE(2),
            channel: nib[10],
            channelMask: nib.readUInt32LE(15),
            updateId: nib[11],
            keySeq: key[0],
            key: key.subarray(1, 17),
        };
    }

    nv(item) {
        const net = this.network();
        switch (item) {
            case 0x0003:
            case 0x0087:
            case 0x0063:
                return Buffer.from([0]);
            case 0x0021: {
                if (net === undefined) {
                    return Buffer.alloc(0);
                }
                const nib = Buffer.alloc(116);
                nib.writeUInt16LE(net.panId, 36);
                nib.writeBigUInt64LE(net.extendedPanId, 57);
                nib[114] = net.updateId;
                return nib;
            }
            case 0x003a:
                return net === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([net.keySeq]), net.key]);
            default:
                throw new Error(`NV item 0x${item.toString(16)} is not served`);
        }
    }

    nwkInfo() {
        const net = this.network();
        const d = Buffer.alloc(24);
        d.writeUInt16LE(net === undefined ? 0xfffe : 0x0000, 0);
        d[2] = this.state;
        d.writeUInt16LE(net?.panId ?? 0xffff, 3);
        d.writeUInt16LE(0xfffe, 5);
        d.writeBigUInt64LE(net?.extendedPanId ?? 0n, 7);
        d[23] = net?.channel ?? 0;
        return d;
    }

    exportPage(cursor) {
        if (this.records === undefined) {
            return Buffer.from([0x09, 0, 0, 0xff, 0xff]);
        }
        this.exportPages++;
        const recs = splitRecords(this.records);
        const page = [];
        let size = 0;
        let next = cursor;
        while (next < recs.length && size + recs[next].bytes.length <= EXPORT_PAGE) {
            page.push(recs[next].bytes);
            size += recs[next].bytes.length;
            next++;
        }
        return Buffer.concat([Buffer.from([0]), u16(1), u16(next < recs.length ? next : 0xffff), ...page]);
    }

    importOp(d) {
        if (d.length > COBS_MUX_MAX_DATA) {
            throw new Error(`SYS_ZS_BACKUP_IMPORT of ${d.length} bytes exceeds ${COBS_MUX_MAX_DATA}`);
        }
        const op = d[0];
        const reply = (count) => Buffer.concat([Buffer.from([0, op]), u16(count)]);
        switch (op) {
            case 0:
                if (this.state !== DEV_HOLD) {
                    throw new Error("SYS_ZS_BACKUP_IMPORT outside DEV_HOLD");
                }
                this.import = {total: d.readUInt32LE(4), chunks: []};
                return reply(0);
            case 1: {
                if (this.import === undefined) {
                    throw new Error("SYS_ZS_BACKUP_IMPORT chunk without a start");
                }
                const index = d.readUInt16LE(1);
                if (index !== this.import.chunks.length) {
                    throw new Error(`SYS_ZS_BACKUP_IMPORT chunk ${index} where chunk ${this.import.chunks.length} is due`);
                }
                this.import.chunks.push(Buffer.from(d.subarray(3)));
                return reply(splitRecords(d.subarray(3)).length);
            }
            case 2: {
                const all = Buffer.concat(this.import.chunks);
                if (all.length !== this.import.total || crc32(all) !== d.readUInt32LE(1)) {
                    throw new Error("SYS_ZS_BACKUP_IMPORT commit does not match the imported chunks");
                }
                this.records = all;
                this.importChunks.push(this.import.chunks.length);
                const header = splitRecords(all).find((r) => r.kind === REC_HEADER);
                this.ieee = header.value.readBigUInt64LE(5);
                this.import = undefined;
                return reply(0);
            }
            default:
                this.import = undefined;
                return reply(0);
        }
    }

    /**
     * ZDO_MSG_CB_INCOMING from `src` with ZDO `body` (status first for responses). The ZDO sequence is
     * the coordinator's to pick; it is chosen, where one exists, so the COBS-Mux frame ends FE 00.
     */
    zdoIncoming(src, cluster, body) {
        const build = (seq) =>
            frame(MT_AREQ, ZDO, 0xff, Buffer.concat([u16(src), Buffer.from([0]), u16(cluster), Buffer.from([0, seq]), u16(0), body]));
        for (let k = 1; k <= 256; k++) {
            const seq = (this.zdoSeq + k) & 0xff;
            if (feTail(encodeCobsMuxResponse({seq: 0}, build(seq)))) {
                this.zdoSeq = seq;
                return build(seq);
            }
        }
        this.zdoSeq = (this.zdoSeq + 1) & 0xff;
        return build(this.zdoSeq);
    }

    routerAt(nwk) {
        return this.router.joined && nwk === this.router.nwk;
    }

    endpointsOf(nwk) {
        if (nwk === 0x0000) {
            return [...this.endpoints.values()];
        }
        return this.routerAt(nwk) ? ROUTER.endpoints : undefined;
    }

    lqiTable(coordinator) {
        const net = this.network();
        const entry = (ieee, nwk, type, relationship) =>
            Buffer.concat([
                u64(net.extendedPanId),
                u64(ieee),
                u16(nwk),
                Buffer.from([type | (1 << 2) | (relationship << 4), 0x02, type === 0 ? 0 : 1, 200]),
            ]);
        if (!coordinator) {
            return [entry(this.ieee, 0x0000, 0, 0)];
        }
        const extra = Array.from({length: this.neighbors}, (_, i) => entry(0x00124b0000c0de00n + BigInt(i), 0x1000 + i, 1, 2));
        return [...(this.router.joined ? [entry(ROUTER.ieee, this.router.nwk, 1, 2)] : []), ...extra];
    }

    rtgTable(coordinator) {
        const route = (dst, next) => Buffer.concat([u16(dst), Buffer.from([0]), u16(next)]);
        if (!coordinator) {
            return [route(0x0000, 0x0000)];
        }
        const extra = Array.from({length: this.neighbors}, (_, i) => route(0x1000 + i, this.router.nwk));
        return [route(this.router.nwk, this.router.nwk), ...extra];
    }

    zdo(command, d) {
        const dst = d.readUInt16LE(0);
        const known = this.endpointsOf(dst);
        if (known === undefined || this.mutedZdo.has(command)) {
            return [];
        }
        const coordinator = dst === 0x0000;
        const page = (cluster, table, start) =>
            this.zdoIncoming(
                dst,
                cluster,
                Buffer.concat([
                    Buffer.from([0, table.length, start, Math.min(TABLE_PAGE, Math.max(0, table.length - start))]),
                    ...table.slice(start, start + TABLE_PAGE),
                ]),
            );
        switch (command) {
            case 0x02: {
                const desc = Buffer.from([coordinator ? 0 : 1, 0x40, 0x8e, 0, 0, 0x50, 0xa0, 0, 0x01, 0x2c, 0xa0, 0, 0]);
                desc.writeUInt16LE(coordinator ? 0x0000 : ROUTER.manufacturerCode, 3);
                return [this.zdoIncoming(dst, 0x8002, Buffer.concat([Buffer.from([0]), u16(dst), desc]))];
            }
            case 0x05:
                return [
                    this.zdoIncoming(
                        dst,
                        0x8005,
                        Buffer.concat([Buffer.from([0]), u16(dst), Buffer.from([known.length, ...known.map((e) => e.id)])]),
                    ),
                ];
            case 0x04: {
                const ep = known.find((e) => e.id === d[4]);
                if (ep === undefined) {
                    return [this.zdoIncoming(dst, 0x8004, Buffer.concat([Buffer.from([0x83]), u16(dst), Buffer.from([0])]))];
                }
                const desc = Buffer.concat([
                    Buffer.from([ep.id]),
                    u16(ep.profile),
                    u16(ep.device),
                    Buffer.from([0, ep.input.length]),
                    ...ep.input.map(u16),
                    Buffer.from([ep.output.length]),
                    ...ep.output.map(u16),
                ]);
                return [this.zdoIncoming(dst, 0x8004, Buffer.concat([Buffer.from([0]), u16(dst), Buffer.from([desc.length]), desc]))];
            }
            case 0x31:
                return [page(0x8031, this.lqiTable(coordinator), d[2])];
            case 0x32:
                return [page(0x8032, this.rtgTable(coordinator), d[2])];
            case 0x01:
                return [this.zdoIncoming(dst, 0x8001, Buffer.concat([Buffer.from([0]), u64(coordinator ? this.ieee : ROUTER.ieee), u16(dst)]))];
            case 0x34: {
                if (coordinator || d.readBigUInt64LE(2) !== ROUTER.ieee) {
                    throw new Error(`ZDO_MGMT_LEAVE_REQ ${d.toString("hex")} does not name the router`);
                }
                const answer = this.zdoIncoming(dst, 0x8034, Buffer.from([0]));
                this.removeRouter();
                return [answer];
            }
            default:
                return [];
        }
    }

    /** The router's ZCL answer on `endpoint` to `zcl` on `cluster`, or undefined. */
    routerZcl(endpoint, cluster, zcl, unicast) {
        const fc = zcl[0];
        const at = fc & 0x04 ? 3 : 1;
        const [tsn, command] = [zcl[at], zcl[at + 1]];
        const body = zcl.subarray(at + 2);
        if (!ROUTER.endpoints.find((e) => e.id === endpoint)?.input.includes(cluster)) {
            return undefined;
        }
        if ((fc & 0x03) === 0 && command === 0x00) {
            const records = [];
            for (let i = 0; i + 1 < body.length; i += 2) {
                const id = body.readUInt16LE(i);
                const value = routerAttribute(cluster, id, this.router.onOff);
                records.push(value === undefined ? Buffer.concat([u16(id), Buffer.from([0x86])]) : Buffer.concat([u16(id), Buffer.from([0]), value]));
            }
            return unicast ? Buffer.concat([Buffer.from([0x18, tsn, 0x01]), ...records]) : undefined;
        }
        if ((fc & 0x03) === 1 && cluster === 0x0006 && command <= 0x02 && endpoint === 1) {
            this.router.onOff = command === 0x02 ? !this.router.onOff : command === 0x01;
            return unicast && !(fc & 0x10) ? Buffer.from([0x18, tsn, 0x0b, command, 0]) : undefined;
        }
        return undefined;
    }

    /** AF_INCOMING_MSG from the router's endpoint `srcEp` to coordinator endpoint `dstEp`. */
    afIncoming(cluster, srcEp, dstEp, zcl) {
        const head = Buffer.alloc(17);
        head.writeUInt16LE(cluster, 2);
        head.writeUInt16LE(this.router.nwk, 4);
        head[6] = srcEp;
        head[7] = dstEp;
        head[9] = 180;
        head[16] = zcl.length;
        return frame(MT_AREQ, AF, 0x81, Buffer.concat([head, zcl]));
    }

    /** `{srsp, after}` for AF_DATA_REQUEST (0x01) or AF_DATA_REQUEST_EXT (0x02). */
    af(command, d, seq) {
        const ext = command === 0x02;
        const request = ext
            ? {
                  mode: d[0],
                  address: d.readBigUInt64LE(1),
                  dst: Number(d.readBigUInt64LE(1) & 0xffffn),
                  dstEp: d[9],
                  pan: d.readUInt16LE(10),
                  srcEp: d[12],
                  cluster: d.readUInt16LE(13),
                  tid: d[15],
                  payload: d.subarray(20),
              }
            : {mode: 2, dst: d.readUInt16LE(0), dstEp: d[2], srcEp: d[3], cluster: d.readUInt16LE(4), tid: d[6], payload: d.subarray(10)};
        this.afRequests.push({command, seq, ...request});
        if (this.busy > 0) {
            this.busy--;
            return {srsp: Buffer.from([0x11]), after: []};
        }
        const failed = this.failConfirms.shift();
        if (failed !== undefined) {
            const confirm = failed.extended
                ? Buffer.concat([Buffer.from([failed.status, request.srcEp, request.tid]), u16(request.dst), Buffer.from([seq, 0, 0, 0, 0])])
                : Buffer.from([failed.status, request.srcEp, request.tid]);
            return {srsp: Buffer.from([0]), after: [frame(MT_AREQ, AF, 0x80, confirm)]};
        }
        const after = [frame(MT_AREQ, AF, 0x80, [0, request.srcEp, request.tid])];
        if (ext && request.mode === 2 && request.dst === 0xffff && request.srcEp === 12 && this.interpanReply !== undefined) {
            after.push(this.interpanIncoming(request.payload));
        }
        const group = request.mode === 1;
        const broadcast = request.mode === 2 && request.dst >= 0xfff8;
        if (this.router.joined && ((group && request.dst === ROUTER.group) || broadcast)) {
            this.routerZcl(1, request.cluster, request.payload, false);
        } else if (request.mode === 2 && this.routerAt(request.dst)) {
            const answer = this.routerZcl(request.dstEp, request.cluster, request.payload, true);
            if (answer !== undefined) {
                after.push(this.afIncoming(request.cluster, request.dstEp, request.srcEp, answer));
            }
        }
        if (this.holdAf) {
            this.heldAf.push(after);
            return {srsp: Buffer.from([0]), after: []};
        }
        return {srsp: Buffer.from([0]), after};
    }

    /**
     * AF_INCOMING_MSG_EXT answering an inter-PAN request from `interpanReply`: its ZCL template with
     * the request's ZCL sequence and inter-PAN transaction ID, from and to the Stub APS endpoint 0xFE.
     */
    interpanIncoming(request) {
        const zcl = Buffer.from(this.interpanReply.zcl);
        zcl[1] = request[1];
        request.copy(zcl, 3, 3, 7);
        const header = Buffer.concat([
            u16(0),
            u16(0x1000),
            Buffer.from([3]),
            u64(this.interpanReply.ieee),
            Buffer.from([0xfe]),
            u16(0xffff),
            Buffer.from([0xfe, 0, 200, 0, 0, 0, 0, 0, 0]),
            u16(zcl.length),
        ]);
        return frame(MT_AREQ, AF, 0x82, Buffer.concat([header, zcl]));
    }

    /** SRSP payload and the AREQs after it for one SREQ. */
    serve(f) {
        const d = f.payload;
        const ok = (after = []) => ({srsp: Buffer.from([0]), after});
        switch (`${f.subsystem}:${f.command}`) {
            case `${MT_SYS}:1`:
                return {srsp: sysPingPayload(zsPingCapabilities())};
            case `${MT_SYS}:2`:
                return {srsp: sysVersionPayload(this.version)};
            case `${MT_SYS}:4`:
                return {srsp: u64(this.ieee)};
            case `${MT_SYS}:19`:
                return {srsp: u16(this.nv(d.readUInt16LE(0)).length)};
            case `${MT_SYS}:28`: {
                const chunk = this.nv(d.readUInt16LE(0)).subarray(d.readUInt16LE(2), d.readUInt16LE(2) + 200);
                return {srsp: Buffer.concat([Buffer.from([0, chunk.length]), chunk])};
            }
            case `${MT_SYS}:112`:
                return {srsp: this.exportPage(d.readUInt16LE(0))};
            case `${MT_SYS}:113`:
                return {srsp: this.importOp(d)};
            case `${AF}:0`:
                if (this.endpoints.has(d[0])) {
                    return {srsp: Buffer.from([0xb8])};
                }
                this.endpoints.set(d[0], parseRegistration(d));
                return ok();
            case `${AF}:4`:
                this.endpoints.delete(d[0]);
                return ok();
            case `${AF}:1`:
            case `${AF}:2`:
                return this.af(f.command, d, f.seq);
            case `${AF}:16`:
                this.interpanCtl.push([...d]);
                return ok();
            case `${APP_CNF}:4`:
                this.installCodes.push({format: d[0], ieee: d.readBigUInt64LE(1), code: d.subarray(9).toString("hex")});
                return ok();
            case `${ZDO}:54`:
            case `${ZDO}:62`:
                return ok();
            case `${ZDO}:64`:
                this.state = DEV_ZB_COORD;
                return ok([frame(MT_AREQ, ZDO, 0xc0, [DEV_ZB_COORD])]);
            case `${ZDO}:80`:
                return {srsp: this.nwkInfo()};
            case `${ZDO}:1`:
            case `${ZDO}:2`:
            case `${ZDO}:4`:
            case `${ZDO}:5`:
            case `${ZDO}:49`:
            case `${ZDO}:50`:
            case `${ZDO}:52`:
                return ok(this.zdo(f.command, f.command === 0x01 ? Buffer.concat([d.subarray(0, 2), d]) : d));
            default:
                throw new Error(`the coordinator does not serve ${nameOf(f.subsystem, f.command)}`);
        }
    }

    reset() {
        this.state = DEV_HOLD;
        this.endpoints.clear();
        this.import = undefined;
        const v = this.version;
        return encodeUnpi(frame(MT_AREQ, MT_SYS, 0x80, [0x20, v.transportRev, v.product, v.major, v.minor, v.maint]));
    }

    nodeRecord(nwk) {
        const node = Buffer.alloc(20);
        node.writeBigUInt64LE(ROUTER.ieee, 0);
        node.writeUInt16LE(nwk, 8);
        node[10] = 3;
        node[11] = 0x0e;
        return record(REC_NODE, node);
    }

    /** Stored records with the router's node record replaced by `node` (or dropped). */
    withRouterNode(node) {
        const kept = splitRecords(this.records).filter((r) => r.kind !== REC_NODE || r.value.readBigUInt64LE(0) !== ROUTER.ieee);
        return Buffer.concat([...kept.map((r) => r.bytes), ...(node === undefined ? [] : [node])]);
    }

    removeRouter() {
        this.router.joined = false;
        this.records = this.withRouterNode(undefined);
    }
}

function parseRegistration(d) {
    const inCount = d[7];
    const input = Array.from({length: inCount}, (_, i) => d.readUInt16LE(8 + 2 * i));
    const outAt = 8 + 2 * inCount;
    const output = Array.from({length: d[outAt]}, (_, i) => d.readUInt16LE(outAt + 1 + 2 * i));
    return {id: d[0], profile: d.readUInt16LE(1), device: d.readUInt16LE(3), input, output};
}

function feTail(wire) {
    return wire.length >= 2 && wire[wire.length - 2] === 0xfe && wire[wire.length - 1] === 0x00;
}

/** One host connection: UNPI until the SYS_ZS_CAPS probe or after a reset, COBS-Mux otherwise. */
class Session {
    constructor(socket, coordinator) {
        this.socket = socket;
        this.coordinator = coordinator;
        this.framing = "unpi";
        this.buffer = Buffer.alloc(0);
    }

    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try {
            while (this.buffer.length > 0) {
                const consumed = this.framing === "unpi" ? this.takeLegacy() : this.takeMux();
                if (consumed === 0) {
                    return;
                }
                this.buffer = this.buffer.subarray(consumed);
            }
        } catch (error) {
            this.coordinator.errors.push(error);
            this.socket.destroy();
        }
    }

    takeLegacy() {
        const probe = takeZsCapsRequest(this.buffer);
        if (probe === undefined) {
            return 0;
        }
        if (probe !== null) {
            this.coordinator.record("SYS_ZS_CAPS");
            this.socket.write(encodeZsCapsResponse(probe.request));
            this.framing = "mux";
            return probe.consumed;
        }
        const {frame: f, consumed} = takeUnpi(this.buffer);
        if (f.type !== MT_SREQ || f.subsystem !== MT_SYS || f.command > 0x02) {
            throw new Error(`UNPI ${nameOf(f.subsystem, f.command)} before the COBS-Mux switch`);
        }
        this.coordinator.record(nameOf(f.subsystem, f.command));
        this.socket.write(encodeUnpi({...f, type: MT_SRSP, payload: this.coordinator.serve(f).srsp}));
        return consumed;
    }

    takeMux() {
        const {frames, consumed} = takeCobsMux(this.buffer);
        for (const [i, f] of frames.entries()) {
            if (f.type === MT_AREQ && f.subsystem === MT_SYS && f.command === 0x00) {
                this.coordinator.record("SYS_RESET_REQ");
                this.socket.write(this.coordinator.reset());
                this.framing = "unpi";
                const rest = frames.slice(i + 1);
                if (rest.length > 0) {
                    throw new Error(`${rest.length} COBS-Mux frames followed SYS_RESET_REQ`);
                }
                return consumed;
            }
            if (f.type !== MT_SREQ) {
                throw new Error(`unexpected ${nameOf(f.subsystem, f.command)} frame type 0x${f.type.toString(16)}`);
            }
            this.coordinator.record(nameOf(f.subsystem, f.command));
            const {srsp, after = []} = this.coordinator.serve(f);
            this.coordinator.notify();
            this.write(encodeCobsMuxResponse(f, {type: MT_SRSP, subsystem: f.subsystem, command: f.command, payload: srsp}));
            this.send(after);
        }
        return consumed;
    }

    write(wire) {
        if (feTail(wire)) {
            this.coordinator.feTailFrames++;
        }
        this.socket.write(wire);
    }

    send(frames) {
        for (const f of frames) {
            this.write(encodeCobsMuxResponse({seq: 0}, f));
        }
    }
}

/**
 * Starts the coordinator on 127.0.0.1:0. `records` (networkRecords) is its stored network, absent
 * for a blank coordinator; `state` its device state at the first connection; `neighbors` extra
 * routers in its neighbor and routing tables.
 */
export async function startZsCoordinator({ieee, version, records, state = DEV_HOLD, neighbors = 0}) {
    const coordinator = new Coordinator({ieee, version, records, state, neighbors});
    const sockets = new Set();
    let closed = () => {};
    const server = createServer((socket) => {
        sockets.add(socket);
        const session = new Session(socket, coordinator);
        coordinator.session = session;
        socket.on("data", (chunk) => session.receive(chunk));
        socket.on("error", (error) => coordinator.errors.push(error));
        socket.once("close", () => {
            sockets.delete(socket);
            if (coordinator.session === session) {
                coordinator.session = undefined;
            }
            closed();
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const live = () => {
        if (coordinator.session === undefined || coordinator.session.framing !== "mux") {
            throw new Error("no host connection in COBS-Mux");
        }
        return coordinator.session;
    };
    const router = coordinator.router;
    const trustCenterJoin = (nwk) => frame(MT_AREQ, ZDO, 0xca, Buffer.concat([u16(nwk), u64(ROUTER.ieee), u16(0x0000)]));
    return {
        transport: `tcp://127.0.0.1:${server.address().port}`,
        coordinator,
        router,
        idle: () =>
            new Promise((resolve) => {
                if (sockets.size === 0) {
                    resolve();
                } else {
                    closed = resolve;
                }
            }),
        audited(name, count = 1) {
            return new Promise((resolve) => {
                const check = () => {
                    if (coordinator.audit.filter((entry) => entry === name).length >= count) {
                        coordinator.onAudit = coordinator.onAudit.filter((w) => w !== check);
                        resolve();
                    }
                };
                coordinator.onAudit.push(check);
                check();
            });
        },
        join() {
            router.joined = true;
            coordinator.records = coordinator.withRouterNode(coordinator.nodeRecord(router.nwk));
            live().send([trustCenterJoin(router.nwk)]);
        },
        rejoin(nwk) {
            router.nwk = nwk;
            coordinator.records = coordinator.withRouterNode(coordinator.nodeRecord(nwk));
            const announce = coordinator.zdoIncoming(nwk, 0x0013, Buffer.concat([u16(nwk), u64(ROUTER.ieee), Buffer.from([0x8e])]));
            live().send([trustCenterJoin(nwk), announce]);
        },
        leave(rejoin) {
            const indication = frame(MT_AREQ, ZDO, 0xc9, Buffer.concat([u16(router.nwk), u64(ROUTER.ieee), Buffer.from([0, 0, rejoin ? 1 : 0])]));
            if (!rejoin) {
                coordinator.removeRouter();
            }
            live().send([indication]);
        },
        fromRouter(cluster, zcl) {
            live().send([coordinator.afIncoming(cluster, 1, 1, Buffer.from(zcl))]);
        },
        holdAf(count) {
            coordinator.holdAf = true;
            return new Promise((resolve) => {
                const check = () => {
                    if (coordinator.heldAf.length >= count) {
                        coordinator.onAudit = coordinator.onAudit.filter((w) => w !== check);
                        resolve();
                    }
                };
                coordinator.onAudit.push(check);
                check();
            });
        },
        releaseAf() {
            coordinator.holdAf = false;
            const held = coordinator.heldAf.splice(0);
            live().send(held.flat());
        },
        dropHost() {
            for (const socket of sockets) {
                socket.destroy();
            }
        },
        close: () =>
            new Promise((resolve, reject) => {
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
}
