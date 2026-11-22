// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// In-process fake ZeroStack coordinator for test/loopback.test.mjs, served on loopback TCP. It
// answers SYS_PING and SYS_VERSION over UNPI, takes the legacy-framed SYS_ZS_CAPS probe, then speaks
// COBS-Mux.
// Anything else it receives is recorded as an error and the link is dropped.
import {createServer} from "node:net";

// UNPI and MT SYS (TI Z-Stack Monitor and Test, public spec)

const UNPI_SOF = 0xfe;
const UNPI_HEADER = 4;
const UNPI_MAX_PAYLOAD = 250;

export const MT_SREQ = 0x20;
export const MT_SRSP = 0x60;
const MT_TYPE_MASK = 0xe0;
const MT_SUBSYSTEM_MASK = 0x1f;
export const MT_SYS = 0x01;
export const SYS_PING = 0x01;
export const SYS_VERSION = 0x02;

function mtFrame(type, subsystem, command, payload) {
    return {type, subsystem, command, payload};
}

/** `0xfe LEN CMD0 CMD1 DATA FCS`, FCS the XOR of LEN through DATA. */
export function encodeUnpi({type, subsystem, command, payload}) {
    if (payload.length > UNPI_MAX_PAYLOAD) {
        throw new Error(`UNPI payload of ${payload.length} bytes exceeds ${UNPI_MAX_PAYLOAD}`);
    }
    const frame = Buffer.alloc(UNPI_HEADER + payload.length + 1);
    frame[0] = UNPI_SOF;
    frame[1] = payload.length;
    frame[2] = type | subsystem;
    frame[3] = command;
    payload.copy(frame, UNPI_HEADER);
    frame[frame.length - 1] = xor(frame.subarray(1, frame.length - 1));
    return frame;
}

/** The UNPI frame at the start of `buffer`: `{frame, consumed}`, or undefined while it is incomplete. */
export function takeUnpi(buffer) {
    if (buffer[0] !== UNPI_SOF) {
        throw new Error(`UNPI frame starts with 0x${hex8(buffer[0])}, not 0xfe`);
    }
    if (buffer.length < 2) {
        return undefined;
    }
    const length = buffer[1];
    if (length > UNPI_MAX_PAYLOAD) {
        throw new Error(`UNPI LEN ${length} exceeds ${UNPI_MAX_PAYLOAD}`);
    }
    const total = UNPI_HEADER + length + 1;
    if (buffer.length < total) {
        return undefined;
    }
    const fcs = xor(buffer.subarray(1, total - 1));
    if (fcs !== buffer[total - 1]) {
        throw new Error(`UNPI FCS 0x${hex8(buffer[total - 1])} does not match 0x${hex8(fcs)}`);
    }
    const frame = mtFrame(buffer[2] & MT_TYPE_MASK, buffer[2] & MT_SUBSYSTEM_MASK, buffer[3], Buffer.from(buffer.subarray(UNPI_HEADER, total - 1)));
    return {frame, consumed: total};
}

/** SYS_VERSION SRSP payload: TransportRev, Product, MajorRel, MinorRel, MaintRel, Revision (u32 LE). */
export function sysVersionPayload({transportRev, product, major, minor, maint, revision}) {
    const payload = Buffer.alloc(9);
    payload.writeUInt8(transportRev, 0);
    payload.writeUInt8(product, 1);
    payload.writeUInt8(major, 2);
    payload.writeUInt8(minor, 3);
    payload.writeUInt8(maint, 4);
    payload.writeUInt32LE(revision, 5);
    return payload;
}

/** SYS_PING SRSP payload: the capability bits (u16 LE). */
export function sysPingPayload(capabilities) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16LE(capabilities, 0);
    return payload;
}

function xor(bytes) {
    return bytes.reduce((acc, byte) => acc ^ byte, 0);
}

function hex8(value) {
    return value === undefined ? "--" : value.toString(16).padStart(2, "0");
}

// ZeroStack wire: SYS_PING capability bit, SYS_ZS_CAPS probe and answer, COBS-Mux framing.

const MT_AREQ = 0x40;
/** COBS-Mux limits: seq, CMD0, CMD1, up to 249 data bytes and CRC-16 make 254 decoded, 257 wire bytes. */
const COBS_MUX_MAX_DATA = 249;
const COBS_MUX_MAX_WIRE = 257;
const SYS_ZS_CAPS = 0x73;
const ZS_CAPS_SUPPORTED = 0x0f;
const ZS_RX_BUDGET = 766;
const ZS_NODES = 200;
const ZS_FEATURES = 0x0f;

/** SYS_PING capability bits of a ZeroStack coordinator, the ZeroStack bit included. */
export function zsPingCapabilities() {
    return 0x2459;
}

