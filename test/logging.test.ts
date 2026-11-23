// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {afterEach, describe, expect, it} from "vitest";
import {setLogger} from "zigbee-herdsman";
import loggerModule from "zigbee-herdsman/dist/utils/logger.js";
import type {NativeLogLevel, NativeLogRecord} from "../native.js";
import {type ConfigurableLogger, dispatchNativeLog, installNativeLogger, resolveEffectiveLogLevel, uninstallNativeLogger} from "../ts/logging.js";

const INITIAL_LOGGER = loggerModule.logger;

afterEach(() => {
    uninstallNativeLogger();
    setLogger(INITIAL_LOGGER);
});

describe("resolveEffectiveLogLevel", () => {
    it("defaults to info when the host logger exposes no getLevel", () => {
        expect(
            resolveEffectiveLogLevel({
                debug: () => {},
                info: () => {},
                warning: () => {},
                error: () => {},
            }),
        ).toBe("info");
        expect(resolveEffectiveLogLevel(null)).toBe("info");
    });

    it("maps base levels including warn alias cleanly", () => {
        expect(resolveEffectiveLogLevel({getLevel: () => "error"})).toBe("error");
        expect(resolveEffectiveLogLevel({getLevel: () => "warn"})).toBe("warning");
        expect(resolveEffectiveLogLevel({getLevel: () => "WARNING"})).toBe("warning");
        expect(resolveEffectiveLogLevel({getLevel: () => "info"})).toBe("info");
        expect(resolveEffectiveLogLevel({getLevel: () => "debug"})).toBe("debug");
    });

    it("resolves namespaced overrides across managed zh:zerostack namespaces", () => {
        // Explicit MT override elevates native level while base stays at info.
        expect(
            resolveEffectiveLogLevel({
                getLevel: () => "info",
                getNamespacedLevels: () => ({"zh:zerostack:mt": "debug"}),
            }),
        ).toBe("debug");

        // Parent colon prefix elevates child namespaces too.
        expect(
            resolveEffectiveLogLevel({
                getLevel: () => "warning",
                getNamespacedLevels: () => ({"zh:zerostack": "debug"}),
            }),
        ).toBe("debug");

        // Parent quieted to warning, child transport at info -> highest managed rank is info.
        expect(
            resolveEffectiveLogLevel({
                getLevel: () => "debug",
                getNamespacedLevels: () => ({"zh:zerostack": "warning", "zh:zerostack:transport": "info"}),
            }),
        ).toBe("info");

        // Unrelated namespaces never escalate native logging.
        expect(
            resolveEffectiveLogLevel({
                getLevel: () => "info",
                getNamespacedLevels: () => ({"z2m:mqtt": "debug", zhc: "debug"}),
            }),
        ).toBe("info");

        // Regex override and malformed regex tolerance.
        expect(
            resolveEffectiveLogLevel({
                getLevel: () => "info",
                getNamespacedLevels: () => ({"^zh:zerostack:.*": "debug", "[broken": "error"}),
            }),
        ).toBe("debug");
    });
});

