import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction falls back to structured text output when model content is empty", () => {
  const serialized = SessionCompaction.serializeCompletedToolState({
    status: "completed",
    input: { path: "notes.txt" },
    content: [],
    structured: {
      type: "text-page",
      content: "read-output",
      mime: "text/plain",
      offset: 1,
      truncated: false,
    },
  })

  expect(serialized).toBe(
    JSON.stringify({
      type: "text-page",
      content: "read-output",
      mime: "text/plain",
      offset: 1,
      truncated: false,
    }),
  )
})

test("compaction prefers bounded model content over structured payloads", () => {
  const serialized = SessionCompaction.serializeCompletedToolState({
    status: "completed",
    input: { path: "pixel.png" },
    content: [{ type: "text", text: "Image read successfully" }],
    structured: { content: "base64-payload" },
  })

  expect(serialized).toBe("Image read successfully")
  expect(serialized).not.toContain("base64-payload")
})
