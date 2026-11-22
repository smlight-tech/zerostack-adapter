// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {Adapter as HostAdapter} from "zigbee-herdsman/dist/adapter/adapter.js";
import {ZsAdapter} from "../ts/adapter.js";
import {Adapter, hostAnchors, hostHerdsmanPath, resolveHerdsman} from "../ts/herdsman.js";

const ADAPTER_MODULE = "zigbee-herdsman/dist/adapter/adapter.js";
const OWN = createRequire(import.meta.url).resolve(ADAPTER_MODULE);

let scratch: string | undefined;

afterEach(() => {
    if (scratch !== undefined) {
        rmSync(scratch, {recursive: true});
        scratch = undefined;
    }
});

/** A directory whose node_modules holds another zigbee-herdsman copy. */
function hostWithOwnCopy(): string {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "zerostack-adapter-host-")));
    const adapterDir = join(scratch, "node_modules", "zigbee-herdsman", "dist", "adapter");
    mkdirSync(adapterDir, {recursive: true});
    writeFileSync(join(scratch, "node_modules", "zigbee-herdsman", "package.json"), '{"name":"zigbee-herdsman","type":"commonjs"}');
    writeFileSync(join(adapterDir, "adapter.js"), "exports.Adapter = class Adapter { static async create() {} };\n");
    return scratch;
}

describe("host zigbee-herdsman resolution", () => {
    it("anchors at the entry script, then the working directory, then this package", () => {
        const app = resolve("/app");
        const srv = resolve("/srv");

        expect(hostAnchors(join(app, "index.js"), app)).toStrictEqual([
            join(app, "index.js"),
            join(app, "package.json"),
            expect.stringMatching(/\/ts\/herdsman\.ts$/),
        ]);
        expect(hostAnchors(join("relative", "index.js"), srv)).toStrictEqual([
            join(srv, "package.json"),
            expect.stringMatching(/\/ts\/herdsman\.ts$/),
        ]);
        expect(hostAnchors(undefined, srv)).toHaveLength(2);
    });

    it("takes the first anchor that resolves the module", () => {
        const host = hostWithOwnCopy();

        expect(resolveHerdsman(ADAPTER_MODULE, [join(host, "index.js"), import.meta.url])).toBe(
            join(host, "node_modules/zigbee-herdsman/dist/adapter/adapter.js"),
        );
    });

    it("resolves zigbee-herdsman from a self-anchored package directory before falling back", () => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "zerostack-adapter-self-")));
        const adapterDir = join(scratch, "dist", "adapter");
        mkdirSync(adapterDir, {recursive: true});
        writeFileSync(join(scratch, "package.json"), '{"name":"zigbee-herdsman","type":"commonjs"}');
        writeFileSync(join(adapterDir, "adapter.js"), "exports.Adapter = class Adapter {};\n");

        expect(resolveHerdsman(ADAPTER_MODULE, [join(scratch, "package.json"), import.meta.url])).toBe(join(adapterDir, "adapter.js"));
    });

    it("falls back to this package when no host anchor resolves zigbee-herdsman", () => {
        scratch = realpathSync(mkdtempSync(join(tmpdir(), "zerostack-adapter-bare-")));

        expect(resolveHerdsman(ADAPTER_MODULE, [join(scratch, "index.js"), join(scratch, "package.json"), import.meta.url])).toBe(OWN);
    });

    it("names every anchor when none resolves the module", () => {
        const bare = realpathSync(mkdtempSync(join(tmpdir(), "zerostack-adapter-bare-")));
        scratch = bare;

        expect(() => resolveHerdsman(ADAPTER_MODULE, [join(bare, "index.js")])).toThrow(`resolves from none of ${join(bare, "index.js")}`);
    });

    it("loads the host's Adapter class, the one ZsAdapter extends and register() patches", () => {
        expect(hostHerdsmanPath(ADAPTER_MODULE)).toBe(OWN);
        expect(Adapter).toBe(HostAdapter);
        expect(ZsAdapter.prototype).toBeInstanceOf(HostAdapter);
    });
});
