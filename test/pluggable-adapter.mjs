// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// A prototype of the external-adapter seam proposed for zigbee-herdsman's `Adapter.create`
// (`src/adapter/adapter.ts`, its `default:` branch): an `adapter` setting that names no built-in
// adapter is a module specifier (a package name, an absolute or `./` path, or a `file://` URL); the
// module's `Adapter` export (or its default export) must be a subclass of herdsman's `Adapter` and is
// built with the same four arguments as a built-in adapter.
import {isAbsolute, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {Adapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import {discoverAdapter} from "zigbee-herdsman/dist/adapter/adapterDiscovery.js";

const BUILT_IN = new Set(["zstack", "ember", "deconz", "zigate", "zboss", "zoh", "ezsp"]);

export function isExternalAdapter(adapter) {
    return typeof adapter === "string" && !BUILT_IN.has(adapter);
}

/** The specifier `import()` takes: a file URL for paths, the package name as given otherwise. */
export function externalAdapterSpecifier(adapter) {
    if (adapter.startsWith("file://")) {
        return adapter;
    }
    if (isAbsolute(adapter) || adapter.startsWith("./") || adapter.startsWith("../")) {
        return pathToFileURL(resolve(adapter)).href;
    }
    return adapter;
}

export async function loadExternalAdapter(adapter) {
    const module = await import(externalAdapterSpecifier(adapter));
    const External = module.Adapter ?? module.default;
    if (typeof External !== "function" || !(External.prototype instanceof Adapter)) {
        throw new Error(`Adapter '${adapter}' does not export a zigbee-herdsman Adapter subclass as 'Adapter' or as its default export`);
    }
    return External;
}

/** Wraps `Adapter.create` as the proposed `default:` branch would extend it. */
export function installPluggableAdapters() {
    const original = Adapter.create;
    Adapter.create = async (networkOptions, transportOptions, backupPath, adapterOptions) => {
        if (!isExternalAdapter(transportOptions.adapter)) {
            return await original.call(Adapter, networkOptions, transportOptions, backupPath, adapterOptions);
        }
        const discovered = await discoverAdapter(transportOptions.adapter, transportOptions.path);
        transportOptions.adapter = discovered.adapter;
        transportOptions.path = discovered.path;
        const External = await loadExternalAdapter(discovered.adapter);
        return new External(networkOptions, transportOptions, backupPath, adapterOptions);
    };
}
