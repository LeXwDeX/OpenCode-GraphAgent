import { describe, expect, test } from "bun:test"
import {
  assertShareOwner,
  assertShareSecret,
  clearShare,
  createShare,
  ShareAlreadyExistsError,
} from "../src/share-storage"

async function rejection(effect: Promise<unknown>) {
  try {
    await effect
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("Expected operation to reject")
}

function storage() {
  const values = new Map<string, unknown>()
  let pending = Promise.resolve()
  const tx = {
    get: async (key: string) => values.get(key),
    put: async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, value)
    },
  }
  const store = {
    ...tx,
    transaction: <T>(fn: (value: typeof tx) => Promise<T>) => {
      const result = pending.then(() => fn(tx))
      pending = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
  return { values, store }
}

describe("share ownership", () => {
  test("concurrent creation produces exactly one owner and rejects duplicate and colliding session IDs", async () => {
    const { values, store } = storage()
    const results = await Promise.allSettled([
      createShare(store, "session_abcdefgh"),
      createShare(store, "session_abcdefgh"),
      createShare(store, "other_abcdefgh"),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(values.get("sessionID")).toBe("session_abcdefgh")
    for (const result of results.slice(1)) {
      expect(result.status).toBe("rejected")
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ShareAlreadyExistsError)
    }
    expect((await rejection(createShare(store, "session_abcdefgh"))).message).toBe("Share already exists")
  })

  test("uncreated shares and missing or incorrect credentials never authorize writes", async () => {
    const { store } = storage()
    for (const secret of [undefined, null, "", "guessed"]) {
      expect((await rejection(assertShareSecret(store, secret))).message).toBe("Invalid secret")
    }
    const secret = await createShare(store, "session_abcdefgh")
    for (const invalid of [undefined, null, "", "guessed"]) {
      expect((await rejection(assertShareSecret(store, invalid))).message).toBe("Invalid secret")
    }
    expect(await assertShareSecret(store, secret)).toBeUndefined()
  })
  test("ownership requires the complete session ID as well as the current credential", async () => {
    const { store } = storage()
    const secret = await createShare(store, "session_abcdefgh")
    expect((await rejection(assertShareOwner(store, "other_abcdefgh", secret))).message).toBe("Invalid session ID")
    expect((await rejection(assertShareOwner(store, "session_abcdefgh", "wrong-secret"))).message).toBe(
      "Invalid secret",
    )
    expect(await assertShareOwner(store, "session_abcdefgh", secret)).toBeUndefined()
  })
})

describe("share deletion", () => {
  test("deletes stored info, messages, and parts across every bucket page", async () => {
    const removed: string[] = []
    const calls: { prefix: string; cursor?: string }[] = []
    const bucket = {
      list: async (options: { prefix: string; cursor?: string }) => {
        calls.push(options)
        return options.cursor
          ? { objects: [{ key: `${options.prefix}last.json` }], truncated: false }
          : { objects: [{ key: `${options.prefix}first.json` }], truncated: true, cursor: "page2" }
      },
      delete: async (keys: string | string[]) => {
        removed.push(...(typeof keys === "string" ? [keys] : keys))
      },
    }
    await clearShare(bucket, "ses_test")
    expect(removed).toEqual([
      "share/session/message/ses_test/first.json",
      "share/session/message/ses_test/last.json",
      "share/session/part/ses_test/first.json",
      "share/session/part/ses_test/last.json",
      "share/session/info/ses_test.json",
    ])
    expect(calls.map(({ cursor }) => cursor)).toEqual([undefined, "page2", undefined, "page2"])
  })

  test("propagates storage failure so callers retain state for retry", async () => {
    const bucket = {
      list: async () => ({ objects: [{ key: "share/session/part/ses_test/a.json" }], truncated: false }),
      delete: async () => {
        throw new Error("R2 unavailable")
      },
    }
    expect((await rejection(clearShare(bucket, "ses_test"))).message).toBe("R2 unavailable")
  })
})
