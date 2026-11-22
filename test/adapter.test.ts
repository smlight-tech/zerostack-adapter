// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {setLogger, Zcl, Zdo, ZSpec} from "zigbee-herdsman";
import {Adapter as HerdsmanAdapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import type {ZclPayload} from "zigbee-herdsman/dist/adapter/events.js";
import type {NetworkOptions} from "zigbee-herdsman/dist/adapter/tstype.js";
import * as BackupUtils from "zigbee-herdsman/dist/utils/backup.js";
import loggerModule from "zigbee-herdsman/dist/utils/logger.js";
import type {GenericZdoResponse} from "zigbee-herdsman/dist/zspec/zdo/definition/tstypes.js";
import type {NativeBackup} from "../native.js";
import {createZeroStackAdapter, ZsAdapter} from "../ts/adapter.js";
import {fromNativeBackup} from "../ts/backup.js";
import {ZsNativeError} from "../ts/errors.js";
import {FakeCoordinator, nativeError} from "./fakeCoordinator.js";

const DEVICE_IEEE = "0x00158d0001a2b3c4";
const DEVICE_NWK = 0x1234;

const NETWORK: NetworkOptions = {
    panID: 0x1a62,
    extendedPanID: [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd],
    channelList: [15],
    networkKey: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13],
    networkKeyDistribute: false,
};

const NATIVE_BACKUP: NativeBackup = {
    network: {
        panId: 0x1a62,
        extendedPanId: "0xdddddddddddddddd",
        channelList: [15],
        networkKey: Buffer.from("01030507090b0d0f00020406080a0c0d", "hex"),
        networkKeyDistribute: false,
    },
    logicalChannel: 15,
    networkKeySequence: 0,
    networkKeyFrameCounter: 120034,
    securityLevel: 5,
    networkUpdateId: 2,
    coordinatorIeeeAddress: "0x00124b0029a1b2c3",
    devices: [
        {
            networkAddress: 0x1234,
            ieeeAddress: "0x00158d0001a2b3c4",
            isDirectChild: true,
            linkKey: {key: Buffer.from("5a6967426565416c6c69616e63653039", "hex"), rxCounter: 7, txCounter: 1024},
        },
        {networkAddress: 0x8f21, ieeeAddress: "0x0017880100c0ffee", isDirectChild: false, linkKey: null},
    ],
    trustCenterLinkKeySeed: Buffer.from("0f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex"),
};

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zerostack-adapter-"));
});

afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, {recursive: true, force: true});
});

function makeAdapter(fake: FakeCoordinator, path = "zs:serial:/dev/ttyUSB0"): ZsAdapter {
    return new ZsAdapter(
        NETWORK,
        {path, adapter: "zstack", baudRate: 460800, rtscts: true},
        join(tempDir, "coordinator_backup.json"),
        {disableLED: false},
        fake.opener(),
    );
}

async function startedAdapter(): Promise<{adapter: ZsAdapter; fake: FakeCoordinator}> {
    const fake = new FakeCoordinator();
    const adapter = makeAdapter(fake);
    await adapter.start();

    return {adapter, fake};
}

function readBasicModel(tsn: number): Zcl.Frame {
    return Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, false, undefined, tsn, "read", "genBasic", [{attrId: 5}], {});
}

function readBasicModelRsp(tsn: number, model: string): Buffer {
    return Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        true,
        undefined,
        tsn,
        "readRsp",
        "genBasic",
        [{attrId: 5, status: Zcl.Status.SUCCESS, dataType: Zcl.DataType.CHAR_STR, attrData: model}],
        {},
    ).toBuffer();
}

function defaultRsp(tsn: number, clusterKey: string, cmdId: number, statusCode: Zcl.Status): Buffer {
    return Zcl.Frame.create(
        Zcl.FrameType.GLOBAL,
        Zcl.Direction.SERVER_TO_CLIENT,
        true,
        undefined,
        tsn,
        "defaultRsp",
        clusterKey,
        {cmdId, statusCode},
        {},
    ).toBuffer();
}

function activeEndpointsRsp(sequence: number, status: Zdo.Status, nwk: number, endpoints: number[]): Buffer {
    if (status !== Zdo.Status.SUCCESS) {
        return Buffer.from([sequence, status]);
    }

    return Buffer.from([sequence, status, nwk & 0xff, nwk >> 8, endpoints.length, ...endpoints]);
}

