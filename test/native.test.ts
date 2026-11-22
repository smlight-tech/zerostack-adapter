// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {ADDON_ENV, addonPath, loadNativeCoordinator, PACKAGE_ADDON_PATH, platformAddonTag} from "../ts/native.js";

const COMPLETE_METHODS = [
    "start",
    "stop",
    "reset",
    "coordinatorIeee",
    "coordinatorVersion",
    "networkParameters",
    "supportsBackup",
    "backup",
    "addInstallCode",
    "permitJoin",
    "unicast",
    "groupcast",
    "broadcast",
    "zdo",
    "interpanChannel",
    "interpanSend",
];

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zerostack-adapter-addon-"));
});

afterEach(() => {
    rmSync(tempDir, {recursive: true, force: true});
});

describe("addon location", () => {
    it("uses the package-local binary unless the environment names one", () => {
        expect(PACKAGE_ADDON_PATH).toBe(fileURLToPath(new URL("../zerostack_adapter.node", import.meta.url)));
        expect(addonPath({}, "nonexistent-platform")).toBe(PACKAGE_ADDON_PATH);
        expect(addonPath({[ADDON_ENV]: "/opt/zerostack-adapter/zerostack_adapter.node"})).toBe("/opt/zerostack-adapter/zerostack_adapter.node");
        expect(() => addonPath({[ADDON_ENV]: ""})).toThrow(`${ADDON_ENV} is set but empty`);
    });

    it("formats platform prebuild tags for glibc, musl, macOS and Windows", () => {
        expect(platformAddonTag("linux", "x64", false)).toBe("linux-x64-gnu");
        expect(platformAddonTag("linux", "arm64", true)).toBe("linux-arm64-musl");
        expect(platformAddonTag("darwin", "arm64", false)).toBe("darwin-arm64");
        expect(platformAddonTag("win32", "x64", false)).toBe("win32-x64-msvc");
    });

    it("throws with the path tried when the binary is missing", () => {
        const missing = join(tempDir, "zerostack_adapter.node");

        expect(() => loadNativeCoordinator(missing)).toThrow(`native addon not found at '${missing}'`);
    });

    it("rejects a ZsCoordinator missing an instance method", () => {
        const fakeAddon = join(tempDir, "partial_addon.cjs");
        const methods = COMPLETE_METHODS.filter((method) => method !== "zdo");
        writeFileSync(fakeAddon, `module.exports = {ZsCoordinator: class { static open() {} ${methods.map((m) => `${m}() {}`).join(" ")} }};\n`);

        expect(() => loadNativeCoordinator(fakeAddon)).toThrow("without a static open() and the methods");
    });

    it("rejects a module that does not export ZsCoordinator.open", () => {
        const fakeAddon = join(tempDir, "not_an_addon.cjs");
        writeFileSync(fakeAddon, "module.exports = {ZsCoordinator: class {}};\n");

        expect(() => loadNativeCoordinator(fakeAddon)).toThrow("without a static open()");
    });

    it("returns the exported coordinator class", () => {
        const fakeAddon = join(tempDir, "addon.cjs");
        writeFileSync(
            fakeAddon,
            `module.exports = {ZsCoordinator: class { static open() { return Promise.reject(new Error("fake")); } ${COMPLETE_METHODS.map((m) => `${m}() {}`).join(" ")} }};\n`,
        );

        const opener = loadNativeCoordinator(fakeAddon);

        expect(opener.open).toBeTypeOf("function");
    });
});
