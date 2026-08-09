import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Duration, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Git } from "@/git"
import { MemoryConfig } from "@/memory/config"
import { Memory } from "@/memory/memory"
import { MemoryModel } from "@/memory/model"
import { MemorySchema } from "@/memory/schema"
import { MemoryStore } from "@/memory/store"
import { Project } from "@/project/project"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Token } from "@/util/token"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

const config = {
  schema_version: 1,
  enabled: true,
  model: "test/memory-small",
  topic_limit: 10,
  topic_limit_floor: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1_200 },
} satisfies MemorySchema.Config

const now = "2026-08-09T12:00:00Z"
const replacementModel = ProviderTest.model({
  providerID: ProviderV2.ID.make("test"),
  id: ModelV2.ID.make("replacement"),
})
const replacementProvider = ProviderTest.fake({ model: replacementModel })
let writtenGlobalConfig: MemorySchema.Config | undefined
let writtenProjectConfig: MemorySchema.Config | undefined

function topic(id = "architecture-boundaries") {
  return {
    schema_version: 1,
    id,
    name: "架构边界",
    summary: "已确认的核心架构边界",
    metadata: {
      categories: ["decision"],
      status: "active",
      importance: "core",
      keywords: ["架构"],
      related_topics: [],
      created_at: now,
      updated_at: now,
      last_matched_at: null,
      match_count: 0,
      revision: 1,
      item_count: 1,
    },
    items: [
      {
        id: "decision-01",
        kind: "decision",
        content: "已确认决定：核心模块之间使用稳定边界",
        rationale: "该边界由用户确认并长期适用",
        confirmed_at: now,
      },
    ],
  } satisfies MemorySchema.Topic
}

const it = testEffect(
  Layer.mergeAll(Git.defaultLayer, MemoryConfig.defaultLayer, MemoryStore.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const memoryIt = testEffect(Memory.defaultLayer)
const unavailableModelIt = testEffect(
  Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        replacementProvider.layer,
        Layer.mock(Project.Service, {
          get: (id) =>
            Effect.succeed({
              id,
              worktree: "/unused",
              vcs: "git" as const,
              time: { created: 0, updated: 0, initialized: 1 },
              sandboxes: [],
            }),
        }),
        Layer.mock(MemoryConfig.Service, {
          load: (directory) =>
            Effect.succeed({
              config: { ...config, enabled: false, model: "removed/model" },
              path: directory,
              level: "project" as const,
            }),
          loadGlobal: () =>
            Effect.succeed({
              config: { ...config, model: "removed/model" },
              path: "/global/memory.jsonc",
              level: "global" as const,
            }),
          writeGlobal: (next) =>
            Effect.sync(() => {
              writtenGlobalConfig = next
              return true
            }),
          writeProject: (_directory, next) =>
            Effect.sync(() => {
              writtenProjectConfig = next
            }),
        }),
        Layer.mock(MemoryModel.Service, {
          generate: () => Effect.succeed({ model: "test/replacement", topic_limit: 10, turn_interval: 5 }),
        }),
        Layer.mock(MemoryStore.Service, {
          ensureGitExclude: () => Effect.void,
          writeTopics: () => Effect.void,
        }),
      ),
    ),
  ),
)

