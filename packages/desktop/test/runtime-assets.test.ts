import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { verifyDesktopRuntimeAssets } from "../scripts/runtime-assets"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("desktop runtime assets", () => {
  test("fails packaging verification when required ripgrep is missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-runtime-assets-"))
    roots.push(directory)

    await expect(
      verifyDesktopRuntimeAssets({
        directory,
        platform: { os: "linux", arch: "x64" },
      }),
    ).rejects.toThrow("Required runtime asset is unavailable: ripgrep@15.1.0")
  })
})
