// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// Native N-API logging bridge integration tests against the compiled .node addon and
// zsCoordinator.mjs / zsPeer.mjs: dynamic AtomicU8 level gating, z2m-log-analyzer-compatible
// SREQ/SRSP/AREQ wire traces, source-side key redaction, and non-blocking weak TSFN exit.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";
import {fileURLToPath} from "node:url";
import {Controller, setLogger} from "zigbee-herdsman";
import loggerModule from "zigbee-herdsman/dist/utils/logger.js";
import {loadNativeCoordinator, uninstallNativeLogger} from "../dist/index.js";
import {register} from "../dist/register.js";
import {ROUTER, startZsCoordinator} from "./zsCoordinator.mjs";

const VERSION = {transportRev: 2, product: 1, major: 0, minor: 9, maint: 11, revision: 20261117};
const FACTORY_IEEE = 0x00124b00f00d0001n;
const SECRET_NETWORK_KEY = [0x9f, 0x8e, 0x7d, 0x6c, 0x5b, 0x4a, 0x39, 0x28, 0x17, 0x06, 0xf5, 0xe4, 0xd3, 0xc2, 0xb1, 0xa0];
const SECRET_KEY_HEX = Buffer.from(SECRET_NETWORK_KEY).toString("hex");
const SECRET_INSTALL_CODE = "83fed3407a939723a5c639b26916d505";
const SECRET_TCLK_SEED = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const NETWORK = {
    panID: 0x1a2b,
    extendedPanID: [0xdd, 0x00, 0x00, 0x00, 0x1a, 0x2b, 0x00, 0x01],
    channelList: [15],
    networkKey: SECRET_NETWORK_KEY,
};
const STEP_MS = 15_000;

