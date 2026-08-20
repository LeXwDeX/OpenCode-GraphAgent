import { describe, expect, test } from "bun:test"
import { resolveReleaseVersion } from "../script/release-version"

describe("GraphAgent release versions", () => {
  test("starts the independent main release line at 1.0.0", () => {
    expect(resolveReleaseVersion({ branch: "main", tags: [] })).toEqual({
      channel: "main",
      version: "1.0.0",
      tag: "graphagent-v1.0.0",
      prerelease: false,
      latest: true,
      previous_tag: "",
    })
  })

  test("starts dev at 1.0.0-dev.1 and ignores inherited OpenCode tags", () => {
    expect(
      resolveReleaseVersion({
        branch: "dev",
        tags: ["v1.17.11-main.10", "v0.0.0-202608082302"],
      }),
    ).toEqual({
      channel: "dev",
      version: "1.0.0-dev.1",
      tag: "graphagent-v1.0.0-dev.1",
      prerelease: true,
      latest: false,
      previous_tag: "",
    })
  })

  test("increments the dev sequence within the pending stable version", () => {
    expect(
      resolveReleaseVersion({
        branch: "dev",
        tags: ["graphagent-v1.0.0-dev.1", "graphagent-v1.0.0-dev.3"],
      }).version,
    ).toBe("1.0.0-dev.4")
  })

  test("promotes the pending dev version on main and moves dev to the next patch", () => {
    expect(resolveReleaseVersion({ branch: "main", tags: ["graphagent-v1.0.0-dev.4"] }).version).toBe("1.0.0")
    expect(resolveReleaseVersion({ branch: "dev", tags: ["graphagent-v1.0.0"] }).version).toBe("1.0.1-dev.1")
    expect(
      resolveReleaseVersion({
        branch: "main",
        tags: ["graphagent-v1.0.0", "graphagent-v1.0.1-dev.2"],
      }).version,
    ).toBe("1.0.1")
  })

  test("rejects releases from feature branches", () => {
    expect(() => resolveReleaseVersion({ branch: "feat/example", tags: [] })).toThrow(
      "GraphAgent releases require main or dev",
    )
  })

  test("seeds previous_tag from the latest stable tag for both channels", () => {
    expect(resolveReleaseVersion({ branch: "dev", tags: ["graphagent-v1.0.8", "graphagent-v1.0.9"] })).toEqual({
      channel: "dev",
      version: "1.0.10-dev.1",
      tag: "graphagent-v1.0.10-dev.1",
      prerelease: true,
      latest: false,
      previous_tag: "graphagent-v1.0.9",
    })
    expect(
      resolveReleaseVersion({ branch: "main", tags: ["graphagent-v1.0.8", "graphagent-v1.0.9"] }).previous_tag,
    ).toBe("graphagent-v1.0.9")
  })

  test("keeps previous_tag on the last stable across the dev series", () => {
    expect(
      resolveReleaseVersion({ branch: "dev", tags: ["graphagent-v1.0.9", "graphagent-v1.0.10-dev.2"] }).previous_tag,
    ).toBe("graphagent-v1.0.9")
  })

  test("wires one resolved version into both the build and GitHub Release", async () => {
    const workflow = await Bun.file(new URL("../../../.github/workflows/release-fork.yml", import.meta.url)).text()

    expect(workflow).not.toContain("inputs.version")
    expect(workflow).not.toContain("0.0.0-")
    expect(workflow).toContain("OPENCODE_CHANNEL: ${{ needs.version.outputs.channel == 'main' && 'latest' || 'dev' }}")
    expect(workflow).toContain("OPENCODE_VERSION: ${{ needs.version.outputs.version }}")
    expect(workflow).toContain('gh release create "${{ needs.version.outputs.tag }}"')
    expect(workflow).toContain("--prerelease --latest=false")
    expect(workflow).toContain("previous_tag: ${{ steps.release-version.outputs.previous_tag }}")
    expect(workflow).toContain("needs.version.outputs.previous_tag")
  })
})
