import { describe, expect, test } from "bun:test"
import { ConfigReasoningDistillation } from "../../src/config/reasoning-distillation"

describe("ConfigReasoningDistillation.resolveEnabled (D02)", () => {
  test("defaults on when nothing is set", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false })).toEqual({
      enabled: true,
      source: "default",
    })
  })

  test("the environment kill-switch overrides an explicit config value", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: true, enabled: true })).toEqual({
      enabled: false,
      source: "environment",
    })
  })

  test("an explicit config value is honored", () => {
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false, enabled: false })).toEqual({
      enabled: false,
      source: "config",
    })
    expect(ConfigReasoningDistillation.resolveEnabled({ disabledByEnvironment: false, enabled: true })).toEqual({
      enabled: true,
      source: "config",
    })
  })
})
