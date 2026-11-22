// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// The built native addon against the in-process ZeroStack peer of zsPeer.mjs on loopback TCP:
// open, coordinatorVersion and stop. Run `npm run build` first.
import assert from "node:assert/strict";
import {afterEach, test} from "node:test";
import {loadNativeCoordinator} from "../dist/native.js";
import {coordinatorVersionOf, startZsPeer} from "./zsPeer.mjs";

const TIMEOUT_MS = 5_000;
const VERSION = {transportRev: 2, product: 1, major: 2, minor: 7, maint: 1, revision: 20261116};

let peer;

afterEach(async () => {
    await peer?.close();
    peer = undefined;
});

/** Rejects after `ms` unless `promise` settles first; the timer never outlives it. */
function within(ms, what, promise) {
    let timer;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

test("opens a zs link, reads the coordinator version and stops without a disconnect event", async () => {
    peer = await startZsPeer(VERSION);
    const ZsCoordinator = loadNativeCoordinator();
    const events = [];

    const coordinator = await ZsCoordinator.open(
        {backend: "zs", transport: peer.transport, baudRate: 115200, rtscts: false},
        (batch) => events.push(...batch),
        TIMEOUT_MS,
    ).catch((error) => {
        throw peer.errors.length === 0 ? error : new AggregateError([error, ...peer.errors], "open failed after the peer refused input");
    });

    assert.deepEqual(peer.audit.slice(0, 3), ["unpi SYS_PING", "unpi SYS_VERSION", "probe SYS_ZS_CAPS"]);

    const version = await coordinator.coordinatorVersion(TIMEOUT_MS);
    assert.deepEqual(version, coordinatorVersionOf(VERSION));
    assert.ok(
        peer.audit.slice(3).every((entry) => entry.startsWith("mux ")),
        `requests after the probe left COBS-Mux: ${peer.audit.join(", ")}`,
    );

    await coordinator.stop();
    await within(TIMEOUT_MS, "the peer seeing the link close", peer.disconnected);
    await coordinator.stop();

    assert.deepEqual(peer.errors, []);
    assert.deepEqual(events, []);
});

test("delivers a burst of indications in link order, in batches", async () => {
    peer = await startZsPeer(VERSION);
    const ZsCoordinator = loadNativeCoordinator();
    const batches = [];
    let all;
    const delivered = new Promise((resolve) => {
        all = resolve;
    });
    const BURST = 64;
    const coordinator = await ZsCoordinator.open(
        {backend: "zs", transport: peer.transport, baudRate: 115200, rtscts: false},
        (batch) => {
            batches.push(batch);
            if (batches.flat().length === BURST) {
                all();
            }
        },
        TIMEOUT_MS,
    );

    // ZDO_TC_DEV_IND: network address, IEEE address, parent; no endpoint needs registering.
    const joins = Array.from({length: BURST}, (_, i) => {
        const payload = Buffer.alloc(12);
        payload.writeUInt16LE(0x1000 + i, 0);
        payload.writeBigUInt64LE(0x00158d0000000000n + BigInt(i), 2);
        return {subsystem: 0x05, command: 0xca, payload};
    });
    peer.indicate(joins);
    await within(TIMEOUT_MS, "the burst reaching onEvent", delivered);
    await coordinator.stop();

    assert.deepEqual(
        batches.flat(),
        joins.map((_, i) => ({
            kind: "deviceJoined",
            networkAddress: 0x1000 + i,
            ieeeAddr: `0x${(0x00158d0000000000n + BigInt(i)).toString(16).padStart(16, "0")}`,
        })),
    );
    assert.ok(batches.every((b) => b.length > 0));
    assert.deepEqual(peer.errors, []);
});

test("contains a throwing JS onEvent callback without uncaughtException and closes cleanly", async () => {
    peer = await startZsPeer(VERSION);
    const ZsCoordinator = loadNativeCoordinator();
    const uncaught = [];
    const onUncaught = (error) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);

    let calls = 0;
    let markInvoked;
    const invoked = new Promise((resolve) => {
        markInvoked = resolve;
    });

    try {
        const coordinator = await ZsCoordinator.open(
            {backend: "zs", transport: peer.transport, baudRate: 115200, rtscts: false},
            () => {
                calls++;
                markInvoked();
                throw new Error("callback boom");
            },
            TIMEOUT_MS,
        );

        const payload = Buffer.alloc(12);
        payload.writeUInt16LE(0x1234, 0);
        payload.writeBigUInt64LE(0x00158d0000000001n, 2);
        peer.indicate([{subsystem: 0x05, command: 0xca, payload}]);

        await within(TIMEOUT_MS, "throwing onEvent invocation", invoked);
        await within(TIMEOUT_MS, "the peer seeing the link close", peer.disconnected);
        await assert.rejects(() => coordinator.stop(), /event delivery to JavaScript failed/);

        assert.equal(calls, 1);
        assert.deepEqual(uncaught, []);
        assert.deepEqual(peer.errors, []);
    } finally {
        process.off("uncaughtException", onUncaught);
    }
});
