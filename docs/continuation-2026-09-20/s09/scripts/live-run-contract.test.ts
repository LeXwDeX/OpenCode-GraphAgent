import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  finishRunSlot,
  initializePrivateRunLedger,
  markRunStarted,
  promptToCompletedIdle,
  ProviderBudgetExceeded,
  ProviderGuardClosed,
  ProviderRequestGuard,
  reserveRunSlot,
} from "./live-run-contract"

const sourcePlan = [
  { run: 13, kind: "one-request-preflight", arm: "enabled", maxProviderRequests: 1 },
  { run: 14, kind: "one-request-preflight", arm: "disabled", maxProviderRequests: 1 },
  { run: 15, kind: "task", task: "T1", arm: "disabled", maxProviderRequests: 12 },
  { run: 16, kind: "task", task: "T1", arm: "enabled", maxProviderRequests: 12 },
  { run: 17, kind: "task", task: "T2", arm: "disabled", maxProviderRequests: 12 },
  { run: 18, kind: "task", task: "T2", arm: "enabled", maxProviderRequests: 12 },
  { run: 19, kind: "task", task: "T3", arm: "disabled", maxProviderRequests: 12 },
  { run: 20, kind: "task", task: "T3", arm: "enabled", maxProviderRequests: 12 },
  { run: 21, kind: "task", task: "T4", arm: "disabled", maxProviderRequests: 12 },
  { run: 22, kind: "task", task: "T4", arm: "enabled", maxProviderRequests: 12 },
] as const

const sha256 = (input: string) => new Bun.CryptoHasher("sha256").update(input).digest("hex")

