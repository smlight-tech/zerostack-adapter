// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {Logger} from "zigbee-herdsman/dist/utils/logger.js";
import type {NativeLogLevel, NativeLogRecord} from "../native.js";
import {loggerModule} from "./herdsman.js";
import type {NativeAddon} from "./native.js";

export const MANAGED_NAMESPACES = ["zh:zerostack", "zh:zerostack:mt", "zh:zerostack:transport"] as const;

export interface ConfigurableLogger extends Logger {
    getLevel?(): string;
    setLevel?(level: string): void;
    getNamespacedLevels?(): Record<string, string>;
    setNamespacedLevels?(levels: Record<string, string>): void;
}

const LEVEL_RANK: Record<NativeLogLevel, number> = {
    off: 0,
    error: 1,
    warning: 2,
    info: 3,
    debug: 4,
    trace: 5,
};

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/;

export function normalizeLogLevel(value: unknown): NativeLogLevel | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    switch (value.trim().toLowerCase()) {
        case "off":
        case "none":
            return "off";
        case "error":
            return "error";
        case "warning":
        case "warn":
            return "warning";
        case "info":
            return "info";
        case "debug":
            return "debug";
        case "trace":
            return "trace";
        default:
            return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readBaseLevel(logger: unknown): NativeLogLevel {
    if (!isRecord(logger)) {
        return "info";
    }
    const getter: unknown = Reflect.get(logger, "getLevel");
    if (typeof getter !== "function") {
        return "info";
    }
    const normalized = normalizeLogLevel(Reflect.apply(getter, logger, []));
    return normalized ?? "info";
}

function readNamespacedLevels(logger: unknown): Record<string, string> | undefined {
    if (!isRecord(logger)) {
        return undefined;
    }
    const getter: unknown = Reflect.get(logger, "getNamespacedLevels");
    if (typeof getter !== "function") {
        return undefined;
    }
    const raw: unknown = Reflect.apply(getter, logger, []);
    if (!isRecord(raw)) {
        return undefined;
    }
    const clean: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw)) {
        if (typeof val === "string") {
            clean[key] = val;
        }
    }
    return clean;
}

function levelForNamespace(namespace: string, base: NativeLogLevel, namespaced: Record<string, string> | undefined): NativeLogLevel {
    if (namespaced === undefined) {
        return base;
    }

    let bestPrefixLen = -1;
    let prefixMatch: NativeLogLevel | undefined;

    for (const [pattern, rawLevel] of Object.entries(namespaced)) {
        const parsed = normalizeLogLevel(rawLevel);
        if (parsed === undefined) {
            continue;
        }
        if ((namespace === pattern || namespace.startsWith(`${pattern}:`)) && pattern.length > bestPrefixLen) {
            bestPrefixLen = pattern.length;
            prefixMatch = parsed;
        }
    }

    if (prefixMatch !== undefined) {
        return prefixMatch;
    }

    for (const [pattern, rawLevel] of Object.entries(namespaced)) {
        if (!REGEX_SYNTAX.test(pattern)) {
            continue;
        }
        const parsed = normalizeLogLevel(rawLevel);
        if (parsed === undefined) {
            continue;
        }
        try {
            if (new RegExp(pattern).test(namespace)) {
                return parsed;
            }
        } catch (error) {
            // Host configuration may supply malformed user regex patterns.
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
        }
    }

    return base;
}

export function resolveEffectiveLogLevel(logger: unknown): NativeLogLevel {
    const base = readBaseLevel(logger);
    const namespaced = readNamespacedLevels(logger);
    let maxLevel: NativeLogLevel = "off";
    let maxRank = LEVEL_RANK[maxLevel];

    for (const ns of MANAGED_NAMESPACES) {
        const candidate = levelForNamespace(ns, base, namespaced);
        const rank = LEVEL_RANK[candidate];
        if (rank > maxRank) {
            maxRank = rank;
            maxLevel = candidate;
        }
    }

    return maxLevel;
}

export function dispatchNativeLog(record: NativeLogRecord, target: Logger = loggerModule.logger): void {
    switch (record.level) {
        case "error":
            target.error(record.message, record.namespace);
            break;
        case "warning":
            target.warning(record.message, record.namespace);
            break;
        case "info":
            target.info(record.message, record.namespace);
            break;
        case "debug":
            target.debug(record.message, record.namespace);
            break;
    }
}

type LogAddon = Pick<NativeAddon, "setLogHandler" | "setLogLevel">;