const SREQ_WIRE_REGEX = /(?:-->\s*SREQ[: -]+|SREQ\s+'-->\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;
const SRSP_WIRE_REGEX = /(?:<--\s*SRSP[: -]+|SRSP\s+'<--\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;
const AREQ_WIRE_REGEX = /(?:<--\s*AREQ[: -]+|AREQ\s+'<--\s*)([A-Za-z0-9_]+)\s*-\s*([A-Za-z0-9_]+)(?:\s*-\s*(\{.+\}))?/;

const INITIAL_LOGGER = loggerModule.logger;
let registration;
let root;

before(() => {
    registration = register(() => loadNativeCoordinator());
    root = mkdtempSync(join(tmpdir(), "zerostack-adapter-logging-"));
});

after(() => {
    uninstallNativeLogger();
    setLogger(INITIAL_LOGGER);
    registration.unregister();
    rmSync(root, {recursive: true, force: true});
});

function createCapturingLogger(initialLevel = "info") {
    let level = initialLevel;
    let namespacedLevels = {};
    const records = [];
    const push = (lvl, msg, ns) => {
        records.push({level: lvl, namespace: ns ?? "", message: typeof msg === "function" ? msg() : msg});
    };

    const logger = {
        debug: (msg, ns) => push("debug", msg, ns),
        info: (msg, ns) => push("info", msg, ns),
        warning: (msg, ns) => push("warning", msg, ns),
        error: (msg, ns) => push("error", msg, ns),
        getLevel: () => level,
        setLevel: (next) => {
            level = next;
        },
        getNamespacedLevels: () => namespacedLevels,
        setNamespacedLevels: (next) => {
            namespacedLevels = next;
        },
    };

    return {logger, records};
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

function flushLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

test("gates debug logs cleanly in Rust at info, switches dynamically, emits parser-compatible wire traces, and redacts keys at source", async () => {
    const {logger, records} = createCapturingLogger("info");
    setLogger(logger);

    const directory = mkdtempSync(join(root, "case-"));
    const peer = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION});
    const zh = new Controller({
        network: NETWORK,
        transport: {path: `zs:${peer.transport}`, adapter: "zstack", baudRate: 115200, rtscts: false},
        databasePath: join(directory, "db.json"),
        databaseBackupPath: join(directory, "db.json.backup"),
        backupPath: join(directory, "coordinator_backup.json"),
        adapter: {disableLED: false},
        acceptJoiningDeviceHandler: () => Promise.resolve(true),
    });

    try {
        assert.equal(await within(STEP_MS, "start", zh.start()), "reset");
        await flushLoop();

        // At info: info transport logs arrive, but ZERO debug logs cross N-API.
        assert.ok(
            records.some((r) => r.level === "info" && r.namespace === "zh:zerostack:transport" && r.message.includes("COBS-Mux negotiated")),
            `missing transport info log: ${JSON.stringify(records)}`,
        );
        assert.equal(
            records.filter((r) => r.level === "debug" && r.namespace.startsWith("zh:zerostack")).length,
            0,
            "debug logs leaked while level was info",
        );

        // Join a router at info, still zero debug logs from native namespaces.
        const interviewed = once(zh, "deviceInterview", (d) => d.status !== "started");
        peer.join();
        const interview = await within(STEP_MS, "router interview", interviewed);
        assert.equal(interview.status, "successful");
        const router = interview.device;
        await flushLoop();
        assert.equal(records.filter((r) => r.level === "debug" && r.namespace.startsWith("zh:zerostack")).length, 0);

        // Dynamically switch logger to debug -> MT SREQ/SRSP/AREQ traces flow immediately.
        const debugStartIdx = records.length;
        logger.setLevel("debug");

        await router.getEndpoint(1).read("genOnOff", ["onOff"]);
        await flushLoop();
        const liveMt = records.slice(debugStartIdx).filter((r) => r.level === "debug" && r.namespace === "zh:zerostack:mt");
        assert.ok(liveMt.length >= 4, `expected MT trace lines at debug, got ${liveMt.length}`);

        const sreq = liveMt.find((r) => r.message.includes("--> SREQ: AF - dataRequest"));
        const srsp = liveMt.find((r) => r.message.includes("<-- SRSP: AF - dataRequest"));
        const confirm = liveMt.find((r) => r.message.includes("<-- AREQ: AF - dataConfirm"));
        const incoming = liveMt.find((r) => r.message.includes("<-- AREQ: AF - incomingMsg"));
        assert.ok(sreq && srsp && confirm && incoming, `missing expected AF trace quartet in: ${JSON.stringify(liveMt)}`);

        const sreqMatch = sreq.message.match(SREQ_WIRE_REGEX);
        const srspMatch = srsp.message.match(SRSP_WIRE_REGEX);
        const confirmMatch = confirm.message.match(AREQ_WIRE_REGEX);
        const incomingMatch = incoming.message.match(AREQ_WIRE_REGEX);
        assert.ok(sreqMatch && srspMatch && confirmMatch && incomingMatch);

        const sreqJson = JSON.parse(sreqMatch[3]);
        assert.equal(sreqJson.dstaddr, ROUTER.nwk);
        assert.equal(sreqJson.clusterid, 6);
        assert.equal(typeof sreqJson.transid, "number");

        const confirmJson = JSON.parse(confirmMatch[3]);
        assert.equal(confirmJson.status, 0);
        assert.equal(confirmJson.transid, sreqJson.transid);

        const incomingJson = JSON.parse(incomingMatch[3]);
        assert.equal(incomingJson.srcaddr, ROUTER.nwk);
        assert.equal(incomingJson.clusterid, 6);

        // Run backup (SYS_ZS_BACKUP_EXPORT) and addInstallCode (APP_CNF_BDB_ADD_INSTALLCODE) under debug.
        const sensStartIdx = records.length;
        await zh.backup();
        await zh.addInstallCode(`Z:0011223344556677$I:${SECRET_INSTALL_CODE}C3B5`);
        await flushLoop();

        const sensMt = records.slice(sensStartIdx).filter((r) => r.namespace === "zh:zerostack:mt");
        assert.ok(
            sensMt.some((r) => r.message.includes("SYS - zsBackupExport") && r.message.includes('"data":"[REDACTED]"')),
            "expected redacted zsBackupExport SRSP",
        );
        assert.ok(
            sensMt.some((r) => r.message.includes("APP_CNF - bdbAddInstallCode") && r.message.includes('"installCode":"[REDACTED]"')),
            "expected redacted bdbAddInstallCode SREQ",
        );

        // Switch back to info and assert debug gate closes cleanly again.
        await flushLoop();
        logger.setLevel("info");
        const afterInfoIdx = records.length;
        await router.getEndpoint(1).read("genOnOff", ["onOff"]);
        await flushLoop();
        assert.equal(
            records.slice(afterInfoIdx).filter((r) => r.level === "debug" && r.namespace.startsWith("zh:zerostack")).length,
            0,
            "debug logs leaked after switching back to info",
        );

        // Verify no secret bytes appeared anywhere in any emitted record from Rust.
        for (const r of records) {
            if (!r.namespace.startsWith("zh:zerostack")) {
                continue;
            }
            const lower = r.message.toLowerCase();
            assert.ok(!lower.includes(SECRET_KEY_HEX), `network key leaked in ${r.namespace}: ${r.message}`);
            assert.ok(!lower.includes(SECRET_INSTALL_CODE), `install code leaked in ${r.namespace}: ${r.message}`);
            assert.ok(!lower.includes(SECRET_TCLK_SEED), `TCLK seed leaked in ${r.namespace}: ${r.message}`);
        }
    } finally {
        await zh.stop();
        await peer.close();
        uninstallNativeLogger();
    }
});

test("emits SYS_RESET_IND, SYS_VERSION, ZDO_TC_DEV_IND and redacted SYS_ZS_BACKUP_IMPORT at debug", async () => {
    const {logger, records} = createCapturingLogger("debug");
    setLogger(logger);

    const directory = mkdtempSync(join(root, "boot-debug-"));
    const peer = await startZsCoordinator({ieee: FACTORY_IEEE, version: VERSION});
    const zh = new Controller({
        network: NETWORK,
        transport: {path: `zs:${peer.transport}`, adapter: "zstack", baudRate: 115200, rtscts: false},
        databasePath: join(directory, "db.json"),
        databaseBackupPath: join(directory, "db.json.backup"),
        backupPath: join(directory, "coordinator_backup.json"),
        adapter: {disableLED: false},
        acceptJoiningDeviceHandler: () => Promise.resolve(true),
    });

    try {
        assert.equal(await within(STEP_MS, "start", zh.start()), "reset");

        const interviewed = once(zh, "deviceInterview", (d) => d.status !== "started");
        peer.join();
        assert.equal((await within(STEP_MS, "router interview", interviewed)).status, "successful");
        await flushLoop();

        const mt = records.filter((r) => r.level === "debug" && r.namespace === "zh:zerostack:mt");
        assert.ok(
            mt.some((r) => /-->\s*AREQ:\s*SYS\s*-\s*resetReq\s*-\s*\{"type":1\}/.test(r.message)),
            "missing resetReq AREQ",
        );
        assert.ok(
            mt.some((r) => /<--\s*AREQ:\s*SYS\s*-\s*resetInd\s*-\s*\{/.test(r.message)),
            "missing resetInd AREQ",
        );
        assert.ok(
            mt.some((r) => /<--\s*SRSP:\s*SYS\s*-\s*version\s*-\s*\{.*"revision":20261117/.test(r.message)),
            "missing SYS_VERSION SRSP",
        );
        assert.ok(
            mt.some((r) => /-->\s*SREQ:\s*SYS\s*-\s*zsBackupImport\s*-\s*\{"op":1,"data":"\[REDACTED\]"/.test(r.message)),
            "missing redacted zsBackupImport chunk SREQ",
        );
        assert.ok(
            mt.some((r) => /<--\s*AREQ:\s*ZDO\s*-\s*tcDeviceInd\s*-\s*\{.*"nwkaddr":/.test(r.message)),
            "missing tcDeviceInd AREQ",
        );

        for (const r of records) {
            if (!r.namespace.startsWith("zh:zerostack")) {
                continue;
            }
            const lower = r.message.toLowerCase();
            assert.ok(!lower.includes(SECRET_KEY_HEX), `network key leaked in ${r.namespace}: ${r.message}`);
            assert.ok(!lower.includes(SECRET_TCLK_SEED), `TCLK seed leaked in ${r.namespace}: ${r.message}`);
        }
    } finally {
        await zh.stop();
        await peer.close();
        uninstallNativeLogger();
    }
});

test("leaves the Node event loop free to exit even when setLogHandler remains installed", () => {
    const childScript = `
        import {loadNativeAddon} from "./dist/index.js";
        import {startZsPeer} from "./test/zsPeer.mjs";
        const addon = loadNativeAddon();
        const received = [];
        addon.setLogLevel("debug");
        addon.setLogHandler((rec) => received.push(rec));
        const peer = await startZsPeer({transportRev: 2, product: 1, major: 2, minor: 7, maint: 1, revision: 20261116});
        const coord = await addon.ZsCoordinator.open(
            {backend: "zs", transport: peer.transport, baudRate: 115200, rtscts: false},
            () => {},
            5000,
        );
        await coord.stop();
        await peer.close();
        if (received.length === 0) {
            throw new Error("expected native log records before exit");
        }
    `;

    // Exits promptly without calling setLogHandler(null) because the TSFN is weak/unref'd.
    execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 5000,
        stdio: "pipe",
    });
});