/** setImmediate runs only after every queued microtask, so the native send has resolved and the adapter is waiting. */
async function drainMicrotasks(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function eui64Le(ieee: string): number[] {
    return [...Buffer.from(ieee.slice(2), "hex").reverse()];
}

describe("start and lifecycle", () => {
    it("opens the parsed backend and transport, then starts with the configured network and no backup", async () => {
        const fake = new FakeCoordinator();
        fake.startResult = "reset";
        const adapter = makeAdapter(fake, "zs:tcp://192.0.2.1:6638");

        await expect(adapter.start()).resolves.toBe("reset");

        expect(fake.openOptions).toStrictEqual({backend: "zs", transport: "tcp://192.0.2.1:6638", baudRate: 460800, rtscts: true});
        expect(fake.started?.backup).toBeNull();
        expect(fake.started?.network).toStrictEqual({
            panId: 0x1a62,
            extendedPanId: "0xdddddddddddddddd",
            channelList: [15],
            networkKey: Buffer.from(NETWORK.networkKey ?? []),
            networkKeyDistribute: false,
        });
        expect(adapter.manufacturerID).toBe(Zcl.ManufacturerCode.TEXAS_INSTRUMENTS);
        expect(adapter.hasZdoMessageOverhead).toBe(true);
    });

    it("restores from herdsman's unified backup file, converted to the native backup", async () => {
        const fake = new FakeCoordinator();
        const adapter = makeAdapter(fake);
        const unified = BackupUtils.toUnifiedBackup(fromNativeBackup(NATIVE_BACKUP));
        writeFileSync(join(tempDir, "coordinator_backup.json"), JSON.stringify(unified));

        await adapter.start();

        // the unified format does not carry networkKeyDistribute; herdsman reads it back as false
        expect(fake.started?.backup).toStrictEqual(NATIVE_BACKUP);
    });

    describe("a restore that fills the device table", () => {
        const restore = async (fake: FakeCoordinator, backup = NATIVE_BACKUP): Promise<string[]> => {
            const original = loggerModule.logger;
            const warnings: string[] = [];
            const ignore = (): void => {};
            setLogger({
                debug: ignore,
                info: ignore,
                warning: (message: string | (() => string)) => warnings.push(typeof message === "function" ? message() : message),
                error: ignore,
            });
            const unified = BackupUtils.toUnifiedBackup(fromNativeBackup(backup));
            writeFileSync(join(tempDir, "coordinator_backup.json"), JSON.stringify(unified));
            try {
                await makeAdapter(fake).start();
            } finally {
                setLogger(original);
            }

            return warnings;
        };

        it("warns when the restored devices reach the table capacity", async () => {
            const fake = new FakeCoordinator();
            fake.startResult = "restored";
            fake.versionMeta = {...fake.versionMeta, zs_nodes: 2};

            await expect(restore(fake)).resolves.toStrictEqual([
                "backup restore filled the coordinator device table (2 of 2 entries): devices missing from the backup need a free entry to be heard",
            ]);
        });

        it("stays quiet below capacity and does not count the coordinator's own entry", async () => {
            const fake = new FakeCoordinator();
            fake.startResult = "restored";
            fake.versionMeta = {...fake.versionMeta, zs_nodes: 3};
            const withSelf = {
                ...NATIVE_BACKUP,
                devices: [
                    ...NATIVE_BACKUP.devices,
                    {networkAddress: 0x0000, ieeeAddress: NATIVE_BACKUP.coordinatorIeeeAddress, isDirectChild: false, linkKey: null},
                ],
            };

            await expect(restore(fake, withSelf)).resolves.toStrictEqual([]);
            expect(fake.versionCalls).toBe(1);
        });

        it("asks nothing more of a coordinator that resumed", async () => {
            const fake = new FakeCoordinator();
            fake.versionMeta = {...fake.versionMeta, zs_nodes: 1};

            await expect(restore(fake)).resolves.toStrictEqual([]);
            expect(fake.versionCalls).toBe(0);
        });

        it("fails the start when the coordinator reports no capacity", async () => {
            const fake = new FakeCoordinator();
            fake.startResult = "restored";
            fake.versionMeta = {revision: "20261101", transportrev: 2};

            await expect(restore(fake)).rejects.toThrow("coordinatorVersion meta has no numeric zs_nodes");
            expect(fake.stopped).toBe(1);
        });
    });

    it("rejects an unknown backup format before opening the native link", async () => {
        const fake = new FakeCoordinator();
        const adapter = makeAdapter(fake);
        writeFileSync(join(tempDir, "coordinator_backup.json"), JSON.stringify({metadata: {format: "something-else", version: 1}}));

        await expect(adapter.start()).rejects.toThrow("Unknown backup format");
        expect(fake.openOptions).toBeUndefined();
    });

    it("closes the native link and propagates the native error when start fails", async () => {
        const fake = new FakeCoordinator();
        fake.failNext.set("start", nativeError("transport", "port vanished"));
        const adapter = makeAdapter(fake);

        const failure = adapter.start();

        await expect(failure).rejects.toBeInstanceOf(ZsNativeError);
        await expect(failure).rejects.toMatchObject({code: "transport", operation: "start"});
        expect(fake.stopped).toBe(1);
        await expect(adapter.getCoordinatorIEEE()).rejects.toThrow("not started");
    });

    it("rejects a path with another scheme at construction", () => {
        expect(() => makeAdapter(new FakeCoordinator(), "ember:serial:/dev/ttyUSB0")).toThrow(
            "'ember:serial:/dev/ttyUSB0' is neither a zerostack-adapter path",
        );
    });

    it("maps network parameters and coordinator queries", async () => {
        const {adapter} = await startedAdapter();

        await expect(adapter.getNetworkParameters()).resolves.toStrictEqual({
            panID: 0x1a62,
            extendedPanID: "0xdddddddddddddddd",
            channel: 15,
            nwkUpdateID: 3,
        });
        await expect(adapter.getCoordinatorIEEE()).resolves.toBe("0x00124b0029a1b2c3");
        await expect(adapter.getCoordinatorVersion()).resolves.toStrictEqual({
            type: "ZeroStack",
            meta: {revision: "20261101", transportrev: 2, zs_nodes: 200},
        });
        await expect(adapter.supportsBackup()).resolves.toBe(true);
    });

    it("passes permitJoin target through, null meaning everyone", async () => {
        const {adapter, fake} = await startedAdapter();

        await adapter.permitJoin(254);
        await adapter.permitJoin(0, DEVICE_NWK);

        expect(fake.permitJoins).toStrictEqual([
            {seconds: 254, networkAddress: null},
            {seconds: 0, networkAddress: DEVICE_NWK},
        ]);
    });

    it("propagates a rejected permitJoin as a ZsNativeError with status", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("permitJoin", nativeError("rejected", "ZDO Mgmt_Permit_Joining_rsp", Zdo.Status.NOT_AUTHORIZED));

        await expect(adapter.permitJoin(60, DEVICE_NWK)).rejects.toMatchObject({
            code: "rejected",
            status: Zdo.Status.NOT_AUTHORIZED,
            message: expect.stringContaining("status=0x8d"),
        });
    });

    it("resolves supportsBackup() before start() and after stop() without throwing synchronously", async () => {
        const adapter = makeAdapter(new FakeCoordinator());

        await expect(adapter.supportsBackup()).resolves.toBe(true);
        await adapter.start();
        await expect(adapter.supportsBackup()).resolves.toBe(true);
        await adapter.stop();
        await expect(adapter.supportsBackup()).resolves.toBe(true);
    });

    it("extends the caller-supplied Adapter base class via createZeroStackAdapter", () => {
        abstract class CustomAdapterBase extends HerdsmanAdapter {}
        const fake = new FakeCoordinator();
        const instance = createZeroStackAdapter(
            CustomAdapterBase,
            NETWORK,
            {path: "/dev/ttyUSB0", adapter: "zstack"},
            join(tempDir, "coordinator_backup.json"),
            {disableLED: false},
            fake.opener(),
        );

        expect(instance).toBeInstanceOf(CustomAdapterBase);
        expect(instance).toBeInstanceOf(HerdsmanAdapter);
        expect(instance).not.toBeInstanceOf(ZsAdapter);
        expect(instance.target).toStrictEqual({backend: "zs", transport: "serial:/dev/ttyUSB0"});
    });
});

