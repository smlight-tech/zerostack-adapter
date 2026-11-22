// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// zigbee-herdsman's own Controller, with the adapter registered by dist/register.js, against the
// built native addon and the fake ZeroStack coordinator of zsCoordinator.mjs on loopback TCP:
// formation, resume and restore (multi-chunk, with link keys), the coordinator and router interviews,
// rejoin and leave, ZDO, unicast, groupcast and broadcast ZCL, AF slots, busy and failed confirms,
// waitFor, permitJoin, install codes, inter-PAN, backup and stop. Run `npm run build` first.
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";
import {Controller, setLogger, Zcl, Zdo} from "zigbee-herdsman";
import {loadNativeCoordinator} from "../dist/native.js";
import {register} from "../dist/register.js";
import {networkRecords, nodeRecords, ROUTER, startZsCoordinator} from "./zsCoordinator.mjs";

const VERSION = {transportRev: 2, product: 1, major: 0, minor: 9, maint: 11, revision: 20261117};
const FACTORY_IEEE = 0x00124b00f00d0001n;
const OTHER_IEEE = 0x00124b00beef0002n;
const NETWORK = {
    panID: 0x1a2b,
    extendedPanID: [0xdd, 0x00, 0x00, 0x00, 0x1a, 0x2b, 0x00, 0x01],
    channelList: [15],
    networkKey: [0x0f, 0x1e, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0x87, 0x96, 0xa5, 0xb4, 0xc3, 0xd2, 0xe1, 0xf0],
};
const NETWORK_PARAMETERS = {panID: 0x1a2b, extendedPanID: "0xdd0000001a2b0001", channel: 15, nwkUpdateID: 0};
const OTHER_NETWORK = {ieee: OTHER_IEEE, panId: 0x0bad, extendedPanId: 0xdd0000000bad0001n, channel: 20, networkKey: Buffer.alloc(16, 0x5a)};
const ROUTER_IEEE = `0x${ROUTER.ieee.toString(16).padStart(16, "0")}`;
const STEP_MS = 15_000;

const errors = [];
let registration;
let root;

before(() => {
    setLogger({
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: (message, namespace) => errors.push(`${namespace}: ${message}`),
    });
    registration = register(() => loadNativeCoordinator());
    root = mkdtempSync(join(tmpdir(), "zerostack-adapter-controller-"));
});

after(() => {
    registration.unregister();
    rmSync(root, {recursive: true, force: true});
});

function hex16(value) {
    return value.toString(16).padStart(16, "0");
}

function testDirectory() {
    errors.length = 0;
    return mkdtempSync(join(root, "test-"));
}

function controllers(directory) {
    const started = [];
    return {
        create(name, transport, network = NETWORK) {
            const zh = new Controller({
                network,
                transport: {path: `zs:${transport}`, adapter: "zstack", baudRate: 115200, rtscts: false},
                databasePath: join(directory, `${name}.db`),
                databaseBackupPath: join(directory, `${name}.db.backup`),
                backupPath: join(directory, "coordinator_backup.json"),
                adapter: {disableLED: false},
                acceptJoiningDeviceHandler: () => Promise.resolve(true),
            });
            started.push(zh);
            return zh;
        },
        async stopAll() {
            for (const zh of started.filter((c) => c.adapter !== undefined && !c.isStopping())) {
                await zh.stop();
            }
        },
    };
}

function once(emitter, event, match = () => true) {
    return new Promise((resolve) => {
        const listener = (data) => {
            if (match(data)) {
                emitter.off(event, listener);
                resolve(data);
            }
        };
        emitter.on(event, listener);
    });
}

function within(ms, what, promise) {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function assertClean(peer) {
    assert.deepEqual(peer.coordinator.errors, []);
    assert.deepEqual(errors, []);
}

function count(peer, name) {
    return peer.coordinator.audit.filter((entry) => entry === name).length;
}

async function joinRouter(zh, peer) {
    const interviewed = once(zh, "deviceInterview", (d) => d.status !== "started");
    const joined = once(zh, "deviceJoined");
    peer.join();
    assert.equal((await within(STEP_MS, "deviceJoined", joined)).device.ieeeAddr, ROUTER_IEEE);
    const interview = await within(STEP_MS, "router interview", interviewed);
    assert.equal(interview.status, "successful");
    return interview.device;
}

async function formWithRouter(zh, peer) {
    assert.equal(await within(STEP_MS, "start", zh.start()), "reset");
    return await joinRouter(zh, peer);
}

async function formedSetup(options = {}) {
    const directory = testDirectory();
    const peer = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION, ...options});
    const zhs = controllers(directory);
    const zh = zhs.create("formed", peer.transport);
    try {
        const router = await formWithRouter(zh, peer);
        return {directory, peer, zhs, zh, router};
    } catch (error) {
        await zhs.stopAll();
        await peer.close();
        throw error;
    }
}

