// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {
    ApsFrame,
    Broadcast,
    CoordinatorVersion,
    Groupcast,
    NativeBackup,
    NativeError,
    NativeEvent,
    NetworkOptions,
    NetworkParameters,
    OpenOptions,
    StartResult,
    Unicast,
    ZdoSend,
    ZsCoordinator,
} from "../native.js";
import type {CoordinatorOpener} from "../ts/native.js";

export function nativeError(code: NativeError["code"], message: string, status?: number): NativeError {
    const error: NativeError = Object.assign(new Error(message), {code});

    if (status !== undefined) {
        error.status = status;
    }

    return error;
}

export class FakeCoordinator implements ZsCoordinator {
    public onEvent: ((events: NativeEvent[]) => void) | undefined;
    public openOptions: OpenOptions | undefined;
    public started: {network: NetworkOptions; backup: NativeBackup | null} | undefined;
    public stopped = 0;
    public readonly unicasts: Unicast[] = [];
    public readonly groupcasts: Groupcast[] = [];
    public readonly broadcasts: Broadcast[] = [];
    public readonly zdoRequests: ZdoSend[] = [];
    public readonly permitJoins: {seconds: number; networkAddress: number | null}[] = [];
    public readonly interpanChannels: (number | null)[] = [];
    public readonly interpanSends: {ieeeAddr: string | null; data: Buffer}[] = [];
    public duringUnicast: ((frame: Unicast) => void) | undefined;
    public duringZdo: ((request: ZdoSend) => void) | undefined;
    public holdZdo = false;
    private readonly heldZdo: (() => void)[] = [];
    public failNext: Map<string, Error> = new Map();
    public nativeBackup: NativeBackup | undefined;
    public startResult: StartResult = "resumed";
    public versionMeta: Record<string, number | string> = {revision: "20261101", transportrev: 2, zs_nodes: 200};
    public versionCalls = 0;
    public disconnectOnStop = false;

    public opener(): CoordinatorOpener {
        return {
            open: (options, onEvent) => {
                this.openOptions = options;
                this.onEvent = onEvent;

                return Promise.resolve(this);
            },
        };
    }

    public deliver(event: NativeEvent): void {
        this.deliverBatch([event]);
    }

    /** Events the native pump hands over in one onEvent call. */
    public deliverBatch(events: NativeEvent[]): void {
        if (this.onEvent === undefined) {
            throw new Error("fake coordinator not opened");
        }

        this.onEvent(events);
    }

    public deliverAps(frame: Partial<ApsFrame> & Pick<ApsFrame, "srcNwk" | "clusterId" | "data">): void {
        this.deliver({
            kind: "aps",
            frame: {
                srcIeee: null,
                srcEndpoint: 1,
                dstEndpoint: 1,
                profileId: 0x0104,
                groupId: null,
                wasBroadcast: false,
                linkquality: 180,
                rssi: -60,
                ...frame,
            },
        });
    }

    public deliverZdo(srcNwk: number, clusterId: number, data: Buffer): void {
        this.deliverAps({srcNwk, clusterId, data, srcEndpoint: 0, dstEndpoint: 0, profileId: 0});
    }

    private check(operation: string): Promise<void> {
        const error = this.failNext.get(operation);

        if (error !== undefined) {
            this.failNext.delete(operation);

            return Promise.reject(error);
        }

        return Promise.resolve();
    }

    public async start(network: NetworkOptions, backup: NativeBackup | null): Promise<StartResult> {
        await this.check("start");
        this.started = {network, backup};

        return this.startResult;
    }

    public async stop(): Promise<void> {
        await this.check("stop");
        this.stopped += 1;

        if (this.disconnectOnStop) {
            this.deliver({kind: "disconnected", reason: "closed by request"});
        }
    }

    public async reset(): Promise<void> {
        await this.check("reset");
    }

    public async coordinatorIeee(): Promise<string> {
        await this.check("coordinatorIeee");

        return "0x00124b0029a1b2c3";
    }

    public async coordinatorVersion(): Promise<CoordinatorVersion> {
        await this.check("coordinatorVersion");
        this.versionCalls++;

        return {type: "ZeroStack", meta: this.versionMeta};
    }

    public async networkParameters(): Promise<NetworkParameters> {
        await this.check("networkParameters");

        return {panId: 0x1a62, extendedPanId: "0xdddddddddddddddd", channel: 15, nwkUpdateId: 3};
    }

    public supportsBackup(): boolean {
        return true;
    }

    public async backup(): Promise<NativeBackup> {
        await this.check("backup");

        if (this.nativeBackup === undefined) {
            throw nativeError("rejected", "not commissioned");
        }

        return this.nativeBackup;
    }

    public async addInstallCode(): Promise<void> {
        await this.check("addInstallCode");
    }

    public async permitJoin(seconds: number, networkAddress: number | null): Promise<void> {
        await this.check("permitJoin");
        this.permitJoins.push({seconds, networkAddress});
    }

    public async unicast(frame: Unicast): Promise<void> {
        this.unicasts.push(frame);
        this.duringUnicast?.(frame);
        await this.check("unicast");
    }

    public async groupcast(frame: Groupcast): Promise<void> {
        this.groupcasts.push(frame);
        await this.check("groupcast");
    }

    public async broadcast(frame: Broadcast): Promise<void> {
        this.broadcasts.push(frame);
        await this.check("broadcast");
    }

    public async zdo(request: ZdoSend): Promise<void> {
        this.zdoRequests.push(request);
        this.duringZdo?.(request);

        if (this.holdZdo) {
            await new Promise<void>((resolve) => this.heldZdo.push(resolve));
        }

        await this.check("zdo");
    }

    public releaseZdo(): void {
        const release = this.heldZdo.shift();

        if (release === undefined) {
            throw new Error("no held ZDO request");
        }

        release();
    }

    public async interpanChannel(channel: number | null): Promise<void> {
        this.interpanChannels.push(channel);
        await this.check("interpanChannel");
    }

    public async interpanSend(ieeeAddr: string | null, data: Buffer): Promise<void> {
        this.interpanSends.push({ieeeAddr, data});
        await this.check("interpanSend");
    }
}