describe("backup", () => {
    it("returns herdsman's Models.Backup with Buffers and the ZeroStack TCLK seed", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.nativeBackup = NATIVE_BACKUP;

        const backup = await adapter.backup([DEVICE_IEEE]);

        expect(backup.coordinatorIeeeAddress).toStrictEqual(Buffer.from("00124b0029a1b2c3", "hex"));
        expect(backup.networkOptions.extendedPanId).toStrictEqual(Buffer.from("dddddddddddddddd", "hex"));
        expect(backup.networkKeyInfo).toStrictEqual({sequenceNumber: 0, frameCounter: 120034});
        expect(backup.znp?.trustCenterLinkKeySeed).toStrictEqual(NATIVE_BACKUP.trustCenterLinkKeySeed);
        expect(backup.devices[0]?.ieeeAddress).toStrictEqual(Buffer.from("00158d0001a2b3c4", "hex"));
        expect(backup.devices[0]?.linkKey?.txCounter).toBe(1024);
        expect(backup.devices[1]).not.toHaveProperty("linkKey");

        const unified = BackupUtils.toUnifiedBackup(backup);
        expect(unified.coordinator_ieee).toBe("00124b0029a1b2c3");
        expect(unified.stack_specific?.zstack?.tclk_seed).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    });

    it("omits the znp section when the coordinator reports no TCLK seed", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.nativeBackup = {...NATIVE_BACKUP, trustCenterLinkKeySeed: null};

        const backup = await adapter.backup([]);

        expect(backup.znp).toBeUndefined();
    });

    it("rejects a native backup with a malformed IEEE address", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.nativeBackup = {...NATIVE_BACKUP, coordinatorIeeeAddress: "0x00124B0029A1B2C3"};

        await expect(adapter.backup([])).rejects.toThrow("coordinatorIeeeAddress '0x00124B0029A1B2C3'");
    });
});

describe("ZCL unicast", () => {
    it("resolves with the response matching source, endpoint, cluster, tsn and command", async () => {
        const {adapter, fake} = await startedAdapter();
        const frame = readBasicModel(10);

        fake.duringUnicast = () => {
            // a response racing the confirm must still be matched
            fake.deliverAps({srcNwk: 0x9999, clusterId: 0x0000, data: readBasicModelRsp(10, "wrong-source")});
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0000, data: readBasicModelRsp(11, "wrong-tsn")});
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0000, srcEndpoint: 2, data: readBasicModelRsp(10, "wrong-endpoint")});
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, data: readBasicModelRsp(10, "wrong-cluster")});
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0000, data: readBasicModelRsp(10, "lumi.sensor")});
        };

        const response = await adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, frame, 5000, false, false);

        expect(response?.data).toStrictEqual(readBasicModelRsp(10, "lumi.sensor"));
        expect(response?.address).toBe(DEVICE_NWK);
        expect(fake.unicasts).toStrictEqual([
            {
                ieeeAddr: DEVICE_IEEE,
                networkAddress: DEVICE_NWK,
                dstEndpoint: 1,
                srcEndpoint: 1,
                clusterId: 0x0000,
                profileId: 0x0104,
                radius: 30,
                apsAck: true,
                data: frame.toBuffer(),
                timeoutMs: 5000,
            },
        ]);
    });

    it("waits for the default response of this command when disableResponse is set", async () => {
        const {adapter, fake} = await startedAdapter();
        const on = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, false, undefined, 33, "on", "genOnOff", {}, {});

        fake.duringUnicast = () => {
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, data: defaultRsp(33, "genOnOff", 0x00, Zcl.Status.SUCCESS)});
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, data: defaultRsp(33, "genOnOff", 0x01, Zcl.Status.UNSUP_COMMAND)});
        };

        const response = await adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, on, 5000, true, false);

        expect(response?.header?.commandIdentifier).toBe(Zcl.Foundation.defaultRsp.ID);
        expect(response?.data).toStrictEqual(defaultRsp(33, "genOnOff", 0x01, Zcl.Status.UNSUP_COMMAND));
    });

    it("sends without APS ack and resolves undefined when no response is expected", async () => {
        const {adapter, fake} = await startedAdapter();
        const on = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 34, "on", "genOnOff", {}, {});

        await expect(adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, on, 5000, true, false)).resolves.toBeUndefined();
        expect(fake.unicasts[0]?.apsAck).toBe(false);
    });

    it("rejects after the timeout when no response arrives, not before", async () => {
        vi.useFakeTimers();
        const {adapter} = await startedAdapter();
        let settled = false;
        const pending = adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, readBasicModel(12), 5000, false, false);
        pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        const rejection = expect(pending).rejects.toThrow(`Timeout after 5000ms [address=${DEVICE_NWK} endpoint=1 clusterId=0 cmdId=1 tsn=12]`);

        await vi.advanceTimersByTimeAsync(4999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
    });

    it("selects the source endpoint and profile from herdsman's coordinator endpoint table", async () => {
        const {adapter, fake} = await startedAdapter();
        const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 35, "on", "genOnOff", {}, {});

        await adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 242, frame, 5000, true, false, 242);
        await adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, frame, 5000, true, false, undefined, 0x0101);

        expect(fake.unicasts.map((u) => [u.srcEndpoint, u.profileId])).toStrictEqual([
            [242, 0xa1e0],
            [2, 0x0101],
        ]);
        await expect(adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, frame, 5000, true, false, 1, 0xc05e)).rejects.toThrow(
            "Profile ID 49246 is not supported",
        );
    });

    it("turns a native delivery failure into a ZsNativeError and keeps other errors unchanged", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("unicast", nativeError("delivery", "MAC no ack", 0xe9));

        const failure = adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, readBasicModel(13), 5000, false, true);

        await expect(failure).rejects.toBeInstanceOf(ZsNativeError);
        await expect(failure).rejects.toMatchObject({code: "delivery", status: 0xe9, message: expect.stringContaining("status=0xe9: MAC no ack")});

        const programmingError = new TypeError("bad frame");
        fake.failNext.set("unicast", programmingError);
        await expect(adapter.sendZclFrameToEndpoint(DEVICE_IEEE, DEVICE_NWK, 1, readBasicModel(14), 5000, false, true)).rejects.toBe(
            programmingError,
        );
    });
});

