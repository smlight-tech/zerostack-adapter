// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {describe, expect, it} from "vitest";
import * as BackupUtils from "zigbee-herdsman/dist/utils/backup.js";
import type {NativeBackup} from "../native.js";
import {fromNativeBackup, toNativeBackup, toNativeNetworkOptions} from "../ts/backup.js";

const BACKUP: NativeBackup = {
    network: {
        panId: 0x6754,
        extendedPanId: "0x00124b0012345678",
        channelList: [11, 25],
        networkKey: Buffer.from("aa000000000000000000000000000055", "hex"),
        networkKeyDistribute: true,
    },
    logicalChannel: 25,
    networkKeySequence: 3,
    networkKeyFrameCounter: 0x00ffff01,
    securityLevel: 5,
    networkUpdateId: 9,
    coordinatorIeeeAddress: "0x00124b0012345678",
    devices: [
        {
            networkAddress: null,
            ieeeAddress: "0xa4c138aabbccddee",
            isDirectChild: false,
            linkKey: {key: Buffer.alloc(16, 0x11), rxCounter: 0, txCounter: 3},
        },
        {networkAddress: 0x0001, ieeeAddress: "0x0017880100c0ffee", isDirectChild: true, linkKey: null},
    ],
    trustCenterLinkKeySeed: null,
};

describe("backup conversion", () => {
    it("round-trips native -> Models.Backup -> native", () => {
        expect(toNativeBackup(fromNativeBackup(BACKUP))).toStrictEqual(BACKUP);
    });

    it("round-trips through herdsman's unified backup file format", () => {
        const unified = JSON.parse(JSON.stringify(BackupUtils.toUnifiedBackup(fromNativeBackup(BACKUP))));
        const restored = toNativeBackup(BackupUtils.fromUnifiedBackup(unified));

        // the open coordinator backup format does not store networkKeyDistribute
        expect(restored).toStrictEqual({...BACKUP, network: {...BACKUP.network, networkKeyDistribute: false}});
    });

    it("reads a device on network address 0000 as one without an address", () => {
        const unified = JSON.parse(JSON.stringify(BackupUtils.toUnifiedBackup(fromNativeBackup(BACKUP))));
        unified.devices[0].nwk_address = "0000";
        unified.devices[1].nwk_address = "0001";
        const devices = toNativeBackup(BackupUtils.fromUnifiedBackup(unified)).devices;

        expect(devices.map((device) => device.networkAddress)).toStrictEqual([null, 0x0001]);
    });

    it("keeps byte order of IEEE addresses as herdsman's hex strings", () => {
        const model = fromNativeBackup(BACKUP);

        expect(model.devices[0]?.ieeeAddress.toString("hex")).toBe("a4c138aabbccddee");
        expect(BackupUtils.toUnifiedBackup(model).devices[0]?.ieee_address).toBe("a4c138aabbccddee");
    });

    it("rejects wrong-length keys", () => {
        expect(() => fromNativeBackup({...BACKUP, network: {...BACKUP.network, networkKey: Buffer.alloc(15)}})).toThrow(
            "networkKey must be 16 bytes, got 15",
        );
    });

    it("requires the generated extended PAN ID and network key in the configuration", () => {
        expect(() => toNativeNetworkOptions({panID: 1, channelList: [11], networkKey: Array(16).fill(1)})).toThrow("extendedPanID is required");
        expect(() => toNativeNetworkOptions({panID: 1, channelList: [11], extendedPanID: Array(8).fill(1)})).toThrow("networkKey is required");
        expect(
            toNativeNetworkOptions({panID: 1, channelList: [11], extendedPanID: [0, 1, 2, 3, 4, 5, 6, 0xff], networkKey: Array(16).fill(1)}),
        ).toMatchObject({
            extendedPanId: "0x00010203040506ff",
            networkKeyDistribute: false,
        });
    });
});