describe("memory config and YAML store", () => {
  memoryIt.instance(
    "builds the production MEMORY layer without ambient dependencies",
    () =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(typeof memory.prepare).toBe("function")
        expect(typeof memory.checkpoint).toBe("function")
      }),
    { git: true },
  )

  it.live("uses the first existing project config and never falls through when it is invalid", () =>
    Effect.gen(function* () {
      const memoryConfig = yield* MemoryConfig.Service
      const tmp = yield* tmpdirScoped()
      const directory = path.join(tmp, ".opencode")
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.json"), JSON.stringify({ ...config, enabled: true })),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          `// project override\n${JSON.stringify({ ...config, enabled: false })}`,
        ),
      )

      const loaded = yield* memoryConfig.load(tmp)
      expect(loaded?.level).toBe("project")
      expect(loaded?.path).toBe(path.join(directory, "memory.jsonc"))
      expect(loaded?.config.enabled).toBe(false)

      yield* Effect.promise(() => fs.writeFile(path.join(directory, "memory.jsonc"), "{ invalid"))
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()

      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.jsonc"), `${JSON.stringify(config)} trailing-garbage`),
      )
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()

      yield* Effect.promise(() =>
        fs.writeFile(path.join(directory, "memory.jsonc"), JSON.stringify({ ...config, topic_limit_floor: 50 })),
      )
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          JSON.stringify({ ...config, topic_limit: 50, topic_limit_floor: 10 }),
        ),
      )
      expect((yield* memoryConfig.load(tmp))?.config).toMatchObject({ topic_limit: 50, topic_limit_floor: 50 })

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(directory, "memory.jsonc"),
          JSON.stringify({ ...config, topic_limit: 20, topic_limit_floor: 50 }),
        ),
      )
      expect(yield* memoryConfig.load(tmp)).toBeUndefined()
    }),
  )

  it.live("replaces an invalid global winner so a later startup can retry initialization", () =>
    Effect.gen(function* () {
      const memoryConfig = yield* MemoryConfig.Service
      const global = yield* tmpdirScoped()
      const project = yield* tmpdirScoped()
      const previous = process.env.OPENCODE_CONFIG_DIR

      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.OPENCODE_CONFIG_DIR = global
        }),
        () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(global, "memory.jsonc"), "{ invalid"))
            expect(yield* memoryConfig.loadGlobal()).toBeUndefined()
            expect(yield* memoryConfig.writeGlobal(config)).toBe(true)
            expect((yield* memoryConfig.load(project))?.config).toEqual(config)
          }),
        () =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = previous
          }),
      )
    }),
  )

  it.live("round-trips one fixed YAML document per topic and isolates worktrees", () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore.Service
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped()
      const git = yield* Git.Service
      yield* Effect.promise(() => fs.rm(second, { recursive: true, force: true }))
      const added = yield* git.run(["worktree", "add", "-b", "memory-linked", second], { cwd: first })
      expect(added.exitCode).toBe(0)
      const firstTopic = topic("first-worktree")
      const secondTopic = topic("second-worktree")

      yield* store.writeTopics(first, { topics: [firstTopic], changed: [firstTopic.id], deleted: [] })
      yield* store.writeTopics(second, {
        topics: [secondTopic],
        changed: [secondTopic.id],
        deleted: [],
      })

      expect(yield* store.readTopics(first)).toEqual([firstTopic])
      expect(yield* store.readTopics(second)).toEqual([secondTopic])
      expect(MemoryStore.topicsDir(first)).not.toBe(MemoryStore.topicsDir(second))

      const yaml = yield* Effect.promise(() =>
        fs.readFile(path.join(MemoryStore.topicsDir(first), `${firstTopic.id}.yaml`), "utf-8"),
      )
      expect(yaml).toContain("schema_version: 1")
      expect(yaml).toContain("metadata:")
      expect(yaml).toContain("items:")
      expect(MemoryStore.decodeTopic(firstTopic, "wrong-file-id")).toBeUndefined()
      expect(MemoryStore.decodeTopic({ ...firstTopic, extra: "not allowed" })).toBeUndefined()
      expect(
        MemoryStore.decodeTopic({
          ...firstTopic,
          metadata: { ...firstTopic.metadata, item_count: 2 },
        }),
      ).toBeUndefined()
    }),
  )
})

