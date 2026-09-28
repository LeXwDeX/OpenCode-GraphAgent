/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

test("adopted thinking replaces the existing displayed part and survives a fresh session sync", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessionID = "ses_reasoning_adoption"
  const messageID = "msg_reasoning_adoption"
  const partID = "prt_reasoning_adoption"
  const session = {
    id: sessionID,
    title: "reasoning",
    slug: "reasoning",
    projectID: "proj_test",
    time: { created: 1, updated: 1 },
    version: "test",
    directory,
  }
  const info: AssistantMessage = {
    id: messageID,
    sessionID,
    parentID: "msg_user",
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: "model",
    providerID: "provider",
    path: { cwd: directory, root: directory },
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  let part: ReasoningPart = {
    id: partID,
    messageID,
    sessionID,
    type: "reasoning",
    text: "original thinking",
    time: { start: 1, end: 2 },
  }
  const serve = (url: URL) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info, parts: [part] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }
  const first = await mount(serve, tmp.path)
  try {
    await first.sync.session.sync(sessionID)
    expect(first.sync.data.part[messageID][0].type).toBe("reasoning")
    expect(first.sync.data.part[messageID][0]).toMatchObject({ text: "original thinking" })
    part = { ...part, text: "蒸馏后的思考", distillation: { originalText: part.text, sourceFingerprint: "source" } }
    first.emit({
      directory,
      payload: { id: "evt_adoption", type: "message.part.updated", properties: { sessionID, part, time: 3 } },
    })
    await wait(() =>
      first.sync.data.part[messageID].some((item) => item.type === "reasoning" && item.text === part.text),
    )
    expect(first.sync.data.part[messageID]).toHaveLength(1)
    expect(first.sync.data.part[messageID][0]).toMatchObject({ id: partID, text: part.text })
  } finally {
    first.app.renderer.destroy()
  }
  const restored = await mount(serve, tmp.path)
  try {
    await restored.sync.session.sync(sessionID)
    expect(restored.sync.data.part[messageID]).toHaveLength(1)
    expect(restored.sync.data.part[messageID][0]).toMatchObject({ id: partID, text: "蒸馏后的思考" })
  } finally {
    restored.app.renderer.destroy()
  }
})
