// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {describe, expect, it} from "vitest";
import {Adapter as HerdsmanAdapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import {ZsAdapter} from "../ts/adapter.js";
import * as entry from "../ts/index.js";
import {adapterTarget, isZsPath, parseZsPath} from "../ts/path.js";

describe("adapterTarget", () => {
    it.each([
        ["zs:serial:/dev/ttyUSB0", "zs", "serial:/dev/ttyUSB0"],
        ["zs:tcp://192.0.2.1:6638", "zs", "tcp://192.0.2.1:6638"],
        ["tcp://192.0.2.1:6638", "zs", "tcp://192.0.2.1:6638"],
        ["socket://192.0.2.1:6638", "zs", "tcp://192.0.2.1:6638"],
        ["/dev/ttyACM0", "zs", "serial:/dev/ttyACM0"],
        ["/dev/serial/by-id/usb-SMLIGHT-if00", "zs", "serial:/dev/serial/by-id/usb-SMLIGHT-if00"],
        ["COM3", "zs", "serial:COM3"],
        ["\\\\.\\COM12", "zs", "serial:\\\\.\\COM12"],
    ])("reads '%s' as backend %s over %s", (path, backend, transport) => {
        expect(adapterTarget(path)).toStrictEqual({backend, transport});
    });

    it.each(["tcp://192.0.2.1", "mdns://slzb-06", "udp://192.0.2.1:6638", "ttyUSB0", "zs:udp://192.0.2.1:6638"])("refuses '%s'", (path) => {
        expect(() => adapterTarget(path)).toThrow("[zerostack-adapter]");
    });

    it.each(["znp:tcp://192.0.2.1:6638", "znp:serial:/dev/ttyUSB0"])("no longer reads the removed znp scheme in '%s'", (path) => {
        expect(() => adapterTarget(path)).toThrow(`[zerostack-adapter] '${path}' is neither a zerostack-adapter path ('zs:<transport>')`);
        expect(() => parseZsPath(path)).toThrow(`[zerostack-adapter] '${path}' is not a zerostack-adapter path (expected 'zs:<transport>')`);
    });

    it("keeps the register hook's own test strict", () => {
        expect(isZsPath("tcp://192.0.2.1:6638")).toBe(false);
        expect(isZsPath("/dev/ttyUSB0")).toBe(false);
        expect(isZsPath("znp:tcp://192.0.2.1:6638")).toBe(false);
        expect(isZsPath("zs:tcp://192.0.2.1:6638")).toBe(true);
    });
});

describe("package entry as an external herdsman adapter", () => {
    it("exports ZsAdapter as Adapter and as the default export", () => {
        expect(entry.Adapter).toBe(ZsAdapter);
        expect(entry.default).toBe(ZsAdapter);
        expect(ZsAdapter.prototype).toBeInstanceOf(HerdsmanAdapter);
    });

    function build(path: string): InstanceType<typeof entry.Adapter> {
        return new entry.Adapter(
            {panID: 0x1a62, extendedPanID: [1, 2, 3, 4, 5, 6, 7, 8], channelList: [11], networkKey: Array(16).fill(7)},
            {path, adapter: "zstack"},
            "/nonexistent/backup.json",
            {disableLED: false},
        );
    }

    it.each([
        ["tcp://192.0.2.1:6638", "tcp://192.0.2.1:6638"],
        ["socket://192.0.2.1:6638", "tcp://192.0.2.1:6638"],
        ["/dev/ttyUSB0", "serial:/dev/ttyUSB0"],
        ["COM4", "serial:COM4"],
    ])("builds from herdsman's four constructor arguments with unprefixed '%s' as zs over %s, without loading the addon", (path, transport) => {
        expect(build(path).target).toStrictEqual({backend: "zs", transport});
    });

    it("refuses a znp: path instead of building an adapter for it", () => {
        expect(() => build("znp:tcp://192.0.2.1:6638")).toThrow("'znp:tcp://192.0.2.1:6638' is neither a zerostack-adapter path ('zs:<transport>')");
    });
});
