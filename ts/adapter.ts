// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {Zcl as ZclNs, Zdo as ZdoNs} from "zigbee-herdsman";
import type {ClusterWaitressMatcher, Adapter as HerdsmanAdapter, ZclWaitressPayload} from "zigbee-herdsman/dist/adapter/adapter.js";
import type * as Events from "zigbee-herdsman/dist/adapter/events.js";
import type {
    AdapterOptions,
    CoordinatorVersion,
    NetworkOptions,
    NetworkParameters,
    StartResult,
    TransportOptions,
} from "zigbee-herdsman/dist/adapter/tstype.js";
import type * as Models from "zigbee-herdsman/dist/models/index.js";
import type {Waitress as WaitressOf} from "zigbee-herdsman/dist/utils/waitress.js";
import type {BroadcastAddress} from "zigbee-herdsman/dist/zspec/enums.js";
import type * as ZdoTypes from "zigbee-herdsman/dist/zspec/zdo/definition/tstypes.js";
import type {ApsFrame, Broadcast, NativeBackup, NativeEvent, ZsCoordinator} from "../native.js";
import {fromNativeBackup, toNativeBackup, toNativeNetworkOptions} from "./backup.js";
import {callNative} from "./errors.js";
import {Adapter, BackupUtils, loggerModule, readBackup, Waitress, Zcl, Zdo, ZSpec} from "./herdsman.js";
import {type CoordinatorOpener, loadNativeCoordinator} from "./native.js";
import {adapterTarget, type ZsTarget} from "./path.js";
import {type ZdoResponder, ZdoWaiters} from "./zdoWaiters.js";

const NS = "zh:zerostack";

const OPEN_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKUP_TIMEOUT_MS = 60_000;
const MULTICAST_TIMEOUT_MS = 3_000;
const INTERPAN_TIMEOUT_MS = 10_000;
const ZDO_SEND_TIMEOUT_MS = 10_000;
const ZDO_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_RADIUS = 30;
const INTERPAN_ENDPOINT = 0xfe;
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_RTSCTS = false;

const MANUFACTURER: ZclNs.ManufacturerCode = Zcl.ManufacturerCode.TEXAS_INSTRUMENTS;

const OUTGOING_BROADCASTS: readonly Broadcast["destination"][] = [0xffff, 0xfffd, 0xfffc];

function isOutgoingBroadcast(destination: number): destination is Broadcast["destination"] {
    return OUTGOING_BROADCASTS.some((candidate) => candidate === destination);
}

function requestByte(clusterId: number, payload: Buffer, offset: number, what: string): number {
    const value = payload[offset];

    if (value === undefined) {
        throw new Error(`[zerostack-adapter] ZDO ${Zdo.ClusterId[clusterId]} payload of ${payload.length} bytes has no ${what} at offset ${offset}`);
    }

    return value;
}

function requestDiscriminator(clusterId: number, payload: Buffer): number | undefined {
    switch (clusterId) {
        case Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST:
            return requestByte(clusterId, payload, 3, "endpoint");
        case Zdo.ClusterId.LQI_TABLE_REQUEST:
        case Zdo.ClusterId.ROUTING_TABLE_REQUEST:
        case Zdo.ClusterId.BINDING_TABLE_REQUEST:
            return requestByte(clusterId, payload, 1, "start index");
        default:
            return undefined;
    }
}

// Duration 0xfe/0xff (channel change / attribute update) expects no response.
function expectsZdoResponse(clusterId: number, payload: Buffer): boolean {
    if (clusterId !== Zdo.ClusterId.NWK_UPDATE_REQUEST) {
        return true;
    }

    return requestByte(clusterId, payload, 5, "scan duration") <= 0x05;
}

function responseDiscriminator(clusterId: number, response: ZdoTypes.GenericZdoResponse): number | undefined {
    switch (clusterId) {
        case Zdo.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE:
            return Zdo.Buffalo.checkStatus<ZdoNs.ClusterId.SIMPLE_DESCRIPTOR_RESPONSE>(response) ? response[1].endpoint : undefined;
        case Zdo.ClusterId.LQI_TABLE_RESPONSE:
            return Zdo.Buffalo.checkStatus<ZdoNs.ClusterId.LQI_TABLE_RESPONSE>(response) ? response[1].startIndex : undefined;
        case Zdo.ClusterId.ROUTING_TABLE_RESPONSE:
            return Zdo.Buffalo.checkStatus<ZdoNs.ClusterId.ROUTING_TABLE_RESPONSE>(response) ? response[1].startIndex : undefined;
        case Zdo.ClusterId.BINDING_TABLE_RESPONSE:
            return Zdo.Buffalo.checkStatus<ZdoNs.ClusterId.BINDING_TABLE_RESPONSE>(response) ? response[1].startIndex : undefined;
        default:
            return undefined;
    }
}

