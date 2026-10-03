import { expect, mock, test } from "bun:test"

await mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}))
await mock.module("sst", () => ({ Resource: { ADMIN_SECRET: { value: "synthetic-admin-secret" } } }))

const { default: app, SyncServer } = await import("../src/api")

function fixture() {
  const values = new Map<string, unknown>()
  const objects = new Map<string, string>()
  const bucketCalls: string[] = []
  let afterGet: ((key: string) => Promise<void>) | undefined
  let beforePut: (() => Promise<void>) | undefined
  let beforeDelete: (() => Promise<void>) | undefined
  let failDelete = false
  const recordStorage = {
    get: async (key: string) => {
      const value = values.get(key)
      await afterGet?.(key)
      return value
    },
    list: async () => new Map([...values].sort(([left], [right]) => left.localeCompare(right))),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value)
      else for (const [name, content] of Object.entries(key)) values.set(name, content)
    },
    deleteAll: async () => {
      values.clear()
    },
  }
  const storage = {
    ...recordStorage,
    transaction: async <T>(callback: (tx: typeof recordStorage) => Promise<T>) => callback(recordStorage),
  }
  const bucket = {
    put: async (key: string, content: string) => {
      bucketCalls.push(`put:${key}`)
      await beforePut?.()
      objects.set(key, content)
    },
    list: async ({ prefix }: { prefix: string }) => {
      bucketCalls.push(`list:${prefix}`)
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }
    },
    delete: async (keys: string | string[]) => {
      bucketCalls.push("delete")
      await beforeDelete?.()
      if (failDelete) {
        failDelete = false
        throw new Error("R2 unavailable")
      }
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key)
    },
  }
  const state = Object.assign(Object.create(null), { storage, getWebSockets: () => [] })
  const server = new SyncServer(state, Object.assign(Object.create(null), { Bucket: bucket }))
  const bindings = Object.assign(Object.create(null), {
    SYNC_SERVER: { idFromName: (id: string) => id, get: () => server },
    WEB_DOMAIN: "example.test",
  })
  return {
    values,
    objects,
    bucketCalls,
    server,
    bindings,
    pauseSecretRead() {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      afterGet = async (key) => {
        if (key !== "secret") return
        afterGet = undefined
        entered.resolve()
        await release.promise
      }
      return { entered: entered.promise, release: () => release.resolve() }
    },
    pausePut() {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      beforePut = async () => {
        beforePut = undefined
        entered.resolve()
        await release.promise
      }
      return { entered: entered.promise, release: () => release.resolve() }
    },
    pauseDelete() {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      beforeDelete = async () => {
        beforeDelete = undefined
        entered.resolve()
        await release.promise
      }
      return { entered: entered.promise, release: () => release.resolve() }
    },
    failDeleteOnce() {
      failDelete = true
    },
  }
}