async function teardown({peer, zhs}) {
    await zhs.stopAll();
    await peer.close();
}

test("a blank coordinator forms the network; the controller interviews it, a router and runs ZDO and ZCL traffic", async () => {
    const setup = await formedSetup({neighbors: 5});
    const {directory, peer, zhs, zh, router} = setup;
    try {
        const audit = peer.coordinator.audit;
        assert.ok(audit.includes("SYS_ZS_BACKUP_IMPORT") && audit.includes("ZDO_STARTUP_FROM_APP"), audit.join(", "));

        assert.equal(await zh.getCoordinatorVersion().then((v) => v.meta.revision), 20261117);
        assert.deepEqual(await zh.getNetworkParameters(), NETWORK_PARAMETERS);
        const backup = JSON.parse(readFileSync(join(directory, "coordinator_backup.json"), "utf8"));
        assert.equal(backup.coordinator_ieee, hex16(FACTORY_IEEE));
        assert.equal(backup.pan_id, "1a2b");
        assert.equal(backup.network_key.key, Buffer.from(NETWORK.networkKey).toString("hex"));

        const coordinator = zh.getDevicesByType("Coordinator")[0];
        assert.equal(coordinator.ieeeAddr, `0x${hex16(FACTORY_IEEE)}`);
        const registered = [...peer.coordinator.endpoints.values()].sort((a, b) => a.id - b.id);
        assert.deepEqual(
            coordinator.endpoints.map((e) => [e.ID, e.profileID, e.inputClusters, e.outputClusters]),
            registered.map((e) => [e.id, e.profile, e.input, e.output]),
        );

        assert.deepEqual(
            [router.type, router.manufacturerID, router.modelID, router.manufacturerName, router.powerSource],
            ["Router", ROUTER.manufacturerCode, ROUTER.modelId, ROUTER.manufacturerName, "Mains (single phase)"],
        );
        const described = ROUTER.endpoints.map((e) => [e.id, e.profile, e.device, e.input, e.output]);
        const describedNow = () => router.endpoints.map((e) => [e.ID, e.profileID, e.deviceID, e.inputClusters, e.outputClusters]);
        assert.deepEqual(describedNow(), described);

        // every endpoint's simple descriptor at once, through the one serialised responder
        const simpleBefore = count(peer, "ZDO_SIMPLE_DESC_REQ");
        await within(STEP_MS, "pipelined simple descriptors", Promise.all(router.endpoints.map((e) => e.updateSimpleDescriptor())));
        assert.equal(count(peer, "ZDO_SIMPLE_DESC_REQ") - simpleBefore, ROUTER.endpoints.length);
        assert.deepEqual(describedNow(), described);

        await router.updateNodeDescriptor();
        assert.equal(router.type, "Router");
        assert.deepEqual(
            (await router.lqi()).map((n) => [n.eui64, n.nwkAddress, n.lqi]),
            [[coordinator.ieeeAddr, 0x0000, 200]],
        );
        assert.deepEqual(
            (await router.routingTable()).map((r) => [r.destinationAddress, r.nextHopAddress]),
            [[0x0000, 0x0000]],
        );

        // 6-entry tables in pages of 2
        const extra = [0x1000, 0x1001, 0x1002, 0x1003, 0x1004];
        const lqiBefore = count(peer, "ZDO_MGMT_LQI_REQ");
        assert.deepEqual(
            (await coordinator.lqi()).map((n) => n.nwkAddress),
            [ROUTER.nwk, ...extra],
        );
        assert.equal(count(peer, "ZDO_MGMT_LQI_REQ") - lqiBefore, 3);
        const rtgBefore = count(peer, "ZDO_MGMT_RTG_REQ");
        assert.deepEqual(
            (await coordinator.routingTable()).map((r) => [r.destinationAddress, r.nextHopAddress]),
            [ROUTER.nwk, ...extra].map((n) => [n, ROUTER.nwk]),
        );
        assert.equal(count(peer, "ZDO_MGMT_RTG_REQ") - rtgBefore, 3);

        const endpoint = router.getEndpoint(1);
        assert.deepEqual(await endpoint.read("genOnOff", ["onOff"]), {onOff: 0});
        await endpoint.command("genOnOff", "on", {});
        assert.equal(peer.router.onOff, true);
        assert.deepEqual(await endpoint.read("genOnOff", ["onOff"]), {onOff: 1});

        const waiter = zh.adapter.waitFor(ROUTER.nwk, 1, 1, 0, 0x5a, 0x0006, 0x02, undefined, STEP_MS);
        peer.fromRouter(0x0006, [0x11, 0x5a, 0x02]);
        const toggled = await within(STEP_MS, "waitFor toggle", waiter.promise);
        assert.deepEqual(
            [toggled.address, toggled.clusterID, toggled.header.transactionSequenceNumber, toggled.header.commandIdentifier],
            [ROUTER.nwk, 0x0006, 0x5a, 0x02],
        );

        const permitBefore = count(peer, "ZDO_MGMT_PERMIT_JOIN_REQ");
        await zh.permitJoin(5);
        assert.ok(zh.getPermitJoin());
        await zh.permitJoin(0);
        assert.equal(count(peer, "ZDO_MGMT_PERMIT_JOIN_REQ") - permitBefore, 2);

        await zh.backup();
        const withRouter = JSON.parse(readFileSync(join(directory, "coordinator_backup.json"), "utf8"));
        assert.deepEqual(
            withRouter.devices.map((d) => [d.ieee_address, d.nwk_address]),
            [[hex16(ROUTER.ieee), ROUTER.nwk.toString(16)]],
        );

        // ZDO replies whose COBS-Mux wire ends FE 00 reached the controller without stalling the link
        assert.ok(peer.coordinator.feTailFrames >= 10, `${peer.coordinator.feTailFrames} replies ended FE 00`);

        await within(STEP_MS, "stop", zh.stop());
        await within(STEP_MS, "the link closing", peer.idle());

        const again = zhs.create("formed", peer.transport);
        assert.equal(await within(STEP_MS, "second start", again.start()), "resumed");
        assert.equal(again.getDeviceByIeeeAddr(ROUTER_IEEE)?.modelID, ROUTER.modelId);
        await within(STEP_MS, "second stop", again.stop());
        assertClean(peer);
    } finally {
        await teardown(setup);
    }
});

