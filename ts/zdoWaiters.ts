// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {GenericZdoResponse} from "zigbee-herdsman/dist/zspec/zdo/definition/tstypes.js";

export type ZdoResponder = {kind: "nwk"; networkAddress: number} | {kind: "eui64"; eui64: string} | {kind: "any"};

export interface ZdoExpectation {
    clusterId: number;
    responder: ZdoResponder;
    discriminator: number | undefined;
}

export interface ZdoIncoming {
    clusterId: number;
    srcNwk: number;
    eui64: string | undefined;
    success: boolean;
    discriminator: number | undefined;
    response: GenericZdoResponse;
}

interface Pending {
    expectation: ZdoExpectation;
    outcome: GenericZdoResponse | undefined;
    settle: ((outcome: {response: GenericZdoResponse} | {error: Error}) => void) | undefined;
    timer: NodeJS.Timeout | undefined;
    closed: Error | undefined;
}

export interface ZdoWait {
    start(timeoutMs: number): Promise<GenericZdoResponse>;
    cancel(): void;
}

function responderKey(responder: ZdoResponder): string {
    switch (responder.kind) {
        case "nwk":
            return `nwk:${responder.networkAddress}`;
        case "eui64":
            return `eui64:${responder.eui64.toLowerCase()}`;
        case "any":
            return "any";
    }
}

function describeResponder(responder: ZdoResponder): string {
    switch (responder.kind) {
        case "nwk":
            return `0x${responder.networkAddress.toString(16).padStart(4, "0")}`;
        case "eui64":
            return responder.eui64;
        case "any":
            return "any responder";
    }
}

function matches(expectation: ZdoExpectation, incoming: ZdoIncoming): boolean {
    if (incoming.clusterId !== expectation.clusterId) {
        return false;
    }

    const responder = expectation.responder;
    const fromResponder =
        responder.kind === "any" ||
        (responder.kind === "nwk" && incoming.srcNwk === responder.networkAddress) ||
        (responder.kind === "eui64" && incoming.eui64 === responder.eui64);

    if (!fromResponder) {
        return false;
    }

    // Failed responses carry no reliable discriminator; match cluster and responder only (so exclusionKey omits discriminator).
    return expectation.discriminator === undefined || !incoming.success || incoming.discriminator === expectation.discriminator;
}

export class ZdoWaiters {
    private readonly pending = new Set<Pending>();
    private readonly turns = new Map<string, Promise<void>>();

    public get size(): number {
        return this.pending.size;
    }

    public static exclusionKey(clusterId: number, responder: ZdoResponder): string {
        return `${clusterId}/${responderKey(responder)}`;
    }

    public async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
        const previous = this.turns.get(key);
        const result = previous === undefined ? run() : previous.then(run);
        // Track ordering only; callers await result directly.
        const turn: Promise<void> = result.then(
            () => this.endTurn(key, turn),
            () => this.endTurn(key, turn),
        );
        this.turns.set(key, turn);

        return await result;
    }

    public register(expectation: ZdoExpectation): ZdoWait {
        const responder = expectation.responder;
        const entry: Pending = {
            expectation: {...expectation, responder: responder.kind === "eui64" ? {kind: "eui64", eui64: responder.eui64.toLowerCase()} : responder},
            outcome: undefined,
            settle: undefined,
            timer: undefined,
            closed: undefined,
        };
        this.pending.add(entry);

        return {
            start: async (timeoutMs) => await this.start(entry, timeoutMs),
            cancel: () => this.release(entry),
        };
    }

    public dispatch(incoming: ZdoIncoming): boolean {
        for (const entry of this.pending) {
            if (!matches(entry.expectation, incoming)) {
                continue;
            }

            const settle = entry.settle;
            this.release(entry);

            if (settle === undefined) {
                entry.outcome = incoming.response;
            } else {
                settle({response: incoming.response});
            }

            return true;
        }

        return false;
    }

    public rejectAll(error: Error): void {
        for (const entry of [...this.pending]) {
            const settle = entry.settle;
            this.release(entry);

            if (settle === undefined) {
                entry.closed = error;
            } else {
                settle({error});
            }
        }
    }

    private async start(entry: Pending, timeoutMs: number): Promise<GenericZdoResponse> {
        if (entry.outcome !== undefined) {
            return entry.outcome;
        }

        if (entry.closed !== undefined) {
            throw entry.closed;
        }

        if (!this.pending.has(entry)) {
            throw new Error("[zerostack-adapter] ZDO wait was cancelled before it started");
        }

        const outcome = await new Promise<{response: GenericZdoResponse} | {error: Error}>((resolve) => {
            entry.settle = resolve;
            entry.timer = setTimeout(() => {
                this.release(entry);
                const {clusterId, discriminator, responder} = entry.expectation;
                const asked = discriminator === undefined ? "" : ` discriminator=${discriminator}`;
                resolve({
                    error: new Error(
                        `[zerostack-adapter] Timeout after ${timeoutMs}ms waiting for ZDO response cluster=0x${clusterId.toString(16).padStart(4, "0")}${asked} ` +
                            `from ${describeResponder(responder)}`,
                    ),
                });
            }, timeoutMs);
        });

        if ("error" in outcome) {
            throw outcome.error;
        }

        return outcome.response;
    }

    private release(entry: Pending): void {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.settle = undefined;
        this.pending.delete(entry);
    }

    private endTurn(key: string, turn: Promise<void>): void {
        if (this.turns.get(key) === turn) {
            this.turns.delete(key);
        }
    }
}
