import { existsSync } from "fs"
import path from "path"

type LicenseScope = {
  id: string
  name: string
  status: "active" | "planned"
  spdx: "AGPL-3.0-or-later"
  copyright: string
  licenseFiles: string[]
  paths: string[]
}

type LicenseScopeManifest = {
  schemaVersion: 1
  defaultLicense: {
    spdx: "MIT"
    licenseFile: string
    copyright: string
  }
  scopes: LicenseScope[]
}

export type LicenseScopeIssue = {
  code: string
  path?: string
  message: string
}

export async function checkLicenseScope(root: string) {
  const manifest = parseManifest(await Bun.file(path.join(root, "LICENSE-SCOPE.json")).json())
  const notice = await Bun.file(path.join(root, "NOTICE")).text()
  const allPaths = manifest.scopes.flatMap((scope) => scope.paths)
  const duplicateIssues: LicenseScopeIssue[] =
    new Set(allPaths).size === allPaths.length
      ? []
      : [{ code: "duplicate-path", message: "LICENSE-SCOPE.json contains duplicate covered paths" }]
  const defaultIssues = existsSync(path.join(root, manifest.defaultLicense.licenseFile))
    ? []
    : [
        {
          code: "missing-default-license",
          path: manifest.defaultLicense.licenseFile,
          message: `Default MIT license file is missing: ${manifest.defaultLicense.licenseFile}`,
        },
      ]
  const scopeIssues = manifest.scopes.flatMap((scope) => {
    const unsafePaths = [...scope.licenseFiles, ...scope.paths].filter(
      (file) => path.isAbsolute(file) || file.split("/").includes(".."),
    )
    const noticeValues = [scope.name, scope.spdx, scope.copyright, ...scope.licenseFiles, ...scope.paths]
    return [
      ...unsafePaths.map((file) => ({
        code: "unsafe-path",
        path: file,
        message: `License scope path must be repository-relative: ${file}`,
      })),
      ...scope.licenseFiles
        .filter((file) => !existsSync(path.join(root, file)))
        .map((file) => ({
          code: "missing-license-file",
          path: file,
          message: `License text is missing: ${file}`,
        })),
      ...noticeValues
        .filter((value) => !notice.includes(value))
        .map((value) => ({
          code: "notice-missing-value",
          path: value,
          message: `NOTICE does not contain license scope value: ${value}`,
        })),
      ...(scope.status === "active"
        ? scope.paths
            .filter((file) => !existsSync(path.join(root, file)))
            .map((file) => ({
              code: "missing-active-path",
              path: file,
              message: `Active AGPL path is missing: ${file}`,
            }))
        : []),
    ]
  })
  const sourceIssues = (
    await Promise.all(
      manifest.scopes
        .filter((scope) => scope.status === "active")
        .flatMap((scope) => scope.paths.map((file) => sourceFiles(root, file)))
        .map(async (files) =>
          Promise.all(
            (await files).map(async (file) => {
              const header = (await Bun.file(file).text()).split("\n").slice(0, 8).join("\n")
              const display = path.relative(root, file).split(path.sep).join("/")
              return [
                ...(!header.includes("SPDX-FileCopyrightText: 2026 LeXwDeX")
                  ? [
                      {
                        code: "missing-spdx-copyright",
                        path: display,
                        message: `AGPL source is missing its SPDX copyright header: ${display}`,
                      },
                    ]
                  : []),
                ...(!header.includes("SPDX-License-Identifier: AGPL-3.0-or-later")
                  ? [
                      {
                        code: "missing-spdx-license",
                        path: display,
                        message: `AGPL source is missing its SPDX license header: ${display}`,
                      },
                    ]
                  : []),
              ]
            }),
          ),
        ),
    )
  ).flat(2)

  return [...duplicateIssues, ...defaultIssues, ...scopeIssues, ...sourceIssues]
}

async function sourceFiles(root: string, file: string) {
  const target = path.join(root, file)
  if (!file.endsWith("/")) return /\.tsx?$/.test(file) && existsSync(target) ? [target] : []
  if (!existsSync(target)) return []
  return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: target, absolute: true, onlyFiles: true }))).filter(
    (entry) => /\.tsx?$/.test(entry),
  )
}

function parseManifest(value: unknown): LicenseScopeManifest {
  const manifest = record(value, "license scope manifest")
  if (manifest.schemaVersion !== 1) throw new Error("LICENSE-SCOPE.json schemaVersion must be 1")
  const defaultLicense = record(manifest.defaultLicense, "defaultLicense")
  if (defaultLicense.spdx !== "MIT") throw new Error("The default repository license must remain MIT")
  if (!Array.isArray(manifest.scopes)) throw new Error("LICENSE-SCOPE.json scopes must be an array")

  return {
    schemaVersion: 1,
    defaultLicense: {
      spdx: "MIT",
      licenseFile: string(defaultLicense.licenseFile, "defaultLicense.licenseFile"),
      copyright: string(defaultLicense.copyright, "defaultLicense.copyright"),
    },
    scopes: manifest.scopes.map((value, index) => {
      const scope = record(value, `scopes[${index}]`)
      if (scope.status !== "active" && scope.status !== "planned") {
        throw new Error(`scopes[${index}].status must be active or planned`)
      }
      if (scope.spdx !== "AGPL-3.0-or-later") {
        throw new Error(`scopes[${index}].spdx must be AGPL-3.0-or-later`)
      }
      return {
        id: string(scope.id, `scopes[${index}].id`),
        name: string(scope.name, `scopes[${index}].name`),
        status: scope.status,
        spdx: "AGPL-3.0-or-later",
        copyright: string(scope.copyright, `scopes[${index}].copyright`),
        licenseFiles: strings(scope.licenseFiles, `scopes[${index}].licenseFiles`),
        paths: strings(scope.paths, `scopes[${index}].paths`),
      }
    }),
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`)
  return value
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`)
  return value
}

function strings(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.length || !value.every(isString)) {
    throw new Error(`${name} must be a non-empty string array`)
  }
  return value.filter(isString)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string" && !!value
}

if (import.meta.main) {
  const issues = await checkLicenseScope(path.join(import.meta.dir, ".."))
  if (issues.length) {
    console.error(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"))
    process.exit(1)
  }
  console.log("License scope check passed")
}
