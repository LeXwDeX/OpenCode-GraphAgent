export * as MemoryStore from "./store"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import { basename, isAbsolute, join, resolve } from "node:path"
import { ulid } from "ulid"
import { parse, stringify } from "yaml"
import { MemoryFile } from "./file"
import { MemorySchema } from "./schema"

const EXCLUDE_RULES = [".opencode/memory.jsonc", ".opencode/memory.json", ".opencode/memory/"] as const
const TOPIC_KEYS = ["schema_version", "id", "name", "summary", "metadata", "items"] as const
const METADATA_KEYS = [
  "categories",
  "status",
  "importance",
  "keywords",
  "related_topics",
  "created_at",
  "updated_at",
  "last_matched_at",
  "match_count",
  "revision",
  "item_count",
] as const
const ITEM_KEYS = ["id", "kind", "content", "rationale", "confirmed_at"] as const

const PROHIBITED_CONTENT = [
  /```|`[^`]+`/,
  /(?:^|\s)(?:~\/|\.\.?\/|\/)[^\s]+/,
  /(?:^|[/\\])(?:src|packages|lib|test|tests|docs?)(?:[/\\]|$)/i,
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|sql|sh|ya?ml|jsonc?|md)(?:\b|$)/i,
  /\b(?:function|class|interface|import|export|const|let|var|return|stack trace|expected|actual)\b/i,
  /\b(?:def|fn|func|struct|enum|async|await|lambda|yield|pass|break|continue|raise|throw|switch|case|catch|public|private|protected|static|void)\b/i,
  /^\s*(?:if|for|while|try|with|match)\b.*:\s*(?:break|continue|pass|return|raise)?/i,
  /^\s*(?:echo|cd|pwd|ls|find|grep|rg|cat|head|tail|cp|mv|rm|mkdir|touch|chmod|chown|curl|wget|git|docker|kubectl|sudo)\b/i,
  /^\s*(?:python\d*|node|deno|bun|ruby|perl|php|java|javac|go|rustc|cargo|sh|bash|zsh|fish|pwsh|powershell|cmd|awk|sed|make|cmake|ninja)\b/i,
  /(?:^|\s)--?[A-Za-z][\w-]*\b/,
  /(?:^|\s)(?:\d?>|<)\s*\S|[;&|]/,
  /\b[a-z_$][\w$]*\s*\([^)]*\)/i,
  /(?:^|\s)[a-z_$][\w$]*\s*(?:\+|\*|%|==|!=|<=|>=|\+=|-=|\*=)\s*[a-z0-9_$]+(?:\s|$)/i,
  /(?:^|\s)[a-z_$][\w$]*\s+-\s+[a-z0-9_$]+(?:\s|$)/i,
  /\b(?:select\b.+\bfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index)|alter\s+table|drop\s+(?:table|index))\b/i,
  /^\s*(?:select|insert|update|delete|create|alter|drop|merge|with|pragma)\b/i,
  /\b(?:console\.log|print|printf|system\.out\.println)\s*\(/i,
  /\b[a-z_$][\w$]*\.[a-z_$][\w$]*\b/i,
  /\b[A-Z][A-Za-z0-9]*(?:Service|Controller|Handler|Schema|Interface|API)\b/,
  /=>|[{}<>]|\(\)\s*;|::/,
  /(?:^|\s)[a-z_$][\w$]*\s*=\s*(?!=)/i,
  /\b(?:npm|bun|pnpm|yarn|pip|cargo)\s+(?:add|install|run|test|build)\b/i,
  /\b(?:AGENTS\.md|CLAUDE\.md|README|TODO|roadmap|milestone|sprint|goal|plan|progress|next step)\b/i,
  /\b(?:we|i|you|the team)\s+(?:should|need(?:s)?\s+to|will|plan(?:s)?\s+to|intend(?:s)?\s+to)\b/i,
  /(?:计划|目标|待办|进度|下一步|临时|当前状态|承诺|稍后)/,
  /\b(?:repository|repo|codebase)\s+(?:currently\s+)?(?:uses?|depends?|contains?|has|implements?|imports?|exports?|is\s+(?:built|written))\b/i,
  /\bwe\s+(?:currently\s+)?(?:use|run|depend\s+on|implement|import|export)\b/i,
  /\b(?:frontend|backend|application|app|service|system)\s+(?:currently\s+)?(?:uses?|runs?|depends?|is\s+(?:powered|built|implemented|written))\b/i,
  /\b(?:powers?|backs?|implements?)\s+(?:the\s+)?(?:frontend|backend|application|app|service|system)\b/i,
  /\b[A-Za-z][A-Za-z0-9_.-]*\s+v?\d+(?:\.\d+){0,3}\b/,
  /(?:仓库|代码库)(?:当前|目前)?(?:使用|依赖|包含|拥有|采用|实现|导入|导出)/,
  /\b(?:dependency|dependencies|package version|runtime version|unit test|integration test|test case|log output|stderr|stdout|exit code)\b/i,
  /\b(?:according to|per) (?:the )?(?:docs?|documentation)\b|(?:文档|说明书)(?:中|里)?(?:规定|写明|说明|提到)/i,
  /\b(?:api[_-]?key|secret|password|access[_-]?token|private[_-]?key)\b/i,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /(?:身份证|社会安全号码|银行卡号|信用卡号|家庭住址|手机号)/,
  /(?:病史|病历|诊断|患有|罹患|过敏|血型|基因|生物识别|指纹|面部识别|宗教|民族|种族|性取向|政治立场|收入|工资|财务状况|征信|护照|驾照|出生日期)/,
  /\b(?:medical|diagnos(?:is|ed)|disease|disability|depression|anxiety|religion|race|ethnicity|sexual orientation|political affiliation|biometric|fingerprint|passport|driver'?s license|salary|income|credit score|date of birth)\b/i,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:SSN\s*)?\d{3}-\d{2}-\d{4}\b/i,
  /\b(?:phone|tel(?:ephone)?|mobile)\s*[:：]?\s*\+?[\d(). -]{7,}\b/i,
  /\b\d{3}[-.]\d{3}[-.]\d{4}\b/,
  /https?:\/\//i,
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
] as const

const ITEM_INTENT = {
  preference:
    /^(?:(?:the\s+)?user\s+(?:prefers?|requires?|always|never)|(?:responses?|answers?)\s+(?:must|should|use|avoid)|用户(?:长期)?(?:偏好|要求)|回答(?:保持|使用|避免)|始终|永远|不要)/i,
  decision:
    /^(?:(?:confirmed\s+)?(?:core\s+)?decision\b|(?:we\s+)?(?:decided|adopted|selected|chose)\b|(?:已确认的?)?(?:核心)?(?:决定|决策)[:：]?|(?:长期)?(?:采用|选择|确定))/i,
  term: /(?:\bmeans\b|\brefers to\b|\bis defined as\b|(?:术语|名称).*(?:指|表示|定义)|定义为|称为)/i,
} as const

const DURABLE_CONFIRMATION =
  /(?:\buser\b.*\b(?:confirm(?:ed|s)?|explicit(?:ly)?|long[- ]term|stable|durable)|\b(?:confirm(?:ed|s)?|explicit(?:ly)?)\b.*\buser\b|用户.*(?:确认|明确|长期|稳定)|(?:确认|明确|长期|稳定).*用户)/i

export type Applied = {
  readonly topics: MemorySchema.Topic[]
  readonly changed: string[]
  readonly deleted: string[]
}

type MutableTopic = Types.DeepMutable<MemorySchema.Topic>

export interface Interface {
  readonly readTopics: (worktree: string) => Effect.Effect<MemorySchema.Topic[], FSUtil.Error>
  readonly writeTopics: (worktree: string, applied: Applied) => Effect.Effect<void, FSUtil.Error>
  readonly ensureGitExclude: (worktree: string) => Effect.Effect<void, FSUtil.Error | StoreError>
}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("MemoryStore.Error", {
  message: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service

    const readTopics = Effect.fn("MemoryStore.readTopics")(function* (worktree: string) {
      const directory = topicsDir(worktree)
      if (!(yield* fs.existsSafe(directory))) return []
      const names = (yield* fs.readDirectoryEntries(directory))
        .filter((entry) => entry.type === "file" && entry.name.endsWith(".yaml"))
        .map((entry) => entry.name)
        .sort()
      const topics = yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            const file = join(directory, name)
            const text = yield* fs.readFileString(file)
            const value = yield* Effect.try({
              try: () => parse(text),
              catch: (cause) => new StoreError({ message: `Memory topic YAML parse failed: ${String(cause)}` }),
            })
            const decoded = decodeTopic(value, basename(name, ".yaml"))
            if (decoded) return decoded
            yield* Effect.logWarning("memory topic is invalid — ignoring", { path: file })
            return undefined
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("memory topic read failed — ignoring", { path: name, cause })
                return undefined
              }),
            ),
          ),
        { concurrency: 8 },
      )
      return topics.filter((topic): topic is MemorySchema.Topic => topic !== undefined)
    })

    const writeTopics = Effect.fn("MemoryStore.writeTopics")(function* (worktree: string, applied: Applied) {
      yield* fs.makeDirectory(topicsDir(worktree), { recursive: true })
      const byID = new Map(applied.topics.map((topic) => [topic.id, topic]))
      yield* Effect.forEach(
        applied.changed,
        (id) => {
          const topic = byID.get(id)
          if (!topic) return Effect.void
          return MemoryFile.atomicWrite(fs, join(topicsDir(worktree), `${id}.yaml`), stringify(topic, { lineWidth: 0 }))
        },
        { concurrency: 1, discard: true },
      )
      yield* Effect.forEach(
        applied.deleted,
        (id) => fs.remove(join(topicsDir(worktree), `${id}.yaml`), { force: true }),
        { concurrency: 1, discard: true },
      )
    })

    const ensureGitExclude = Effect.fn("MemoryStore.ensureGitExclude")(function* (worktree: string) {
      const result = yield* git.run(["rev-parse", "--git-path", "info/exclude"], { cwd: worktree })
      if (result.exitCode !== 0) return yield* new StoreError({ message: result.stderr.toString("utf8").trim() })
      const raw = result.text().trim()
      if (!raw) return yield* new StoreError({ message: "Git did not resolve info/exclude" })
      const file = isAbsolute(raw) ? raw : resolve(worktree, raw)
      const current = (yield* fs.readFileStringSafe(file)) ?? ""
      const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()))
      const missing = EXCLUDE_RULES.filter((rule) => !lines.has(rule))
      if (missing.length === 0) return yield* Effect.void
      const prefix = current.length === 0 || current.endsWith("\n") ? current : current + "\n"
      yield* MemoryFile.atomicWrite(fs, file, prefix + missing.join("\n") + "\n")
      return yield* Effect.logDebug("memory Git exclusions installed", { worktree, path: file })
    })

    return Service.of({ readTopics, writeTopics, ensureGitExclude })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Git.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node, Git.node])

