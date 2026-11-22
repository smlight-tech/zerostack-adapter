// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {existsSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import type {ZsCoordinator} from "../native.js";

export type CoordinatorOpener = Pick<typeof ZsCoordinator, "open">;

export function platformAddonTag(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
    isMusl: boolean = detectMusl(platform),
): string {
    if (platform === "linux") {
        if (arch === "arm") {
            return `linux-arm-${isMusl ? "musleabihf" : "gnueabihf"}`;
        }
        return `linux-${arch}-${isMusl ? "musl" : "gnu"}`;
    }
    if (platform === "win32") {
        return `win32-${arch}-msvc`;
    }
    return `${platform}-${arch}`;
}

function detectMusl(platform: NodeJS.Platform): boolean {
    if (platform !== "linux") {
        return false;
    }
    return glibcVersion(process.report.getReport()) === undefined;
}

// musl Node builds omit glibcVersionRuntime from process.report.
function glibcVersion(report: unknown): string | undefined {
    if (typeof report !== "object" || report === null || !("header" in report)) {
        return undefined;
    }
    const header: unknown = report.header;
    if (typeof header !== "object" || header === null || !("glibcVersionRuntime" in header)) {
        return undefined;
    }
    const version: unknown = header.glibcVersionRuntime;
    return typeof version === "string" && version !== "" ? version : undefined;
}

export function addonPath(tag: string = platformAddonTag()): string {
    return fileURLToPath(new URL(`../zerostack_adapter.${tag}.node`, import.meta.url));
}

export function loadNativeCoordinator(path: string = addonPath()): CoordinatorOpener {
    if (!existsSync(path)) {
        throw new Error(
            `[zerostack-adapter] native addon not found at '${path}' ` +
                `(expected zerostack_adapter.${platformAddonTag()}.node next to package.json)`,
        );
    }

    const loaded: unknown = createRequire(import.meta.url)(path);

    if (typeof loaded !== "object" || loaded === null || !("ZsCoordinator" in loaded)) {
        throw new Error(`[zerostack-adapter] native addon '${path}' does not export ZsCoordinator`);
    }

    const coordinator = loaded.ZsCoordinator;

    if (!isCoordinatorClass(coordinator)) {
        throw new Error(
            `[zerostack-adapter] native addon '${path}' exports a ZsCoordinator without a static open() and the methods ${INSTANCE_METHODS.join(", ")}`,
        );
    }

    return coordinator;
}

const INSTANCE_METHODS = [
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
] as const satisfies readonly (keyof ZsCoordinator)[];

function isCoordinatorClass(value: unknown): value is typeof ZsCoordinator {
    if (typeof value !== "function" || !("open" in value) || typeof value.open !== "function" || !("prototype" in value)) {
        return false;
    }

    const prototype: unknown = value.prototype;

    return (
        typeof prototype === "object" &&
        prototype !== null &&
        INSTANCE_METHODS.every((method) => method in prototype && typeof Reflect.get(prototype, method) === "function")
    );
}
