// Runs in a fresh bun process so the real @modelcontextprotocol transports are
// used even when the surrounding test run has mock.module overrides active
// (Bun's module registry is process-global across the suite). Drives
// MCP.Service against the server-stdio fixture: connect a local server that
// spawns a child, disconnect, and report whether the whole process tree was
// reaped (issue #503).
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { MCP } from "../../../src/mcp/index"
import { TestInstance, withTmpdirInstance } from "../../fixture/fixture"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitDead(pid: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (!alive(pid)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

async function waitForPidFile(file: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return parseInt(await fs.readFile(file, "utf8"), 10)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  return undefined
}

const result = await Effect.runPromise(
  withTmpdirInstance({ config: { mcp: {} } })(
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const { directory } = yield* TestInstance
      const childPidFile = path.join(directory, "fixture-child.pid")

      yield* mcp.add("tree-server", {
        type: "local",
        command: [process.execPath, path.join(import.meta.dir, "server-stdio.ts")],
        environment: { MCP_FIXTURE_CHILD_PID_FILE: childPidFile },
      })

      const status = (yield* mcp.status())["tree-server"]
      if (status?.status !== "connected") return { ok: false, stage: "connect", status }

      const client = (yield* mcp.clients())["tree-server"]
      const rootPid = client?.transport instanceof StdioClientTransport ? client.transport.pid : null
      if (typeof rootPid !== "number") return { ok: false, stage: "root-pid" }

      const childPid = yield* Effect.promise(() => waitForPidFile(childPidFile, 5_000))
      if (childPid === undefined) return { ok: false, stage: "child-pid-file", rootPid }

      yield* mcp.disconnect("tree-server")

      return {
        ok: true,
        rootDead: yield* Effect.promise(() => waitDead(rootPid, 10_000)),
        childDead: yield* Effect.promise(() => waitDead(childPid, 10_000)),
        rootPid,
        childPid,
      }
    }),
  ).pipe(Effect.scoped, Effect.provide(MCP.defaultLayer)),
)

console.log(JSON.stringify(result))
if (!result.ok || !result.rootDead || !result.childDead) process.exit(1)