test("a coordinator on another network is restored from the controller's backup", async () => {
    const directory = testDirectory();
    const formed = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION});
    const other = await startZsCoordinator({ieee: OTHER_IEEE, version: VERSION, records: networkRecords(OTHER_NETWORK), state: 9});
    const zhs = controllers(directory);
    try {
        const first = zhs.create("restore", formed.transport);
        await formWithRouter(first, formed);
        await first.backup();
        await within(STEP_MS, "stop", first.stop());

        const zh = zhs.create("restore", other.transport);
        assert.equal(await within(STEP_MS, "start", zh.start()), "restored");
        assert.equal(other.coordinator.ieee, FACTORY_IEEE);
        assert.deepEqual(await zh.getNetworkParameters(), NETWORK_PARAMETERS);
        const backup = await zh.adapter.backup([]);
        assert.deepEqual(
            backup.devices.map((d) => [d.ieeeAddress.toString("hex"), d.networkAddress]),
            [[hex16(ROUTER.ieee), ROUTER.nwk]],
        );
        assert.equal(zh.getDeviceByIeeeAddr(ROUTER_IEEE)?.modelID, ROUTER.modelId);
        await within(STEP_MS, "stop", zh.stop());
        assertClean(formed);
        assertClean(other);
    } finally {
        await zhs.stopAll();
        await formed.close();
        await other.close();
    }
});

const SEED = Buffer.from("5a8d3c71e2049bf6a1c3e5072d4f6189", "hex");

/** ZeroStack's TCLK derivation: the seed rotated by `shift`, XOR the little-endian IEEE. */
function derivedKey(ieee, shift) {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(ieee);
    return Buffer.from(Array.from({length: 16}, (_, i) => SEED[(i + shift) % 16] ^ le[i % 8]));
}

