import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { formatWithOptions } from "node:util"
import { xdgData } from "xdg-basedir"

// Keep this first-import module synchronous. Global has top-level await, which
// lets sibling dependencies emit warnings before console interception is ready.
const directory = path.join(xdgData!, "opencode", "log")
try {
  mkdirSync(directory, { recursive: true })
} catch {}

for (const method of ["log", "info", "debug", "warn", "error"] as const) {
  console[method] = (...args: unknown[]) => {
    try {
      appendFileSync(
        path.join(directory, "opencode.log"),
        `${new Date().toISOString()} level=${method.toUpperCase()} component=tui-worker ${formatWithOptions({ colors: false, depth: 8 }, ...args)}\n`,
      )
    } catch {
      // A failed log sink must never fall back to the renderer's terminal.
    }
  }
}
