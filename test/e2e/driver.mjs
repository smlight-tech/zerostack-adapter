// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// MQTT driver of scripts/z2m-e2e.sh, run with the gateway image's Node:
// `node driver.mjs '<JSON options>'`. It drives the gateway's MQTT API against the external
// coordinator peer of scripts/z2m-e2e.sh and prints one `PASS <check>: <observed>` line per check; the first
// failed check prints `FAIL <check>: <reason>` and exits 1.
//
// Options: mode ("boot": checks 1-5, "restart": check 6), mqtt (broker URL), app (the gateway's
// application directory, whose package.json names its version and whose node_modules has `mqtt`),
// audit (the peer's frame audit), coordinatorIeee, routerIeee, routerNwk, channel, panId,
// extendedPanId (hex string), serial ({port, adapter} as configured), framing (expected
// coordinator meta framing), timeoutMs (per check).
import {deepStrictEqual, strictEqual} from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";

const options = JSON.parse(process.argv[2]);
const required = [
    "mode",
    "mqtt",
    "app",
    "audit",
    "coordinatorIeee",
    "routerIeee",
    "routerNwk",
    "channel",
    "panId",
    "extendedPanId",
    "serial",
    "framing",
    "timeoutMs",
];
for (const key of required) {
    if (options[key] === undefined) {
        throw new Error(`driver option '${key}' is missing`);
    }
}
const BASE = "zigbee2mqtt";
const AF = 0x04;
const SREQ = 1;
const ON_OFF = 0x0006;
const appRequire = createRequire(join(options.app, "package.json"));
const mqtt = appRequire("mqtt");
const appVersion = JSON.parse(readFileSync(join(options.app, "package.json"), "utf8")).version;

/** Every message since connecting, in arrival order, and the waiters on them. */
const messages = [];
const waiters = new Set();

const client = await mqtt.connectAsync(options.mqtt, {clientId: `zerostack-adapter-e2e-${process.pid}`, reconnectPeriod: 0});
client.on("message", (topic, payload, packet) => {
    const message = {index: messages.length, topic, text: payload.toString("utf8"), retained: packet.retain};
    messages.push(message);
    for (const waiter of waiters) {
        waiter.offer(message);
    }
});
await client.subscribeAsync(`${BASE}/#`, {qos: 1});

function parse(message) {
    try {
        return JSON.parse(message.text);
    } catch (error) {
        throw new Error(`${message.topic} carried no JSON: '${message.text}'`, {cause: error});
    }
}

/**
 * Resolves with the first message from index `from` on `topic` whose JSON payload `accepts`;
 * rejects after the check timeout, naming the last payload seen on the topic.
 */
function expect(what, topic, accepts, from) {
    return new Promise((resolve, reject) => {
        let last;
        const waiter = {
            offer: (message) => {
                if (message.index < from || message.topic !== topic) {
                    return;
                }
                last = message.text;
                let accepted;
                try {
                    accepted = accepts(parse(message), message);
                } catch (error) {
                    finish();
                    reject(error);
                    return;
                }
                if (accepted) {
                    finish();
                    resolve({message, payload: parse(message)});
                }
            },
        };
        const timer = setTimeout(() => {
            finish();
            reject(new Error(`${what}: nothing on ${topic} within ${options.timeoutMs} ms (last: ${last ?? "none"})`));
        }, options.timeoutMs);
        function finish() {
            clearTimeout(timer);
            waiters.delete(waiter);
        }
        waiters.add(waiter);
        for (const message of messages.slice(from)) {
            if (!waiters.has(waiter)) {
                return;
            }
            waiter.offer(message);
        }
    });
}

/** Publishes `payload` to `topic` and returns the index the answers start at. */
async function publish(topic, payload) {
    const from = messages.length;
    await client.publishAsync(topic, JSON.stringify(payload), {qos: 1});
    return from;
}

async function request(name, payload, expected) {
    const from = await publish(`${BASE}/bridge/request/${name}`, payload);
    const {payload: response} = await expect(name, `${BASE}/bridge/response/${name}`, () => true, from);
    deepStrictEqual(response, expected, `bridge/response/${name}`);
    return response;
}

function pass(check, observed) {
    console.log(`PASS ${check}: ${JSON.stringify(observed)}`);
}