describe("memory controller policy", () => {
  test("owns IDs and metadata and rejects partial or prohibited action batches", () => {
    const ids = ["alpha", "beta"]
    const created = MemoryStore.applyActions({
      topics: [],
      topicLimit: 10,
      now,
      id: () => ids.shift() ?? "unexpected",
      actions: [
        {
          type: "create_topic",
          name: "交互偏好",
          summary: "长期交互偏好",
          categories: ["preference"],
          keywords: ["简洁"],
          related_topics: [],
          item: {
            kind: "preference",
            content: "回答保持简洁中文",
            rationale: "用户长期明确偏好这种表达方式",
          },
        },
      ],
    })

    expect(created.topics[0]).toMatchObject({
      id: "topic-alpha",
      metadata: { created_at: now, updated_at: now, revision: 1, item_count: 1 },
      items: [{ id: "item-beta", confirmed_at: now }],
    })

    const original = structuredClone(created.topics)
    expect(() =>
      MemoryStore.applyActions({
        topics: created.topics,
        topicLimit: 10,
        now,
        actions: [
          { type: "update_topic", topic_id: "topic-alpha", name: "已修改名称" },
          {
            type: "upsert_item",
            topic_id: "topic-alpha",
            item: { kind: "decision", content: "const x = 1", rationale: "下一步执行这个计划" },
          },
        ],
      }),
    ).toThrow("prohibited content")
    expect(created.topics).toEqual(original)

    expect(() =>
      MemoryStore.applyActions({
        topics: created.topics,
        topicLimit: 10,
        actions: [
          {
            type: "upsert_item",
            topic_id: "topic-alpha",
            item_id: "item-not-owned",
            item: { kind: "preference", content: "回答保持简洁中文", rationale: "用户确认这是长期偏好" },
          },
        ],
      }),
    ).toThrow("Memory item not found")
  })

  test("enforces topic capacity and rejects plans, documentation, code, and secrets", () => {
    const topics = Array.from({ length: 10 }, (_, index) => topic(`topic-${index}`))
    expect(() =>
      MemoryStore.applyActions({
        topics,
        topicLimit: 10,
        actions: [
          {
            type: "create_topic",
            name: "额外主题",
            summary: "额外核心主题",
            categories: ["decision"],
            keywords: [],
            related_topics: [],
            item: { kind: "decision", content: "长期采用稳定架构边界", rationale: "用户已经确认" },
          },
        ],
      }),
    ).toThrow("capacity")

    expect(MemoryStore.isAllowedMemoryText("长期回答使用简洁中文")).toBe(true)
    expect(MemoryStore.isAllowedMemoryText("下一步添加缓存")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("文档中规定采用这个方案")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("api_key 是 abc123")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SELECT * FROM users")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SELECT 1")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText('print("hello")')).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("def add(a,b): a+b")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("The repository currently uses React 19")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("代码库目前依赖 React 19")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("credential sk-proj-1234567890abcdef")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("用户患有抑郁症")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("SSN 123-45-6789")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("React 19 powers the frontend")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("while True: break")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("We should add caching")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("We use React")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("Phone: 555-123-4567")).toBe(false)
    expect(MemoryStore.isAllowedMemoryText("xoxb-1234567890-abcdef")).toBe(false)
  })

  test("requires item-kind semantics and explicit durable confirmation", () => {
    const apply = (kind: "preference" | "decision" | "term", content: string, rationale: string) =>
      MemoryStore.applyActions({
        topics: [],
        topicLimit: 10,
        actions: [
          {
            type: "create_topic",
            name: "Stable context",
            summary: "Confirmed durable context",
            categories: [kind],
            keywords: ["stable"],
            related_topics: [],
            item: { kind, content, rationale },
          },
        ],
      })

    expect(() => apply("decision", "Cache responses", "User explicitly confirmed this long-term decision")).toThrow(
      "prohibited content",
    )
    expect(() =>
      apply("decision", "Confirmed decision: while True: break", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: echo hello", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: python -c pass", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: sh -c id", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() =>
      apply("decision", "Confirmed decision: lambda x: x", "User explicitly confirmed this durable decision"),
    ).toThrow("prohibited content")
    expect(() => apply("decision", "Confirmed decision: use stable boundaries", "Temporary experiment")).toThrow(
      "prohibited content",
    )
    expect(MemoryStore.isAllowedMemoryText("User prefers concise answers")).toBe(true)
    expect(MemoryStore.isAllowedMemoryText("User explicitly confirmed this long-term preference")).toBe(true)
    expect(
      MemoryStore.isAllowedMemoryItem({
        kind: "preference",
        content: "User prefers concise answers",
        rationale: "User explicitly confirmed this long-term preference",
      }),
    ).toBe(true)
    expect(() =>
      apply("preference", "User prefers concise answers", "User explicitly confirmed this long-term preference"),
    ).not.toThrow()
    expect(() =>
      apply("decision", "Confirmed decision: use stable boundaries", "User explicitly confirmed this durable decision"),
    ).not.toThrow()
    expect(() =>
      apply("term", "MEMORY means worktree-local durable preferences", "User explicitly confirmed this stable term"),
    ).not.toThrow()
  })

  test("renders only complete fields within the injection budget", () => {
    const first = topic("first-topic")
    const base = topic("second-topic")
    const second = {
      ...base,
      items: [{ ...base.items[0], content: "长期偏好".repeat(180) }],
    } satisfies MemorySchema.Topic
    const rendered = Memory.renderTopics([first, second], {
      ...config,
      injection: { max_topics: 2, max_tokens: 200 },
    })

    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toContain("first-topic")
    expect(rendered[0]).not.toContain("second-topic")
    expect(rendered[0]).toContain("Current user input and higher-priority instructions always win")
    expect(Token.estimate(rendered[0])).toBeLessThanOrEqual(200)
  })
})