/** An open coordinator backup of NETWORK: 18 devices plus a coordinator self-entry. */
function largeBackup() {
    const devices = [];
    for (let i = 0; i < 8; i++) {
        devices.push({
            nwk_address: (0x2000 + i).toString(16),
            ieee_address: hex16(0x00124b0000a10000n + BigInt(i)),
            is_child: i % 2 === 0,
            link_key: {key: Buffer.alloc(16, 0x11 * (i + 1)).toString("hex"), rx_counter: 100 + i, tx_counter: 1000 + i},
        });
    }
    for (let i = 0; i < 6; i++) {
        const ieee = 0x00124b0000b20000n + BigInt(i);
        devices.push({
            nwk_address: (0x3000 + i).toString(16),
            ieee_address: hex16(ieee),
            is_child: false,
            link_key: {key: derivedKey(ieee, i + 1).toString("hex"), rx_counter: 50 + i, tx_counter: 5000 + i},
        });
    }
    devices.push({nwk_address: "4001", ieee_address: hex16(0x00124b0000c30001n), is_child: false});
    devices.push({nwk_address: "4002", ieee_address: hex16(0x00124b0000c30002n), is_child: true});
    devices.push({nwk_address: "0000", ieee_address: hex16(FACTORY_IEEE), is_child: false});
    devices.push({
        nwk_address: "0000",
        ieee_address: hex16(0x00124b0000d40000n),
        is_child: false,
        link_key: {key: Buffer.alloc(16, 0x77).toString("hex"), rx_counter: 7, tx_counter: 70},
    });
    devices.push({
        nwk_address: "fffe",
        ieee_address: hex16(0x00124b0000e50000n),
        is_child: true,
        link_key: {key: derivedKey(0x00124b0000e50000n, 9).toString("hex"), rx_counter: 9, tx_counter: 90},
    });
    return {
        metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "zerostack-adapter test", internal: {}},
        stack_specific: {zstack: {tclk_seed: SEED.toString("hex")}},
        coordinator_ieee: hex16(FACTORY_IEEE),
        pan_id: "1a2b",
        extended_pan_id: "dd0000001a2b0001",
        nwk_update_id: 0,
        security_level: 5,
        channel: 15,
        channel_mask: [15],
        network_key: {key: Buffer.from(NETWORK.networkKey).toString("hex"), sequence_number: 0, frame_counter: 4000},
        devices,
    };
}

test("a backup of 18 devices with explicit and derived link keys restores in several chunks and exports in several pages", async () => {
    const directory = testDirectory();
    const source = largeBackup();
    writeFileSync(join(directory, "coordinator_backup.json"), JSON.stringify(source));
    const peer = await startZsCoordinator({ieee: OTHER_IEEE, version: VERSION, records: networkRecords(OTHER_NETWORK), state: 9});
    const zhs = controllers(directory);
    try {
        const zh = zhs.create("large", peer.transport);
        assert.equal(await within(STEP_MS, "start", zh.start()), "restored");
        assert.ok(peer.coordinator.importChunks.at(-1) >= 3, `the import took ${peer.coordinator.importChunks.at(-1)} chunks`);

        const expected = source.devices.filter((d) => d.ieee_address !== hex16(FACTORY_IEEE));
        const nodes = new Map(nodeRecords(peer.coordinator.records).map((n) => [hex16(n.ieee), n]));
        assert.deepEqual([...nodes.keys()].sort(), expected.map((d) => d.ieee_address).sort());
        assert.deepEqual(
            expected.map((d) => nodes.get(d.ieee_address).keyKind),
            [...Array(8).fill("explicit"), ...Array(6).fill("derived"), "none", "none", "explicit", "derived"],
        );
        assert.deepEqual(
            ["00124b0000d40000", "00124b0000e50000"].map((ieee) => nodes.get(ieee).nwk),
            [0xfffe, 0xfffe],
        );

        const pagesBefore = peer.coordinator.exportPages;
        await zh.backup();
        assert.ok(peer.coordinator.exportPages - pagesBefore >= 3, `the export took ${peer.coordinator.exportPages - pagesBefore} pages`);
        const exported = JSON.parse(readFileSync(join(directory, "coordinator_backup.json"), "utf8"));
        assert.equal(exported.stack_specific.zstack.tclk_seed, SEED.toString("hex"));
        assert.ok(exported.network_key.frame_counter >= source.network_key.frame_counter);
        const byIeee = new Map(exported.devices.map((d) => [d.ieee_address, d]));
        assert.deepEqual([...byIeee.keys()].sort(), expected.map((d) => d.ieee_address).sort());
        for (const want of expected) {
            const got = byIeee.get(want.ieee_address);
            const unaddressed = want.nwk_address === "0000" || want.nwk_address === "fffe";
            assert.equal(got.nwk_address, unaddressed ? null : want.nwk_address, want.ieee_address);
            assert.equal(got.is_child, want.is_child, want.ieee_address);
            assert.equal(got.link_key?.key, want.link_key?.key, want.ieee_address);
            if (want.link_key !== undefined) {
                assert.ok(got.link_key.rx_counter >= want.link_key.rx_counter, want.ieee_address);
                assert.ok(got.link_key.tx_counter >= want.link_key.tx_counter, want.ieee_address);
            }
        }
        await within(STEP_MS, "stop", zh.stop());
        assertClean(peer);
    } finally {
        await zhs.stopAll();
        await peer.close();
    }
});

