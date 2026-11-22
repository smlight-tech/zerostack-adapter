// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {existsSync, readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {dirname, isAbsolute, join} from "node:path";
import type * as Index from "zigbee-herdsman";
import type * as AdapterModule from "zigbee-herdsman/dist/adapter/adapter.js";
import type * as AdapterUtils from "zigbee-herdsman/dist/adapter/utils.js";
import type * as BackupModule from "zigbee-herdsman/dist/utils/backup.js";
import type * as LoggerModule from "zigbee-herdsman/dist/utils/logger.js";
import type * as WaitressModule from "zigbee-herdsman/dist/utils/waitress.js";

// Resolve zigbee-herdsman from the host via require() so we patch and extend the exact copy it runs.

export function hostAnchors(argv1: string | undefined, cwd: string): string[] {
    const anchors = argv1 !== undefined && isAbsolute(argv1) ? [argv1] : [];

    return [...anchors, join(cwd, "package.json"), import.meta.url];
}

function isModuleNotFound(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND";
}

function resolveFromPackageDir(dir: string, subpath: string): string | undefined {
    if (subpath !== "zigbee-herdsman" && !subpath.startsWith("zigbee-herdsman/")) {
        return undefined;
    }

    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
        return undefined;
    }

    let manifest: unknown;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }

    if (!record(manifest) || manifest.name !== "zigbee-herdsman") {
        return undefined;
    }

    const candidate = subpath === "zigbee-herdsman" ? join(dir, "dist", "index.js") : join(dir, subpath.slice("zigbee-herdsman/".length));

    return existsSync(candidate) ? candidate : undefined;
}

export function resolveHerdsman(subpath: string, anchors: string[]): string {
    for (const anchor of anchors) {
        try {
            return createRequire(anchor).resolve(subpath);
        } catch (error) {
            if (!isModuleNotFound(error)) {
                throw error;
            }
        }

        const selfResolved = resolveFromPackageDir(dirname(anchor), subpath);
        if (selfResolved !== undefined) {
            return selfResolved;
        }
    }

    throw new Error(`[zerostack-adapter] ${subpath} resolves from none of ${anchors.join(", ")}: run the host from its own directory`);
}

const ANCHORS = hostAnchors(process.argv[1], process.cwd());
const load = createRequire(import.meta.url);

function host(subpath: string): unknown {
    return load(resolveHerdsman(subpath, ANCHORS));
}

export function hostHerdsmanPath(subpath: string): string {
    return resolveHerdsman(subpath, ANCHORS);
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function functions(value: unknown, names: string[]): boolean {
    return (typeof value === "function" || record(value)) && names.every((name) => typeof Reflect.get(value, name) === "function");
}

function isIndex(value: unknown): value is Pick<typeof Index, "Zcl" | "Zdo" | "ZSpec"> {
    return (
        record(value) &&
        record(value.Zcl) &&
        functions(value.Zcl.Frame, ["fromBuffer", "create"]) &&
        functions(value.Zcl.Header, ["fromBuffer"]) &&
        record(value.Zcl.ManufacturerCode) &&
        record(value.Zdo) &&
        functions(value.Zdo.Buffalo, ["checkStatus"]) &&
        record(value.Zdo.ClusterId) &&
        functions(value.Zdo.Utils, ["getResponseClusterId"]) &&
        record(value.ZSpec) &&
        record(value.ZSpec.Utils)
    );
}

function isAdapterModule(value: unknown): value is Pick<typeof AdapterModule, "Adapter"> {
    return record(value) && functions(value.Adapter, ["create", "zclWaitressValidator", "clusterWaitressTimeoutFormatter"]);
}

function isAdapterUtils(value: unknown): value is Pick<typeof AdapterUtils, "readBackup"> {
    return record(value) && typeof value.readBackup === "function";
}

function isBackupUtils(value: unknown): value is Pick<typeof BackupModule, "fromUnifiedBackup" | "fromLegacyBackup" | "toUnifiedBackup"> {
    return functions(value, ["fromUnifiedBackup", "fromLegacyBackup", "toUnifiedBackup"]);
}

function isLoggerModule(value: unknown): value is typeof LoggerModule {
    return record(value) && record(value.logger) && typeof value.setLogger === "function";
}

function isWaitressModule(value: unknown): value is Pick<typeof WaitressModule, "Waitress"> {
    return record(value) && typeof value.Waitress === "function" && functions(value.Waitress.prototype, ["waitFor", "resolve", "remove", "clear"]);
}

function checked<T>(subpath: string, guard: (value: unknown) => value is T): T {
    const module = host(subpath);

    if (!guard(module)) {
        throw new Error(`[zerostack-adapter] ${subpath} of the host's zigbee-herdsman lacks what this adapter uses`);
    }

    return module;
}

const index = checked("zigbee-herdsman", isIndex);

export const {Zcl, Zdo, ZSpec} = index;
export const {Adapter} = checked("zigbee-herdsman/dist/adapter/adapter.js", isAdapterModule);
export const {readBackup} = checked("zigbee-herdsman/dist/adapter/utils.js", isAdapterUtils);
export const BackupUtils = checked("zigbee-herdsman/dist/utils/backup.js", isBackupUtils);
// Read loggerModule.logger per call because setLogger() mutates the export.
export const loggerModule = checked("zigbee-herdsman/dist/utils/logger.js", isLoggerModule);
export const {Waitress} = checked("zigbee-herdsman/dist/utils/waitress.js", isWaitressModule);
