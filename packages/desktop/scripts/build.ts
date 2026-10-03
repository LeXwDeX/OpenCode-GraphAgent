import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { checkToolchain } from "../../../script/toolchain.mjs"

checkToolchain()

const require = createRequire(import.meta.url)
const manifestPath = require.resolve("electron-vite/package.json")
const manifest: unknown = require(manifestPath)
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("bin" in manifest) ||
  typeof manifest.bin !== "object" ||
  manifest.bin === null ||
  !("electron-vite" in manifest.bin) ||
  typeof manifest.bin["electron-vite"] !== "string" ||
  !manifest.bin["electron-vite"].trim()
) {
  throw new Error("electron-vite package is missing its electron-vite CLI bin")
}
const cli = resolve(dirname(manifestPath), manifest.bin["electron-vite"])

// Rollup parses the bundled backend too; the default 2 GiB heap is insufficient.
// A Node argument keeps this budget local to the build and preserves NODE_OPTIONS.
const child = Bun.spawn(["node", "--max-old-space-size=4096", cli, "build", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await child.exited)