describe("ZCL waitFor", () => {
    it("honours defaultRspCommandId", async () => {
        const {adapter, fake} = await startedAdapter();
        const waiter = adapter.waitFor(DEVICE_NWK, 1, Zcl.FrameType.SPECIFIC, Zcl.Direction.SERVER_TO_CLIENT, 40, 0x0006, 0x02, 0x02, 5000);

        fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, data: defaultRsp(40, "genOnOff", 0x01, Zcl.Status.SUCCESS)});
        fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, data: defaultRsp(40, "genOnOff", 0x02, Zcl.Status.FAILURE)});

        await expect(waiter.promise).resolves.toMatchObject({data: defaultRsp(40, "genOnOff", 0x02, Zcl.Status.FAILURE)});
    });

    it("cancel stops the timeout", async () => {
        vi.useFakeTimers();
        const {adapter} = await startedAdapter();
        const waiter = adapter.waitFor(DEVICE_NWK, 1, Zcl.FrameType.GLOBAL, Zcl.Direction.SERVER_TO_CLIENT, 41, 0, 0x01, undefined, 1000);
        let settled = false;
        waiter.promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        waiter.cancel();
        await vi.advanceTimersByTimeAsync(5000);

        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("ZCL group and broadcast", () => {
    it("emits incoming group frames with their group and 0 for non-groupcast", async () => {
        const {adapter, fake} = await startedAdapter();
        const payloads: ZclPayload[] = [];
        adapter.on("zclPayload", (payload) => payloads.push(payload));
        const toggle = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 7, "toggle", "genOnOff", {}, {});

        fake.deliverAps({srcNwk: 0x4321, clusterId: 0x0006, groupId: 0x0019, wasBroadcast: true, dstEndpoint: 0xff, data: toggle.toBuffer()});
        fake.deliverAps({srcNwk: 0x4321, clusterId: 0x0006, data: toggle.toBuffer(), linkquality: 77});

        expect(payloads).toHaveLength(2);
        expect(payloads[0]).toMatchObject({
            groupID: 0x0019,
            wasBroadcast: true,
            destinationEndpoint: 0xff,
            address: 0x4321,
            endpoint: 1,
            clusterID: 6,
        });
        expect(payloads[0]?.header?.commandIdentifier).toBe(0x02);
        expect(payloads[1]).toMatchObject({groupID: 0, wasBroadcast: false, linkquality: 77});
    });

    it("sends groupcasts and broadcasts with the selected source endpoint", async () => {
        const {adapter, fake} = await startedAdapter();
        const off = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 8, "off", "genOnOff", {}, {});

        await adapter.sendZclFrameToGroup(0x0019, off);
        await adapter.sendZclFrameToAll(242, off, 242, ZSpec.BroadcastAddress.RX_ON_WHEN_IDLE);

        expect(fake.groupcasts).toStrictEqual([
            {groupId: 0x0019, srcEndpoint: 1, clusterId: 6, profileId: 0x0104, radius: 30, data: off.toBuffer(), timeoutMs: 3000},
        ]);
        expect(fake.broadcasts).toStrictEqual([
            {
                destination: 0xfffd,
                dstEndpoint: 242,
                srcEndpoint: 242,
                clusterId: 6,
                profileId: 0xa1e0,
                radius: 30,
                data: off.toBuffer(),
                timeoutMs: 3000,
            },
        ]);
    });

    it("rejects broadcast destinations the native contract does not carry", async () => {
        const {adapter, fake} = await startedAdapter();
        const off = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 9, "off", "genOnOff", {}, {});

        await expect(adapter.sendZclFrameToAll(1, off, 1, 0xfffb)).rejects.toThrow("0xfffb is not supported");
        expect(fake.broadcasts).toHaveLength(0);
    });

    it("propagates a native groupcast failure", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("groupcast", nativeError("timeout", "no confirm"));
        const off = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 10, "off", "genOnOff", {}, {});

        await expect(adapter.sendZclFrameToGroup(5, off)).rejects.toMatchObject({code: "timeout"});
    });
});

/** Any sequence: the coordinator picks the over-the-air ZDO sequence and the host never learns it. */
const SEQ = 0x5a;

function simpleDescRsp(status: Zdo.Status, nwk: number, endpoint: number): Buffer {
    if (status !== Zdo.Status.SUCCESS) {
        return Buffer.from([SEQ, status]);
    }

    return Buffer.from([SEQ, status, nwk & 0xff, nwk >> 8, 8, endpoint, 0x04, 0x01, 0x02, 0x01, 0x01, 0, 0]);
}

/** Mgmt_Lqi_rsp, Mgmt_Rtg_rsp and Mgmt_Bind_rsp share the head: status, total entries, start index, entry count. */
function mgmtTableRsp(status: Zdo.Status, startIndex: number): Buffer {
    return status === Zdo.Status.SUCCESS ? Buffer.from([SEQ, status, 0, startIndex, 0]) : Buffer.from([SEQ, status]);
}

function simpleDescReq(endpoint: number): Buffer {
    return Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, DEVICE_NWK, endpoint);
}

function trackSettled<T>(promise: Promise<T>): {settled: () => boolean} {
    let done = false;
    promise.then(
        () => {
            done = true;
        },
        () => {
            done = true;
        },
    );

    return {settled: () => done};
}

