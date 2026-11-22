// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {NetworkOptions as HerdsmanNetworkOptions} from "zigbee-herdsman/dist/adapter/tstype.js";
import type * as Models from "zigbee-herdsman/dist/models/index.js";
import type {BackupDevice, NativeBackup, NetworkOptions} from "../native.js";

const EUI64_HEX = /^0x[0-9a-f]{16}$/;

function requireLength(what: string, buffer: Buffer, length: number): Buffer {
    if (buffer.length !== length) {
        throw new Error(`[zerostack-adapter] ${what} must be ${length} bytes, got ${buffer.length}`);
    }

    return buffer;
}

export function eui64ToHex(what: string, buffer: Buffer): string {
    return `0x${requireLength(what, buffer, 8).toString("hex")}`;
}

export function hexToEui64(what: string, value: string): Buffer {
    if (!EUI64_HEX.test(value)) {
        throw new Error(`[zerostack-adapter] ${what} '${value}' is not 0x + 16 lowercase hex digits`);
    }

    return Buffer.from(value.slice(2), "hex");
}

export function toNativeNetworkOptions(options: HerdsmanNetworkOptions): NetworkOptions {
    if (options.extendedPanID === undefined) {
        throw new Error("[zerostack-adapter] network option extendedPanID is required");
    }

    if (options.networkKey === undefined) {
        throw new Error("[zerostack-adapter] network option networkKey is required");
    }

    return {
        panId: options.panID,
        extendedPanId: eui64ToHex("extendedPanID", Buffer.from(options.extendedPanID)),
        channelList: [...options.channelList],
        networkKey: requireLength("networkKey", Buffer.from(options.networkKey), 16),
        networkKeyDistribute: options.networkKeyDistribute === true,
    };
}

export function toNativeBackup(backup: Models.Backup): NativeBackup {
    const seed = backup.znp?.trustCenterLinkKeySeed;

    return {
        network: {
            panId: backup.networkOptions.panId,
            extendedPanId: eui64ToHex("backup extendedPanId", backup.networkOptions.extendedPanId),
            channelList: [...backup.networkOptions.channelList],
            networkKey: requireLength("backup networkKey", backup.networkOptions.networkKey, 16),
            networkKeyDistribute: backup.networkOptions.networkKeyDistribute,
        },
        logicalChannel: backup.logicalChannel,
        networkKeySequence: backup.networkKeyInfo.sequenceNumber,
        networkKeyFrameCounter: backup.networkKeyInfo.frameCounter,
        securityLevel: backup.securityLevel,
        networkUpdateId: backup.networkUpdateId,
        coordinatorIeeeAddress: eui64ToHex("backup coordinatorIeeeAddress", backup.coordinatorIeeeAddress),
        devices: backup.devices.map(
            (device): BackupDevice => ({
                // 0x0000 is the coordinator's address; treat as unaddressed.
                networkAddress: device.networkAddress === 0 ? null : device.networkAddress,
                ieeeAddress: eui64ToHex("backup device ieeeAddress", device.ieeeAddress),
                isDirectChild: device.isDirectChild,
                linkKey:
                    device.linkKey === undefined
                        ? null
                        : {
                              key: requireLength("backup device link key", device.linkKey.key, 16),
                              rxCounter: device.linkKey.rxCounter,
                              txCounter: device.linkKey.txCounter,
                          },
            }),
        ),
        trustCenterLinkKeySeed: seed === undefined ? null : requireLength("backup trustCenterLinkKeySeed", seed, 16),
    };
}

export function fromNativeBackup(backup: NativeBackup): Models.Backup {
    const result: Models.Backup = {
        networkOptions: {
            panId: backup.network.panId,
            extendedPanId: hexToEui64("backup extendedPanId", backup.network.extendedPanId),
            channelList: [...backup.network.channelList],
            networkKey: requireLength("backup networkKey", backup.network.networkKey, 16),
            networkKeyDistribute: backup.network.networkKeyDistribute,
        },
        logicalChannel: backup.logicalChannel,
        networkKeyInfo: {
            sequenceNumber: backup.networkKeySequence,
            frameCounter: backup.networkKeyFrameCounter,
        },
        securityLevel: backup.securityLevel,
        networkUpdateId: backup.networkUpdateId,
        coordinatorIeeeAddress: hexToEui64("backup coordinatorIeeeAddress", backup.coordinatorIeeeAddress),
        devices: backup.devices.map((device) => ({
            networkAddress: device.networkAddress,
            ieeeAddress: hexToEui64("backup device ieeeAddress", device.ieeeAddress),
            isDirectChild: device.isDirectChild,
            ...(device.linkKey === null
                ? {}
                : {
                      linkKey: {
                          key: requireLength("backup device link key", device.linkKey.key, 16),
                          rxCounter: device.linkKey.rxCounter,
                          txCounter: device.linkKey.txCounter,
                      },
                  }),
        })),
    };

    if (backup.trustCenterLinkKeySeed !== null) {
        result.znp = {trustCenterLinkKeySeed: requireLength("backup trustCenterLinkKeySeed", backup.trustCenterLinkKeySeed, 16)};
    }

    return result;
}
