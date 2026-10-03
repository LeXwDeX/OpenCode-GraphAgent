import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { copyServerAssets } from "../scripts/server-assets"
import packaging from "../electron-builder.config"
import { buildNodeSchemaWorker, NODE_SCHEMA_WORKER_NAME } from "../../opencode/script/schema-worker-build"

test("desktop copies the mandatory worker beside backend chunks and includes it in ASAR packaging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-schema-assets-"))
  const source = path.join(directory, "node"),
    destination = path.join(directory, "out/main/chunks")
  await mkdir(source)
  await writeFile(path.join(source, NODE_SCHEMA_WORKER_NAME), "worker")
  await writeFile(path.join(source, "parser.wasm"), "wasm")
  await copyServerAssets(source, destination)
  expect(await readFile(path.join(destination, NODE_SCHEMA_WORKER_NAME), "utf8")).toBe("worker")
  expect(await readFile(path.join(destination, "parser.wasm"), "utf8")).toBe("wasm")
  expect(packaging.files).toContain("out/**/*")
})

test("desktop build rejects a missing schema worker rather than shipping a broken backend", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-schema-missing-"))
  const source = path.join(directory, "node")
  await mkdir(source)
  await expect(copyServerAssets(source, path.join(directory, "chunks"))).rejects.toThrow()
})

test("ASAR includes the exact selected worker asset and it executes on native Node", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-schema-asar-"))
  const source = path.join(directory, "node")
  const packaged = path.join(directory, "packaged")
  await buildNodeSchemaWorker(source)
  await copyServerAssets(source, path.join(packaged, "out/main/chunks"))
  const require = createRequire(import.meta.url)
  const asar: {
    createPackage(source: string, destination: string): Promise<void>
    listPackage(archive: string): string[]
    extractFile(archive: string, file: string): Buffer
  } = require(require.resolve("@electron/asar", { paths: [require.resolve("electron-builder")] }))
  const archive = path.join(directory, "app.asar")
  await asar.createPackage(packaged, archive)
  const lookup = path.join("out", "main", "chunks", NODE_SCHEMA_WORKER_NAME)
  expect(asar.listPackage(archive)).toContain(path.join("/", lookup))
  const selected = path.join(directory, NODE_SCHEMA_WORKER_NAME)
  const selectedBytes = asar.extractFile(archive, lookup)
  expect(selectedBytes).toEqual(await readFile(path.join(source, NODE_SCHEMA_WORKER_NAME)))
  await writeFile(selected, selectedBytes)
  const fixture = fileURLToPath(new URL("../../opencode/test/dag/fixture/schema-validation-node.ts", import.meta.url))
  const child = Bun.spawn(["node", fixture, selected], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 5_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ normal: true, deadline: true, cancelled: true })
  } finally {
    clearTimeout(watchdog)
    child.kill()
  }
})
