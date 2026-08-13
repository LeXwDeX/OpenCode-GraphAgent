#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "path"
import { verifyDesktopRuntimeAssets } from "./runtime-assets"

const directory = path.resolve(import.meta.dir, "..", "resources", "runtime-assets")
const result = await verifyDesktopRuntimeAssets({ directory })
console.log(`[runtime-assets] verified ${result.id}@${result.version}: ${result.path}`)
