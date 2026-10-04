import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/BootstrapRetry"
const project = {
  id: "proj_bootstrap_retry",
  worktree: directory,
  vcs: "git",
  name: "bootstrap-retry",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}
const provider = { all: [], connected: [], default: {} }

for (const newLayoutDesigns of [false, true]) {
  test(`recovers the home page after a global bootstrap failure (${newLayoutDesigns ? "new" : "legacy"} layout)`, async ({
    page,
  }) => {
    await mockOpenCodeServer(page, {
      directory,
      project,
      provider,
      sessions: [],
      pageMessages: () => ({ items: [] }),
    })

    let failedRequests = 0
    let allowRetry = false
    await page.route("**/global/config*", async (route) => {
      failedRequests++
      if (!allowRetry)
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ name: "BootstrapTestError", data: { message: "synthetic global config failure" } }),
        })
      return route.fallback()
    })
    await page.addInitScript((newLayout) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
    }, newLayoutDesigns)

    await page.goto("/")
    await expect.poll(() => failedRequests).toBeGreaterThan(0)
    const alert = page.getByRole("alert")
    await expect(alert).toBeVisible()
    const retry = alert.getByRole("button", { name: "Retry" })
    await expect(retry).toBeEnabled()

    allowRetry = true
    const recoveredConfig = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/global/config" && response.status() === 200,
    )
    await retry.click()
    await recoveredConfig
    await expect(alert).toBeHidden()
  })
}