export function decodeTopic(value: unknown, expectedID?: string) {
  if (!hasExactKeys(value, TOPIC_KEYS)) return undefined
  if (!hasExactKeys(value.metadata, METADATA_KEYS)) return undefined
  if (!Array.isArray(value.items) || value.items.some((item) => !hasExactKeys(item, ITEM_KEYS))) return undefined
  const decoded = Schema.decodeUnknownOption(MemorySchema.Topic)(value)
  if (Option.isNone(decoded)) return undefined
  const topic = decoded.value
  if (expectedID && topic.id !== expectedID) return undefined
  if (topic.metadata.item_count !== topic.items.length) return undefined
  if (new Set(topic.items.map((item) => item.id)).size !== topic.items.length) return undefined
  if (new Set(topic.metadata.categories).size !== topic.metadata.categories.length) return undefined
  if (topic.metadata.related_topics.includes(topic.id)) return undefined
  if ([topic.name, topic.summary, ...topic.metadata.keywords].some((value) => !isAllowedMemoryText(value)))
    return undefined
  if (topic.items.some((item) => !isAllowedMemoryItem(item))) return undefined
  return topic
}

export function applyActions(input: {
  topics: MemorySchema.Topic[]
  actions: ReadonlyArray<MemorySchema.MaintenanceAction>
  topicLimit: number
  now?: string
  id?: () => string
}): Applied {
  const now = input.now ?? new Date().toISOString()
  const makeID = input.id ?? (() => ulid().toLowerCase())
  const topics = new Map(input.topics.map((topic) => [topic.id, cloneTopic(topic)]))
  const changed = new Set<string>()
  const deleted = new Set<string>()

  for (const action of input.actions) {
    if (action.type === "no_change") continue
    if (action.type === "create_topic") {
      assertSemantic(action.name, action.summary, ...action.keywords)
      assertItem(action.item)
      if (topics.size >= input.topicLimit) throw new StoreError({ message: "Memory topic capacity reached" })
      const id = `topic-${makeID()}`
      const itemID = `item-${makeID()}`
      if (topics.has(id)) throw new StoreError({ message: `Memory topic ID collision: ${id}` })
      const topic: MutableTopic = {
        schema_version: MemorySchema.SCHEMA_VERSION,
        id,
        name: action.name,
        summary: action.summary,
        metadata: {
          categories: unique(action.categories),
          status: "active",
          importance: "core",
          keywords: unique(action.keywords),
          related_topics: validRelated(action.related_topics, id, topics),
          created_at: now,
          updated_at: now,
          last_matched_at: null,
          match_count: 0,
          revision: 1,
          item_count: 1,
        },
        items: [
          {
            id: itemID,
            kind: action.item.kind,
            content: action.item.content,
            rationale: action.item.rationale,
            confirmed_at: now,
          },
        ],
      }
      topics.set(id, topic)
      changed.add(id)
      continue
    }

    const topic = topics.get(action.topic_id)
    if (!topic) throw new StoreError({ message: `Memory topic not found: ${action.topic_id}` })

    if (action.type === "delete_topic") {
      topics.delete(topic.id)
      changed.delete(topic.id)
      deleted.add(topic.id)
      for (const related of topics.values()) {
        if (!related.metadata.related_topics.includes(topic.id)) continue
        related.metadata.related_topics = related.metadata.related_topics.filter((id) => id !== topic.id)
        touch(related, now)
        changed.add(related.id)
      }
      continue
    }

    if (action.type === "upsert_item") {
      assertItem(action.item)
      const index = action.item_id ? topic.items.findIndex((item) => item.id === action.item_id) : -1
      if (action.item_id && index < 0) throw new StoreError({ message: `Memory item not found: ${action.item_id}` })
      const itemID = action.item_id ?? `item-${makeID()}`
      const item = {
        id: itemID,
        kind: action.item.kind,
        content: action.item.content,
        rationale: action.item.rationale,
        confirmed_at: now,
      }
      topic.items = index < 0 ? [...topic.items, item] : topic.items.map((current, i) => (i === index ? item : current))
      touch(topic, now)
      changed.add(topic.id)
      continue
    }

    if (action.type === "delete_item") {
      if (!topic.items.some((item) => item.id === action.item_id))
        throw new StoreError({ message: `Memory item not found: ${action.item_id}` })
      if (topic.items.length === 1) throw new StoreError({ message: "Cannot delete the last item from a topic" })
      topic.items = topic.items.filter((item) => item.id !== action.item_id)
      touch(topic, now)
      changed.add(topic.id)
      continue
    }

    const semantic = [action.name, action.summary, ...(action.keywords ?? [])].filter(
      (value): value is string => value !== undefined,
    )
    assertSemantic(...semantic)
    if (
      action.name === undefined &&
      action.summary === undefined &&
      action.categories === undefined &&
      action.keywords === undefined &&
      action.related_topics === undefined
    )
      throw new StoreError({ message: "Memory topic update is empty" })
    topic.name = action.name ?? topic.name
    topic.summary = action.summary ?? topic.summary
    topic.metadata.categories = action.categories ? unique(action.categories) : topic.metadata.categories
    topic.metadata.keywords = action.keywords ? unique(action.keywords) : topic.metadata.keywords
    topic.metadata.related_topics = action.related_topics
      ? validRelated(action.related_topics, topic.id, topics)
      : topic.metadata.related_topics
    touch(topic, now)
    changed.add(topic.id)
  }

  const result = Array.from(topics.values()).sort((a, b) => a.id.localeCompare(b.id))
  if (result.some((topic) => !decodeTopic(topic, topic.id)))
    throw new StoreError({ message: "Memory actions produced an invalid topic" })
  return {
    topics: result,
    changed: Array.from(changed),
    deleted: Array.from(deleted),
  }
}

