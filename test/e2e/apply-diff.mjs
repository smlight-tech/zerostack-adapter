// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// Applies a unified diff without fuzz: `node apply-diff.mjs <diff> <root> [<path>...]`. Every hunk
// must match its file exactly at the line it names, or nothing is written. With paths, only the
// files of the diff with those `b/` paths are patched, and each named path must be in the diff.
// Lines before the first `--- ` line, and `#` lines between files, are comments.
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const [diffPath, root, ...only] = process.argv.slice(2);
if (diffPath === undefined || root === undefined) {
    throw new Error("usage: apply-diff.mjs <diff> <root> [<path>...]");
}

/** The files of the diff: `{path, hunks: [{start, old, new}]}`. */
function parse(text) {
    const lines = text.split("\n");
    if (lines.at(-1) === "") {
        lines.pop();
    }
    const files = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.startsWith("--- ")) {
            if (files.length !== 0 && line !== "" && !line.startsWith("#")) {
                throw new Error(`line ${i + 1}: expected '--- ' but found '${line}'`);
            }
            i += 1;
            continue;
        }
        const plus = lines[i + 1];
        if (plus === undefined || !plus.startsWith("+++ b/")) {
            throw new Error(`line ${i + 2}: expected '+++ b/<path>'`);
        }
        const file = {path: plus.slice("+++ b/".length), hunks: []};
        i += 2;
        while (i < lines.length && lines[i].startsWith("@@ ")) {
            const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
            if (header === null) {
                throw new Error(`line ${i + 1}: malformed hunk header '${lines[i]}'`);
            }
            const oldCount = header[2] === undefined ? 1 : Number(header[2]);
            const newCount = header[4] === undefined ? 1 : Number(header[4]);
            const hunk = {start: Number(header[1]), old: [], new: []};
            i += 1;
            while (hunk.old.length < oldCount || hunk.new.length < newCount) {
                const body = lines[i];
                if (body === undefined) {
                    throw new Error(`${file.path}: hunk at line ${hunk.start} ends early`);
                }
                const text = body.slice(1);
                if (body.startsWith(" ")) {
                    hunk.old.push(text);
                    hunk.new.push(text);
                } else if (body.startsWith("-")) {
                    hunk.old.push(text);
                } else if (body.startsWith("+")) {
                    hunk.new.push(text);
                } else {
                    throw new Error(`${file.path}: unexpected line '${body}' in the hunk at line ${hunk.start}`);
                }
                i += 1;
            }
            if (hunk.old.length !== oldCount || hunk.new.length !== newCount) {
                throw new Error(`${file.path}: the hunk at line ${hunk.start} does not have the line counts its header names`);
            }
            file.hunks.push(hunk);
        }
        if (file.hunks.length === 0) {
            throw new Error(`${file.path}: no hunks`);
        }
        files.push(file);
    }
    return files;
}

/** The patched text of `original`; throws unless every hunk matches exactly where it says. */
function patch(file, original) {
    const lines = original.split("\n");
    const out = [];
    let next = 0;
    for (const hunk of file.hunks) {
        const at = hunk.old.length === 0 ? hunk.start : hunk.start - 1;
        if (at < next) {
            throw new Error(`${file.path}: hunks at line ${hunk.start} overlap or are out of order`);
        }
        const found = lines.slice(at, at + hunk.old.length);
        if (found.length !== hunk.old.length || found.some((line, k) => line !== hunk.old[k])) {
            throw new Error(`${file.path}: the hunk at line ${hunk.start} does not match the file`);
        }
        out.push(...lines.slice(next, at), ...hunk.new);
        next = at + hunk.old.length;
    }
    out.push(...lines.slice(next));
    return out.join("\n");
}

const files = parse(readFileSync(diffPath, "utf8"));
const missing = only.filter((path) => !files.some((file) => file.path === path));
if (missing.length !== 0) {
    throw new Error(`not in ${diffPath}: ${missing.join(", ")}`);
}
const selected = only.length === 0 ? files : files.filter((file) => only.includes(file.path));
const patched = selected.map((file) => ({file, text: patch(file, readFileSync(join(root, file.path), "utf8"))}));
for (const {file, text} of patched) {
    writeFileSync(join(root, file.path), text);
    console.log(`patched ${join(root, file.path)} (${file.hunks.length} hunks)`);
}
