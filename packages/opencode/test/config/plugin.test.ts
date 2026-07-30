import { describe, expect, test } from "bun:test"
import { ConfigPlugin } from "@/config/plugin"

describe("ConfigPlugin.dependencyVersion", () => {
  test("pins stable latest releases", () => {
    expect(ConfigPlugin.dependencyVersion({ channel: "latest", version: "1.17.11" })).toBe("1.17.11")
  })

  test("does not pin local builds", () => {
    expect(ConfigPlugin.dependencyVersion({ channel: "local", version: "1.17.11" })).toBeUndefined()
  })

  test("does not pin fork or prerelease versions", () => {
    expect(ConfigPlugin.dependencyVersion({ channel: "latest", version: "1.17.11-main.3" })).toBeUndefined()
    expect(ConfigPlugin.dependencyVersion({ channel: "latest", version: "1.17.11-beta.1" })).toBeUndefined()
  })

  test("does not pin branch channels", () => {
    expect(ConfigPlugin.dependencyVersion({ channel: "dev", version: "1.17.11" })).toBeUndefined()
  })
})