export function markMatched(topics: MemorySchema.Topic[], topicIDs: string[], now = new Date().toISOString()): Applied {
  const ids = new Set(topicIDs)
  const changed: string[] = []
  const next = topics.map((topic) => {
    if (!ids.has(topic.id)) return topic
    changed.push(topic.id)
    const updated = cloneTopic(topic)
    updated.metadata.last_matched_at = now
    updated.metadata.match_count += 1
    updated.metadata.revision += 1
    updated.metadata.updated_at = now
    return updated
  })
  return { topics: next, changed, deleted: [] }
}

export function isAllowedMemoryText(value: string) {
  const text = value.trim()
  if (!text || text.length > 1_000) return false
  if (text.includes("\n") || text.includes("\r")) return false
  return !PROHIBITED_CONTENT.some((pattern) => pattern.test(text))
}

export function isAllowedMemoryItem(item: Pick<MemorySchema.TopicItem, "kind" | "content" | "rationale">) {
  if (!isAllowedMemoryText(item.content) || !isAllowedMemoryText(item.rationale)) return false
  const intent = item.content.match(ITEM_INTENT[item.kind])
  if (!intent || !DURABLE_CONFIRMATION.test(item.rationale)) return false
  const payload = item.content
    .slice((intent.index ?? 0) + intent[0].length)
    .replace(/^[\s:：—–-]+/, "")
    .trim()
  return payload.length > 0 && isAllowedMemoryText(payload)
}