describe("ZDO", () => {
    it("correlates by response cluster and source, including a response racing the send", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);
        const rsp = Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE;

        fake.duringZdo = () => {
            fake.deliverZdo(0x9999, rsp, activeEndpointsRsp(SEQ, Zdo.Status.SUCCESS, 0x9999, [8]));
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 1));
            fake.deliverZdo(DEVICE_NWK, rsp, activeEndpointsRsp(SEQ, Zdo.Status.SUCCESS, DEVICE_NWK, [1, 242]));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false);

        expect(response).toStrictEqual([Zdo.Status.SUCCESS, {nwkAddress: DEVICE_NWK, endpointList: [1, 242]}]);
        expect(fake.zdoRequests).toStrictEqual([
            {ieeeAddr: DEVICE_IEEE, networkAddress: DEVICE_NWK, clusterId: Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, data: request, timeoutMs: 10000},
        ]);
    });

    it("matches a response arriving after the send resolved", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);
        const pending = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false);

        await drainMicrotasks();
        expect(fake.zdoRequests).toHaveLength(1);
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE, activeEndpointsRsp(0x07, Zdo.Status.SUCCESS, DEVICE_NWK, [4]));

        await expect(pending).resolves.toStrictEqual([Zdo.Status.SUCCESS, {nwkAddress: DEVICE_NWK, endpointList: [4]}]);
    });

    it("returns a non-success status the way herdsman adapters do, so callers throw Zdo.StatusError", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);
        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE, activeEndpointsRsp(SEQ, Zdo.Status.DEVICE_NOT_FOUND, 0, []));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false);

        expect(response).toStrictEqual([Zdo.Status.DEVICE_NOT_FOUND, undefined]);
        expect(Zdo.Buffalo.checkStatus(response)).toBe(false);
        expect(() => {
            if (!Zdo.Buffalo.checkStatus(response)) {
                throw new Zdo.StatusError(response[0]);
            }
        }).toThrow(Zdo.StatusError);
    });

    it("matches NETWORK_ADDRESS_RESPONSE on the EUI64 in the payload for a broadcast request", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, DEVICE_IEEE, false, 0);
        const nwkAddrRsp = (ieee: string, nwk: number): Buffer => Buffer.from([SEQ, Zdo.Status.SUCCESS, ...eui64Le(ieee), nwk & 0xff, nwk >> 8]);
        fake.duringZdo = () => {
            fake.deliverZdo(0x2222, Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, nwkAddrRsp("0x0017880100c0ffee", 0x2222));
            fake.deliverZdo(0x5678, Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, nwkAddrRsp(DEVICE_IEEE, 0x5678));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, 0xfffd, Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, request, false);

        expect(response).toStrictEqual([Zdo.Status.SUCCESS, {eui64: DEVICE_IEEE, nwkAddress: 0x5678, startIndex: 0, assocDevList: []}]);
    });

    it("matches Simple_Desc_rsp on the requested endpoint when successful", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 2));
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 1));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);

        expect(response).toMatchObject([Zdo.Status.SUCCESS, {endpoint: 1, profileId: 0x0104}]);
    });

    it("matches a failed Simple_Desc_rsp on cluster and responder alone", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.NOT_ACTIVE, DEVICE_NWK, 0));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(7), false);

        expect(response).toStrictEqual([Zdo.Status.NOT_ACTIVE, undefined]);
    });

    it.each([
        ["Mgmt_Lqi", Zdo.ClusterId.LQI_TABLE_REQUEST, Zdo.ClusterId.LQI_TABLE_RESPONSE],
        ["Mgmt_Rtg", Zdo.ClusterId.ROUTING_TABLE_REQUEST, Zdo.ClusterId.ROUTING_TABLE_RESPONSE],
        ["Mgmt_Bind", Zdo.ClusterId.BINDING_TABLE_REQUEST, Zdo.ClusterId.BINDING_TABLE_RESPONSE],
    ] as const)("matches %s_rsp on the requested start index when successful, and a failure on cluster and responder", async (_name, req, rsp) => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, req, 3);
        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, rsp, mgmtTableRsp(Zdo.Status.SUCCESS, 0));
            fake.deliverZdo(DEVICE_NWK, rsp, mgmtTableRsp(Zdo.Status.SUCCESS, 3));
        };

        const response = await adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, req, request, false);

        expect(response).toMatchObject([Zdo.Status.SUCCESS, {startIndex: 3}]);

        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, rsp, mgmtTableRsp(Zdo.Status.NOT_SUPPORTED, 0));
        };

        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, req, request, false)).resolves.toStrictEqual([Zdo.Status.NOT_SUPPORTED, undefined]);
    });

    it("serialises Simple_Desc requests to one device and never answers one with the other's response", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.holdZdo = true;
        const first = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);
        const second = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(2), false);
        const secondState = trackSettled(second);

        await drainMicrotasks();
        // a failed response could not tell the two apart, so the second is not on air yet
        expect(fake.zdoRequests.map((r) => r.data[3])).toStrictEqual([1]);

        // an endpoint-2 response arrives while only the endpoint-1 request is on air; it must not answer it
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 2));
        fake.releaseZdo();
        await drainMicrotasks();
        expect(fake.zdoRequests).toHaveLength(1);
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 1));

        await expect(first).resolves.toMatchObject([Zdo.Status.SUCCESS, {endpoint: 1}]);
        await drainMicrotasks();
        expect(fake.zdoRequests.map((r) => r.data[3])).toStrictEqual([1, 2]);
        expect(secondState.settled()).toBe(false);

        fake.releaseZdo();
        await drainMicrotasks();
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 2));

        await expect(second).resolves.toMatchObject([Zdo.Status.SUCCESS, {endpoint: 2}]);
    });

    it("gives a failed response to the request in flight only, not to the queued one", async () => {
        const {adapter, fake} = await startedAdapter();
        const first = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);
        const second = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(2), false);
        await drainMicrotasks();

        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.NOT_ACTIVE, DEVICE_NWK, 0));
        await expect(first).resolves.toStrictEqual([Zdo.Status.NOT_ACTIVE, undefined]);

        await drainMicrotasks();
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 2));
        await expect(second).resolves.toMatchObject([Zdo.Status.SUCCESS, {endpoint: 2}]);
    });

    it("runs requests to different devices concurrently", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.holdZdo = true;
        const other = 0x4444;
        const first = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);
        const second = adapter.sendZdo(
            "0x0017880100c0ffee",
            other,
            Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST,
            Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, other, 1),
            false,
        );

        await drainMicrotasks();
        expect(fake.zdoRequests.map((r) => r.networkAddress)).toStrictEqual([DEVICE_NWK, other]);

        fake.deliverZdo(other, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, other, 1));
        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 1));
        fake.releaseZdo();
        fake.releaseZdo();

        await expect(first).resolves.toMatchObject([Zdo.Status.SUCCESS, {nwkAddress: DEVICE_NWK}]);
        await expect(second).resolves.toMatchObject([Zdo.Status.SUCCESS, {nwkAddress: other}]);
    });

    it("resolves a Mgmt_NWK_Update channel change (duration 0xfe) once sent, without waiting", async () => {
        vi.useFakeTimers();
        const {adapter, fake} = await startedAdapter();
        fake.holdZdo = true;
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NWK_UPDATE_REQUEST, [20], 0xfe, undefined, 1, undefined);
        expect(request[5]).toBe(0xfe);
        const pending = adapter.sendZdo(DEVICE_IEEE, 0xffff, Zdo.ClusterId.NWK_UPDATE_REQUEST, request, false);
        const state = trackSettled(pending);

        await vi.advanceTimersByTimeAsync(0);
        expect(state.settled()).toBe(false);
        fake.releaseZdo();

        await expect(pending).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for the Mgmt_NWK_Update_rsp of an energy scan", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NWK_UPDATE_REQUEST, [11, 15], 0x03, 1, undefined, undefined);
        const state = trackSettled(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.NWK_UPDATE_REQUEST, request, false));

        await drainMicrotasks();

        expect(fake.zdoRequests).toHaveLength(1);
        expect(state.settled()).toBe(false);
        await adapter.stop();
    });

    it("does not wait when disableResponse is set", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);

        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, true)).resolves.toBeUndefined();
        expect(fake.zdoRequests).toHaveLength(1);
    });

    it("rejects a ZDO request queued behind one in flight when the adapter stops, without sending it or starting its wait", async () => {
        vi.useFakeTimers();
        const {adapter, fake} = await startedAdapter();
        const first = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);
        const second = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(2), false);
        const firstRejection = expect(first).rejects.toThrow("[zerostack-adapter] adapter stopped");
        const secondRejection = expect(second).rejects.toThrow("[zerostack-adapter] adapter stopped");

        await vi.advanceTimersByTimeAsync(0);
        expect(fake.zdoRequests).toHaveLength(1);
        await adapter.stop();

        await firstRejection;
        await secondRejection;
        expect(fake.zdoRequests).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects after the ZDO response timeout and frees the key", async () => {
        vi.useFakeTimers();
        const {adapter, fake} = await startedAdapter();
        const pending = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(1), false);
        const rejection = expect(pending).rejects.toThrow(
            "Timeout after 15000ms waiting for ZDO response cluster=0x8004 discriminator=1 from 0x1234",
        );

        await vi.advanceTimersByTimeAsync(14999);
        expect(trackSettled(pending).settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);

        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE, simpleDescRsp(Zdo.Status.SUCCESS, DEVICE_NWK, 2));
        };
        await expect(
            adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST, simpleDescReq(2), false),
        ).resolves.toMatchObject([Zdo.Status.SUCCESS, {endpoint: 2}]);
    });

    it("propagates a native ZDO send failure, leaves no waiter behind and frees the key", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("zdo", nativeError("delivery", "NWK no route", 0xcd));
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);

        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false)).rejects.toMatchObject({
            code: "delivery",
            status: 0xcd,
        });

        fake.duringZdo = () => {
            fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_RESPONSE, activeEndpointsRsp(SEQ, Zdo.Status.SUCCESS, DEVICE_NWK, [5]));
        };
        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false)).resolves.toStrictEqual([
            Zdo.Status.SUCCESS,
            {nwkAddress: DEVICE_NWK, endpointList: [5]},
        ]);
    });

    it("propagates native 'unsupported' for a ZDO cluster", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("zdo", nativeError("unsupported", "no MT command for Mgmt_NWK_IEEE_Joining_List_req"));
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);

        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false)).rejects.toMatchObject({
            name: "ZsNativeError",
            code: "unsupported",
        });
    });

    it("rejects a pending ZDO wait when the adapter stops", async () => {
        const {adapter, fake} = await startedAdapter();
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, DEVICE_NWK);
        const pending = adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST, request, false);
        await drainMicrotasks();
        expect(fake.zdoRequests).toHaveLength(1);

        await adapter.stop();

        await expect(pending).rejects.toThrow("adapter stopped");
        expect(fake.stopped).toBe(1);
    });
});