describe("installNativeLogger", () => {
    it("bridges records to loggerModule.logger and tracks runtime setLevel / setNamespacedLevels / setLogger", () => {
        let baseLevel = "info";
        let namespaced: Record<string, string> = {};
        const emitted: {level: string; namespace: string; message: string}[] = [];

        const hostLogger: ConfigurableLogger = {
            debug: (msg, ns) => emitted.push({level: "debug", namespace: ns, message: typeof msg === "function" ? msg() : msg}),
            info: (msg, ns) => emitted.push({level: "info", namespace: ns, message: typeof msg === "function" ? msg() : msg}),
            warning: (msg, ns) => emitted.push({level: "warning", namespace: ns, message: typeof msg === "function" ? msg() : msg}),
            error: (msg, ns) => emitted.push({level: "error", namespace: ns, message: msg}),
            getLevel: () => baseLevel,
            setLevel: (lvl: string) => {
                baseLevel = lvl;
            },
            getNamespacedLevels: () => namespaced,
            setNamespacedLevels: (map: Record<string, string>) => {
                namespaced = map;
            },
        };
        setLogger(hostLogger);

        const levelHistory: NativeLogLevel[] = [];
        const handlerHistory: (((record: NativeLogRecord) => void) | null)[] = [];
        const mockAddon = {
            setLogHandler: (cb: ((record: NativeLogRecord) => void) | null) => {
                handlerHistory.push(cb);
            },
            setLogLevel: (level: NativeLogLevel) => {
                levelHistory.push(level);
            },
        };

        installNativeLogger(mockAddon);
        expect(levelHistory).toStrictEqual(["info"]);
        expect(handlerHistory).toHaveLength(1);
        const callback = handlerHistory[0];
        expect(callback).toBeTypeOf("function");

        hostLogger.setLevel?.("debug");
        expect(levelHistory.at(-1)).toBe("debug");

        hostLogger.setNamespacedLevels?.({"zh:zerostack": "warning"});
        expect(levelHistory.at(-1)).toBe("warning");

        hostLogger.setNamespacedLevels?.({"zh:zerostack:mt": "debug", "zh:zerostack": "warning"});
        expect(levelHistory.at(-1)).toBe("debug");

        // Replacing logger via zigbee-herdsman's setLogger updates Rust immediately.
        let secondLevel = "error";
        const secondLogger: ConfigurableLogger = {
            debug: () => {},
            info: () => {},
            warning: () => {},
            error: (msg, ns) => emitted.push({level: "error", namespace: ns, message: msg}),
            getLevel: () => secondLevel,
            setLevel: (lvl: string) => {
                secondLevel = lvl;
            },
        };
        setLogger(secondLogger);
        expect(levelHistory.at(-1)).toBe("error");

        secondLogger.setLevel?.("info");
        expect(levelHistory.at(-1)).toBe("info");

        setLogger(hostLogger);
        callback?.({level: "debug", namespace: "zh:zerostack:mt", message: '--> SREQ: AF - dataRequest - {"dstaddr":4660}'});
        callback?.({level: "info", namespace: "zh:zerostack:transport", message: "COBS-Mux negotiated"});
        callback?.({level: "warning", namespace: "zh:zerostack", message: "retry warning"});
        callback?.({level: "error", namespace: "zh:zerostack", message: "fatal failure"});

        expect(emitted).toStrictEqual([
            {level: "debug", namespace: "zh:zerostack:mt", message: '--> SREQ: AF - dataRequest - {"dstaddr":4660}'},
            {level: "info", namespace: "zh:zerostack:transport", message: "COBS-Mux negotiated"},
            {level: "warning", namespace: "zh:zerostack", message: "retry warning"},
            {level: "error", namespace: "zh:zerostack", message: "fatal failure"},
        ]);

        uninstallNativeLogger();
        expect(handlerHistory.at(-1)).toBeNull();
        expect(levelHistory.at(-1)).toBe("info");

        const countBefore = levelHistory.length;
        hostLogger.setLevel?.("debug");
        setLogger(secondLogger);
        expect(levelHistory).toHaveLength(countBefore);
    });

    it("verifies wire-trace format against herdsman SREQ/SRSP/AREQ parser patterns", () => {
        const sreqWireRegex = /(?:-->\s*SREQ[: -]+|SREQ\s+'-->\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;
        const srspWireRegex = /(?:<--\s*SRSP[: -]+|SRSP\s+'<--\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;
        const areqWireRegex = /(?:<--\s*AREQ[: -]+|AREQ\s+'<--\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;

        const sreq =
            '--> SREQ: AF - dataRequest - {"dstaddr":4660,"destendpoint":1,"srcendpoint":1,"clusterid":6,"transid":1,"options":16,"radius":30,"len":3}';
        const srsp = '<-- SRSP: AF - dataRequest - {"status":0}';
        const areq = '<-- AREQ: AF - dataConfirm - {"status":0,"endpoint":1,"transid":1,"dstaddr":4660,"seq":1}';

        const m1 = sreq.match(sreqWireRegex);
        const m2 = srsp.match(srspWireRegex);
        const m3 = areq.match(areqWireRegex);

        expect(m1?.[1]).toBe("AF");
        expect(m1?.[2]).toBe("dataRequest");
        expect(JSON.parse(m1?.[3] ?? "{}")).toMatchObject({dstaddr: 4660, clusterid: 6, transid: 1});
        expect(m2?.[1]).toBe("AF");
        expect(m2?.[2]).toBe("dataRequest");
        expect(JSON.parse(m2?.[3] ?? "{}")).toStrictEqual({status: 0});
        expect(m3?.[1]).toBe("AF");
        expect(m3?.[2]).toBe("dataConfirm");
        expect(JSON.parse(m3?.[3] ?? "{}")).toMatchObject({status: 0, transid: 1, dstaddr: 4660});
    });

    it("routes dispatchNativeLog directly to a provided logger", () => {
        const seen: string[] = [];
        dispatchNativeLog(
            {level: "warning", namespace: "zh:zerostack", message: "hello"},
            {
                debug: () => {},
                info: () => {},
                warning: (m, ns) => seen.push(`${ns}:${typeof m === "function" ? m() : m}`),
                error: () => {},
            },
        );
        expect(seen).toStrictEqual(["zh:zerostack:hello"]);
    });
});