export function indexes(topics: MemorySchema.Topic[]) {
  return topics.map(MemorySchema.topicIndex)
}

export function topicsDir(worktree: string) {
  return join(worktree, ".opencode", "memory", "topics")
}

function assertSemantic(...values: string[]) {
  if (values.some((value) => !isAllowedMemoryText(value)))
    throw new StoreError({ message: "Memory action contains prohibited content" })
}

function cloneTopic(topic: MemorySchema.Topic): MutableTopic {
  return {
    schema_version: topic.schema_version,
    id: topic.id,
    name: topic.name,
    summary: topic.summary,
    metadata: {
      categories: [...topic.metadata.categories],
      status: topic.metadata.status,
      importance: topic.metadata.importance,
      keywords: [...topic.metadata.keywords],
      related_topics: [...topic.metadata.related_topics],
      created_at: topic.metadata.created_at,
      updated_at: topic.metadata.updated_at,
      last_matched_at: topic.metadata.last_matched_at,
      match_count: topic.metadata.match_count,
      revision: topic.metadata.revision,
      item_count: topic.metadata.item_count,
    },
    items: topic.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      content: item.content,
      rationale: item.rationale,
      confirmed_at: item.confirmed_at,
    })),
  }
}

function assertItem(item: Pick<MemorySchema.TopicItem, "kind" | "content" | "rationale">) {
  if (!isAllowedMemoryItem(item)) throw new StoreError({ message: "Memory action contains prohibited content" })
}

function touch(topic: MutableTopic, now: string) {
  topic.metadata.updated_at = now
  topic.metadata.revision++
  topic.metadata.item_count = topic.items.length
}

function unique<T>(values: ReadonlyArray<T>) {
  return Array.from(new Set(values))
}

function validRelated(values: ReadonlyArray<string>, self: string, topics: ReadonlyMap<string, MutableTopic>) {
  return unique(values).filter((id) => id !== self && topics.has(id))
}

function hasExactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