describe("events", () => {
    it("emits END_DEVICE_ANNOUNCE as zdoResponse and not as zclPayload", async () => {
        const {adapter, fake} = await startedAdapter();
        const zdo: [number, GenericZdoResponse][] = [];
        const zcl: ZclPayload[] = [];
        adapter.on("zdoResponse", (clusterId, response) => zdo.push([clusterId, response]));
        adapter.on("zclPayload", (payload) => zcl.push(payload));

        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.END_DEVICE_ANNOUNCE, Buffer.from([0x11, 0x34, 0x12, ...eui64Le(DEVICE_IEEE), 0x80]));

        expect(zcl).toHaveLength(0);
        expect(zdo).toHaveLength(1);
        expect(zdo[0]?.[0]).toBe(Zdo.ClusterId.END_DEVICE_ANNOUNCE);
        expect(zdo[0]?.[1]).toMatchObject([
            Zdo.Status.SUCCESS,
            {nwkAddress: DEVICE_NWK, eui64: DEVICE_IEEE, capabilities: {deviceType: 0, allocateAddress: 1}},
        ]);
    });

    it("accepts ZDO callbacks without linkquality but logs and drops ZCL frames without it", async () => {
        const {adapter, fake} = await startedAdapter();
        const zdo: number[] = [];
        const zcl: ZclPayload[] = [];
        adapter.on("zdoResponse", (clusterId) => zdo.push(clusterId));
        adapter.on("zclPayload", (payload) => zcl.push(payload));
        const announce = Buffer.from([0x11, 0x34, 0x12, ...eui64Le(DEVICE_IEEE), 0x80]);
        const toggle = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 7, "toggle", "genOnOff", {}, {});
        const original = loggerModule.logger;
        const errors: string[] = [];
        const ignore = (): void => {};
        setLogger({
            debug: ignore,
            info: ignore,
            warning: ignore,
            error: (message: string, namespace: string) => errors.push(`${namespace} ${message}`),
        });

        try {
            fake.deliverAps({
                srcNwk: DEVICE_NWK,
                clusterId: Zdo.ClusterId.END_DEVICE_ANNOUNCE,
                srcEndpoint: 0,
                dstEndpoint: 0,
                profileId: 0,
                linkquality: null,
                rssi: null,
                data: announce,
            });
            fake.deliverAps({srcNwk: DEVICE_NWK, clusterId: 0x0006, linkquality: null, data: toggle.toBuffer()});
        } finally {
            setLogger(original);
        }

        expect(zdo).toStrictEqual([Zdo.ClusterId.END_DEVICE_ANNOUNCE]);
        expect(zcl).toHaveLength(0);
        expect(errors).toStrictEqual(["zh:zerostack Dropping ZCL frame cluster=0x0006 from 0x1234: native frame carries no linkquality"]);
    });

    it("emits zdoResponse for a NETWORK_ADDRESS_RESPONSE while sendZdo awaits it", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: [number, GenericZdoResponse][] = [];
        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, DEVICE_IEEE, false, 0);
        const rsp = Buffer.from([0x33, Zdo.Status.SUCCESS, ...eui64Le(DEVICE_IEEE), 0x78, 0x56]);
        adapter.on("zdoResponse", (clusterId, response) => seen.push([clusterId, response]));
        const pending = adapter.sendZdo(DEVICE_IEEE, 0xfffd, Zdo.ClusterId.NETWORK_ADDRESS_REQUEST, request, false);
        await drainMicrotasks();

        fake.deliverZdo(0x5678, Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, rsp);

        const expected = [Zdo.Status.SUCCESS, {eui64: DEVICE_IEEE, nwkAddress: 0x5678, startIndex: 0, assocDevList: []}];
        await expect(pending).resolves.toStrictEqual(expected);
        expect(seen).toStrictEqual([[Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, expected]]);
    });

    it("emits a NWK_addr_rsp synthesized from a concentrator indication like any other", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: [number, GenericZdoResponse][] = [];
        adapter.on("zdoResponse", (clusterId, response) => seen.push([clusterId, response]));

        fake.deliverAps({
            srcNwk: 0x6a01,
            clusterId: Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE,
            srcEndpoint: 0,
            dstEndpoint: 0,
            profileId: 0,
            linkquality: null,
            rssi: null,
            data: Buffer.from([0x00, Zdo.Status.SUCCESS, ...eui64Le(DEVICE_IEEE), 0x01, 0x6a]),
        });

        expect(seen).toStrictEqual([
            [Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE, [Zdo.Status.SUCCESS, {eui64: DEVICE_IEEE, nwkAddress: 0x6a01, startIndex: 0, assocDevList: []}]],
        ]);
    });

    it("does not emit the Mgmt_Permit_Joining_rsp of native permitJoin, but emits one a sendZdo awaited", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: number[] = [];
        adapter.on("zdoResponse", (clusterId) => seen.push(clusterId));
        const rsp = Buffer.from([0x44, Zdo.Status.SUCCESS]);

        await adapter.permitJoin(254);
        fake.deliverZdo(0x0000, Zdo.ClusterId.PERMIT_JOINING_RESPONSE, rsp);
        expect(seen).toStrictEqual([]);

        const request = Zdo.Buffalo.buildRequest(true, Zdo.ClusterId.PERMIT_JOINING_REQUEST, 60, 1, []);
        fake.duringZdo = () => fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.PERMIT_JOINING_RESPONSE, rsp);
        await expect(adapter.sendZdo(DEVICE_IEEE, DEVICE_NWK, Zdo.ClusterId.PERMIT_JOINING_REQUEST, request, false)).resolves.toStrictEqual([
            Zdo.Status.SUCCESS,
            undefined,
        ]);
        expect(seen).toStrictEqual([Zdo.ClusterId.PERMIT_JOINING_RESPONSE]);
    });

    it("does not emit ZDO requests addressed to the coordinator", async () => {
        const {adapter, fake} = await startedAdapter();
        const zdo: number[] = [];
        const zcl: ZclPayload[] = [];
        adapter.on("zdoResponse", (clusterId) => zdo.push(clusterId));
        adapter.on("zclPayload", (payload) => zcl.push(payload));

        fake.deliverZdo(DEVICE_NWK, Zdo.ClusterId.IEEE_ADDRESS_REQUEST, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00]));

        expect(zdo).toHaveLength(0);
        expect(zcl).toHaveLength(0);
    });

    it("handles a batch of native events in link order", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: unknown[] = [];
        adapter.on("deviceJoined", (payload) => seen.push(["joined", payload.networkAddress]));
        adapter.on("deviceLeave", (payload) => seen.push(["leave", payload.networkAddress]));

        fake.deliverBatch([
            {kind: "deviceJoined", networkAddress: 0x1001, ieeeAddr: DEVICE_IEEE},
            {kind: "deviceLeave", networkAddress: 0x1002, ieeeAddr: DEVICE_IEEE},
            {kind: "deviceJoined", networkAddress: 0x1003, ieeeAddr: DEVICE_IEEE},
        ]);

        expect(seen).toStrictEqual([
            ["joined", 0x1001],
            ["leave", 0x1002],
            ["joined", 0x1003],
        ]);
    });

    it("maps join, leave and disconnect events", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: unknown[] = [];
        adapter.on("deviceJoined", (payload) => seen.push(["joined", payload]));
        adapter.on("deviceLeave", (payload) => seen.push(["leave", payload]));
        adapter.on("disconnected", () => seen.push(["disconnected"]));

        fake.deliver({kind: "deviceJoined", networkAddress: DEVICE_NWK, ieeeAddr: DEVICE_IEEE});
        fake.deliver({kind: "deviceLeave", networkAddress: DEVICE_NWK, ieeeAddr: DEVICE_IEEE});
        fake.deliver({kind: "deviceLeave", networkAddress: null, ieeeAddr: DEVICE_IEEE});
        fake.deliver({kind: "deviceLeave", networkAddress: DEVICE_NWK, ieeeAddr: null});
        fake.deliver({kind: "disconnected", reason: "serial EOF"});

        expect(seen).toStrictEqual([
            ["joined", {networkAddress: DEVICE_NWK, ieeeAddr: DEVICE_IEEE}],
            ["leave", {networkAddress: DEVICE_NWK, ieeeAddr: DEVICE_IEEE}],
            ["leave", {ieeeAddr: DEVICE_IEEE}],
            ["leave", {networkAddress: DEVICE_NWK}],
            ["disconnected"],
        ]);

        const original = loggerModule.logger;
        const errors: string[] = [];
        const ignore = (): void => {};
        setLogger({
            debug: ignore,
            info: ignore,
            warning: ignore,
            error: (message: string, namespace: string) => errors.push(`${namespace} ${message}`),
        });
        try {
            fake.deliver({kind: "deviceLeave", networkAddress: null, ieeeAddr: null});
        } finally {
            setLogger(original);
        }

        expect(seen).toHaveLength(5);
        expect(errors).toStrictEqual([expect.stringContaining("neither networkAddress nor ieeeAddr")]);
    });

    it("logs a throwing event listener and delivers later events in the same batch", async () => {
        const {adapter, fake} = await startedAdapter();
        const seen: number[] = [];
        adapter.on("deviceJoined", (payload) => {
            if (payload.networkAddress === 0x1001) {
                throw new Error("listener-boom");
            }
            seen.push(payload.networkAddress);
        });

        const original = loggerModule.logger;
        const errors: string[] = [];
        const ignore = (): void => {};
        setLogger({
            debug: ignore,
            info: ignore,
            warning: ignore,
            error: (message: string, namespace: string) => errors.push(`${namespace} ${message}`),
        });
        try {
            fake.deliverBatch([
                {kind: "deviceJoined", networkAddress: 0x1001, ieeeAddr: DEVICE_IEEE},
                {kind: "deviceJoined", networkAddress: 0x1002, ieeeAddr: DEVICE_IEEE},
            ]);
        } finally {
            setLogger(original);
        }

        expect(seen).toStrictEqual([0x1002]);
        expect(errors).toStrictEqual([expect.stringContaining("listener-boom")]);
        await expect(adapter.getCoordinatorVersion()).resolves.toMatchObject({type: "ZeroStack"});
    });
});