test("a backup on channel 25 with a channel_mask of 11..26 restores for channelList [25], resumes and exports [25]", async () => {
    const directory = testDirectory();
    const network = {...NETWORK, channelList: [25]};
    const allChannels = Array.from({length: 16}, (_, i) => 11 + i);
    writeFileSync(
        join(directory, "coordinator_backup.json"),
        JSON.stringify({
            metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "zerostack-adapter test", internal: {}},
            stack_specific: {zstack: {tclk_seed: SEED.toString("hex")}},
            coordinator_ieee: hex16(FACTORY_IEEE),
            pan_id: "1a2b",
            extended_pan_id: "dd0000001a2b0001",
            nwk_update_id: 0,
            security_level: 5,
            channel: 25,
            channel_mask: allChannels,
            network_key: {key: Buffer.from(NETWORK.networkKey).toString("hex"), sequence_number: 0, frame_counter: 4000},
            devices: [{nwk_address: "4001", ieee_address: hex16(0x00124b0000c30001n), is_child: false}],
        }),
    );
    const peer = await startZsCoordinator({ieee: OTHER_IEEE, version: VERSION, records: networkRecords(OTHER_NETWORK), state: 9});
    const zhs = controllers(directory);
    try {
        const zh = zhs.create("mask", peer.transport, network);
        assert.equal(await within(STEP_MS, "start", zh.start()), "restored");
        // the backup's mask is restored as is: 0x07fff800 = channels 11..26
        assert.equal(peer.coordinator.network().channelMask, 0x07fff800);
        assert.deepEqual(await zh.getNetworkParameters(), {...NETWORK_PARAMETERS, channel: 25});
        await zh.backup();
        const exported = JSON.parse(readFileSync(join(directory, "coordinator_backup.json"), "utf8"));
        assert.equal(exported.channel, 25);
        assert.deepEqual(exported.channel_mask, [25]);
        assert.deepEqual(
            exported.devices.map((d) => d.ieee_address),
            [hex16(0x00124b0000c30001n)],
        );
        await within(STEP_MS, "stop", zh.stop());

        // the NIB still holds all 16 channels: the next start resumes without an import (forming or restoring)
        const importsBefore = peer.coordinator.importChunks.length;
        const again = zhs.create("mask", peer.transport, network);
        assert.equal(await within(STEP_MS, "restart", again.start()), "resumed");
        assert.equal(peer.coordinator.importChunks.length, importsBefore);
        await within(STEP_MS, "stop", again.stop());
        assertClean(peer);
    } finally {
        await zhs.stopAll();
        await peer.close();
    }
});

test("the router rejoins at a new address, leaves with and without rejoin and is removed by the controller", async () => {
    const setup = await formedSetup();
    const {peer, zh} = setup;
    try {
        let router = zh.getDeviceByIeeeAddr(ROUTER_IEEE);
        // the controller takes the new address from the trust center join, then sees it again in the announce
        const announced = once(zh, "deviceAnnounce");
        peer.rejoin(0x6b10);
        assert.equal((await within(STEP_MS, "device announce", announced)).device.ieeeAddr, ROUTER_IEEE);
        assert.equal(router.networkAddress, 0x6b10);
        assert.deepEqual(await router.getEndpoint(1).read("genOnOff", ["onOff"]), {onOff: 0});
        assert.equal(peer.coordinator.afRequests.at(-1).dst, 0x6b10);

        const leaves = [];
        zh.on("deviceLeave", (d) => leaves.push(d.ieeeAddr));
        peer.leave(true);
        // the link delivers in order: a reply after the indication means it was handled
        assert.deepEqual(await zh.getNetworkParameters(), NETWORK_PARAMETERS);
        assert.deepEqual(leaves, []);
        assert.ok(zh.getDeviceByIeeeAddr(ROUTER_IEEE));

        await router.removeFromNetwork();
        assert.equal(count(peer, "ZDO_MGMT_LEAVE_REQ"), 1);
        assert.equal(zh.getDeviceByIeeeAddr(ROUTER_IEEE), undefined);
        assert.equal(peer.router.joined, false);

        router = await joinRouter(zh, peer);
        const left = once(zh, "deviceLeave");
        peer.leave(false);
        assert.equal((await within(STEP_MS, "deviceLeave", left)).ieeeAddr, ROUTER_IEEE);
        assert.equal(zh.getDeviceByIeeeAddr(ROUTER_IEEE), undefined);
        assert.deepEqual(leaves, [ROUTER_IEEE]);
        assertClean(peer);
    } finally {
        await teardown(setup);
    }
});

