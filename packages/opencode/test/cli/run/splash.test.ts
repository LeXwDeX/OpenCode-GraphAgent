import { afterEach, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { commandName } from "@/command-name"
import { exitSplash } from "@/cli/cmd/run/splash"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"

const active: TestRenderer[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
})

function claim(renderer: TestRenderer): Array<{ snapshot: { getRealCharBytes(addLineBreaks?: boolean): Uint8Array } }> {
  const queue = Reflect.get(renderer, "externalOutputQueue")
  const commits = queue.claim()
  return commits
}

test("exit splash resume line uses dynamic command name", async () => {
  const out = await createTestRenderer({
    width: 120,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)

  out.renderer.writeToScrollback(
    exitSplash({
      title: "Test session",
      session_id: "sess_abc",
      theme: RUN_THEME_FALLBACK.splash,
    }),
  )

  const commits = claim(out.renderer)
  const decoder = new TextDecoder()
  let text = ""
  for (const commit of commits) {
    text += decoder.decode(commit.snapshot.getRealCharBytes(true))
  }
  expect(text).toContain("sess_abc")
  expect(text).toContain("Test session")
  expect(text).toContain("Continue")
  expect(text).toContain(`${commandName()} --mini -s sess_abc`)
  expect(text).not.toContain("opencode --mini -s sess_abc")
  for (const commit of commits) {
    const snapshot = commit.snapshot as { destroy?: () => void }
    snapshot.destroy?.()
  }
})
