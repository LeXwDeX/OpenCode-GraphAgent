import { expect, spyOn, test } from "bun:test"
import { Share } from "../../src/core/share"
import { Storage } from "../../src/core/storage"

const ownerPath = "../../src/core/share.ts?independent-owner"
const other: typeof Share = (await import(ownerPath)).Share
const message = (id: string): Share.Data => ({
  type: "message",
  data: {
    id,
    sessionID: "fixture",
    role: "user",
    time: { created: 0 },
    agent: "fixture",
    model: { providerID: "fixture", modelID: "fixture" },
  },
})
const dataID = (item: Share.Data | undefined) => (item && "id" in item.data ? item.data.id : undefined)
function stateData(value: unknown): Share.Data[] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return []
  return value.data.map((item) => Share.Data.parse(item))
}
const session = () => `test_${crypto.randomUUID()}`

test("independent owners atomically create one winner and retain concurrent updates", async () => {
  const sessionID = session()
  const results = await Promise.allSettled([Share.create({ sessionID }), other.create({ sessionID })])
  const winners = results.filter((x) => x.status === "fulfilled")
  expect(winners).toHaveLength(1)
  expect(results.find((x) => x.status === "rejected")?.reason.message).toContain("Share already exists")
  const share = winners[0].value
  try {
    await Promise.all([Share.sync({ share, data: [message("a")] }), other.syncOld({ share, data: [message("b")] })])
    expect((await Share.data(share.id)).map((x) => dataID(x))).toEqual(["a", "b"])
    expect(await Share.get(share.id)).toEqual(share)
  } finally {
    await Share.remove(share)
  }
})

test("stale authorized sync cannot cross revocation and recreation", async () => {
  const sessionID = session()
  const share = await Share.create({ sessionID })
  const cas = Storage.compareAndSwap
  let release!: () => void
  let entered!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  let held = false
  const spy = spyOn(Storage, "compareAndSwap").mockImplementation(async (key, value, etag) => {
    if (!held && key[1] === share.id && stateData(value).length) {
      held = true
      entered()
      await wait
    }
    return cas(key, value, etag)
  })
  let next: Share.Info | undefined
  try {
    const pending = other.sync({ share, data: [message("stale")] }).catch((x) => x)
    await blocked
    await Share.remove(share)
    next = await Share.create({ sessionID })
    release()
    expect((await pending).message).toContain("Share secret invalid")
    expect(await Share.data(next.id)).toEqual([])
    await Share.sync({ share: next, data: [message("fresh")] })
    expect((await Share.data(next.id)).map((x) => dataID(x))).toEqual(["fresh"])
  } finally {
    release()
    spy.mockRestore()
    if (next) await Share.remove(next)
  }
})

test("legacy snapshot migration races with sync without losing persisted data", async () => {
  const share = await Share.create({ sessionID: session() })
  await Storage.write(["share", share.id], share)
  await Storage.write(["share_compaction", share.id], { data: [message("old")] })
  await Storage.write(["share_data", share.id, "message", "older"], { id: "older" })
  try {
    await Promise.all([other.data(share.id), Share.sync({ share, data: [message("new")] })])
    expect((await Share.data(share.id)).map((x) => dataID(x))).toEqual(["new", "old", "older"])
  } finally {
    await Share.remove(share)
  }
})

test("revocation deletes legacy objects beyond the first storage page", async () => {
  const share = await Share.create({ sessionID: session() })
  await Promise.all(
    Array.from({ length: 1002 }, (_, i) =>
      Storage.write(["share_event", share.id, String(i).padStart(4, "0")], [message(String(i))]),
    ),
  )
  await Share.remove(share)
  expect(await Storage.list({ prefix: ["share_event", share.id] })).toEqual([])
})

test("legacy migration cannot overwrite a recreated generation", async () => {
  const sessionID = session()
  const share = await Share.create({ sessionID })
  await Storage.write(["share", share.id], share)
  await Storage.write(["share_snapshot", share.id], { data: [message("old-generation")] })
  const cas = Storage.compareAndSwap
  let release!: () => void
  let entered!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  let held = false
  const spy = spyOn(Storage, "compareAndSwap").mockImplementation(async (key, value, etag) => {
    if (!held && key[1] === share.id && dataID(stateData(value)[0]) === "old-generation") {
      held = true
      entered()
      await wait
    }
    return cas(key, value, etag)
  })
  let next: Share.Info | undefined
  try {
    const pending = other.data(share.id)
    await blocked
    await Share.remove(share)
    next = await Share.create({ sessionID })
    await Share.sync({ share: next, data: [message("new-generation")] })
    release()
    expect((await pending).map((x) => dataID(x))).toEqual(["new-generation"])
    expect((await Share.data(next.id)).map((x) => dataID(x))).toEqual(["new-generation"])
  } finally {
    release()
    spy.mockRestore()
    if (next) await Share.remove(next)
  }
})

test("persistent CAS conflicts fail explicitly without claiming an update", async () => {
  const share = await Share.create({ sessionID: session() })
  const spy = spyOn(Storage, "compareAndSwap").mockResolvedValue(false)
  try {
    const failure = await Share.sync({ share, data: [message("unacknowledged")] }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Share.Errors.Conflict)
    expect(spy).toHaveBeenCalledTimes(64)
    expect(await Share.data(share.id)).toEqual([])
  } finally {
    spy.mockRestore()
    await Share.remove(share)
  }
})
