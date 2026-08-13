// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "path"
import { Effect } from "effect"
import { RuntimeAsset } from "@opencode-ai/core/runtime-asset"
import { RipgrepAsset } from "@opencode-ai/core/runtime-asset/catalog/ripgrep"

export type DesktopRuntimeAssetsInput = {
  readonly directory: string
  readonly platform?: RuntimeAsset.Platform
  readonly mirrorBaseURL?: string
  readonly publicFallback?: boolean
  readonly fetch?: RuntimeAsset.Fetch
}

export async function prepareDesktopRuntimeAssets(input: DesktopRuntimeAssetsInput) {
  const platform = input.platform ?? { os: process.platform, arch: process.arch }
  const runtime = RuntimeAsset.managed({
    platform,
    cacheDirectory: input.directory,
    ...(input.mirrorBaseURL ? { mirrorBaseURL: input.mirrorBaseURL } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  const sources = RuntimeAsset.sources.filter(
    (source) =>
      source === "cache" ||
      (source === "mirror" && !!input.mirrorBaseURL) ||
      (source === "public" && input.publicFallback !== false),
  )
  const result = await Effect.runPromise(runtime.resolve(RipgrepAsset.descriptor, { sources }))
  if (result._tag !== "Available") throw new Error(`required desktop runtime asset is unavailable: ${result.id}`)
  await Bun.write(
    path.join(input.directory, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        assets: [
          {
            id: result.id,
            version: result.version,
            os: platform.os,
            arch: platform.arch,
            path: path.relative(input.directory, result.path).replaceAll("\\", "/"),
            source: result.source,
            sha256: result.sha256,
          },
        ],
      },
      null,
      2,
    ) + "\n",
  )
  return verifyDesktopRuntimeAssets({ directory: input.directory, platform })
}

export async function verifyDesktopRuntimeAssets(input: {
  readonly directory: string
  readonly platform?: RuntimeAsset.Platform
}) {
  const platform = input.platform ?? { os: process.platform, arch: process.arch }
  const runtime = RuntimeAsset.managed({ platform, cacheDirectory: input.directory })
  const result = await Effect.runPromise(
    runtime.resolve(RipgrepAsset.descriptor, {
      sources: ["cache"],
    }),
  )
  if (result._tag !== "Available") throw new Error(`required desktop runtime asset is unavailable: ${result.id}`)
  const executable = Bun.file(result.path)
  if (!(await executable.exists()) || executable.size === 0) {
    throw new Error(`required desktop runtime asset is empty: ${result.path}`)
  }
  const manifestFile = path.join(input.directory, "manifest.json")
  const value: unknown = await Bun.file(manifestFile).json()
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets)) {
    throw new Error(`desktop runtime asset manifest is invalid: ${manifestFile}`)
  }
  const entry = value.assets.find(
    (value) =>
      isRecord(value) &&
      value.id === RipgrepAsset.descriptor.id &&
      value.version === RipgrepAsset.descriptor.version &&
      value.os === platform.os &&
      value.arch === platform.arch,
  )
  if (!entry) throw new Error(`desktop runtime asset manifest is missing ripgrep for ${platform.os}-${platform.arch}`)
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
