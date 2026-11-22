// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

export {
    createZeroStackAdapter,
    createZsAdapterClass,
    ZsAdapter as Adapter,
    ZsAdapter as default,
    ZsAdapter,
    type ZsAdapterConstructor,
} from "./adapter.js";
export {fromNativeBackup, toNativeBackup, toNativeNetworkOptions} from "./backup.js";
export {isNativeError, ZsNativeError} from "./errors.js";
export {ADDON_ENV, addonPath, type CoordinatorOpener, loadNativeCoordinator, PACKAGE_ADDON_PATH} from "./native.js";
export {adapterTarget, isZsPath, parseZsPath, type ZsTarget} from "./path.js";
export {type Registration, register} from "./register.js";