/**
 * The legacy-framed SYS_ZS_CAPS SREQ at the start of `buffer`: `{request, consumed}`, undefined
 * while the frame is incomplete, or null when the frame there is another MT frame.
 */
export function takeZsCapsRequest(buffer) {
    const taken = takeUnpi(buffer);
    if (taken === undefined) {
        return undefined;
    }
    const {frame, consumed} = taken;
    if (frame.type !== MT_SREQ || frame.subsystem !== MT_SYS || frame.command !== SYS_ZS_CAPS) {
        return null;
    }
    if (frame.payload.length < 2 || frame.payload[0] !== 1) {
        throw new Error(`SYS_ZS_CAPS request ${frame.payload.toString("hex")} is not version 1`);
    }
    return {request: {want: frame.payload[1], window: frame.payload[2]}, consumed};
}

/** The bytes answering `request` (from takeZsCapsRequest) that switch the link to COBS-Mux. */
export function encodeZsCapsResponse(request) {
    const payload = Buffer.alloc(11);
    payload[1] = 1;
    payload[2] = request.want & ZS_CAPS_SUPPORTED;
    payload.writeUInt16LE(ZS_RX_BUDGET, 3);
    payload.writeUInt16LE(ZS_NODES, 5);
    payload.writeUInt32LE(ZS_FEATURES, 7);
    return encodeUnpi(mtFrame(MT_SRSP, MT_SYS, SYS_ZS_CAPS, payload));
}

/** CRC-16/X-25: reflected 0x8408, init and final XOR 0xffff. */
function crc16x25(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
        }
    }
    return crc ^ 0xffff;
}

function cobsDecode(block) {
    const out = [];
    let at = 0;
    while (at < block.length) {
        const code = block[at];
        if (at + code > block.length) {
            throw new Error(`COBS block of ${code} overruns the frame`);
        }
        out.push(...block.subarray(at + 1, at + code));
        at += code;
        if (code < 0xff && at < block.length) {
            out.push(0);
        }
    }
    return Buffer.from(out);
}

function cobsEncode(raw) {
    const out = [0];
    let codeAt = 0;
    for (const byte of raw) {
        if (byte !== 0) {
            out.push(byte);
        }
        if (byte === 0 || out.length - codeAt === 0xff) {
            out[codeAt] = out.length - codeAt;
            codeAt = out.length;
            out.push(0);
        }
    }
    out[codeAt] = out.length - codeAt;
    out.push(0);
    return Buffer.from(out);
}

/**
 * The COBS-Mux frames at the start of `buffer`: `{frames, consumed}`; each frame is
 * `{type, subsystem, command, payload, seq}`. Empty frames (delimiter runs) are skipped.
 */
export function takeCobsMux(buffer) {
    const frames = [];
    let consumed = 0;
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0, consumed)) {
        const block = buffer.subarray(consumed, end);
        consumed = end + 1;
        if (block.length === 0) {
            continue;
        }
        if (block.length + 1 > COBS_MUX_MAX_WIRE) {
            throw new Error(`COBS-Mux frame of ${block.length + 1} wire bytes exceeds ${COBS_MUX_MAX_WIRE}`);
        }
        const raw = cobsDecode(block);
        if (raw.length < 5) {
            throw new Error(`COBS-Mux frame of ${raw.length} bytes is truncated`);
        }
        if (raw.length - 5 > COBS_MUX_MAX_DATA) {
            throw new Error(`COBS-Mux frame carries ${raw.length - 5} MT data bytes, over ${COBS_MUX_MAX_DATA}`);
        }
        const crc = raw.readUInt16LE(raw.length - 2);
        if (crc16x25(raw.subarray(0, raw.length - 2)) !== crc) {
            throw new Error(`COBS-Mux CRC mismatch in ${raw.toString("hex")}`);
        }
        const frame = mtFrame(raw[1] & MT_TYPE_MASK, raw[1] & MT_SUBSYSTEM_MASK, raw[2], Buffer.from(raw.subarray(3, raw.length - 2)));
        frames.push({...frame, seq: raw[0]});
    }
    if (buffer.length - consumed >= COBS_MUX_MAX_WIRE) {
        throw new Error(`${buffer.length - consumed} bytes without a COBS-Mux delimiter`);
    }
    return {frames, consumed};
}

/** COBS-Mux bytes answering `request` (from takeCobsMux) with the MT `response`. */
export function encodeCobsMuxResponse(request, response) {
    const seq = response.type === MT_AREQ ? 0 : request.seq;
    const raw = Buffer.alloc(response.payload.length + 5);
    raw[0] = seq;
    raw[1] = response.type | response.subsystem;
    raw[2] = response.command;
    response.payload.copy(raw, 3);
    raw.writeUInt16LE(crc16x25(raw.subarray(0, raw.length - 2)), raw.length - 2);
    return cobsEncode(raw);
}