function hex16(value: number): string {
    return `0x${value.toString(16).padStart(4, "0")}`;
}

// Must match endpoints registered in src/zs_protocol.rs.
const COORDINATOR_ENDPOINTS: readonly {readonly endpoint: number; readonly appprofid: number}[] = [
    {endpoint: 1, appprofid: 0x0104},
    {endpoint: 2, appprofid: 0x0101},
    {endpoint: 3, appprofid: 0x0104},
    {endpoint: 4, appprofid: 0x0107},
    {endpoint: 5, appprofid: 0x0108},
    {endpoint: 6, appprofid: 0x0109},
    {endpoint: 8, appprofid: 0x0104},
    {endpoint: 10, appprofid: 0x0104},
    {endpoint: 11, appprofid: 0x0104},
    {endpoint: 110, appprofid: 0x0104},
    {endpoint: 12, appprofid: 0xc05e},
    {endpoint: 13, appprofid: 0x0104},
    {endpoint: 47, appprofid: 0x0104},
    {endpoint: 239, appprofid: 0xc001},
    {endpoint: 242, appprofid: 0xa1e0},
];

function selectSourceEndpoint(sourceEndpoint: number | undefined, profileId: number | undefined): {endpoint: number; profileId: number} {
    const endpoint =
        sourceEndpoint ?? (profileId === undefined ? undefined : COORDINATOR_ENDPOINTS.find((e) => e.appprofid === profileId)?.endpoint) ?? 1;
    const registered = COORDINATOR_ENDPOINTS.find((e) => e.endpoint === endpoint);

    if (registered === undefined) {
        throw new Error(`[zerostack-adapter] source endpoint ${endpoint} is not a coordinator endpoint`);
    }

    if (profileId !== undefined && registered.appprofid !== profileId) {
        throw new Error(`Profile ID ${profileId} is not supported by this adapter.`);
    }

    return {endpoint, profileId: registered.appprofid};
}

const PRODUCTION_ADDON: CoordinatorOpener = {
    open: (...args) => loadNativeCoordinator().open(...args),
};

export interface ZsAdapter extends HerdsmanAdapter {
    readonly target: ZsTarget;
}

export type ZsAdapterConstructor = new (
    networkOptions: NetworkOptions,
    transportOptions: TransportOptions,
    backupPath: string,
    adapterOptions: AdapterOptions,
    opener?: CoordinatorOpener,
) => ZsAdapter;

const ADAPTER_CLASSES = new WeakMap<typeof HerdsmanAdapter, ZsAdapterConstructor>();