describe("memory cadence evidence", () => {
  test("counts only completed real user-to-main-agent turns and removes code evidence", () => {
    const sessionID = SessionID.make("ses_memory_test")
    const providerID = ProviderV2.ID.make("test")
    const modelID = ModelV2.ID.make("test-model")
    const userID = MessageID.ascending()
    const syntheticID = MessageID.ascending()
    const commandID = MessageID.ascending()
    const unfinishedID = MessageID.ascending()
    const messages: SessionV1.WithParts[] = [
      {
        info: {
          id: userID,
          role: "user",
          sessionID,
          time: { created: 1 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: userID,
            sessionID,
            type: "text",
            text: "长期偏好是简洁中文\n```ts\nconst token = 'secret'\n```\n查看 /tmp/output.log",
          },
        ],
      },
      {
        info: assistant(userID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: syntheticID,
          role: "user",
          sessionID,
          time: { created: 2 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: syntheticID,
            sessionID,
            type: "text",
            text: "synthetic continuation",
            synthetic: true,
          },
        ],
      },
      {
        info: assistant(syntheticID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: commandID,
          role: "user",
          sessionID,
          time: { created: 3 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: commandID,
            sessionID,
            type: "text",
            text: "/goal write the docs",
          },
          {
            id: PartID.ascending(),
            messageID: commandID,
            sessionID,
            type: "text",
            text: "目标已设定",
          },
        ],
      },
      {
        info: assistant(commandID, sessionID, providerID, modelID, "end_turn"),
        parts: [],
      },
      {
        info: {
          id: unfinishedID,
          role: "user",
          sessionID,
          time: { created: 4 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: unfinishedID,
            sessionID,
            type: "text",
            text: "尚未完成",
          },
        ],
      },
      {
        info: assistant(unfinishedID, sessionID, providerID, modelID, "tool-calls"),
        parts: [],
      },
    ]

    expect(Memory.completedTurns(messages)).toBe(1)
    expect(Memory.cleanEvidence(messages)).toContain("长期偏好是简洁中文")
    expect(Memory.cleanEvidence(messages)).not.toContain("const token")
    expect(Memory.cleanEvidence(messages)).not.toContain("/tmp/output.log")
    expect(Memory.cleanEvidence(messages)).not.toContain("synthetic continuation")
    expect(Memory.cleanEvidence(messages)).not.toContain("目标已设定")
  })
})

describe("memory Git exclusions", () => {
  it.live("installs exact local exclusions idempotently without touching .gitignore", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const git = yield* Git.Service
      const store = yield* MemoryStore.Service
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, ".gitignore"), "keep-me\n"))

      yield* store.ensureGitExclude(tmp)
      yield* store.ensureGitExclude(tmp)

      const resolved = yield* git.run(["rev-parse", "--git-path", "info/exclude"], { cwd: tmp })
      const raw = resolved.text().trim()
      const exclude = path.isAbsolute(raw) ? raw : path.resolve(tmp, raw)
      const lines = (yield* Effect.promise(() => fs.readFile(exclude, "utf-8"))).split(/\r?\n/)

      for (const rule of [".opencode/memory.jsonc", ".opencode/memory.json", ".opencode/memory/"]) {
        expect(lines.filter((line) => line === rule)).toHaveLength(1)
      }
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp, ".gitignore"), "utf-8"))).toBe("keep-me\n")
    }),
  )
})

describe("memory hidden model", () => {
  it.live("interrupts an unsettled hidden call at the controller deadline", () =>
    Effect.gen(function* () {
      let interrupted = false
      const service = MemoryModel.make({
        execute: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        timeout: Duration.millis(10),
      })

      const exit = yield* service
        .generate({
          model: ProviderTest.model(),
          system: "system",
          prompt: "prompt",
          schema: MemorySchema.MatchResponse,
          maxOutputTokens: 32,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(interrupted).toBe(true)
    }),
  )
})

describe("memory enablement", () => {
  unavailableModelIt.instance(
    "reselects an available model for startup and the only enable command",
    () =>
      Effect.gen(function* () {
        writtenGlobalConfig = undefined
        writtenProjectConfig = undefined
        const memory = yield* Memory.Service
        yield* memory.init()
        expect(writtenGlobalConfig).toMatchObject({ model: "test/replacement" })
        expect(yield* memory.setEnabled(true)).toBe("Memory on")
        expect(writtenProjectConfig).toMatchObject({ enabled: true, model: "test/replacement" })
      }),
    { git: true },
  )
})

function assistant(
  parentID: MessageID,
  sessionID: SessionID,
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  finish: string,
): SessionV1.Assistant {
  return {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID,
    modelID,
    time: { created: 1 },
    finish,
  }
}