interface WrappedMethodState {
    readonly hadOwn: boolean;
    readonly originalDescriptor: PropertyDescriptor | undefined;
    readonly wrapper: (...args: unknown[]) => unknown;
}

const wrappedLoggers = new Map<object, Map<"setLevel" | "setNamespacedLevels", WrappedMethodState>>();

let activeAddon: LogAddon | undefined;
let originalLoggerProperty: PropertyDescriptor | undefined;
let loggerPropertyHooked = false;

function restoreLoggerMethods(target: object, methods: Map<"setLevel" | "setNamespacedLevels", WrappedMethodState>): void {
    for (const [name, state] of methods) {
        if (Reflect.get(target, name) !== state.wrapper) {
            continue;
        }
        if (state.hadOwn && state.originalDescriptor !== undefined) {
            Object.defineProperty(target, name, state.originalDescriptor);
        } else {
            Reflect.deleteProperty(target, name);
        }
    }
}

function attachLoggerMethods(logger: unknown): void {
    if (!isRecord(logger) || Object.isFrozen(logger)) {
        return;
    }

    let entries = wrappedLoggers.get(logger);
    if (entries === undefined) {
        entries = new Map();
        wrappedLoggers.set(logger, entries);
    }

    for (const name of ["setLevel", "setNamespacedLevels"] as const) {
        if (entries.has(name)) {
            continue;
        }
        const raw: unknown = Reflect.get(logger, name);
        if (typeof raw !== "function") {
            continue;
        }
        const hadOwn = Object.hasOwn(logger, name);
        const originalDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(logger, name) : undefined;
        if (originalDescriptor !== undefined && !originalDescriptor.configurable && !originalDescriptor.writable) {
            continue;
        }
        if (!hadOwn && !Object.isExtensible(logger)) {
            continue;
        }

        const originalFn = raw;
        const wrapper = function (this: unknown, ...args: unknown[]): unknown {
            const result: unknown = Reflect.apply(originalFn, this, args);
            syncNativeLogLevel();
            return result;
        };

        entries.set(name, {hadOwn, originalDescriptor, wrapper});
        Object.defineProperty(logger, name, {
            value: wrapper,
            configurable: true,
            enumerable: originalDescriptor?.enumerable ?? false,
            writable: true,
        });
    }
}

function ensureLoggerSetterHook(): void {
    if (loggerPropertyHooked) {
        return;
    }
    const existing = Object.getOwnPropertyDescriptor(loggerModule, "logger");
    if (existing !== undefined && !existing.configurable) {
        return;
    }
    originalLoggerProperty = existing;
    let current = loggerModule.logger;
    Object.defineProperty(loggerModule, "logger", {
        configurable: true,
        enumerable: existing?.enumerable ?? true,
        get: () => current,
        set: (next: Logger) => {
            current = next;
            attachLoggerMethods(next);
            syncNativeLogLevel();
        },
    });
    loggerPropertyHooked = true;
}

function restoreLoggerSetterHook(): void {
    if (!loggerPropertyHooked) {
        return;
    }
    const current = loggerModule.logger;
    if (originalLoggerProperty !== undefined) {
        Object.defineProperty(loggerModule, "logger", {
            ...originalLoggerProperty,
            value: current,
        });
    }
    originalLoggerProperty = undefined;
    loggerPropertyHooked = false;
}

export function syncNativeLogLevel(): NativeLogLevel | undefined {
    if (activeAddon === undefined) {
        return undefined;
    }
    const level = resolveEffectiveLogLevel(loggerModule.logger);
    activeAddon.setLogLevel(level);
    return level;
}

export function installNativeLogger(addon: LogAddon): void {
    if (activeAddon !== undefined && activeAddon !== addon) {
        activeAddon.setLogHandler(null);
    }
    activeAddon = addon;
    ensureLoggerSetterHook();
    attachLoggerMethods(loggerModule.logger);
    syncNativeLogLevel();
    addon.setLogHandler((record) => dispatchNativeLog(record));
}

export function uninstallNativeLogger(): void {
    if (activeAddon !== undefined) {
        activeAddon.setLogHandler(null);
        activeAddon.setLogLevel("info");
        activeAddon = undefined;
    }
    for (const [target, methods] of wrappedLoggers) {
        restoreLoggerMethods(target, methods);
    }
    wrappedLoggers.clear();
    restoreLoggerSetterHook();
}
