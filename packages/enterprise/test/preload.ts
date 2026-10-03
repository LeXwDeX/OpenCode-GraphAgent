// Exercise the real signed S3 adapter against isolated process-local storage.
// Override every credential/endpoint input before source modules are imported.
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
    const keys = [...objects.keys()]
      .sort()
      .filter((key) => key.startsWith(prefix) && (!after || key > after))
      .slice(0, limit)
    return new Response(
      `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}</ListBucketResult>`,
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
      return value === undefined ? new Response(null, { status: 404 }) : new Response(value)
    }
    case "PUT":
      objects.set(key, await request.text())
      return new Response(null, { status: 200 })
    case "DELETE":
      objects.delete(key)
      return new Response(null, { status: 204 })
    default:
      throw new Error("Unexpected storage object method")
  }
}
// Bun exposes preconnect on fetch; the offline transport never opens sockets.
globalThis.fetch = Object.assign(offlineFetch, { preconnect() {} })
