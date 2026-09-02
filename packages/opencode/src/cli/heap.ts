import path from "path"
import * as fs from "fs/promises"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024
// Each snapshot is hundreds of MB and RSS storms re-arm; keep only the newest
// few so repeated snapshots cannot fill the log directory.
const RETAINED_SNAPSHOTS = 2

let timer: Timer | undefined
let lock = false
let armed = true

export function pruneHeapSnapshots(directory: string, keep = RETAINED_SNAPSHOTS) {
  return fs
    .readdir(directory, { withFileTypes: true })
    .then((entries) => {
      const names = entries
        .filter((entry) => entry.isFile() && entry.name.startsWith("heap-") && entry.name.endsWith(".heapsnapshot"))
        .map((entry) => entry.name)
        .sort()
      return Promise.all(
        names.slice(0, Math.max(0, names.length - keep)).map((name) =>
          fs.rm(path.join(directory, name), { force: true }).catch((cause) => {
            console.warn(`opencode: failed to prune heap snapshot ${name}: ${String(cause)}`)
          }),
        ),
      )
    })
    .catch(() => {})
}

export function start() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .catch(() => {})
    await pruneHeapSnapshots(Global.Path.log)

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