async function post(bindings: ReturnType<typeof fixture>["bindings"], route: string, body: Record<string, unknown>) {
  return app.request(
    `http://example.test${route}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    bindings,
  )
}

test("share GET decodes the real Durable Object JSON response and retains ordered parts", async () => {
  const { values, server, bindings } = fixture()
  const sessionID = "ses_test"
  const info = { id: sessionID, title: "Synthetic share" }
  const message = { id: "msg_test", role: "assistant" }
  const first = { id: "part_1", messageID: "msg_test", type: "text", text: "first" }
  const second = { id: "part_2", messageID: "msg_test", type: "text", text: "second" }
  values.set(`session/part/${sessionID}/msg_test/part_2`, second)
  values.set("secret", "synthetic-secret")
  values.set(`session/info/${sessionID}`, info)
  values.set(`session/part/${sessionID}/msg_test/part_1`, first)
  values.set(`session/message/${sessionID}/msg_test`, message)
  const rpc = await server.getData()
  expect(typeof rpc).toBe("string")
  expect(JSON.parse(rpc)).toHaveLength(4)
  const response = await app.request("http://example.test/share_data?id=test", {}, bindings)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(
    JSON.stringify({ info, messages: { msg_test: { parts: [first, second], ...message } } }),
  )
})

test("share GET ignores orphan and malformed records without exposing metadata", async () => {
  const { values, bindings } = fixture()
  values.set("secret", "synthetic-secret")
  values.set("session/part/ses_test/missing/part_1", { messageID: "missing", text: "orphan" })
  values.set("session/message/ses_test/broken", null)
  values.set("session/message/ses_test/no-id", { role: "assistant" })
  const response = await app.request("http://example.test/share_data?id=test", {}, bindings)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(JSON.stringify({ messages: {} }))
})

test("missing share identifiers return a public validation error", async () => {
  const { bindings } = fixture()
  const response = await app.request("http://example.test/share_data", {}, bindings)
  expect(response.status).toBe(400)
})

for (const route of ["/share_delete", "/share_sync"]) {
  test(`${route}: paused old authorization cannot mutate a recreated share`, async () => {
    const f = fixture()
    const sessionID = "session_abcdefgh"
    const secret = await f.server.share(sessionID)
    const gate = f.pauseSecretRead()
    const oldRequest = post(f.bindings, route, {
      sessionID,
      secret,
      key: `session/info/${sessionID}`,
      content: { old: true },
    })
    await gate.entered
    let adminDone = false
    const revoked = post(f.bindings, "/share_delete_admin", {
      sessionShortName: "abcdefgh",
      adminSecret: "synthetic-admin-secret",
    }).then((response) => {
      adminDone = true
      return response
    })
    await Bun.sleep(0)
    const recreated = post(f.bindings, "/share_create", { sessionID })
    try {
      await Bun.sleep(0)
      expect(adminDone).toBe(false)
      expect(f.bucketCalls).toHaveLength(0)
    } finally {
      gate.release()
    }
    expect((await oldRequest).status).toBe(200)
    expect((await revoked).status).toBe(200)
    const newResponse = await recreated
    expect(newResponse.status).toBe(200)
    const next = await newResponse.json()
    if (typeof next !== "object" || next === null || !("secret" in next) || typeof next.secret !== "string")
      throw new Error("Expected a new share secret")
    expect(next.secret).not.toBe(secret)
    const newContent = { title: "new share" }
    expect(
      (
        await post(f.bindings, "/share_sync", {
          sessionID,
          secret: next.secret,
          key: `session/info/${sessionID}`,
          content: newContent,
        })
      ).status,
    ).toBe(200)
    const calls = f.bucketCalls.length
    expect((await post(f.bindings, "/share_delete", { sessionID, secret })).status).not.toBe(200)
    expect(
      (
        await post(f.bindings, "/share_sync", {
          sessionID,
          secret,
          key: `session/info/${sessionID}`,
          content: { stale: true },
        })
      ).status,
    ).not.toBe(200)
    expect(f.values.get("secret")).toBe(next.secret)
    expect(f.values.get(`session/info/${sessionID}`)).toEqual(newContent)
    expect(f.objects.get(`share/session/info/${sessionID}.json`)).toBe(JSON.stringify(newContent))
    expect(f.bucketCalls).toHaveLength(calls)
  })
}

test("R2 publish stays serialized with admin deletion and recreation", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  const gate = f.pausePut()
  const publish = post(f.bindings, "/share_sync", {
    sessionID,
    secret,
    key: `session/info/${sessionID}`,
    content: { old: true },
  })
  await gate.entered
  let adminDone = false
  const revoked = post(f.bindings, "/share_delete_admin", {
    sessionShortName: "abcdefgh",
    adminSecret: "synthetic-admin-secret",
  }).then((response) => {
    adminDone = true
    return response
  })
  await Bun.sleep(0)
  const recreated = post(f.bindings, "/share_create", { sessionID })
  try {
    await Bun.sleep(0)
    expect(adminDone).toBe(false)
  } finally {
    gate.release()
  }
  expect((await publish).status).toBe(200)
  expect((await revoked).status).toBe(200)
  const next = await recreated
  expect(next.status).toBe(200)
  expect(f.values.get(`session/info/${sessionID}`)).toBeUndefined()
  expect(f.objects.has(`share/session/info/${sessionID}.json`)).toBe(false)
})

test("R2 deletion stays serialized with late sync and new create", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  const gate = f.pauseDelete()
  const deleting = post(f.bindings, "/share_delete", { sessionID, secret })
  await gate.entered
  let syncDone = false
  const stale = post(f.bindings, "/share_sync", {
    sessionID,
    secret,
    key: `session/info/${sessionID}`,
    content: { stale: true },
  }).then((response) => {
    syncDone = true
    return response
  })
  const create = post(f.bindings, "/share_create", { sessionID })
  try {
    await Bun.sleep(0)
    expect(syncDone).toBe(false)
  } finally {
    gate.release()
  }
  expect((await deleting).status).toBe(200)
  expect((await stale).status).not.toBe(200)
  expect((await create).status).toBe(200)
  expect(f.objects.size).toBe(0)
})

test("mutations reject missing credentials, session collisions, and admin bypass without touching R2", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  for (const route of ["/share_sync", "/share_delete"]) {
    for (const body of [{ sessionID }, { sessionID: "other_abcdefgh", secret }]) {
      expect(
        (await post(f.bindings, route, { ...body, key: `session/info/${sessionID}`, content: {} })).status,
      ).not.toBe(200)
    }
  }
  expect((await post(f.bindings, "/share_delete_admin", { sessionShortName: "abcdefgh" })).status).not.toBe(200)
  expect(f.bucketCalls).toHaveLength(0)
  expect(f.values.get("secret")).toBe(secret)
})

test("invalid info prefix extension returns 400 without writing", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  const response = await post(f.bindings, "/share_sync", {
    sessionID,
    secret,
    key: `session/info/${sessionID}-other`,
    content: {},
  })
  expect(response.status).toBe(400)
  expect(f.bucketCalls).toHaveLength(0)
})

test("direct mutation RPC calls require authorization even when Hono is bypassed", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  const rejects = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      return false
    } catch {
      return true
    }
  }
  expect(await rejects(() => Reflect.apply(f.server.clear.bind(f.server), undefined, []))).toBe(true)
  expect(
    await rejects(() => Reflect.apply(f.server.publish.bind(f.server), undefined, [`session/info/${sessionID}`, {}])),
  ).toBe(true)
  expect(await rejects(() => Reflect.apply(f.server.clearAdmin.bind(f.server), undefined, []))).toBe(true)
  expect(await rejects(() => f.server.clear("other_abcdefgh", secret))).toBe(true)
  expect(await rejects(() => f.server.clearAdmin("wrong-admin-secret"))).toBe(true)
  expect(f.bucketCalls).toHaveLength(0)
  expect(f.values.get("secret")).toBe(secret)
})

test("R2 cleanup failure retains ownership and releases the queue for retry", async () => {
  const f = fixture()
  const sessionID = "session_abcdefgh"
  const secret = await f.server.share(sessionID)
  f.failDeleteOnce()
  expect((await post(f.bindings, "/share_delete", { sessionID, secret })).status).toBe(500)
  expect(f.values.get("secret")).toBe(secret)
  expect((await post(f.bindings, "/share_create", { sessionID })).status).toBe(409)
  expect((await post(f.bindings, "/share_delete", { sessionID, secret })).status).toBe(200)
  expect(f.values.size).toBe(0)
  expect((await post(f.bindings, "/share_create", { sessionID })).status).toBe(200)
})
