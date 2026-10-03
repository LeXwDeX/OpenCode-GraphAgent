import { describe, expect, test } from "bun:test"
import { Identifier } from "@opencode-ai/core/util/identifier"
import { Share } from "../../src/core/share"
import { Storage } from "../../src/core/storage"

function part(sessionID: string): Share.Data {
  return {
    type: "part",
    data: { id: "part1", sessionID, messageID: "msg1", type: "text", text: "Private after revocation" },
  }
}

describe("share revocation", () => {
  test("deletes exact snapshot and compaction objects and legacy groups without deleting neighboring shares", async () => {
    const sessionID = Identifier.descending()
    const share = await Share.create({ sessionID })
    const neighbor = await Share.create({ sessionID: Identifier.descending() })
    const data = [part(sessionID)]
    await Share.sync({ share, data })
    await Storage.write(["share_compaction", share.id], { data })
    await Storage.write(["share_event", share.id, "event1"], data)
    await Storage.write(["share_data", share.id, "session"], { id: sessionID })
    await Share.sync({ share: neighbor, data: [part(neighbor.sessionID)] })
    try {
      await Share.remove(share)
      expect(await Share.get(share.id)).toBeUndefined()
      expect(await Storage.read(["share_snapshot", share.id])).toBeUndefined()
      expect(await Storage.read(["share_compaction", share.id])).toBeUndefined()
      expect(await Storage.list({ prefix: ["share_event", share.id] })).toEqual([])
      expect(await Storage.list({ prefix: ["share_data", share.id] })).toEqual([])
      expect(await Share.data(share.id).catch((error: unknown) => error)).toBeInstanceOf(Share.Errors.NotFound)
      expect(await Share.get(neighbor.id)).toEqual(neighbor)
      expect(await Share.data(neighbor.id)).toEqual([part(neighbor.sessionID)])
    } finally {
      await Share.remove(neighbor)
    }
  })

  test("orphan snapshots from an in-flight sync are unreadable after revocation", async () => {
    const share = await Share.create({ sessionID: Identifier.descending() })
    await Share.remove(share)
    // A sync that passed its initial ownership check could finish after removal.
    await Storage.write(["share_snapshot", share.id], { data: [part(share.sessionID)] })
    try {
      expect(await Share.data(share.id).catch((error: unknown) => error)).toBeInstanceOf(Share.Errors.NotFound)
    } finally {
      await Storage.remove(["share_snapshot", share.id])
    }
  })

  test("missing shares cannot reconstruct snapshots from legacy compaction", async () => {
    const share = await Share.create({ sessionID: Identifier.descending() })
    await Share.remove(share)
    await Storage.write(["share_compaction", share.id], { data: [part(share.sessionID)] })
    try {
      expect(await Share.data(share.id).catch((error: unknown) => error)).toBeInstanceOf(Share.Errors.NotFound)
      expect(await Storage.read(["share_snapshot", share.id])).toBeUndefined()
    } finally {
      await Storage.remove(["share_compaction", share.id])
      await Storage.remove(["share_snapshot", share.id])
    }
  })
})