/** The ZCL command of an AF data request to the router's On/Off cluster in an audit line, or undefined. */
function onOffCommand(line) {
    if (line.direction !== "taken" || line.type !== SREQ || line.subsystem !== AF) {
        return undefined;
    }
    const p = Buffer.from(line.payload, "hex");
    let destination;
    let endpoint;
    let cluster;
    let data;
    if (line.command === 0x01) {
        // AF_DATA_REQUEST: destination, endpoints, cluster, transaction, options, radius, length, data.
        destination = p.readUInt16LE(0);
        endpoint = p[2];
        cluster = p.readUInt16LE(4);
        data = p.subarray(10, 10 + p[9]);
    } else if (line.command === 0x02) {
        // AF_DATA_REQUEST_EXT: mode, address, endpoint, PAN, source endpoint, cluster, transaction,
        // options, radius, length, data.
        destination = p.readUInt16LE(1);
        endpoint = p[9];
        cluster = p.readUInt16LE(13);
        data = p.subarray(20, 20 + p.readUInt16LE(18));
    } else {
        return undefined;
    }
    if (destination !== options.routerNwk || cluster !== ON_OFF) {
        return undefined;
    }
    const control = data[0];
    const header = control & 0x04 ? 5 : 3;
    return {
        endpoint,
        clusterSpecific: (control & 0x03) === 0x01,
        command: data[header - 1],
        zcl: data.subarray(0, header).toString("hex"),
    };
}

