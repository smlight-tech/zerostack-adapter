// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {Backend} from "../native.js";

const BACKEND: Backend = "zs";
const PREFIX = `${BACKEND}:`;
const TRANSPORT_SCHEMES = ["serial:", "tcp://", "tls:"] as const;

export interface ZsTarget {
    backend: Backend;
    transport: string;
}

function hasZsPrefix(path: string): boolean {
    return path.startsWith(PREFIX);
}

export function isZsPath(path: string | undefined): path is string {
    return path !== undefined && hasZsPrefix(path);
}

export function parseZsPath(path: string): ZsTarget {
    if (!hasZsPrefix(path)) {
        throw new Error(`[zerostack-adapter] '${path}' is not a zerostack-adapter path (expected '${PREFIX}<transport>')`);
    }

    const transport = path.slice(PREFIX.length);
    const scheme = TRANSPORT_SCHEMES.find((candidate) => transport.startsWith(candidate));

    if (scheme === undefined || transport.length === scheme.length) {
        throw new Error(
            `[zerostack-adapter] invalid transport '${transport}' in '${path}' (expected ${TRANSPORT_SCHEMES.map((s) => `${s}...`).join(", ")})`,
        );
    }

    return {backend: BACKEND, transport};
}

export function adapterTarget(path: string): ZsTarget {
    if (hasZsPrefix(path)) {
        return parseZsPath(path);
    }

    if (/^(tcp|socket):\/\/[^/]+:\d+$/.test(path)) {
        return {backend: BACKEND, transport: path.replace(/^socket:/, "tcp:")};
    }

    if (path.startsWith("/dev/") || /^(\\\\\.\\)?COM\d+$/i.test(path)) {
        return {backend: BACKEND, transport: `serial:${path}`};
    }

    throw new Error(
        `[zerostack-adapter] '${path}' is neither a zerostack-adapter path ('${PREFIX}<transport>') ` +
            "nor a TCP (tcp://host:port), /dev/ or COM port path",
    );
}
