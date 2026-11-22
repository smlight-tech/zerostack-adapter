// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import type {NativeError} from "../native.js";

const NATIVE_ERROR_CODES: ReadonlySet<string> = new Set<NativeError["code"]>([
    "transport",
    "timeout",
    "delivery",
    "rejected",
    "unsupported",
    "invalid",
]);

export function isNativeError(error: unknown): error is NativeError {
    return (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        NATIVE_ERROR_CODES.has(error.code) &&
        (!("status" in error) || error.status === undefined || typeof error.status === "number")
    );
}

export class ZsNativeError extends Error {
    public readonly code: NativeError["code"];
    public readonly status: number | undefined;
    public readonly operation: string;

    public constructor(operation: string, cause: NativeError) {
        const status = cause.status === undefined ? "" : ` status=0x${cause.status.toString(16).padStart(2, "0")}`;
        super(`[zerostack-adapter] ${operation} failed: ${cause.code}${status}: ${cause.message}`, {cause});
        this.name = "ZsNativeError";
        this.code = cause.code;
        this.status = cause.status;
        this.operation = operation;
    }
}

export async function callNative<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (isNativeError(error)) {
            throw new ZsNativeError(operation, error);
        }

        throw error;
    }
}