test("groupcast and broadcast ZCL reach the router through AF_DATA_REQUEST_EXT and AF_DATA_REQUEST", async () => {
    const setup = await formedSetup();
    const {peer, zh} = setup;
    try {
        const requests = peer.coordinator.afRequests;
        const last = () => requests.at(-1);
        await zh.createGroup(ROUTER.group).command("genOnOff", "on", {});
        assert.deepEqual([last().command, last().mode, last().dst, last().dstEp, last().cluster], [0x02, 1, ROUTER.group, 0xff, 0x0006]);
        assert.equal(peer.router.onOff, true);

        await zh.sendRaw({
            networkAddress: 0xfffd,
            dstEndpoint: 0xff,
            clusterKey: "genOnOff",
            zcl: {frameType: Zcl.FrameType.SPECIFIC, direction: Zcl.Direction.CLIENT_TO_SERVER, commandKey: "toggle", payload: {}},
        });
        assert.deepEqual([last().command, last().dst, last().dstEp, last().cluster], [0x01, 0xfffd, 0xff, 0x0006]);
        assert.equal(peer.router.onOff, false);
        assertClean(peer);
    } finally {
        await teardown(setup);
    }
});

test("unicasts share 8 AF slots, retry a busy coordinator and fail on extended delivery confirms", async () => {
    const setup = await formedSetup();
    const {peer, zh, router} = setup;
    try {
        const endpoint = router.getEndpoint(1);
        const requests = peer.coordinator.afRequests;

        const before = requests.length;
        const held = peer.holdAf(8);
        const reads = Array.from({length: 12}, () => endpoint.read("genBasic", ["zclVersion"]));
        await within(STEP_MS, "8 AF requests in flight", held);
        // the link is ordered: this reply comes after any 9th AF request already written
        assert.deepEqual(await zh.getNetworkParameters(), NETWORK_PARAMETERS);
        assert.equal(requests.length - before, 8);
        peer.releaseAf();
        assert.deepEqual(await within(STEP_MS, "12 reads", Promise.all(reads)), Array(12).fill({zclVersion: 8}));
        assert.equal(requests.length - before, 12);

        const busyBefore = requests.length;
        peer.coordinator.busy = 1;
        assert.deepEqual(await endpoint.read("genBasic", ["zclVersion"]), {zclVersion: 8});
        assert.equal(requests.length - busyBefore, 2);
        assert.equal(requests.at(-1).tid, requests.at(-2).tid);

        for (const status of [0xe9, 0xcd, 0xf0]) {
            peer.coordinator.failConfirms.push({status, extended: true});
            await assert.rejects(endpoint.read("genBasic", ["zclVersion"]), (error) => {
                assert.match(error.message, new RegExp(`delivery status=0x${status.toString(16)}: `));
                return true;
            });
        }
        assert.deepEqual(await endpoint.read("genBasic", ["zclVersion"]), {zclVersion: 8});
        assertClean(peer);
    } finally {
        await teardown(setup);
    }
});

