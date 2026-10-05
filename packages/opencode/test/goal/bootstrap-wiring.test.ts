import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// The production AppRuntime singleton must not reuse a fixture's noopBootstrap
// through the process-wide layer memoMap. Run both original probes in a fresh
// process so they still exercise production initialization without manual init.
test("Goal production wiring in an isolated process", async () => {
  const fixture = fileURLToPath(new URL("./bootstrap-wiring.fixture.ts", import.meta.url))
  const proc = Bun.spawn([process.execPath, "test", "--timeout", "20000", fixture], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  // Drain both streams immediately so diagnostic output cannot block exit.
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.all([proc.exited, stdout, stderr]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill()
          reject(new Error("Goal production wiring child exceeded its 50 second process bound"))
        }, 50_000)
      }),
    ])
    const [code, out, err] = result
    expect({ code, output: out + err }).toEqual({ code: 0, output: expect.stringContaining("2 pass") })
    expect(out + err).toContain("0 fail")
  } finally {
    clearTimeout(timer)
    proc.kill()
    await proc.exited
    await Promise.all([stdout, stderr])
  }
}, 55_000)
