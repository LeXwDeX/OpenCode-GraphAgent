import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { appendPrompt, isOpenCodeHealthy } from "../connection";

async function fixture(
  status: number,
  body: string,
  fn: (port: number, posts: string[]) => Promise<void>,
  redirect = false,
) {
  const posts: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) {text += chunk;}
      posts.push(text);
      response.end("{}");
      return;
    }
    assert.equal(request.url, "/global/health");
    if (redirect) {response.setHeader("Location", "/unexpected");}
    response.writeHead(status);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  try {
    await fn((server.address() as AddressInfo).port, posts);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

for (const [name, status, body] of [
  ["404", 404, '{"healthy":true,"version":"1"}'],
  ["401", 401, '{"healthy":true,"version":"1"}'],
  ["HTML", 200, "<html>other local service</html>"],
  ["invalid JSON", 200, "{"],
  ["unhealthy", 200, '{"healthy":false,"version":"1"}'],
  ["missing version", 200, '{"healthy":true}'],
  ["blank version", 200, '{"healthy":true,"version":" "}'],
  ["wrong version type", 200, '{"healthy":true,"version":1}'],
  ["redirect", 302, '{"healthy":true,"version":"1"}'],
] as const) {
  test(`rejects ${name} without sending file references`, async () => {
    await fixture(
      status,
      body,
      async (port, posts) => {
        assert.equal(await isOpenCodeHealthy(port), false);
        assert.equal(await appendPrompt(port, "@private/example.ts#L1-3"), false);
        assert.deepEqual(posts, []);
      },
      status === 302,
    );
  });
}

test("healthy server receives the selected file reference", async () => {
  await fixture(200, '{"healthy":true,"version":"1.17.11"}', async (port, posts) => {
    assert.equal(await isOpenCodeHealthy(port), true);
    assert.equal(await appendPrompt(port, "In @example.ts#L2"), true);
    assert.deepEqual(
      posts.map((body) => JSON.parse(body)),
      [{ text: "In @example.ts#L2" }],
    );
  });
});

test("health request times out and invalid ports fail closed", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  try {
    assert.equal(await isOpenCodeHealthy((server.address() as AddressInfo).port, 20), false);
    for (const port of [0, -1, 65536, NaN, 1.5]) {assert.equal(await appendPrompt(port, "@example.ts"), false);}
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
