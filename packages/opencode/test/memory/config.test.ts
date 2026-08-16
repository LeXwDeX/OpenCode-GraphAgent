import { describe, expect, test } from "bun:test"
import { decodeConfig } from "@/memory/config"
import { MemorySchema, updateConfig } from "@/memory/schema"

// memory-config-fidelity: topic_limit_floor was a dead knob — no runtime
// consumer read it, and readConfig silently rewrote any floor ≠ limit file to
// floor := limit on every load, overwriting explicit user values. The field
// must be gone: legacy files carrying it still decode (extra property is
// tolerated), and decoded/updated configs never contain it.

const valid = {
  schema_version: 1,
  enabled: true,
  model: "p/m",
  topic_limit: 10,
  turn_interval: 5,
  injection: { max_topics: 3, max_tokens: 1200 },
}

describe("MemoryConfig decode/update — topic_limit_floor removed", () => {
  test("legacy file with a divergent floor still decodes (field ignored)", () => {
    const decoded = decodeConfig(JSON.stringify({ ...valid, topic_limit_floor: 30 }))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      expect(Object.keys(decoded.value)).not.toContain("topic_limit_floor")
    }
  })

  test("decoded config never carries the field", () => {
    const decoded = decodeConfig(JSON.stringify(valid))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      expect(Object.keys(decoded.value)).not.toContain("topic_limit_floor")
    }
  })

  test("updateConfig output never carries the field", () => {
    const decoded = decodeConfig(JSON.stringify(valid))
    expect(decoded._tag).toBe("Some")
    if (decoded._tag === "Some") {
      const next = updateConfig(decoded.value, { enabled: false })
      expect(Object.keys(next)).not.toContain("topic_limit_floor")
    }
  })

  test("schema bounds for the live knobs are preserved", () => {
    expect(decodeConfig(JSON.stringify({ ...valid, topic_limit: 9 }))._tag).toBe("None")
    expect(decodeConfig(JSON.stringify({ ...valid, turn_interval: 0 }))._tag).toBe("None")
    expect(decodeConfig(JSON.stringify({ ...valid, injection: { max_topics: 4, max_tokens: 1200 } }))._tag).toBe(
      "None",
    )
    expect(MemorySchema.MIN_TOPIC_LIMIT).toBe(10)
  })
})
