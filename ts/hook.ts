// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

// TODO(post-upstream-merge): strip ./register shim once zigbee-herdsman merges native zerostack adapter
import {loadNativeCoordinator} from "./native.js";
import {register} from "./register.js";

register(() => loadNativeCoordinator());
