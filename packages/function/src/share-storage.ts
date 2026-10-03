import { randomUUID } from "node:crypto"

export class ShareAlreadyExistsError extends Error {
  constructor() {
    super("Share already exists")
  }
}

interface ShareRecordStorage {
  get(key: "secret" | "sessionID"): Promise<unknown>
  put(values: { secret: string; sessionID: string }): Promise<void>
}

interface ShareTransactionStorage {
  transaction<T>(callback: (storage: ShareRecordStorage) => Promise<T>): Promise<T>
}

interface ShareBucket {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
  delete(keys: string | string[]): Promise<void>
}

export function createShare(storage: ShareTransactionStorage, sessionID: string) {
  return storage.transaction(async (tx) => {
    if ((await tx.get("secret")) !== undefined || (await tx.get("sessionID")) !== undefined)
      throw new ShareAlreadyExistsError()
    const secret = randomUUID()
    await tx.put({ secret, sessionID })
    return secret
  })
}

export async function assertShareSecret(storage: Pick<ShareRecordStorage, "get">, secret: unknown) {
  if (typeof secret !== "string" || !secret) throw new Error("Invalid secret")
  const expected = await storage.get("secret")
  if (typeof expected !== "string" || !expected || secret !== expected) throw new Error("Invalid secret")
}

export async function assertShareOwner(storage: Pick<ShareRecordStorage, "get">, sessionID: unknown, secret: unknown) {
  await assertShareSecret(storage, secret)
  if (typeof sessionID !== "string" || !sessionID || (await storage.get("sessionID")) !== sessionID)
    throw new Error("Invalid session ID")
}

export async function clearShare(bucket: ShareBucket, sessionID: string) {
  for (const prefix of [`share/session/message/${sessionID}/`, `share/session/part/${sessionID}/`]) {
    let cursor: string | undefined
    do {
      const page = await bucket.list({ prefix, limit: 1000, cursor })
      if (page.objects.length) await bucket.delete(page.objects.map((item) => item.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
  await bucket.delete(`share/session/info/${sessionID}.json`)
}
