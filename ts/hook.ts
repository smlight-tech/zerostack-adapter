// SPDX-License-Identifier: MIT
// Copyright (c) 2026 SMLIGHT

import {loadNativeCoordinator} from "./native.js";
import {register} from "./register.js";

register(() => loadNativeCoordinator());