function audit() {
    return readFileSync(options.audit, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
}

/**
 * Sets the On/Off state of the router's endpoint 1 (`state_1`: the generated definition of the
 * two-endpoint router has no plain `state`) and checks that the peer took exactly that On/Off
 * command and the gateway then published the device state: the new `state_1` next to the
 * unchanged `state_2` and the link quality of the peer's frames.
 */
async function setState(check, state) {
    const topic = `${BASE}/${options.routerIeee}`;
    const before = audit().length;
    const from = await publish(`${topic}/set`, {state_1: state});
    const {payload} = await expect(check, topic, () => true, from);
    deepStrictEqual(payload, {linkquality: 200, state_1: state, state_2: "OFF"}, `${topic} payload`);
    const commands = audit()
        .slice(before)
        .map(onOffCommand)
        .filter((command) => command !== undefined);
    deepStrictEqual(
        commands.map((c) => ({endpoint: c.endpoint, clusterSpecific: c.clusterSpecific, command: c.command})),
        [{endpoint: 1, clusterSpecific: true, command: state === "ON" ? 0x01 : 0x00}],
        "On/Off commands the peer took",
    );
    pass(check, {sent: {state_1: state}, published: payload, peerTook: commands});
}

function router(devices) {
    return devices.find((d) => d.ieee_address === options.routerIeee);
}

async function boot() {
    const {payload: state} = await expect("1 bridge/state", `${BASE}/bridge/state`, (p) => p.state === "online", 0);
    deepStrictEqual(state, {state: "online"});
    pass("1 bridge/state", state);

    const {payload: info} = await expect("2 bridge/info", `${BASE}/bridge/info`, () => true, 0);
    strictEqual(info.coordinator.ieee_address, options.coordinatorIeee, "coordinator IEEE");
    strictEqual(info.coordinator.type, "zStack3x0", "coordinator type");
    strictEqual(info.coordinator.meta.framing, options.framing, "coordinator meta framing");
    deepStrictEqual(info.network, {pan_id: options.panId, extended_pan_id: options.extendedPanId, channel: options.channel}, "network");
    strictEqual(info.version, appVersion, "gateway version");
    strictEqual(info.permit_join, false, "permit_join at start");
    deepStrictEqual({port: info.config.serial.port, adapter: info.config.serial.adapter}, options.serial, "serial");
    pass("2 bridge/info", {
        coordinator: info.coordinator,
        network: info.network,
        version: info.version,
        zigbee_herdsman: info.zigbee_herdsman,
        permit_join: info.permit_join,
        serial: options.serial,
    });

    const joinFrom = messages.length;
    const permit = await request("permit_join", {time: 60}, {data: {time: 60}, status: "ok"});
    const event = `${BASE}/bridge/event`;
    const ofRouter = (type) => (p) => p.type === type && p.data.ieee_address === options.routerIeee;
    const {payload: joined} = await expect("3 device_joined", event, ofRouter("device_joined"), joinFrom);
    const {payload: started} = await expect(
        "3 interview started",
        event,
        (p) => ofRouter("device_interview")(p) && p.data.status === "started",
        joinFrom,
    );
    const {payload: interviewed} = await expect(
        "3 interview finished",
        event,
        (p) => ofRouter("device_interview")(p) && p.data.status !== "started",
        joinFrom,
    );
    strictEqual(interviewed.data.status, "successful", "interview status");
    // The gateway configures the router after its interview (binds, reporting, reads of its state);
    // the state checks start once it logged the outcome.
    const configured = `z2m: Successfully configured '${options.routerIeee}'`;
    const {payload: configuredLog, message: configuredMessage} = await expect(
        "3 configure",
        `${BASE}/bridge/logging`,
        (p) => {
            if (p.message.startsWith(`z2m: Failed to configure '${options.routerIeee}'`)) {
                throw new Error(`3 configure: ${p.message}`);
            }
            return p.message.startsWith(configured);
        },
        joinFrom,
    );
    // The device list the gateway republishes once the configuration succeeded.
    const {payload: devices} = await expect(
        "3 bridge/devices",
        `${BASE}/bridge/devices`,
        (p) => router(p)?.interview_state === "SUCCESSFUL",
        configuredMessage.index,
    );
    const listed = router(devices);
    strictEqual(listed.type, "Router", "device type");
    strictEqual(listed.network_address, options.routerNwk, "router network address");
    const closed = await request("permit_join", {time: 0}, {data: {time: 0}, status: "ok"});
    pass("3 permit_join + join + interview", {
        permitJoin: permit,
        joined: joined.data,
        interviewStarted: started.data,
        interviewDone: {status: interviewed.data.status, supported: interviewed.data.supported},
        configured: configuredLog.message,
        device: {
            friendly_name: listed.friendly_name,
            type: listed.type,
            network_address: listed.network_address,
            supported: listed.supported,
            manufacturer: listed.manufacturer,
            model_id: listed.model_id,
            power_source: listed.power_source,
            interview_state: listed.interview_state,
            definition: {
                source: listed.definition.source,
                model: listed.definition.model,
                vendor: listed.definition.vendor,
                description: listed.definition.description,
                exposes: listed.definition.exposes.map((e) =>
                    e.type === "switch" || e.type === "light" ? `${e.type}(${e.features.map((f) => f.property).join(",")})` : e.property,
                ),
            },
            endpoints: Object.fromEntries(
                Object.entries(listed.endpoints).map(([id, e]) => [id, {bindings: e.bindings, configured_reportings: e.configured_reportings}]),
            ),
        },
        permitJoinClosed: closed,
    });

    await setState("4a set ON", "ON");
    await setState("4b set OFF", "OFF");

    const health = await request("health_check", {}, {data: {healthy: true}, status: "ok"});
    pass("5 health_check", health);
}

async function restart() {
    const from = await publish(`${BASE}/bridge/request/restart`, {});
    const {payload: response} = await expect("6 restart response", `${BASE}/bridge/response/restart`, () => true, from);
    deepStrictEqual(response, {data: {}, status: "ok"});
    const live = (_payload, message) => !message.retained;
    const {message: offline} = await expect("6 bridge/state offline", `${BASE}/bridge/state`, (p, m) => live(p, m) && p.state === "offline", from);
    const {payload: online, message: onlineMessage} = await expect(
        "6 bridge/state online",
        `${BASE}/bridge/state`,
        (p, m) => live(p, m) && p.state === "online",
        offline.index,
    );
    deepStrictEqual(online, {state: "online"});
    const {payload: info} = await expect("6 bridge/info", `${BASE}/bridge/info`, live, onlineMessage.index);
    strictEqual(info.coordinator.ieee_address, options.coordinatorIeee, "coordinator IEEE after restart");
    strictEqual(info.coordinator.meta.framing, options.framing, "coordinator meta framing after restart");
    deepStrictEqual(info.network, {pan_id: options.panId, extended_pan_id: options.extendedPanId, channel: options.channel}, "network after restart");
    const {payload: devices} = await expect("6 bridge/devices", `${BASE}/bridge/devices`, live, offline.index);
    const listed = router(devices);
    strictEqual(listed?.interview_state, "SUCCESSFUL", "router after restart");
    // On start the gateway republishes the router's cached state before it logs that it started.
    const topic = `${BASE}/${options.routerIeee}`;
    const {payload: cached} = await expect("6 cached state", topic, () => true, onlineMessage.index);
    deepStrictEqual(cached, {state_1: "OFF", state_2: "OFF"}, "cached state after restart");
    await expect("6 started", `${BASE}/bridge/logging`, (p) => p.message === "z2m: Zigbee2MQTT started!", onlineMessage.index);
    pass("6 restart", {
        response,
        states: ["offline", online.state],
        coordinator: info.coordinator.ieee_address,
        network: info.network,
        router: {ieee_address: listed.ieee_address, network_address: listed.network_address, interview_state: listed.interview_state},
        cachedState: cached,
    });
    await setState("6 set ON after restart", "ON");
}

const modes = {boot, restart};
const run = modes[options.mode];
if (run === undefined) {
    throw new Error(`unknown mode '${options.mode}'`);
}
try {
    await run();
} catch (error) {
    console.log(`FAIL ${error.message}`);
    process.exitCode = 1;
} finally {
    await client.endAsync();
}
