import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import { checkLicenseScope } from "../../../script/check-license-scope"

const root = path.join(import.meta.dir, "../../..")
const tempRoots: string[] = []
const scopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "planned"]),
  spdx: z.literal("AGPL-3.0-or-later"),
  copyright: z.string().min(1),
  licenseFiles: z.array(z.string().min(1)).min(1),
  paths: z.array(z.string().min(1)).min(1),
})
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  defaultLicense: z.object({
    spdx: z.literal("MIT"),
    licenseFile: z.string().min(1),
    copyright: z.string().min(1),
  }),
  scopes: z.array(scopeSchema).min(1),
})

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("license scope manifest", () => {
  test("uses MIT by default and AGPL only for explicit scopes", async () => {
    const manifest = manifestSchema.parse(await Bun.file(path.join(root, "LICENSE-SCOPE.json")).json())

    expect(existsSync(path.join(root, manifest.defaultLicense.licenseFile))).toBe(true)
    expect(new Set(manifest.scopes.map((scope) => scope.id)).size).toBe(manifest.scopes.length)
    expect(new Set(manifest.scopes.flatMap((scope) => scope.paths)).size).toBe(
      manifest.scopes.flatMap((scope) => scope.paths).length,
    )
  })

  test("keeps NOTICE synchronized with every AGPL scope", async () => {
    const manifest = manifestSchema.parse(await Bun.file(path.join(root, "LICENSE-SCOPE.json")).json())
    const notice = await Bun.file(path.join(root, "NOTICE")).text()

    for (const scope of manifest.scopes) {
      expect(notice).toContain(scope.name)
      expect(notice).toContain(scope.spdx)
      expect(notice).toContain(scope.copyright)
      for (const file of scope.licenseFiles) expect(existsSync(path.join(root, file))).toBe(true)
      for (const file of scope.paths) expect(notice).toContain(file)
    }
  })

  test("accepts the repository license boundary", async () => {
    expect(await checkLicenseScope(root)).toEqual([])
  })

  test("rejects an AGPL source without SPDX headers", async () => {
    const fixture = await createFixture({ header: false, noticePath: true })
    expect((await checkLicenseScope(fixture)).map((issue) => issue.code)).toEqual([
      "missing-spdx-copyright",
      "missing-spdx-license",
    ])
  })

  test("rejects an AGPL path missing from NOTICE", async () => {
    const fixture = await createFixture({ header: true, noticePath: false })
    expect((await checkLicenseScope(fixture)).map((issue) => issue.code)).toEqual(["notice-missing-value"])
  })
})

async function createFixture(input: { header: boolean; noticePath: boolean }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "license-scope-"))
  tempRoots.push(root)
  await mkdir(path.join(root, "src", "module"), { recursive: true })
  const copyright = "Copyright (c) 2026 LeXwDeX"
  await Promise.all([
    Bun.write(path.join(root, "LICENSE"), "MIT\n"),
    Bun.write(path.join(root, "AGPL.txt"), "AGPL-3.0-or-later\n"),
    Bun.write(
      path.join(root, "NOTICE"),
      ["Fixture module", "AGPL-3.0-or-later", copyright, "AGPL.txt", input.noticePath ? "src/module/" : ""].join("\n"),
    ),
    Bun.write(
      path.join(root, "LICENSE-SCOPE.json"),
      JSON.stringify({
        schemaVersion: 1,
        defaultLicense: { spdx: "MIT", licenseFile: "LICENSE", copyright: "Upstream" },
        scopes: [
          {
            id: "fixture-module",
            name: "Fixture module",
            status: "active",
            spdx: "AGPL-3.0-or-later",
            copyright,
            licenseFiles: ["AGPL.txt"],
            paths: ["src/module/"],
          },
        ],
      }),
    ),
    Bun.write(
      path.join(root, "src", "module", "index.ts"),
      input.header
        ? `// SPDX-FileCopyrightText: 2026 LeXwDeX\n// SPDX-License-Identifier: AGPL-3.0-or-later\n`
        : "export const value = true\n",
    ),
  ])
  return root
}