describe("lifecycle events", () => {
    it("does not emit disconnected for a requested stop, but does for a link loss", async () => {
        const {adapter, fake} = await startedAdapter();
        let disconnects = 0;
        adapter.on("disconnected", () => {
            disconnects += 1;
        });

        fake.deliver({kind: "disconnected", reason: "serial EOF"});
        expect(disconnects).toBe(1);

        fake.disconnectOnStop = true;
        await adapter.stop();

        expect(fake.stopped).toBe(1);
        expect(disconnects).toBe(1);
    });

    it("does not emit disconnected when start fails and the link is closed", async () => {
        const fake = new FakeCoordinator();
        fake.failNext.set("start", nativeError("rejected", "formation failed"));
        fake.disconnectOnStop = true;
        const adapter = makeAdapter(fake);
        let disconnects = 0;
        adapter.on("disconnected", () => {
            disconnects += 1;
        });

        await expect(adapter.start()).rejects.toMatchObject({code: "rejected"});
        expect(fake.stopped).toBe(1);
        expect(disconnects).toBe(0);
    });
});

describe("logging", () => {
    it("logs through a logger installed with herdsman's setLogger after import", async () => {
        const original = loggerModule.logger;
        const lines: string[] = [];
        const record = (message: string | (() => string), namespace: string): void => {
            lines.push(`${namespace} ${typeof message === "function" ? message() : message}`);
        };
        setLogger({debug: record, info: record, warning: record, error: record});

        try {
            const {fake} = await startedAdapter();
            fake.deliver({kind: "disconnected", reason: "serial EOF"});
        } finally {
            setLogger(original);
        }

        expect(lines).toStrictEqual(["zh:zerostack zs coordinator started (resumed)", "zh:zerostack coordinator link lost: serial EOF"]);
    });
});