test("start refuses to replace a coordinator running the backup's network or to form on two channels", async () => {
    const directory = testDirectory();
    writeFileSync(
        join(directory, "coordinator_backup.json"),
        JSON.stringify({
            metadata: {format: "zigpy/open-coordinator-backup", version: 1, source: "zerostack-adapter test", internal: {}},
            stack_specific: {},
            coordinator_ieee: hex16(OTHER_IEEE),
            pan_id: "0bad",
            extended_pan_id: "dd0000000bad0001",
            nwk_update_id: 0,
            security_level: 5,
            channel: 20,
            channel_mask: [20],
            network_key: {key: OTHER_NETWORK.networkKey.toString("hex"), sequence_number: 0, frame_counter: 100},
            devices: [],
        }),
    );
    const running = await startZsCoordinator({ieee: OTHER_IEEE, version: VERSION, records: networkRecords(OTHER_NETWORK), state: 9});
    const blank = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION});
    const zhs = controllers(directory);
    try {
        // the configuration names another network than the backup the coordinator runs
        await assert.rejects(zhs.create("refused", running.transport).start(), /runs the backup's network/);
        assert.equal(count(running, "SYS_RESET_REQ"), 0);
        assert.deepEqual(running.coordinator.importChunks, []);
        assert.equal(running.coordinator.network().panId, 0x0bad);

        rmSync(join(directory, "coordinator_backup.json"));
        await assert.rejects(zhs.create("two", blank.transport, {...NETWORK, channelList: [11, 15]}).start(), /exactly one channel/);
        assert.equal(count(blank, "SYS_RESET_REQ"), 0);
        assert.deepEqual(blank.coordinator.importChunks, []);
        assert.deepEqual(running.coordinator.errors, []);
        assert.deepEqual(blank.coordinator.errors, []);
    } finally {
        await zhs.stopAll();
        await running.close();
        await blank.close();
    }
});

test("install codes and inter-PAN frames reach the coordinator through the addon", async () => {
    const directory = testDirectory();
    const peer = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION});
    const zhs = controllers(directory);
    try {
        const zh = zhs.create("interpan", peer.transport);
        assert.equal(await within(STEP_MS, "start", zh.start()), "reset");

        // the Zigbee specification's example install code; C3B5 is its CRC
        const code = "83fed3407a939723a5c639b26916d505";
        await zh.addInstallCode(`Z:0011223344556677$I:${code}C3B5`);
        // without the CRC herdsman sends the code with its CRC and the 16 bytes as a hashed key
        await zh.addInstallCode(`Z:0011223344556677$I:${code}`);
        const ieee = 0x0011223344556677n;
        assert.deepEqual(peer.coordinator.installCodes, [
            {format: 1, ieee, code: `${code}c3b5`},
            {format: 1, ieee, code: `${code}c3b5`},
            {format: 2, ieee, code},
        ]);

        const touchlink = (name, payload) =>
            Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 7, name, "touchlink", payload, {});
        const identify = touchlink("identifyRequest", {transactionID: 1, duration: 3});
        const scan = touchlink("scanRequest", {transactionID: 2, zigbeeInformation: 4, touchlinkInformation: 18});
        const before = peer.coordinator.afRequests.length;
        await zh.adapter.setChannelInterPAN(11);
        await zh.adapter.sendZclFrameInterPANToIeeeAddr(identify, "0x0017880100c0ffee");
        await zh.adapter.sendZclFrameInterPANBroadcast(scan, 500, true);
        await zh.adapter.restoreChannelInterPAN();
        // AF_INTER_PAN_CTL: register endpoint 12, set channel 11, back to the network channel
        assert.deepEqual(peer.coordinator.interpanCtl, [[2, 12], [1, 11], [0]]);
        const interpan = (mode, address, frame) => ({
            mode,
            address,
            dstEp: 0xfe,
            pan: 0xffff,
            srcEp: 12,
            cluster: 0x1000,
            payload: frame.toBuffer().toString("hex"),
        });
        assert.deepEqual(
            peer.coordinator.afRequests.slice(before).map((r) => ({
                mode: r.mode,
                address: r.address,
                dstEp: r.dstEp,
                pan: r.pan,
                srcEp: r.srcEp,
                cluster: r.cluster,
                payload: r.payload.toString("hex"),
            })),
            [interpan(3, 0x0017880100c0ffeen, identify), interpan(2, 0xffffn, scan)],
        );

        // a touchlink device answers the scan on AF_INCOMING_MSG_EXT from the Stub APS endpoint 0xFE;
        // identify sends its identify request only after that reply reached herdsman
        peer.coordinator.interpanReply = {
            ieee: 0x0017880100c0ffeen,
            zcl: Zcl.Frame.create(
                Zcl.FrameType.SPECIFIC,
                Zcl.Direction.SERVER_TO_CLIENT,
                true,
                undefined,
                0,
                "scanResponse",
                "touchlink",
                {
                    transactionID: 1,
                    rssiCorrection: 0,
                    zigbeeInformation: 5,
                    touchlinkInformation: 18,
                    keyBitmask: 0x10,
                    responseID: 1,
                    extendedPanID: "0x0102030405060708",
                    networkUpdateID: 0,
                    logicalChannel: 15,
                    panID: 0x1a62,
                    networkAddress: 0x4a21,
                    numberOfSubDevices: 0,
                    totalGroupIdentifiers: 0,
                },
                {},
            ).toBuffer(),
        };
        const identified = peer.coordinator.afRequests.length;
        await within(STEP_MS, "touchlink identify", zh.touchlink.identify("0x0017880100c0ffee", 15));
        assert.deepEqual(peer.coordinator.interpanCtl.slice(3), [[2, 12], [1, 15], [0]]);
        assert.deepEqual(
            peer.coordinator.afRequests.slice(identified).map((r) => [r.mode, r.address, r.payload[2]]),
            [
                [2, 0xffffn, 0x00],
                [3, 0x0017880100c0ffeen, 0x06],
            ],
        );

        // the inter-PAN lock is released: network traffic is accepted again
        await zh.permitJoin(10);
        await within(STEP_MS, "stop", zh.stop());
        assertClean(peer);
    } finally {
        await zhs.stopAll();
        await peer.close();
    }
});

