// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// TODO(post-upstream-merge): strip ./register shim once zigbee-herdsman merges native zerostack adapter
import type {Adapter as HerdsmanAdapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import {ZsAdapter} from "./adapter.js";
import {Adapter} from "./herdsman.js";
import type {CoordinatorOpener} from "./native.js";
import {isZsPath, parseZsPath} from "./path.js";

type AdapterClass = typeof HerdsmanAdapter;
type Create = AdapterClass["create"];

const PATCHED = Symbol.for("@smlight/zerostack-adapter/Adapter.create");

export interface Registration {
    unregister(): void;
}

let active: {adapter: AdapterClass; original: Create; patched: Create; registration: Registration} | undefined;

export function register(provideOpener: () => CoordinatorOpener): Registration {
    const adapter: AdapterClass = Adapter;

    if (active !== undefined && active.adapter === adapter && adapter.create === active.patched) {
        return active.registration;
    }

    if (Reflect.has(adapter.create, PATCHED)) {
        return {
            unregister: (): void => {
                throw new Error("[zerostack-adapter] Adapter.create was patched by another copy of zerostack-adapter; unregister through that copy");
            },
        };
    }

    const original = adapter.create;
    const patched: Create = async (networkOptions, transportOptions, backupPath, adapterOptions) => {
        if (!isZsPath(transportOptions.path)) {
            return await original.call(adapter, networkOptions, transportOptions, backupPath, adapterOptions);
        }

        // Reject a bad transport before loading the addon.
        parseZsPath(transportOptions.path);
        const opener = provideOpener();

        return new ZsAdapter(networkOptions, transportOptions, backupPath, adapterOptions, opener);
    };
    Object.defineProperty(patched, PATCHED, {value: true});

    const registration: Registration = {
        unregister: (): void => {
            if (active === undefined || adapter.create !== patched) {
                throw new Error("[zerostack-adapter] zigbee-herdsman Adapter.create is not patched by this registration");
            }

            adapter.create = active.original;
            active = undefined;
        },
    };

    adapter.create = patched;
    active = {adapter, original, patched, registration};

    return registration;
}
