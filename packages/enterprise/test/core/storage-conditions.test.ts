import { expect, test } from "bun:test"
import { Storage } from "../../src/core/storage"

test("pagination decodes escaped XML keys and continuation tokens and respects total limit", async () => {
  const urls: URL[] = []
  const adapter = Storage.createAdapter(
    {
      fetch: (url) => {
        urls.push(new URL(url instanceof Request ? url.url : String(url)))
        return Promise.resolve(
          new Response(
            urls.length === 1
              ? "<ListBucketResult><Contents><Key>p/a&amp;b.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>x&amp;y</NextContinuationToken></ListBucketResult>"
              : "<ListBucketResult><Contents><Key>p/c&#x3C;d.json</Key></Contents><Contents><Key>p/e.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>",
          ),
        )
      },
    },
    "https://fixture.invalid",
    "bucket",
  )
  expect(await adapter.list({ prefix: "p/", limit: 2, after: "0" })).toEqual(["p/a&b.json", "p/c<d.json"])
  expect(urls[0].searchParams.get("start-after")).toBe("p/0.json")
  expect(urls[1].searchParams.get("continuation-token")).toBe("x&y")
  expect(urls[1].searchParams.get("max-keys")).toBe("1")
})

test("CAS conflicts are explicit and unsupported storage fails closed", async () => {
  const headers: Headers[] = []
  let status = 412
  const adapter = Storage.createAdapter(
    {
      fetch: (_url, init) => {
        headers.push(new Headers(init?.headers))
        return Promise.resolve(new Response(null, { status }))
      },
    },
    "https://fixture.invalid",
    "bucket",
  )
  expect(await adapter.compareAndSwap("a", "{}", '"revision"')).toBe(false)
  expect(headers[0].get("if-match")).toBe('"revision"')
  expect(await adapter.compareAndSwap("a", "{}")).toBe(false)
  expect(headers[1].get("if-none-match")).toBe("*")
  status = 501
  expect(String(await adapter.compareAndSwap("a", "{}").catch((error: unknown) => error))).toContain("501")
  expect(headers).toHaveLength(3)
})

test("missing ETag and malformed truncated lists cannot cause unsafe writes or incomplete success", async () => {
  const adapter = Storage.createAdapter(
    {
      fetch: () =>
        Promise.resolve(new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>")),
    },
    "https://fixture.invalid",
    "bucket",
  )
  expect(String(await adapter.readVersion("a").catch((error: unknown) => error))).toContain("ETag")
  expect(String(await adapter.list().catch((error: unknown) => error))).toContain("continuation token")
})
