// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// The built package: no ESM import of zigbee-herdsman (it is loaded with require() from the host,
// ts/herdsman.ts) and no source maps (their sources are not packed). Run `npm run build` first.
import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "node:test";
import {fileURLToPath} from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));

test("dist/ imports zigbee-herdsman nowhere", () => {
    const imports = readdirSync(DIST)
        .filter((file) => file.endsWith(".js"))
        .flatMap((file) =>
            [...readFileSync(join(DIST, file), "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']zigbee-herdsman[^"']*["']/g)].map(
                (match) => `${file}: ${match[0]}`,
            ),
        );
    assert.deepEqual(imports, []);
});

test("dist/ carries no source maps", () => {
    assert.deepEqual(
        readdirSync(DIST).filter((file) => file.endsWith(".map")),
        [],
    );
});
