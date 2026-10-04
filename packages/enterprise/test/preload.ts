// Exercise the real signed S3 adapter against isolated process-local storage.
// Override every credential/endpoint input before source modules are imported.
import { createHash } from "node:crypto"

const endpoint = "https://offline-test.r2.cloudflarestorage.com"
const bucket = "offline-test-bucket"
process.env.OPENCODE_STORAGE_ADAPTER = "r2"
process.env.OPENCODE_STORAGE_ACCOUNT_ID = "offline-test"
process.env.OPENCODE_STORAGE_BUCKET = bucket
process.env.OPENCODE_STORAGE_REGION = "us-east-1"
process.env.OPENCODE_STORAGE_ACCESS_KEY_ID = "synthetic-access-key"
process.env.OPENCODE_STORAGE_SECRET_ACCESS_KEY = "synthetic-secret-key"

const objects = new Map<string, string>()
const offlineFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== endpoint || !url.pathname.startsWith(`/${bucket}`)) {
    throw new Error("Enterprise tests forbid external network requests")
  }
  if (url.pathname === `/${bucket}` && request.method === "GET") {
    if (url.searchParams.get("list-type") !== "2") throw new Error("Unexpected storage list request")
    const prefix = url.searchParams.get("prefix") ?? ""
    const after = url.searchParams.get("start-after")
    const limit = Number(url.searchParams.get("max-keys") ?? 1000)
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid storage list limit")
    const all = [...objects.keys()].sort().filter((key) => key.startsWith(prefix) && (!after || key > after))
    const offset = Number(url.searchParams.get("continuation-token") ?? 0)
    const keys = all.slice(offset, offset + limit)
    const truncated = offset + keys.length < all.length
    return new Response(
      `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${offset + keys.length}</NextContinuationToken>` : ""}${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join("")}</ListBucketResult>`,
      {
        headers: { "Content-Type": "application/xml" },
      },
    )
  }
  if (!url.pathname.startsWith(`/${bucket}/`) || url.search) throw new Error("Unexpected storage object request")
  const key = url.pathname.slice(bucket.length + 2)
  switch (request.method) {
    case "GET": {
      const value = objects.get(key)
      return value === undefined
        ? new Response(null, { status: 404 })
        : new Response(value, { headers: { ETag: etag(value) } })
    }
    case "PUT": {
      const body = await request.text()
      const current = objects.get(key)
      if (request.headers.get("if-none-match") === "*" && current !== undefined)
        return new Response(null, { status: 412 })
      const match = request.headers.get("if-match")
      if (match && (current === undefined || match !== etag(current))) return new Response(null, { status: 412 })
      objects.set(key, body)
      return new Response(null, { status: 200 })
    }
    case "DELETE":
      objects.delete(key)
      return new Response(null, { status: 204 })
    default:
      throw new Error("Unexpected storage object method")
  }
}
function etag(body: string) {
  return `"${createHash("sha256").update(body).digest("hex")}"`
}
// Bun exposes preconnect on fetch; the offline transport never opens sockets.
globalThis.fetch = Object.assign(offlineFetch, { preconnect() {} })