describe("Inter-PAN", () => {
    it("locks normal traffic while on the Inter-PAN channel and maps sends to the native calls", async () => {
        const {adapter, fake} = await startedAdapter();
        const scan = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.CLIENT_TO_SERVER,
            true,
            undefined,
            0,
            "scanRequest",
            "touchlink",
            {transactionID: 1, zigbeeInformation: 4, touchlinkInformation: 18},
            {},
        );

        await adapter.setChannelInterPAN(11);
        await expect(adapter.sendZclFrameToGroup(1, scan)).rejects.toThrow("Inter-PAN mode");
        await adapter.sendZclFrameInterPANToIeeeAddr(scan, DEVICE_IEEE);
        await expect(adapter.sendZclFrameInterPANBroadcast(scan, 5000, true)).resolves.toBeUndefined();
        await adapter.restoreChannelInterPAN();

        expect(fake.interpanChannels).toStrictEqual([11, null]);
        expect(fake.interpanSends).toStrictEqual([
            {ieeeAddr: DEVICE_IEEE, data: scan.toBuffer()},
            {ieeeAddr: null, data: scan.toBuffer()},
        ]);
        await adapter.sendZclFrameToGroup(1, scan);
        expect(fake.groupcasts).toHaveLength(1);
    });

    it("reports inter-PAN frames by their EUI64 source, as zstack does, and matches the broadcast response on endpoint 0xfe", async () => {
        const {adapter, fake} = await startedAdapter();
        const payloads: ZclPayload[] = [];
        adapter.on("zclPayload", (payload) => payloads.push(payload));
        const scan = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.CLIENT_TO_SERVER,
            true,
            undefined,
            0,
            "scanRequest",
            "touchlink",
            {transactionID: 0x12345678, zigbeeInformation: 4, touchlinkInformation: 18},
            {},
        );
        const scanRsp = Zcl.Frame.create(
            Zcl.FrameType.SPECIFIC,
            Zcl.Direction.SERVER_TO_CLIENT,
            true,
            undefined,
            0,
            "scanResponse",
            "touchlink",
            {
                transactionID: 0x12345678,
                rssiCorrection: 0,
                zigbeeInformation: 5,
                touchlinkInformation: 18,
                keyBitmask: 0x10,
                responseID: 1,
                extendedPanID: "0x0102030405060708",
                networkUpdateID: 0,
                logicalChannel: 11,
                panID: 0x1a62,
                networkAddress: 0x4a21,
                numberOfSubDevices: 0,
                totalGroupIdentifiers: 0,
            },
            {},
        ).toBuffer();
        const bulb = "0x0017880100c0ffee";

        await adapter.setChannelInterPAN(11);
        const pending = adapter.sendZclFrameInterPANBroadcast(scan, 5000, false);
        await drainMicrotasks();
        fake.deliverAps({srcNwk: 0xfffe, srcIeee: bulb, srcEndpoint: 0x01, dstEndpoint: 0xfe, clusterId: 0x1000, profileId: 0xc05e, data: scanRsp});
        fake.deliverAps({
            srcNwk: 0xfffe,
            srcIeee: bulb,
            srcEndpoint: 0xfe,
            dstEndpoint: 0xfe,
            clusterId: 0x1000,
            profileId: 0xc05e,
            wasBroadcast: false,
            data: scanRsp,
        });

        const response = await pending;
        await adapter.restoreChannelInterPAN();

        expect(response.address).toMatch(/^0x[0-9a-f]{16}$/);
        expect(response.address).toBe(bulb);
        expect(response.endpoint).toBe(0xfe);
        expect(payloads.map((p) => [p.address, p.endpoint])).toStrictEqual([
            [bulb, 0x01],
            [bulb, 0xfe],
        ]);
    });

    it("propagates 'unsupported' from the native addon and releases the lock", async () => {
        const {adapter, fake} = await startedAdapter();
        fake.failNext.set("interpanChannel", nativeError("unsupported", "coordinator has no Inter-PAN"));
        const off = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 1, "off", "genOnOff", {}, {});

        await expect(adapter.setChannelInterPAN(11)).rejects.toMatchObject({code: "unsupported", name: "ZsNativeError"});
        await adapter.sendZclFrameToGroup(1, off);
        expect(fake.groupcasts).toHaveLength(1);
    });
});