// Cached per host Adapter constructor so instanceof checks match.
export function createZsAdapterClass(adapterBase: typeof HerdsmanAdapter): ZsAdapterConstructor {
    const cached = ADAPTER_CLASSES.get(adapterBase);
    if (cached !== undefined) {
        return cached;
    }

    class ZsAdapterImpl extends adapterBase implements ZsAdapter {
        public readonly target: ZsTarget;
        private readonly opener: CoordinatorOpener;
        private coordinator: ZsCoordinator | undefined;
        private readonly zclWaitress: WaitressOf<ZclWaitressPayload, ClusterWaitressMatcher>;
        private readonly zdoWaiters: ZdoWaiters;
        private interpanLock: boolean;

        public constructor(
            networkOptions: NetworkOptions,
            transportOptions: TransportOptions,
            backupPath: string,
            adapterOptions: AdapterOptions,
            opener: CoordinatorOpener = PRODUCTION_ADDON,
        ) {
            super(networkOptions, transportOptions, backupPath, adapterOptions);

            if (transportOptions.path === undefined) {
                throw new Error("[zerostack-adapter] transport path is required");
            }

            this.target = adapterTarget(transportOptions.path);
            this.opener = opener;
            this.coordinator = undefined;
            this.hasZdoMessageOverhead = true;
            this.manufacturerID = MANUFACTURER;
            this.zclWaitress = new Waitress(adapterBase.zclWaitressValidator, adapterBase.clusterWaitressTimeoutFormatter);
            this.zdoWaiters = new ZdoWaiters();
            this.interpanLock = false;
        }

        public async start(): Promise<StartResult> {
            if (this.coordinator !== undefined) {
                throw new Error("[zerostack-adapter] adapter already started");
            }

            const storedBackup = this.readStoredBackup();
            const network = toNativeNetworkOptions(this.networkOptions);
            const backup = storedBackup === undefined ? null : toNativeBackup(storedBackup);
            const coordinator = await callNative(`open ${this.target.backend} ${this.target.transport}`, () =>
                this.opener.open(
                    {
                        backend: this.target.backend,
                        transport: this.target.transport,
                        baudRate: this.transport.options.baudRate ?? DEFAULT_BAUD_RATE,
                        rtscts: this.transport.options.rtscts ?? DEFAULT_RTSCTS,
                    },
                    (events) => {
                        for (const event of events) {
                            try {
                                this.onNativeEvent(event);
                            } catch (error) {
                                loggerModule.logger.error(`Unhandled error handling native ${event.kind} event: ${error}`, NS);
                            }
                        }
                    },
                    OPEN_TIMEOUT_MS,
                ),
            );

            try {
                const result = await callNative("start", () => coordinator.start(network, backup, START_TIMEOUT_MS));
                if (result === "restored" && backup !== null) {
                    await this.warnIfRestoreFilledTable(coordinator, backup);
                }
                this.coordinator = coordinator;
                loggerModule.logger.info(`${this.target.backend} coordinator started (${result})`, NS);

                return result;
            } catch (startError) {
                try {
                    await coordinator.stop();
                } catch (stopError) {
                    throw new AggregateError([startError, stopError], "[zerostack-adapter] start failed and the native link did not close");
                }

                throw startError;
            }
        }

        private async warnIfRestoreFilledTable(coordinator: ZsCoordinator, backup: NativeBackup): Promise<void> {
            const version = await callNative("coordinatorVersion", () => coordinator.coordinatorVersion(REQUEST_TIMEOUT_MS));
            const capacity = version.meta.zs_nodes;
            if (typeof capacity !== "number") {
                throw new Error("[zerostack-adapter] coordinatorVersion meta has no numeric zs_nodes");
            }
            const restored = backup.devices.filter((d) => d.ieeeAddress !== backup.coordinatorIeeeAddress).length;
            if (restored >= capacity) {
                loggerModule.logger.warning(
                    `backup restore filled the coordinator device table (${restored} of ${capacity} entries): devices missing from the backup need a free entry to be heard`,
                    NS,
                );
            }
        }

        public async stop(): Promise<void> {
            const coordinator = this.coordinator;
            this.coordinator = undefined;
            this.zclWaitress.clear();
            this.zdoWaiters.rejectAll(new Error("[zerostack-adapter] adapter stopped"));

            if (coordinator !== undefined) {
                await callNative("stop", () => coordinator.stop());
            }
        }

        public async reset(type: "soft" | "hard"): Promise<void> {
            const coordinator = this.requireCoordinator();
            await callNative(`${type} reset`, () => coordinator.reset(type, REQUEST_TIMEOUT_MS));
        }

        public async getCoordinatorIEEE(): Promise<string> {
            const coordinator = this.requireCoordinator();

            return await callNative("coordinatorIeee", () => coordinator.coordinatorIeee(REQUEST_TIMEOUT_MS));
        }

        public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
            const coordinator = this.requireCoordinator();

            return await callNative("coordinatorVersion", () => coordinator.coordinatorVersion(REQUEST_TIMEOUT_MS));
        }

        public async getNetworkParameters(): Promise<NetworkParameters> {
            const coordinator = this.requireCoordinator();
            const params = await callNative("networkParameters", () => coordinator.networkParameters(REQUEST_TIMEOUT_MS));

            return {panID: params.panId, extendedPanID: params.extendedPanId, channel: params.channel, nwkUpdateID: params.nwkUpdateId};
        }

        public async supportsBackup(): Promise<boolean> {
            return await Promise.resolve(true);
        }

        public async backup(ieeeAddressesInDatabase: string[]): Promise<Models.Backup> {
            const coordinator = this.requireCoordinator();
            const backup = await callNative("backup", () => coordinator.backup(ieeeAddressesInDatabase, BACKUP_TIMEOUT_MS));

            return fromNativeBackup(backup);
        }

        public async addInstallCode(ieeeAddress: string, key: Buffer, hashed: boolean): Promise<void> {
            const coordinator = this.requireCoordinator();
            await callNative(`addInstallCode ${ieeeAddress}`, () => coordinator.addInstallCode(ieeeAddress, key, hashed, REQUEST_TIMEOUT_MS));
        }

        public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
            this.checkInterpanLock();
            const coordinator = this.requireCoordinator();
            const target = networkAddress === undefined ? null : networkAddress;
            await callNative(`permitJoin ${seconds}s`, () => coordinator.permitJoin(seconds, target, REQUEST_TIMEOUT_MS));
        }

        public async sendZdo(
            ieeeAddress: string,
            networkAddress: number,
            clusterId: ZdoNs.ClusterId,
            payload: Buffer,
            disableResponse: true,
        ): Promise<void>;
        public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
            ieeeAddress: string,
            networkAddress: number,
            clusterId: K,
            payload: Buffer,
            disableResponse: false,
        ): Promise<ZdoTypes.RequestToResponseMap[K]>;
        public async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
            ieeeAddress: string,
            networkAddress: number,
            clusterId: K,
            payload: Buffer,
            disableResponse: boolean,
        ): Promise<ZdoTypes.RequestToResponseMap[K] | undefined> {
            this.checkInterpanLock();
            const coordinator = this.requireCoordinator();
            const operation = `ZDO ${Zdo.ClusterId[clusterId]} to ${ieeeAddress}:${hex16(networkAddress)}`;
            const send = async (): Promise<void> =>
                await callNative(operation, () =>
                    coordinator.zdo({ieeeAddr: ieeeAddress, networkAddress, clusterId, data: payload, timeoutMs: ZDO_SEND_TIMEOUT_MS}),
                );
            const responseClusterId =
                disableResponse || !expectsZdoResponse(clusterId, payload) ? undefined : Zdo.Utils.getResponseClusterId(clusterId);

            if (responseClusterId === undefined) {
                await send();
                return undefined;
            }

            const responder = this.zdoResponder(responseClusterId, ieeeAddress, networkAddress);
            const expectation = {clusterId: responseClusterId, responder, discriminator: requestDiscriminator(clusterId, payload)};
            const response = await this.zdoWaiters.exclusive(ZdoWaiters.exclusionKey(responseClusterId, responder), async () => {
                // A turn queued before stop() must not send or wait on the stopped coordinator.
                if (this.coordinator !== coordinator) {
                    throw new Error("[zerostack-adapter] adapter stopped");
                }

                // Register before sending: the response can overtake the native confirm.
                const wait = this.zdoWaiters.register(expectation);

                try {
                    await send();
                } catch (error) {
                    wait.cancel();
                    throw error;
                }

                return await wait.start(ZDO_RESPONSE_TIMEOUT_MS);
            });

            return response as ZdoTypes.RequestToResponseMap[K];
        }

        public async sendZclFrameToEndpoint(
            ieeeAddr: string,
            networkAddress: number,
            endpoint: number,
            zclFrame: ZclNs.Frame,
            timeout: number,
            disableResponse: boolean,
            _disableRecovery: boolean,
            sourceEndpoint?: number,
            profileId?: number,
        ): Promise<Events.ZclPayload | undefined> {
            this.checkInterpanLock();
            const coordinator = this.requireCoordinator();
            const source = selectSourceEndpoint(sourceEndpoint, profileId);
            const command = zclFrame.command;
            let responseCommandId: number | undefined;

            if (command.response !== undefined && !disableResponse) {
                responseCommandId = command.response;
            } else if (!zclFrame.header.frameControl.disableDefaultResponse) {
                responseCommandId = Zcl.Foundation.defaultRsp.ID;
            }

            const waiter =
                responseCommandId === undefined
                    ? undefined
                    : this.zclWaitress.waitFor(
                          {
                              address: networkAddress,
                              endpoint,
                              frameType: zclFrame.header.frameControl.frameType,
                              clusterId: zclFrame.cluster.ID,
                              commandId: responseCommandId,
                              defaultRspCommandId: command.ID,
                              transactionSequenceNumber: zclFrame.header.transactionSequenceNumber,
                          },
                          timeout,
                      );

            try {
                await callNative(`ZCL ${zclFrame.cluster.name}.${command.name} to ${ieeeAddr}:${hex16(networkAddress)}/${endpoint}`, () =>
                    coordinator.unicast({
                        ieeeAddr,
                        networkAddress,
                        dstEndpoint: endpoint,
                        srcEndpoint: source.endpoint,
                        clusterId: zclFrame.cluster.ID,
                        profileId: source.profileId,
                        radius: DEFAULT_RADIUS,
                        apsAck: responseCommandId !== undefined,
                        data: zclFrame.toBuffer(),
                        timeoutMs: timeout,
                    }),
                );
            } catch (error) {
                if (waiter !== undefined) {
                    this.zclWaitress.remove(waiter.ID);
                }

                throw error;
            }

            if (waiter === undefined) {
                return undefined;
            }

            return await waiter.start().promise;
        }

        public async sendZclFrameToGroup(groupID: number, zclFrame: ZclNs.Frame, sourceEndpoint?: number, profileId?: number): Promise<void> {
            this.checkInterpanLock();
            const coordinator = this.requireCoordinator();
            const source = selectSourceEndpoint(sourceEndpoint, profileId);

            await callNative(`ZCL ${zclFrame.cluster.name}.${zclFrame.command.name} to group ${hex16(groupID)}`, () =>
                coordinator.groupcast({
                    groupId: groupID,
                    srcEndpoint: source.endpoint,
                    clusterId: zclFrame.cluster.ID,
                    profileId: source.profileId,
                    radius: DEFAULT_RADIUS,
                    data: zclFrame.toBuffer(),
                    timeoutMs: MULTICAST_TIMEOUT_MS,
                }),
            );
        }

        public async sendZclFrameToAll(
            endpoint: number,
            zclFrame: ZclNs.Frame,
            sourceEndpoint: number,
            destination: BroadcastAddress,
            profileId?: number,
        ): Promise<void> {
            this.checkInterpanLock();
            const coordinator = this.requireCoordinator();
            const source = selectSourceEndpoint(sourceEndpoint, profileId);

            if (!isOutgoingBroadcast(destination)) {
                throw new Error(`[zerostack-adapter] broadcast destination ${hex16(destination)} is not supported (0xffff, 0xfffd, 0xfffc)`);
            }

            await callNative(`ZCL ${zclFrame.cluster.name}.${zclFrame.command.name} broadcast to ${hex16(destination)}`, () =>
                coordinator.broadcast({
                    destination,
                    dstEndpoint: endpoint,
                    srcEndpoint: source.endpoint,
                    clusterId: zclFrame.cluster.ID,
                    profileId: source.profileId,
                    radius: DEFAULT_RADIUS,
                    data: zclFrame.toBuffer(),
                    timeoutMs: MULTICAST_TIMEOUT_MS,
                }),
            );
        }

        public waitFor(
            networkAddress: number,
            endpoint: number,
            frameType: ZclNs.FrameType,
            _direction: ZclNs.Direction,
            transactionSequenceNumber: number | undefined,
            clusterId: number,
            commandId: number,
            defaultRspCommandId: number | undefined,
            timeout: number,
        ): {promise: Promise<Events.ZclPayload>; cancel: () => void} {
            const matcher: ClusterWaitressMatcher = {address: networkAddress, endpoint, frameType, clusterId, commandId, transactionSequenceNumber};

            if (defaultRspCommandId !== undefined) {
                matcher.defaultRspCommandId = defaultRspCommandId;
            }

            const waiter = this.zclWaitress.waitFor(matcher, timeout);

            return {promise: waiter.start().promise, cancel: () => this.zclWaitress.remove(waiter.ID)};
        }

        public async setChannelInterPAN(channel: number): Promise<void> {
            const coordinator = this.requireCoordinator();
            this.interpanLock = true;

            try {
                await callNative(`interpanChannel ${channel}`, () => coordinator.interpanChannel(channel, REQUEST_TIMEOUT_MS));
            } catch (error) {
                this.interpanLock = false;
                throw error;
            }
        }

        public async sendZclFrameInterPANToIeeeAddr(zclFrame: ZclNs.Frame, ieeeAddress: string): Promise<void> {
            const coordinator = this.requireCoordinator();
            await callNative(`Inter-PAN ${zclFrame.cluster.name}.${zclFrame.command.name} to ${ieeeAddress}`, () =>
                coordinator.interpanSend(ieeeAddress, zclFrame.toBuffer(), INTERPAN_TIMEOUT_MS),
            );
        }

        public async sendZclFrameInterPANBroadcast(zclFrame: ZclNs.Frame, timeout: number, disableResponse: false): Promise<Events.ZclPayload>;
        public async sendZclFrameInterPANBroadcast(zclFrame: ZclNs.Frame, timeout: number, disableResponse: true): Promise<undefined>;
        public async sendZclFrameInterPANBroadcast(
            zclFrame: ZclNs.Frame,
            timeout: number,
            disableResponse: boolean,
        ): Promise<Events.ZclPayload | undefined> {
            const coordinator = this.requireCoordinator();
            const command = zclFrame.command;

            if (!disableResponse && command.response === undefined) {
                throw new Error(`Command '${command.name}' has no response, cannot wait for response`);
            }

            const waiter =
                disableResponse || command.response === undefined
                    ? undefined
                    : this.zclWaitress.waitFor(
                          {
                              address: undefined,
                              endpoint: INTERPAN_ENDPOINT,
                              frameType: zclFrame.header.frameControl.frameType,
                              clusterId: zclFrame.cluster.ID,
                              commandId: command.response,
                          },
                          timeout,
                      );

            try {
                await callNative(`Inter-PAN ${zclFrame.cluster.name}.${command.name} broadcast`, () =>
                    coordinator.interpanSend(null, zclFrame.toBuffer(), INTERPAN_TIMEOUT_MS),
                );
            } catch (error) {
                if (waiter !== undefined) {
                    this.zclWaitress.remove(waiter.ID);
                }

                throw error;
            }

            if (waiter === undefined) {
                return undefined;
            }

            return await waiter.start().promise;
        }

        public async restoreChannelInterPAN(): Promise<void> {
            const coordinator = this.requireCoordinator();
            await callNative("interpanChannel restore", () => coordinator.interpanChannel(null, REQUEST_TIMEOUT_MS));
            this.interpanLock = false;
        }

        private onNativeEvent(event: NativeEvent): void {
            switch (event.kind) {
                case "aps": {
                    this.onApsFrame(event.frame);
                    break;
                }
                case "deviceJoined": {
                    this.emit("deviceJoined", {networkAddress: event.networkAddress, ieeeAddr: event.ieeeAddr});
                    break;
                }
                case "deviceLeave": {
                    const {networkAddress, ieeeAddr} = event;

                    if (ieeeAddr !== null) {
                        this.emit("deviceLeave", networkAddress === null ? {ieeeAddr} : {networkAddress, ieeeAddr});
                    } else if (networkAddress !== null) {
                        this.emit("deviceLeave", {networkAddress});
                    } else {
                        throw new Error("[zerostack-adapter] native deviceLeave event carries neither networkAddress nor ieeeAddr");
                    }

                    break;
                }
                case "disconnected": {
                    if (this.coordinator === undefined) {
                        loggerModule.logger.debug(`coordinator link closed: ${event.reason}`, NS);
                        break;
                    }

                    loggerModule.logger.error(`coordinator link lost: ${event.reason}`, NS);
                    this.emit("disconnected");
                    break;
                }
            }
        }

        private onApsFrame(frame: ApsFrame): void {
            if (frame.profileId === Zdo.ZDO_PROFILE_ID && frame.dstEndpoint === Zdo.ZDO_ENDPOINT) {
                this.onZdoFrame(frame);
                return;
            }

            if (frame.linkquality === null) {
                loggerModule.logger.error(
                    `Dropping ZCL frame cluster=${hex16(frame.clusterId)} from ${hex16(frame.srcNwk)}: native frame carries no linkquality`,
                    NS,
                );
                return;
            }

            const payload: Events.ZclPayload = {
                clusterID: frame.clusterId,
                address: frame.srcIeee === null ? frame.srcNwk : frame.srcIeee,
                header: Zcl.Header.fromBuffer(frame.data),
                data: frame.data,
                endpoint: frame.srcEndpoint,
                linkquality: frame.linkquality,
                groupID: frame.groupId === null ? 0 : frame.groupId,
                wasBroadcast: frame.wasBroadcast,
                destinationEndpoint: frame.dstEndpoint,
            };

            if (payload.header !== undefined) {
                this.zclWaitress.resolve({...payload, header: payload.header});
            }

            this.emit("zclPayload", payload);
        }

        private onZdoFrame(frame: ApsFrame): void {
            const clusterId = frame.clusterId;

            if (clusterId < 0x8000 && clusterId !== Zdo.ClusterId.END_DEVICE_ANNOUNCE) {
                loggerModule.logger.debug(() => `ZDO request ${hex16(clusterId)} from ${hex16(frame.srcNwk)} handled by coordinator`, NS);
                return;
            }

            if (frame.data.length === 0) {
                loggerModule.logger.error(`Dropping empty ZDO frame cluster=${hex16(clusterId)} from ${hex16(frame.srcNwk)}`, NS);
                return;
            }

            let response: ZdoTypes.GenericZdoResponse;

            try {
                response = Zdo.Buffalo.readResponse(this.hasZdoMessageOverhead, clusterId, frame.data);
            } catch (error) {
                loggerModule.logger.error(`Unable to parse ZDO response cluster=${hex16(clusterId)} from ${hex16(frame.srcNwk)}: ${error}`, NS);
                return;
            }

            const eui64 =
                clusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE && Zdo.Buffalo.checkStatus<ZdoNs.ClusterId.NETWORK_ADDRESS_RESPONSE>(response)
                    ? response[1].eui64.toLowerCase()
                    : undefined;

            const answered = this.zdoWaiters.dispatch({
                clusterId,
                srcNwk: frame.srcNwk,
                eui64,
                success: response[0] === Zdo.Status.SUCCESS,
                discriminator: responseDiscriminator(clusterId, response),
                response,
            });

            if (!answered && clusterId === Zdo.ClusterId.PERMIT_JOINING_RESPONSE) {
                loggerModule.logger.debug(`Mgmt_Permit_Joining_rsp from ${hex16(frame.srcNwk)} answered native permitJoin`, NS);
                return;
            }

            // Always emit even when answered so Controller updates its device table.
            this.emit("zdoResponse", clusterId, response);
        }

        private requireCoordinator(): ZsCoordinator {
            if (this.coordinator === undefined) {
                throw new Error("[zerostack-adapter] adapter is not started");
            }

            return this.coordinator;
        }

        private checkInterpanLock(): void {
            if (this.interpanLock) {
                throw new Error("Cannot execute command, in Inter-PAN mode");
            }
        }

        private zdoResponder(responseClusterId: number, ieeeAddress: string, networkAddress: number): ZdoResponder {
            if (responseClusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE) {
                return {kind: "eui64", eui64: ieeeAddress};
            }

            if (ZSpec.Utils.isBroadcastAddress(networkAddress)) {
                return {kind: "any"};
            }

            return {kind: "nwk", networkAddress};
        }

        private readStoredBackup(): Models.Backup | undefined {
            const data = readBackup(this.backupPath);

            if (data === undefined) {
                return undefined;
            }

            if ("adapterType" in data) {
                return BackupUtils.fromLegacyBackup(data);
            }

            if (data.metadata?.format === "zigpy/open-coordinator-backup" && data.metadata?.version) {
                if (data.metadata.version !== 1) {
                    throw new Error(`Unsupported open coordinator backup version (version=${data.metadata.version})`);
                }

                return BackupUtils.fromUnifiedBackup(data);
            }

            throw new Error("Unknown backup format");
        }
    }

    ADAPTER_CLASSES.set(adapterBase, ZsAdapterImpl);

    return ZsAdapterImpl;
}

export const ZsAdapter: ZsAdapterConstructor = createZsAdapterClass(Adapter);

export function createZeroStackAdapter(
    adapterBase: typeof HerdsmanAdapter,
    networkOptions: NetworkOptions,
    transportOptions: TransportOptions,
    backupPath: string,
    adapterOptions: AdapterOptions,
    opener?: CoordinatorOpener,
): ZsAdapter {
    const AdapterClass = createZsAdapterClass(adapterBase);

    return new AdapterClass(networkOptions, transportOptions, backupPath, adapterOptions, opener);
}
