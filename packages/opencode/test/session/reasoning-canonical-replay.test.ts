import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { adoptReasoning } from "@/session/reasoning-adoption"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { ProviderTest } from "../fake/provider"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(SessionAutomationLease.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const source = "ORIGINAL canonical reasoning with a stable source identity"
const replacement = "DISTILLED canonical reasoning with the same source identity"
const detail = { type: "reasoning.text", text: source, format: "unknown", index: 0 }
const metadata = { openrouter: { reasoning_details: [detail] } }

it.instance("replays an adopted persistent reasoning object as one coherent pair in the next request", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned canonical replay" })
    const providerID = ProviderV2.ID.make("openrouter")
    const modelID = ModelV2.ID.make("stealth/space-bunny-alpha")
    const firstUserID = MessageID.ascending()
    const assistantID = MessageID.ascending()
    const nextUserID = MessageID.ascending()

    const firstUser: SessionV1.User = {
      id: firstUserID,
      sessionID: chat.id,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID },
    }
    const assistant: SessionV1.Assistant = {
      id: assistantID,
      sessionID: chat.id,
      parentID: firstUserID,
      role: "assistant",
      agent: "build",
      modelID,
      providerID,
      mode: "build",
      path: { cwd: chat.directory, root: chat.directory },
      time: { created: 2, completed: 3 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const part: SessionV1.ReasoningPart = {
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: assistantID,
      type: "reasoning",
      text: source,
      metadata,
      time: { start: 2, end: 3 },
    }
    yield* sessions.updateMessage(firstUser)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: firstUserID,
      type: "text",
      text: "Explain the synthetic ledger",
      time: { start: 1, end: 1 },
    })
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart(part)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: assistantID,
      type: "text",
      text: "Ledger answer",
      time: { start: 3, end: 3 },
    })

    const original = yield* sessions.messages({ sessionID: chat.id })
    expect(
      yield* adoptReasoning({
        sessionID: chat.id,
        sources: original,
        replacements: [{ messageID: assistantID, partID: part.id, before: source, after: replacement }],
      }),
    ).toBe(true)

    yield* sessions.updateMessage({ ...firstUser, id: nextUserID, time: { created: 4 } })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: nextUserID,
      type: "text",
      text: "Continue the same synthetic ledger",
      time: { start: 4, end: 4 },
    })
    const reloaded = yield* sessions.messages({ sessionID: chat.id })
    expect(reloaded).toHaveLength(3)
    const saved = reloaded.flatMap((message) => message.parts).find((item) => item.id === part.id)
    expect(saved).toMatchObject({
      type: "reasoning",
      text: replacement,
      metadata: { openrouter: { reasoning_details: [{ ...detail, text: replacement }] } },
      distillation: { version: 2, originalText: source, originalMetadata: metadata },
    })
    expect(JSON.stringify(reloaded)).not.toContain('"role":"memory"')

    const model = ProviderTest.model({
      id: modelID,
      providerID,
      api: { id: modelID, npm: "@openrouter/ai-sdk-provider", url: "https://openrouter.ai/api/v1" },
    })
    const replay = (enabled: boolean) =>
      MessageV2.toModelMessagesEffect(reloaded, model, { reasoningDistillationEnabled: enabled })
    const reasoning = (messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) =>
      messages
        .flatMap((message) => (message.role !== "assistant" || !Array.isArray(message.content) ? [] : message.content))
        .filter((content) => content.type === "reasoning")

    const enabled = reasoning(yield* replay(true))
    expect(enabled).toHaveLength(1)
    expect(enabled[0]).toMatchObject({
      text: replacement,
      providerOptions: { openrouter: { reasoning_details: [{ ...detail, text: replacement }] } },
    })
    const disabled = reasoning(yield* replay(false))
    expect(disabled).toHaveLength(1)
    expect(disabled[0]).toMatchObject({ text: source, providerOptions: metadata })
    expect((yield* replay(true)).at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Continue the same synthetic ledger" }],
    })
  }),
)
