// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// IEEE addresses and extended PAN IDs use "0x" + 16 lowercase hex digits.

export type Backend = "zs";
export type StartResult = "resumed" | "reset" | "restored";

export interface OpenOptions {
    backend: Backend;
    /** e.g. "serial:/dev/ttyUSB0" or "tcp://host:port". */
    transport: string;
    baudRate: number;
    rtscts: boolean;
}

export interface NetworkOptions {
    panId: number;
    extendedPanId: string;
    channelList: number[];
    networkKey: Buffer;
    networkKeyDistribute: boolean;
}

export interface BackupLinkKey {
    key: Buffer;
    rxCounter: number;
    txCounter: number;
}

export interface BackupDevice {
    networkAddress: number | null;
    ieeeAddress: string;
    isDirectChild: boolean;
    linkKey: BackupLinkKey | null;
}

export interface NativeBackup {
    network: NetworkOptions;
    logicalChannel: number;
    networkKeySequence: number;
    networkKeyFrameCounter: number;
    securityLevel: number;
    networkUpdateId: number;
    coordinatorIeeeAddress: string;
    devices: BackupDevice[];
    trustCenterLinkKeySeed: Buffer | null;
}

export interface NetworkParameters {
    panId: number;
    extendedPanId: string;
    channel: number;
    nwkUpdateId: number;
}

export interface CoordinatorVersion {
    type: string;
    meta: Record<string, number | string>;
}

export interface ApsFrame {
    /** 0xfffe for inter-PAN frames carrying only a 64-bit source. */
    srcNwk: number;
    srcIeee: string | null;
    srcEndpoint: number;
    dstEndpoint: number;
    clusterId: number;
    profileId: number;
    groupId: number | null;
    wasBroadcast: boolean;
    linkquality: number | null;
    rssi: number | null;
    data: Buffer;
}

export type NativeEvent =
    | {kind: "aps"; frame: ApsFrame}
    | {kind: "deviceJoined"; networkAddress: number; ieeeAddr: string}
    | {kind: "deviceLeave"; networkAddress: number | null; ieeeAddr: string | null}
    /** Link lost; never emitted for a requested stop(). */
    | {kind: "disconnected"; reason: string};

export interface NativeError extends Error {
    code: "transport" | "timeout" | "delivery" | "rejected" | "unsupported" | "invalid";
    status?: number;
}

export interface Unicast {
    ieeeAddr: string;
    networkAddress: number;
    dstEndpoint: number;
    srcEndpoint: number;
    clusterId: number;
    profileId: number;
    radius: number;
    apsAck: boolean;
    data: Buffer;
    timeoutMs: number;
}

export interface Groupcast {
    groupId: number;
    srcEndpoint: number;
    clusterId: number;
    profileId: number;
    radius: number;
    data: Buffer;
    timeoutMs: number;
}

export interface Broadcast {
    destination: 0xffff | 0xfffd | 0xfffc;
    dstEndpoint: number;
    srcEndpoint: number;
    clusterId: number;
    profileId: number;
    radius: number;
    data: Buffer;
    timeoutMs: number;
}

export interface ZdoSend {
    ieeeAddr: string;
    networkAddress: number;
    clusterId: number;
    /** Leading sequence byte is ignored; the coordinator picks the sequence. */
    data: Buffer;
    timeoutMs: number;
}

export declare class ZsCoordinator {
    static open(options: OpenOptions, onEvent: (events: NativeEvent[]) => void, timeoutMs: number): Promise<ZsCoordinator>;
    start(network: NetworkOptions, backup: NativeBackup | null, timeoutMs: number): Promise<StartResult>;
    stop(): Promise<void>;
    reset(kind: "soft" | "hard", timeoutMs: number): Promise<void>;
    coordinatorIeee(timeoutMs: number): Promise<string>;
    coordinatorVersion(timeoutMs: number): Promise<CoordinatorVersion>;
    networkParameters(timeoutMs: number): Promise<NetworkParameters>;
    supportsBackup(): boolean;
    backup(knownIeeeAddrs: string[], timeoutMs: number): Promise<NativeBackup>;
    addInstallCode(ieeeAddr: string, code: Buffer, hashed: boolean, timeoutMs: number): Promise<void>;
    permitJoin(seconds: number, networkAddress: number | null, timeoutMs: number): Promise<void>;
    unicast(frame: Unicast): Promise<void>;
    groupcast(frame: Groupcast): Promise<void>;
    broadcast(frame: Broadcast): Promise<void>;
    zdo(request: ZdoSend): Promise<void>;
    interpanChannel(channel: number | null, timeoutMs: number): Promise<void>;
    interpanSend(ieeeAddr: string | null, data: Buffer, timeoutMs: number): Promise<void>;
}
