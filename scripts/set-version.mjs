// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function parseVersion(args) {
    if (args.length !== 1) {
        throw new Error("usage: node scripts/set-version.mjs <version>");
    }

    const version = args[0].startsWith("v") ? args[0].slice(1) : args[0];
    if (!SEMVER.test(version)) {
        throw new Error(`invalid SemVer version '${args[0]}' (expected [v]X.Y.Z[-prerelease])`);
    }

    return version;
}

function splitLines(text) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return {eol, lines: text.split(/\r?\n/)};
}

function updatePackageJson(version) {
    const file = join(ROOT, "package.json");
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "string") {
        throw new Error("package.json has no string version");
    }

    const indentMatch = raw.match(/^([ \t]*)"name"\s*:/m);
    if (indentMatch === null) {
        throw new Error("package.json has no top-level name property");
    }

    const versionPattern = new RegExp(`^(${indentMatch[1]}"version"\\s*:\\s*")([^"]*)("(?:,?))$`, "gm");
    const matches = [...raw.matchAll(versionPattern)];
    if (matches.length !== 1) {
        throw new Error(`expected 1 top-level version field in package.json, found ${matches.length}`);
    }

    const updated = raw.replace(versionPattern, `$1${version}$3`);
    const verify = JSON.parse(updated);
    if (verify.version !== version) {
        throw new Error(`package.json version verification failed: got '${verify.version}'`);
    }

    writeFileSync(file, updated, "utf8");
}

function updatePackageLock(version) {
    const file = join(ROOT, "package-lock.json");
    const raw = readFileSync(file, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const parsed = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "string") {
        throw new Error("package-lock.json has no top-level version");
    }
    if (typeof parsed.packages?.[""]?.version !== "string") {
        throw new Error('package-lock.json has no packages[""].version');
    }

    parsed.version = version;
    parsed.packages[""].version = version;

    const trailing = raw.endsWith("\n") ? eol : "";
    const formatted = JSON.stringify(parsed, null, 4).replaceAll("\n", eol) + trailing;
    writeFileSync(file, formatted, "utf8");
}

function updateCargoToml(version) {
    const file = join(ROOT, "Cargo.toml");
    const raw = readFileSync(file, "utf8");
    const {eol, lines} = splitLines(raw);

    let inPackage = false;
    let packageSections = 0;
    let packageName;
    let versionLine = -1;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*\[package\]\s*(?:#.*)?$/.test(line)) {
            inPackage = true;
            packageSections += 1;
            continue;
        }
        if (/^\s*\[/.test(line)) {
            inPackage = false;
            continue;
        }
        if (!inPackage) {
            continue;
        }

        const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
        if (nameMatch !== null) {
            if (packageName !== undefined) {
                throw new Error("Cargo.toml [package] has multiple name lines");
            }
            packageName = nameMatch[1];
        }

        if (/^\s*version\s*=\s*"[^"]+"\s*(?:#.*)?$/.test(line)) {
            if (versionLine !== -1) {
                throw new Error("Cargo.toml [package] has multiple version lines");
            }
            versionLine = i;
        }
    }

    if (packageSections !== 1 || packageName === undefined || versionLine === -1) {
        throw new Error("Cargo.toml must contain a single [package] section with name and version");
    }

    lines[versionLine] = lines[versionLine].replace(/(^\s*version\s*=\s*")([^"]+)(")/, `$1${version}$3`);
    writeFileSync(file, lines.join(eol), "utf8");
    return packageName;
}

function updateCargoLock(packageName, version) {
    const file = join(ROOT, "Cargo.lock");
    const raw = readFileSync(file, "utf8");
    const {eol, lines} = splitLines(raw);

    const stanzas = [];
    let current = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*\[\[package\]\]\s*(?:#.*)?$/.test(line)) {
            current = {name: undefined, hasSource: false, versionLines: []};
            stanzas.push(current);
            continue;
        }
        if (/^\s*\[/.test(line)) {
            current = null;
            continue;
        }
        if (current === null) {
            continue;
        }

        const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
        if (nameMatch !== null) {
            current.name = nameMatch[1];
        }
        if (/^\s*source\s*=/.test(line)) {
            current.hasSource = true;
        }
        if (/^\s*version\s*=\s*"[^"]+"\s*(?:#.*)?$/.test(line)) {
            current.versionLines.push(i);
        }
    }

    const matching = stanzas.filter((stanza) => stanza.name === packageName && !stanza.hasSource);
    if (matching.length !== 1) {
        throw new Error(`expected 1 local [[package]] stanza named '${packageName}' in Cargo.lock, found ${matching.length}`);
    }

    const target = matching[0];
    if (target.versionLines.length !== 1) {
        throw new Error(`expected 1 version line in Cargo.lock stanza '${packageName}', found ${target.versionLines.length}`);
    }

    const idx = target.versionLines[0];
    lines[idx] = lines[idx].replace(/(^\s*version\s*=\s*")([^"]+)(")/, `$1${version}$3`);
    writeFileSync(file, lines.join(eol), "utf8");
}

try {
    const version = parseVersion(process.argv.slice(2));
    updatePackageJson(version);
    updatePackageLock(version);
    const cargoPackageName = updateCargoToml(version);
    updateCargoLock(cargoPackageName, version);
    console.log(`Stamped version ${version} in package.json, package-lock.json, Cargo.toml, and Cargo.lock (${cargoPackageName})`);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
}
