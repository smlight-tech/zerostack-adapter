// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {createRequire} from "node:module";
import {afterEach, describe, expect, it} from "vitest";
import {Adapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import type {NetworkOptions} from "zigbee-herdsman/dist/adapter/tstype.js";
import {ZStackAdapter} from "zigbee-herdsman/dist/adapter/z-stack/adapter/zStackAdapter.js";
import {ZsAdapter} from "../ts/adapter.js";
import type {CoordinatorOpener} from "../ts/native.js";
import {type Registration, register} from "../ts/register.js";
import {FakeCoordinator} from "./fakeCoordinator.js";

const NETWORK: NetworkOptions = {panID: 0x1a62, extendedPanID: [1, 2, 3, 4, 5, 6, 7, 8], channelList: [11], networkKey: Array(16).fill(7)};
const ORIGINAL_CREATE = Adapter.create;

let registration: Registration | undefined;

afterEach(() => {
    registration?.unregister();
    registration = undefined;
});

function registerCounting(): {opens: number[]} {
    const calls = {opens: [] as number[]};
    const fake = new FakeCoordinator();
    registration = register((): CoordinatorOpener => {
        calls.opens.push(calls.opens.length);

        return fake.opener();
    });

    return calls;
}

describe("register", () => {
    it("patches the Adapter class the Controller reaches through dist/adapter/index.js", () => {
        registerCounting();
        const controllerView: unknown = createRequire(import.meta.url)("zigbee-herdsman/dist/adapter/index.js");

        expect(controllerView).toHaveProperty("Adapter", Adapter);
        expect(Adapter.create).not.toBe(ORIGINAL_CREATE);
    });

    it("builds a ZsAdapter for zs:tcp:// paths and loads the addon only then", async () => {
        const calls = registerCounting();

        const adapter = await Adapter.create(NETWORK, {path: "zs:tcp://192.0.2.1:6638", adapter: "zstack"}, "/nonexistent/backup.json", {
            disableLED: false,
        });

        expect(adapter).toBeInstanceOf(ZsAdapter);
        expect(adapter instanceof ZsAdapter && adapter.target).toStrictEqual({backend: "zs", transport: "tcp://192.0.2.1:6638"});
        expect(calls.opens).toHaveLength(1);
    });

    it("delegates every other path to herdsman's original factory unchanged", async () => {
        const calls = registerCounting();

        const adapter = await Adapter.create(NETWORK, {path: "tcp://192.0.2.1:6638", adapter: "zstack"}, "/nonexistent/backup.json", {
            disableLED: false,
        });

        expect(adapter).toBeInstanceOf(ZStackAdapter);
        expect(adapter).not.toBeInstanceOf(ZsAdapter);
        expect(calls.opens).toHaveLength(0);
    });

    it("builds a ZsAdapter for the zs scheme", async () => {
        const calls = registerCounting();

        const adapter = await Adapter.create(NETWORK, {path: "zs:serial:/dev/ttyUSB0", adapter: "zstack"}, "/nonexistent/backup.json", {
            disableLED: false,
        });

        expect(adapter instanceof ZsAdapter && adapter.target).toStrictEqual({backend: "zs", transport: "serial:/dev/ttyUSB0"});
        expect(calls.opens).toHaveLength(1);
    });

    it.each(["znp", "zhs", "espzb", "ember", "ZNP", "ZS"])(
        "hands a '%s:' path to herdsman's original factory without loading the addon",
        async (scheme) => {
            const calls = registerCounting();

            const adapter = await Adapter.create(NETWORK, {path: `${scheme}:serial:/dev/ttyUSB0`, adapter: "zstack"}, "/nonexistent/backup.json", {
                disableLED: false,
            });

            expect(adapter).toBeInstanceOf(ZStackAdapter);
            expect(adapter).not.toBeInstanceOf(ZsAdapter);
            expect(calls.opens).toHaveLength(0);
        },
    );

    it("rejects a zs: path with an unknown transport without loading the addon", async () => {
        const calls = registerCounting();

        await expect(
            Adapter.create(NETWORK, {path: "zs:udp://192.0.2.1:6638", adapter: "zstack"}, "/nonexistent/backup.json", {disableLED: false}),
        ).rejects.toThrow("invalid transport 'udp://192.0.2.1:6638' in 'zs:udp://192.0.2.1:6638'");
        expect(calls.opens).toHaveLength(0);
    });

    it("propagates an addon load failure for zs: paths", async () => {
        registration = register(() => {
            throw new Error("[zerostack-adapter] native addon not found at '/opt/missing.node'");
        });

        await expect(
            Adapter.create(NETWORK, {path: "zs:serial:/dev/ttyACM0", adapter: "zstack"}, "/nonexistent/backup.json", {disableLED: false}),
        ).rejects.toThrow("/opt/missing.node");
    });

    it("returns the first registration on a second call and restores the original on unregister", async () => {
        const calls = registerCounting();
        const patched = Adapter.create;
        const second = register(() => {
            throw new Error("the second registration's opener must never be used");
        });

        expect(second).toBe(registration);
        expect(Adapter.create).toBe(patched);
        await Adapter.create(NETWORK, {path: "zs:serial:/dev/ttyUSB0", adapter: "zstack"}, "/nonexistent/backup.json", {disableLED: false});
        expect(calls.opens).toHaveLength(1);

        registration?.unregister();
        registration = undefined;
        expect(Adapter.create).toBe(ORIGINAL_CREATE);
    });

    it("leaves an Adapter.create another copy of the package patched alone", () => {
        const foreign: typeof Adapter.create = () => Promise.reject(new Error("the foreign patch must not run"));
        Object.defineProperty(foreign, Symbol.for("@smlight/zerostack-adapter/Adapter.create"), {value: true});
        Adapter.create = foreign;
        try {
            const other = register(() => new FakeCoordinator().opener());

            expect(Adapter.create).toBe(foreign);
            expect(() => other.unregister()).toThrow("patched by another copy of zerostack-adapter");
        } finally {
            Adapter.create = ORIGINAL_CREATE;
        }
    });
});