/** The CoordinatorVersion the addon reports for a coordinator with this SYS_VERSION identity. */
export function coordinatorVersionOf(version) {
    const type = ["zStack12", "zStack3x0", "zStack30x"][version.product];
    if (type === undefined) {
        throw new Error(`product ${version.product} has no coordinator type`);
    }
    return {
        type,
        meta: {
            transportrev: version.transportRev,
            product: version.product,
            majorrel: version.major,
            minorrel: version.minor,
            maintrel: version.maint,
            revision: version.revision,
            framing: "cobs-mux",
            mt_capabilities: zsPingCapabilities(),
            zs_granted: ZS_CAPS_SUPPORTED,
            zs_features: ZS_FEATURES,
            zs_nodes: ZS_NODES,
            zs_rx_budget: ZS_RX_BUDGET,
        },
    };
}

function answer(frame, version) {
    if (frame.type !== MT_SREQ || frame.subsystem !== MT_SYS) {
        return undefined;
    }
    switch (frame.command) {
        case SYS_PING:
            return mtFrame(MT_SRSP, MT_SYS, SYS_PING, sysPingPayload(zsPingCapabilities()));
        case SYS_VERSION:
            return mtFrame(MT_SRSP, MT_SYS, SYS_VERSION, sysVersionPayload(version));
        default:
            return undefined;
    }
}

function describe(frame) {
    return `type 0x${hex8(frame.type)} subsystem 0x${hex8(frame.subsystem)} command 0x${hex8(frame.command)}`;
}

class Session {
    constructor(socket, version, audit, errors) {
        this.socket = socket;
        this.version = version;
        this.audit = audit;
        this.errors = errors;
        this.framing = "unpi";
        this.buffer = Buffer.alloc(0);
    }

    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try {
            this.drain();
        } catch (error) {
            this.errors.push(error);
            this.socket.destroy();
        }
    }

    drain() {
        while (this.buffer.length > 0) {
            const consumed = this.framing === "unpi" ? this.takeLegacy() : this.takeMux();
            if (consumed === 0) {
                return;
            }
            this.buffer = this.buffer.subarray(consumed);
        }
    }

    takeLegacy() {
        const probe = takeZsCapsRequest(this.buffer);
        if (probe === undefined) {
            return 0;
        }
        if (probe !== null) {
            this.audit.push("probe SYS_ZS_CAPS");
            this.socket.write(encodeZsCapsResponse(probe.request));
            this.framing = "mux";
            return probe.consumed;
        }
        const taken = takeUnpi(this.buffer);
        if (taken === undefined) {
            return 0;
        }
        this.socket.write(encodeUnpi(this.serve("unpi", taken.frame)));
        return taken.consumed;
    }

    takeMux() {
        const {frames, consumed} = takeCobsMux(this.buffer);
        for (const frame of frames) {
            this.socket.write(encodeCobsMuxResponse(frame, this.serve("mux", frame)));
        }
        return consumed;
    }

    serve(framing, frame) {
        const response = answer(frame, this.version);
        if (response === undefined) {
            throw new Error(`the peer does not serve ${describe(frame)} over ${framing}`);
        }
        this.audit.push(`${framing} ${frame.command === SYS_PING ? "SYS_PING" : "SYS_VERSION"}`);
        return response;
    }
}

/**
 * Starts the peer on 127.0.0.1 with SYS_VERSION identity `version` and resolves once it listens.
 * `audit` lists the requests it served in order, `errors` what it refused; `disconnected` resolves
 * when the first host connection has closed; `close()` stops listening and drops open connections.
 */
export async function startZsPeer(version) {
    const audit = [];
    const errors = [];
    const sockets = new Set();
    let onDisconnect;
    const disconnected = new Promise((resolve) => {
        onDisconnect = resolve;
    });
    const server = createServer((socket) => {
        sockets.add(socket);
        const session = new Session(socket, version, audit, errors);
        socket.on("data", (chunk) => session.receive(chunk));
        socket.on("error", (error) => errors.push(error));
        socket.once("close", () => {
            sockets.delete(socket);
            onDisconnect();
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const {port} = server.address();
    return {
        transport: `tcp://127.0.0.1:${port}`,
        audit,
        errors,
        disconnected,
        /** Writes the MT AREQs `{subsystem, command, payload}` to every COBS-Mux host in one write. */
        indicate: (areqs) => {
            const wire = Buffer.concat(areqs.map((f) => encodeCobsMuxResponse({seq: 0}, {type: MT_AREQ, ...f})));
            for (const socket of sockets) {
                socket.write(wire);
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
