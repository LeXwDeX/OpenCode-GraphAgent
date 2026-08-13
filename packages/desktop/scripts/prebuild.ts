#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"

import { prepareDesktopRuntimeAssets } from "./runtime-assets"
import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

const runtimeAsset = await prepareDesktopRuntimeAssets({
  directory: path.resolve(import.meta.dir, "..", "resources", "runtime-assets"),
  mirrorBaseURL: process.env.OPENCODE_RUNTIME_ASSET_MIRROR,
  publicFallback: process.env.OPENCODE_RUNTIME_ASSET_DISABLE_PUBLIC !== "true",
})
console.log(`[runtime-assets] prepared ${runtimeAsset.id}@${runtimeAsset.version}: ${runtimeAsset.path}`)

await $`cd ../opencode && bun script/build-node.ts`