test("a soft reset leaves the coordinator in DEV_HOLD refusing AF until start(); a hard reset is refused; a lost link emits adapterDisconnected", async () => {
    const setup = await formedSetup();
    const {peer, zhs, zh, router} = setup;
    try {
        const resets = count(peer, "SYS_RESET_REQ");
        await within(STEP_MS, "soft reset", zh.reset("soft"));
        assert.equal(count(peer, "SYS_RESET_REQ"), resets + 1);
        // the coordinator is back in DEV_HOLD with no endpoints; the renegotiated link answers in COBS-Mux
        assert.equal(peer.coordinator.state, 0);
        assert.equal(peer.coordinator.endpoints.size, 0);
        assert.equal((await zh.getCoordinatorVersion()).type, "zStack3x0");
        // AF is refused before anything is sent until start() registers the endpoints again
        const sent = peer.coordinator.afRequests.length;
        await assert.rejects(router.getEndpoint(1).read("genOnOff", ["onOff"]), /source endpoint 1 is not registered/);
        assert.equal(peer.coordinator.afRequests.length, sent);
        await assert.rejects(zh.reset("hard"), /hard reset/);
        assert.equal(count(peer, "SYS_RESET_REQ"), resets + 1);
        await within(STEP_MS, "stop", zh.stop());

        const again = zhs.create("formed", peer.transport);
        assert.equal(await within(STEP_MS, "restart", again.start()), "resumed");
        assert.equal(peer.coordinator.state, 9);
        assert.deepEqual(await again.getDeviceByIeeeAddr(ROUTER_IEEE).getEndpoint(1).read("genOnOff", ["onOff"]), {onOff: 0});

        const disconnected = once(again, "adapterDisconnected");
        peer.dropHost();
        await within(STEP_MS, "adapterDisconnected", disconnected);
        assert.deepEqual(peer.coordinator.errors, []);
        assert.deepEqual(errors, [
            // stop() after the reset: herdsman's Green Power permit-join broadcast is refused like any AF send
            "zh:controller: Failed to disable join on stop: ZsNativeError: [zerostack-adapter] ZCL greenPower.commisioningMode broadcast to 0xfffd failed: invalid: source endpoint 242 is not registered with profile 0xa1e0",
            "zh:zerostack: coordinator link lost: transport: the transport closed",
        ]);
    } finally {
        await teardown(setup);
    }
});

test("stop() rejects a ZDO request queued behind an unanswered one at once", async () => {
    const setup = await formedSetup();
    const {peer, zh} = setup;
    try {
        const request = (endpoint) =>
            zh.adapter.sendZdo(
                ROUTER_IEEE,
                ROUTER.nwk,
                Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST,
                Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, ROUTER.nwk, endpoint),
                false,
            );
        peer.coordinator.mutedZdo.add(0x04);
        const sent = count(peer, "ZDO_SIMPLE_DESC_REQ");
        const outcomes = Promise.allSettled([request(1), request(2)]);
        await within(STEP_MS, "the first request", peer.audited("ZDO_SIMPLE_DESC_REQ", sent + 1));

        await within(STEP_MS, "stop", zh.stop());
        assert.deepEqual(
            (await within(2_000, "both rejections", outcomes)).map((o) => [o.status, o.reason?.message]),
            [
                ["rejected", "[zerostack-adapter] adapter stopped"],
                ["rejected", "[zerostack-adapter] adapter stopped"],
            ],
        );
        assert.equal(count(peer, "ZDO_SIMPLE_DESC_REQ"), sent + 1);
        assertClean(peer);
    } finally {
        await teardown(setup);
    }
});
