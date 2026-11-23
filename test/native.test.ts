// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {addonPath, loadNativeAddon, loadNativeCoordinator, platformAddonTag} from "../ts/native.js";

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
    it("resolves strictly to the platform-tagged binary", () => {
        expect(addonPath("linux-x64-gnu")).toBe(fileURLToPath(new URL("../zerostack_adapter.linux-x64-gnu.node", import.meta.url)));
        expect(addonPath("nonexistent-platform")).toBe(fileURLToPath(new URL("../zerostack_adapter.nonexistent-platform.node", import.meta.url)));
        expect(addonPath()).toBe(fileURLToPath(new URL(`../zerostack_adapter.${platformAddonTag()}.node`, import.meta.url)));
    });

    it("formats platform prebuild tags for glibc, musl, macOS and Windows", () => {
        const expected: readonly [NodeJS.Platform, string, boolean, string][] = [
            ["linux", "x64", false, "linux-x64-gnu"],
            ["linux", "arm64", false, "linux-arm64-gnu"],
            ["linux", "x64", true, "linux-x64-musl"],
            ["linux", "arm64", true, "linux-arm64-musl"],
            ["linux", "arm", false, "linux-arm-gnueabihf"],
            ["linux", "arm", true, "linux-arm-musleabihf"],
            ["linux", "riscv64", false, "linux-riscv64-gnu"],
            ["darwin", "arm64", false, "darwin-arm64"],
            ["darwin", "x64", false, "darwin-x64"],
            ["win32", "x64", false, "win32-x64-msvc"],
            ["win32", "arm64", false, "win32-arm64-msvc"],
        ];
        for (const [platform, arch, isMusl, tag] of expected) {
            expect(platformAddonTag(platform, arch, isMusl)).toBe(tag);
        }

        const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        const scripts = typeof pkg === "object" && pkg !== null && "scripts" in pkg ? pkg.scripts : undefined;
        const prepack =
            typeof scripts === "object" && scripts !== null && "prepack" in scripts && typeof scripts.prepack === "string" ? scripts.prepack : "";
        for (const [, , , tag] of expected) {
            expect(prepack).toContain(`'${tag}'`);
        }
    });

    it("throws with the path tried when the binary is missing", () => {
        const missing = join(tempDir, "zerostack_adapter.linux-x64-gnu.node");
        const missingPlatform = addonPath("nonexistent-platform");

        expect(() => loadNativeCoordinator(missing)).toThrow(`native addon not found at '${missing}'`);
        expect(() => loadNativeCoordinator(missingPlatform)).toThrow(`native addon not found at '${missingPlatform}'`);
    });

    it("rejects a ZsCoordinator missing an instance method", () => {
        const fakeAddon = join(tempDir, "partial_addon.cjs");
        const methods = COMPLETE_METHODS.filter((method) => method !== "zdo");
        writeFileSync(
            fakeAddon,
            `module.exports = {setLogHandler() {}, setLogLevel() {}, ZsCoordinator: class { static open() {} ${methods.map((m) => `${m}() {}`).join(" ")} }};\n`,
        );

        expect(() => loadNativeCoordinator(fakeAddon)).toThrow("without a static open() and the methods");
    });

    it("rejects a module that does not export ZsCoordinator.open", () => {
        const fakeAddon = join(tempDir, "not_an_addon.cjs");
        writeFileSync(fakeAddon, "module.exports = {ZsCoordinator: class {}};\n");

        expect(() => loadNativeCoordinator(fakeAddon)).toThrow("without a static open()");
    });

    it("rejects an addon missing setLogHandler or setLogLevel", () => {
        const fakeAddon = join(tempDir, "no_logging_addon.cjs");
        writeFileSync(
            fakeAddon,
            `module.exports = {ZsCoordinator: class { static open() {} ${COMPLETE_METHODS.map((m) => `${m}() {}`).join(" ")} }};\n`,
        );

        expect(() => loadNativeAddon(fakeAddon)).toThrow("does not export setLogHandler() and setLogLevel()");
    });

    it("returns the exported coordinator class and logging hooks", () => {
        const fakeAddon = join(tempDir, "addon.cjs");
        writeFileSync(
            fakeAddon,
            `module.exports = {setLogHandler() {}, setLogLevel() {}, ZsCoordinator: class { static open() { return Promise.reject(new Error("fake")); } ${COMPLETE_METHODS.map((m) => `${m}() {}`).join(" ")} }};\n`,
        );

        const opener = loadNativeCoordinator(fakeAddon);
        const addon = loadNativeAddon(fakeAddon);
        const addonAgain = loadNativeAddon(fakeAddon);

        expect(opener.open).toBeTypeOf("function");
        expect(addon.setLogHandler).toBeTypeOf("function");
        expect(addon.setLogLevel).toBeTypeOf("function");
        expect(addonAgain).toBe(addon);
    });
});
