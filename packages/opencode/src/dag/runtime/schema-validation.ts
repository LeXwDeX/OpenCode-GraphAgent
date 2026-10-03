// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

declare const OPENCODE_SCHEMA_VALIDATION_WORKER_PATH: string

// Host resource budget, including worker startup and both provider spellings.
// This is independent of the workflow's model deadline.
export const SCHEMA_VALIDATION_BUDGET_MS = 250

export type Validation = { ok: true; payload: unknown } | { ok: false; error: string }

export function validateInWorker(
  schema: Record<string, unknown>,
  payload: unknown,
  signal: AbortSignal,
  budgetMS = SCHEMA_VALIDATION_BUDGET_MS,
  workerTarget?: string | URL,
): Promise<Validation> {
  return new Promise((resolve) => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (result: Validation) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      worker?.terminate()
      resolve(result)
    }
    const cancel = () => finish({ ok: false, error: "schema validation cancelled" })
    if (signal.aborted) return cancel()
    signal.addEventListener("abort", cancel, { once: true })
    timer = setTimeout(
      () => finish({ ok: false, error: `schema validation exceeded its ${budgetMS} ms host resource budget` }),
      budgetMS,
    )
    try {
      const target =
        typeof OPENCODE_SCHEMA_VALIDATION_WORKER_PATH !== "undefined"
          ? OPENCODE_SCHEMA_VALIDATION_WORKER_PATH
          : new URL("./schema-validation-worker.ts", import.meta.url)
      worker = new Worker(workerTarget ?? target)
      worker.onmessage = (event: MessageEvent<Validation>) => finish(event.data)
      worker.onerror = (event) => {
        event.preventDefault()
        finish({ ok: false, error: `schema validation worker failed: ${event.message}` })
      }
      worker.onmessageerror = () => finish({ ok: false, error: "schema validation worker response could not be read" })
      worker.postMessage({ schema, payload })
    } catch (error) {
      finish({ ok: false, error: `schema validation worker failed: ${String(error)}` })
    }
  })
}
