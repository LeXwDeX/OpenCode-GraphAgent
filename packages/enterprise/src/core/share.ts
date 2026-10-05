import { Message, Model, Part, Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import z from "zod"
import { Storage } from "./storage"

function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) {
  return (input: z.infer<T>) => cb(schema.parse(input))
}

export namespace Share {
  export const Info = z.object({
    id: z.string(),
    secret: z.string(),
    sessionID: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const Data = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("session"),
      data: z.custom<Session>(),
    }),
    z.object({
      type: z.literal("message"),
      data: z.custom<Message>(),
    }),
    z.object({
      type: z.literal("part"),
      data: z.custom<Part>(),
    }),
    z.object({
      type: z.literal("session_diff"),
      data: z.custom<SnapshotFileDiff[]>(),
    }),
    z.object({
      type: z.literal("model"),
      data: z.custom<Model[]>(),
    }),
  ])
  export type Data = z.infer<typeof Data>

  type Snapshot = {
    data: Data[]
  }

  type Compaction = {
    event?: string
    data: Data[]
  }

  function key(item: Data) {
    switch (item.type) {
      case "session":
        return "session"
      case "message":
        return `message/${item.data.id}`
      case "part":
        return `part/${item.data.messageID}/${item.data.id}`
      case "session_diff":
        return "session_diff"
      case "model":
        return "model"
      default:
        throw new Error("Unsupported share data type")
    }
  }

  function merge(...items: Data[][]) {
    const map = new Map<string, Data>()
    for (const list of items) {
      for (const item of list) {
        map.set(key(item), item)
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, item]) => item)
  }

  async function readSnapshot(shareID: string) {
    return (await Storage.read<Snapshot>(["share_snapshot", shareID]))?.data
  }

  type State = Info & { version?: 2; data?: Data[]; deleted?: boolean; revision?: string }

  // One durable record orders authorization, data, revocation and recreation.
  // Tombstones are retained so a stale writer cannot recreate a deleted generation.
  async function state(id: string) {
    return Storage.readVersion<State>(["share", id])
  }

  function publicInfo(value: State): Info {
    return { id: value.id, sessionID: value.sessionID, secret: value.secret }
  }

  async function legacy(shareID: string) {
    const snapshot = await readSnapshot(shareID)
    const compaction = (await Storage.read<Compaction>(["share_compaction", shareID])) ?? { data: [] }
    const list = (await Storage.list({ prefix: ["share_event", shareID], before: compaction.event })).toReversed()
    const oldPaths = await Storage.list({ prefix: ["share_data", shareID] })
    const oldData = (
      await Promise.all(
        oldPaths.map(async (path) => {
          const type = path[2]
          if (!["session", "message", "part", "session_diff", "model"].includes(type)) return []
          const data = await Storage.read<unknown>(path)
          return data === undefined ? [] : [Data.parse({ type, data })]
        }),
      )
    ).flat()
    return merge(
      oldData,
      compaction.data,
      (await Promise.all(list.map((event) => Storage.read<Data[]>(event)))).flatMap((x) => x ?? []),
      snapshot ?? [],
    )
  }

  export const create = fn(z.object({ sessionID: z.string() }), async (body) => {
    const isTest = process.env.NODE_ENV === "test" || body.sessionID.startsWith("test_")
    const info: Info = {
      id: (isTest ? "test_" : "") + body.sessionID.slice(-8),
      sessionID: body.sessionID,
      secret: crypto.randomUUID(),
    }
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await state(info.id)
      if (current && !current.value.deleted) throw new Errors.AlreadyExists(info.id)
      if (
        await Storage.compareAndSwap(
          ["share", info.id],
          { ...info, version: 2, data: [], revision: crypto.randomUUID() },
          current?.etag,
        )
      )
        return info
    }
    throw new Errors.Conflict(info.id)
  })

  export async function get(id: string) {
    const current = await state(id)
    return current && !current.value.deleted ? publicInfo(current.value) : undefined
  }

  export const remove = fn(Info.pick({ id: true, secret: true }), async (body) => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await state(body.id)
      if (!current || current.value.deleted) throw new Errors.NotFound(body.id)
      if (current.value.secret !== body.secret) throw new Errors.InvalidSecret(body.id)
      if (
        !(await Storage.compareAndSwap(
          ["share", body.id],
          { version: 2, deleted: true, revision: crypto.randomUUID() },
          current.etag,
        ))
      )
        continue
      // New generations use only the authoritative record, never these legacy objects.
      const groups = await Promise.all([
        Storage.list({ prefix: ["share_event", body.id] }),
        Storage.list({ prefix: ["share_data", body.id] }),
      ])
      await Promise.all([Storage.remove(["share_snapshot", body.id]), Storage.remove(["share_compaction", body.id])])
      for (const item of groups.flat()) await Storage.remove(item)
      return
    }
    throw new Errors.Conflict(body.id)
  })

  export const removeAdmin = fn(Info.pick({ id: true }), async (body) => {
    const share = await get(body.id)
    if (!share) throw new Errors.NotFound(body.id)
    await remove({ id: share.id, secret: share.secret })
  })

  export const sync = fn(
    z.object({ share: Info.pick({ id: true, secret: true }), data: Data.array() }),
    async (input) => {
      for (let attempt = 0; attempt < 64; attempt++) {
        const current = await state(input.share.id)
        if (!current || current.value.deleted) throw new Errors.NotFound(input.share.id)
        if (current.value.secret !== input.share.secret) throw new Errors.InvalidSecret(input.share.id)
        const data = current.value.version === 2 ? (current.value.data ?? []) : await legacy(input.share.id)
        if (
          await Storage.compareAndSwap(
            ["share", input.share.id],
            { ...current.value, version: 2, data: merge(data, input.data), revision: crypto.randomUUID() },
            current.etag,
          )
        )
          return
      }
      throw new Errors.Conflict(input.share.id)
    },
  )

  export async function data(shareID: string) {
    for (let attempt = 0; attempt < 64; attempt++) {
      const current = await state(shareID)
      if (!current || current.value.deleted) throw new Errors.NotFound(shareID)
      if (current.value.version === 2) return current.value.data ?? []
      const data = await legacy(shareID)
      if (
        await Storage.compareAndSwap(
          ["share", shareID],
          { ...current.value, version: 2, data, revision: crypto.randomUUID() },
          current.etag,
        )
      )
        return data
    }
    throw new Errors.Conflict(shareID)
  }

  // Historical callers participate in the same durable generation fence.
  export const syncOld = sync

  export const Errors = {
    Conflict: class extends Error {
      constructor(public id: string) {
        super(`Share update conflict: ${id}`)
      }
    },
    NotFound: class extends Error {
      constructor(public id: string) {
        super(`Share not found: ${id}`)
      }
    },
    InvalidSecret: class extends Error {
      constructor(public id: string) {
        super(`Share secret invalid: ${id}`)
      }
    },
    AlreadyExists: class extends Error {
      constructor(public id: string) {
        super(`Share already exists: ${id}`)
      }
    },
  }
}