async function continuationSources(directory: string) {
  const sourceLedgerPath = path.join(directory, "source-ledger.json")
  const run13FailureSummaryPath = path.join(directory, "run13-failure-summary.json")
  const candidate = "a".repeat(40)
  const modelIdentitySha256 = "b".repeat(64)
  const modelConfigSha256 = "c".repeat(64)
  const sourceLedgerRaw = `${JSON.stringify(
    {
      schemaVersion: 3,
      contract: "s09-user-authorized-autonomous-acceptance-22",
      ceilingSessions: 22,
      historicalConsumedSessions: 12,
      retryBudget: 0,
      continuation: {
        sourceLedgerSha256: "d".repeat(64),
        run12FailureSummarySha256: "e".repeat(64),
        sourceSchemaVersion: 2,
        sourceContract: "s09-user-approved-continuation-20",
        sourceCeilingSessions: 20,
        sourceHistoricalConsumedSessions: 10,
        sourceConsumedSessions: 12,
        sourceCandidateCommit: "9".repeat(40),
        sourceModelIdentitySha256: modelIdentitySha256,
        sourceModelConfigSha256: modelConfigSha256,
        sourceContext: 81_920,
        sourceOutputReserve: 4_096,
        consumedRun: 12,
        consumedRunState: "fail",
        consumedRunFailureCode: "stub-run12-fixture-overflow",
      },
      halted: { at: "2026-09-20T00:00:04.000Z", run: 13, reason: "unclassified-live-run-failure" },
      runs: sourcePlan.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              state: "fail",
              lease: "stub-run13-lease",
              reservedAt: "2026-09-20T00:00:00.000Z",
              startedAt: "2026-09-20T00:00:01.000Z",
              finishedAt: "2026-09-20T00:00:04.000Z",
              failureCode: "unclassified-live-run-failure",
            }
          : { ...entry, state: "planned" },
      ),
      updatedAt: "2026-09-20T00:00:04.000Z",
    },
    null,
    2,
  )}\n`
  await writeFile(sourceLedgerPath, sourceLedgerRaw, { mode: 0o600 })
  await writeFile(
    run13FailureSummaryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      candidate,
      classificationPatchCandidate: "4".repeat(40),
      run: 13,
      status: "FAIL",
      consumed: true,
      acceptedM0: false,
      originalLedgerFailureCode: "unclassified-live-run-failure",
      derivedClassification: "provider-upstream-http-503",
      upstream: { actualForwardedRequests: 1, httpStatus: 503, normalCompletion: false },
      guard: { maximum: 1, additionalUpstreamForwards: 0 },
      remainingRuns: [14, 15, 16, 17, 18, 19, 20, 21, 22],
      artifacts: { "continuation-ledger.json": sha256(sourceLedgerRaw) },
    })}\n`,
    { mode: 0o600 },
  )
  return { sourceLedgerPath, run13FailureSummaryPath }
}

async function withTemp<T>(task: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "s09-live-contract-"))
  try {
    return await task(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function rejected(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected promise to reject")
}

describe("S09 live run budget contract", () => {
  test("durably consumes a run slot and fail-stops later fixed-order runs", async () => {
    await withTemp(async (directory) => {
      const ledgerPath = path.join(directory, "ledger.json")
      await initializePrivateRunLedger(ledgerPath, await continuationSources(directory))
      const reservation = await reserveRunSlot(ledgerPath, 14)
      await markRunStarted(ledgerPath, reservation)
      await finishRunSlot(ledgerPath, reservation, { state: "fail", failureCode: "stub-upstream-error" })

      expect(String(await rejected(reserveRunSlot(ledgerPath, 15)))).toContain("model stage is halted")
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8"))
      expect(ledger).toMatchObject({
        schemaVersion: 4,
        contract: "s09-user-authorized-qwen-100req-acceptance-23",
        ceilingSessions: 23,
        historicalConsumedSessions: 13,
        authorizedNewProviderRequestLimit: 100,
        plannedProviderRequestMaximum: 98,
        continuation: {
          sourceSchemaVersion: 3,
          sourceContract: "s09-user-authorized-autonomous-acceptance-22",
          sourceCeilingSessions: 22,
          sourceHistoricalConsumedSessions: 12,
          sourceConsumedSessions: 13,
          consumedRun: 13,
          consumedRunState: "fail",
          consumedRunFailureCode: "unclassified-live-run-failure",
        },
      })
      expect(ledger.runs[0]).toMatchObject({ run: 14, state: "fail", failureCode: "stub-upstream-error" })
      expect(ledger.runs[1]).toMatchObject({ run: 15, state: "planned" })
      expect(ledger.halted).toMatchObject({ run: 14, reason: "stub-upstream-error" })
    })
  })

  test("marks a crash after reservation invalid instead of returning the slot", async () => {
    await withTemp(async (directory) => {
      const ledgerPath = path.join(directory, "ledger.json")
      await initializePrivateRunLedger(ledgerPath, await continuationSources(directory))
      await reserveRunSlot(ledgerPath, 14)

      expect(String(await rejected(reserveRunSlot(ledgerPath, 14)))).toContain("interrupted after reservation")
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8"))
      expect(ledger.runs[0]).toMatchObject({
        run: 14,
        state: "invalid",
        failureCode: "interrupted-after-durable-reservation",
      })
      expect(ledger.halted).toMatchObject({ run: 14 })
    })
  })

  test("refuses to initialize over an existing budget file", async () => {
    await withTemp(async (directory) => {
      const ledgerPath = path.join(directory, "ledger.json")
      await writeFile(ledgerPath, "do-not-overwrite\n", { mode: 0o600 })
      expect(
        String(await rejected(initializePrivateRunLedger(ledgerPath, await continuationSources(directory)))),
      ).toContain("already exists")
      expect(await readFile(ledgerPath, "utf8")).toBe("do-not-overwrite\n")
    })
  })

  test("refuses a continuation when the run13 failure summary does not bind the source ledger", async () => {
    await withTemp(async (directory) => {
      const ledgerPath = path.join(directory, "ledger.json")
      const source = await continuationSources(directory)
      const summary = JSON.parse(await readFile(source.run13FailureSummaryPath, "utf8"))
      summary.artifacts["continuation-ledger.json"] = "0".repeat(64)
      await writeFile(source.run13FailureSummaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 })
      expect(String(await rejected(initializePrivateRunLedger(ledgerPath, source)))).toContain(
        "does not bind the source ledger",
      )
      expect(await Bun.file(ledgerPath).exists()).toBe(false)
    })
  })

  test("refuses continuation evidence that is not owner-only", async () => {
    await withTemp(async (directory) => {
      const ledgerPath = path.join(directory, "ledger.json")
      const source = await continuationSources(directory)
      await chmod(source.run13FailureSummaryPath, 0o644)
      expect(String(await rejected(initializePrivateRunLedger(ledgerPath, source)))).toContain(
        "must be an owner-only regular file",
      )
      expect(await Bun.file(ledgerPath).exists()).toBe(false)
    })
  })

  test("checks the provider cap before forwarding", async () => {
    const guard = new ProviderRequestGuard(1)
    let forwarded = 0
    expect(
      await guard.forward(async () => {
        forwarded++
        return "first"
      }),
    ).toBe("first")

    const error = await rejected(
      guard.forward(async () => {
        forwarded++
        return "second"
      }),
    )
    expect(error).toBeInstanceOf(ProviderBudgetExceeded)
    expect(forwarded).toBe(1)
    expect(guard.count).toBe(1)
    expect(guard.closed).toBe(true)
  })

  test("closing the guard aborts an in-flight upstream", async () => {
    const guard = new ProviderRequestGuard(12)
    let reachedProvider = false
    const pending = guard.forward(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          reachedProvider = true
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    )
    expect(reachedProvider).toBe(true)
    guard.close("stub-fail-stop")
    expect(await rejected(pending)).toBeInstanceOf(ProviderGuardClosed)
    expect(guard.attempts[0]?.outcome).toBe("aborted")
  })
})

describe("S09 live prompt completion contract", () => {
  test("waits for the prompt RPC and idle state instead of pre-existing assistant counts", async () => {
    const guard = new ProviderRequestGuard(12)
    let resolvePrompt: ((value: { info: { role: string; finish: string } }) => void) | undefined
    let settled = false
    const completed = promptToCompletedIdle({
      timeoutMs: 1_000,
      guard,
      prompt: () =>
        new Promise((resolve) => {
          resolvePrompt = resolve
        }),
      status: async () => "idle",
      abortSession: async () => undefined,
      isCompletedAssistant: (result) => result.info.role === "assistant" && result.info.finish === "stop",
    }).finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    resolvePrompt?.({ info: { role: "assistant", finish: "stop" } })
    expect(await completed).toMatchObject({ info: { role: "assistant", finish: "stop" } })
  })

  test("fails closed when the prompt response is not terminal or the session is still busy", async () => {
    const nonterminalGuard = new ProviderRequestGuard(12)
    expect(
      String(
        await rejected(
          promptToCompletedIdle({
            timeoutMs: 1_000,
            guard: nonterminalGuard,
            prompt: async () => ({ info: { role: "assistant", finish: "tool-calls" } }),
            status: async () => "idle",
            abortSession: async () => undefined,
            isCompletedAssistant: (result) => result.info.finish === "stop",
          }),
        ),
      ),
    ).toContain("completed assistant")
    expect(nonterminalGuard.closed).toBe(true)

    const busyGuard = new ProviderRequestGuard(12)
    expect(
      String(
        await rejected(
          promptToCompletedIdle({
            timeoutMs: 1_000,
            guard: busyGuard,
            prompt: async () => ({ info: { role: "assistant", finish: "stop" } }),
            status: async () => "busy",
            abortSession: async () => undefined,
            isCompletedAssistant: (result) => result.info.finish === "stop",
          }),
        ),
      ),
    ).toContain("session is busy")
    expect(busyGuard.closed).toBe(true)
  })

  test("timeout aborts the in-flight provider and asks the host to abort", async () => {
    const guard = new ProviderRequestGuard(12)
    let hostAborts = 0
    const completed = promptToCompletedIdle({
      timeoutMs: 20,
      guard,
      prompt: () =>
        guard.forward(
          (signal) =>
            new Promise<{ info: { role: string; finish: string } }>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            }),
        ),
      status: async () => "busy",
      abortSession: async () => {
        hostAborts++
      },
      isCompletedAssistant: (result) => result.info.finish === "stop",
    })

    await rejected(completed)
    expect(hostAborts).toBe(1)
    expect(guard.closed).toBe(true)
    expect(guard.attempts[0]?.outcome).toBe("aborted")
  })

  test("the deadline also covers hanging status and does not wait for hanging or rejecting abort cleanup", async () => {
    for (const abortSession of [
      () => new Promise<void>(() => undefined),
      async () => {
        throw new Error("stub abort rejected")
      },
    ]) {
      const guard = new ProviderRequestGuard(12)
      const started = Date.now()
      expect(
        String(
          await rejected(
            promptToCompletedIdle({
              timeoutMs: 20,
              guard,
              prompt: async () => ({ info: { role: "assistant", finish: "stop" } }),
              status: () => new Promise(() => undefined),
              abortSession,
              isCompletedAssistant: (result) => result.info.finish === "stop",
            }),
          ),
        ),
      ).toContain("prompt exceeded 20ms")
      expect(Date.now() - started).toBeLessThan(250)
      expect(guard.closed).toBe(true)
    }
  })
})
