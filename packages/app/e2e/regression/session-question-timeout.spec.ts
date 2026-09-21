import { mkdir } from "node:fs/promises"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/QuestionTimeout"
const projectID = "proj_question_timeout"
const sessionID = "ses_question_timeout"
const title = "Question timeout browser regression"

type QuestionRequest = {
  id: string
  sessionID: string
  expiresAt: number
  questions: Array<{
    header: string
    question: string
    options: Array<{ label: string; description: string }>
  }>
}

type EventPayload = {
  directory: string
  payload: {
    type: "question.asked" | "question.replied" | "question.timed_out"
    properties: QuestionRequest | { sessionID: string; requestID: string }
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

test("renders timeout lifecycle and cancels it only after real interaction", async ({ page }) => {
  test.setTimeout(60_000)
  const events: EventPayload[] = []
  const pending: QuestionRequest[] = []
  const interactions: string[] = []

  await mockServer(page, pending, events)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(/^\/question\/([^/]+)\/interact$/)
    if (request.method() === "POST" && match?.[1]) interactions.push(match[1])
  })

  const navigation = question("question-navigation", "Navigation does not cancel the timeout", 2_200)
  pending.push(navigation)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  const timeout = dock.locator('[data-slot="question-timeout"]')
  const minimal = dock.getByRole("radio", { name: /Minimal/ })
  const extended = dock.getByRole("radio", { name: /Extended/ })

  await expect(dock.getByText(navigation.questions[0]!.question)).toBeVisible()
  await expect(timeout).toHaveText(/Timeout in \d+s/)
  await extended.hover()
  await minimal.focus()
  await minimal.press("ArrowDown")
  await expect(extended).toBeFocused()
  expect(interactions).toEqual([])
  await expect(timeout).toHaveText("Timeout in 0s", { timeout: 5_000 })
  expect(interactions).toEqual([])
  await screenshot(page, "countdown-navigation")

  pending.splice(0)
  events.push(resolved("question.timed_out", navigation.id))
  await expect(dock).toHaveCount(0)

  const selected = question("question-selection", "Selection permanently cancels the timeout", 1_500)
  events.push(asked(selected))
  await expect(dock.getByText(selected.questions[0]!.question)).toBeVisible()
  await dock.getByRole("radio", { name: /Minimal/ }).click()
  await expect.poll(() => interactions).toContain(selected.id)
  await expect(timeout).toHaveCount(0)
  await page.waitForTimeout(1_800)
  await expect(dock).toBeVisible()
  await expect(timeout).toHaveCount(0)

  events.push(resolved("question.replied", selected.id))
  await expect(dock).toHaveCount(0)

  const custom = question("question-custom", "Custom focus permanently cancels the timeout", 1_500)
  events.push(asked(custom))
  await expect(dock.getByText(custom.questions[0]!.question)).toBeVisible()
  await dock.getByRole("radio", { name: /Type your own answer/ }).click()
  await expect(dock.locator("textarea")).toBeFocused()
  await expect.poll(() => interactions).toContain(custom.id)
  await expect(timeout).toHaveCount(0)
  await page.waitForTimeout(1_800)
  await expect(dock).toBeVisible()
  await expect(timeout).toHaveCount(0)
  await screenshot(page, "interaction-cancelled")

  events.push(resolved("question.replied", custom.id))
  await expect(dock).toHaveCount(0)
})

function question(id: string, text: string, timeoutMs: number, targetSessionID = sessionID): QuestionRequest {
  return {
    id,
    sessionID: targetSessionID,
    expiresAt: Date.now() + timeoutMs,
    questions: [
      {
        header: "Implementation",
        question: text,
        options: [
          { label: "Minimal", description: "Use the smallest correct change" },
          { label: "Extended", description: "Include additional behavior" },
        ],
      },
    ],
  }
}

function asked(request: QuestionRequest): EventPayload {
  return { directory, payload: { type: "question.asked", properties: request } }
}

function resolved(
  type: "question.replied" | "question.timed_out",
  requestID: string,
  targetSessionID = sessionID,
): EventPayload {
  return { directory, payload: { type, properties: { sessionID: targetSessionID, requestID } } }
}

async function screenshot(page: Page, name: string) {
  const root = process.env.OPENCODE_TEST_BROWSER_EVIDENCE_DIR
  if (!root) return
  const dir = path.join(root, "question-timeout")
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true })
}

async function mockServer(page: Page, questions: QuestionRequest[], events: EventPayload[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-timeout",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "question-timeout",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    questions: () => questions,
    events: () => events.splice(0, 1),
    eventRetry: 16,
  })
}
