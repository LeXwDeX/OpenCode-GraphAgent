import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

// Bun module mocks survive test files. Run the real inference fixture in a fresh
// process so Stripe's database/schema doubles cannot replace its Drizzle modules.
test("real inference auth excludes removed users/workspaces and keeps provider credentials server-side", async () => {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./zenCredentialBoundary.fixture.ts", import.meta.url))],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const deadline = setTimeout(() => child.kill(), 10000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  } finally {
    clearTimeout(deadline)
    child.kill()
  }
}, 15000)
