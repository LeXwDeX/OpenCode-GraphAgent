import { AwsClient } from "aws4fetch"
import { lazy } from "@opencode-ai/core/util/lazy"

export namespace Storage {
  export interface Adapter {
    read(path: string): Promise<string | undefined>
    write(path: string, value: string): Promise<void>
    readVersion(path: string): Promise<{ value: string; etag: string } | undefined>
    compareAndSwap(path: string, value: string, etag?: string): Promise<boolean>
    remove(path: string): Promise<void>
    list(options?: { prefix?: string; limit?: number; after?: string; before?: string }): Promise<string[]>
  }

  export function createAdapter(client: Pick<AwsClient, "fetch">, endpoint: string, bucket: string): Adapter {
    const base = `${endpoint}/${bucket}`
    return {
      async read(path: string): Promise<string | undefined> {
        const response = await client.fetch(`${base}/${path}`)
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`)
        return response.text()
      },

      async readVersion(path) {
        const response = await client.fetch(`${base}/${path}`)
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`Failed to read ${path}: ${response.status}`)
        const etag = response.headers.get("etag")
        if (!etag) throw new Error(`Storage did not provide an ETag for ${path}`)
        return { value: await response.text(), etag }
      },

      async compareAndSwap(path, value, etag) {
        // S3 and R2 support conditional PutObject. Never fall back to an unconditional write.
        const response = await client.fetch(`${base}/${path}`, {
          method: "PUT",
          body: value,
          headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }) },
        })
        if (response.status === 412 || response.status === 409 || (etag && response.status === 404)) return false
        if (!response.ok) throw new Error(`Failed to conditionally write ${path}: ${response.status}`)
        return true
      },

      async write(path: string, value: string): Promise<void> {
        const response = await client.fetch(`${base}/${path}`, {
          method: "PUT",
          body: value,
          headers: {
            "Content-Type": "application/json",
          },
        })
        if (!response.ok) throw new Error(`Failed to write ${path}: ${response.status}`)
      },

      async remove(path: string): Promise<void> {
        const response = await client.fetch(`${base}/${path}`, {
          method: "DELETE",
        })
        if (!response.ok) throw new Error(`Failed to remove ${path}: ${response.status}`)
      },

      async list(options?: { prefix?: string; limit?: number; after?: string; before?: string }): Promise<string[]> {
        const prefix = options?.prefix || ""
        const limit = options?.limit
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid list limit")
        if (limit === 0) return []
        const keys: string[] = []
        let cursor: string | undefined
        const seen = new Set<string>()
        const before = options?.before ? prefix + options.before + ".json" : undefined
        do {
          const params = new URLSearchParams({ "list-type": "2", prefix, "encoding-type": "url" })
          params.set("max-keys", String(Math.min(1000, limit === undefined ? 1000 : limit - keys.length)))
          if (cursor) params.set("continuation-token", cursor)
          else if (options?.after) params.set("start-after", prefix + options.after + ".json")
          const response = await client.fetch(`${base}?${params}`)
          if (!response.ok) throw new Error(`Failed to list ${prefix}: ${response.status}`)
          const xml = await response.text()
          const encoded = /<EncodingType>url<\/EncodingType>/.test(xml)
          for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
            const text = xmlText(match[1])
            const key = encoded ? decodeURIComponent(text) : text
            if (before && key >= before) return keys
            keys.push(key)
            if (limit !== undefined && keys.length === limit) return keys
          }
          if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return keys
          const token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1]
          cursor = token === undefined ? undefined : xmlText(token)
          if (!cursor || seen.has(cursor)) throw new Error("Invalid storage continuation token")
          seen.add(cursor)
        } while (cursor)
        return keys
      },
    }
  }

  function xmlText(value: string) {
    return value.replace(/&([^;]+);/g, (_, entity: string) => {
      const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
      if (entity in entities) return entities[entity]
      if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity))
        return String.fromCodePoint(
          entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
        )
      throw new Error("Invalid XML entity")
    })
  }

  function s3(): Adapter {
    const bucket = process.env.OPENCODE_STORAGE_BUCKET!
    const region = process.env.OPENCODE_STORAGE_REGION || "us-east-1"
    const client = new AwsClient({
      region,
      accessKeyId: process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(client, `https://s3.${region}.amazonaws.com`, bucket)
  }

  function r2() {
    const accountId = process.env.OPENCODE_STORAGE_ACCOUNT_ID!
    const client = new AwsClient({
      accessKeyId: process.env.OPENCODE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY!,
    })
    return createAdapter(client, `https://${accountId}.r2.cloudflarestorage.com`, process.env.OPENCODE_STORAGE_BUCKET!)
  }

  const adapter = lazy(() => {
    const type = process.env.OPENCODE_STORAGE_ADAPTER
    if (type === "r2") return r2()
    if (type === "s3") return s3()
    throw new Error("No storage adapter configured")
  })

  function resolve(key: string[]) {
    return key.join("/") + ".json"
  }

  export async function read<T>(key: string[]) {
    const result = await adapter().read(resolve(key))
    if (!result) return undefined
    const value: T = JSON.parse(result)
    return value
  }

  // Stored JSON preserves the existing caller-selected read type; runtime validation belongs to its owner.
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  export async function readVersion<T>(key: string[]): Promise<{ value: T; etag: string } | undefined> {
    const result = await adapter().readVersion(resolve(key))
    if (!result) return undefined
    const value: T = JSON.parse(result.value)
    return { value, etag: result.etag }
  }

  export function compareAndSwap(key: string[], value: unknown, etag?: string) {
    return adapter().compareAndSwap(resolve(key), JSON.stringify(value), etag)
  }

  export function write(key: string[], value: unknown) {
    return adapter().write(resolve(key), JSON.stringify(value))
  }

  export function remove(key: string[]) {
    return adapter().remove(resolve(key))
  }

  export async function list(options?: { prefix?: string[]; limit?: number; after?: string; before?: string }) {
    const p = options?.prefix ? options.prefix.join("/") + (options.prefix.length ? "/" : "") : ""
    const result = await adapter().list({
      prefix: p,
      limit: options?.limit,
      after: options?.after,
      before: options?.before,
    })
    return result.map((x) => x.replace(/\.json$/, "").split("/"))
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const val = await read<T>(key)
    if (!val) throw new Error("Not found")
    fn(val)
    await write(key, val)
    return val
  }
}
