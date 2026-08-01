import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { DagWorkflows } from "@/dag/workflows"
import { StartSpec } from "@/tool/workflow"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"

let dir: string
let projectDir: string
let globalDir: string
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR

const spec = (name: string, nodes: number) =>
  [
    `title: ${name} title`,
    "config:",
    `  name: ${name}`,
    "  nodes:",
    ...Array.from({ length: nodes }, (_, index) => `    - id: node-${index}`),
  ].join("\n")

const writeProject = (file: string, content: string) =>
  fs.mkdir(path.join(projectDir, ".opencode", "workflows"), { recursive: true }).then(() =>
    fs.writeFile(path.join(projectDir, ".opencode", "workflows", file), content),
  )

const writeGlobal = (file: string, content: string) =>
  fs
    .mkdir(path.join(globalDir, "workflows"), { recursive: true })
    .then(() => fs.writeFile(path.join(globalDir, "workflows", file), content))

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dag-workflows-"))
  projectDir = path.join(dir, "project")
  globalDir = path.join(dir, "global")
  await fs.mkdir(projectDir, { recursive: true })
  // Flag.OPENCODE_CONFIG_DIR reads the env — redirect the global scope so the
  // real user config dir is never read or written.
  process.env.OPENCODE_CONFIG_DIR = globalDir
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
  await fs.rm(dir, { recursive: true, force: true })
})

describe("DagWorkflows.isName", () => {
  it("treats bare identifiers as names", () => {
    expect(DagWorkflows.isName("code-review")).toBe(true)
    expect(DagWorkflows.isName("review_v2")).toBe(true)
  })

  it("treats anything path-shaped as a path, so existing spec_path calls keep working", () => {
    expect(DagWorkflows.isName("review.yaml")).toBe(false)
    expect(DagWorkflows.isName("review.YML")).toBe(false)
    expect(DagWorkflows.isName(".opencode/workflows/review.yaml")).toBe(false)
    expect(DagWorkflows.isName("./review")).toBe(false)
    expect(DagWorkflows.isName("../review")).toBe(false)
    expect(DagWorkflows.isName("dir\\review")).toBe(false)
    expect(DagWorkflows.isName("/abs/review.yaml")).toBe(false)
    expect(DagWorkflows.isName("")).toBe(false)
  })

  it("rejects control characters, which would make the filesystem lookup throw", () => {
    expect(DagWorkflows.isName("a\u0000b")).toBe(false)
    expect(DagWorkflows.isName("a\nb")).toBe(false)
  })
})

describe("DagWorkflows.resolve", () => {
  it("resolves a project workflow", async () => {
    await writeProject("code-review.yaml", spec("code-review", 3))
    const entry = await Effect.runPromise(DagWorkflows.resolve("code-review", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.path).toBe(path.join(projectDir, ".opencode", "workflows", "code-review.yaml"))
    expect(entry?.title).toBe("code-review title")
    expect(entry?.nodes).toBe(3)
  })

  it("resolves a global workflow when the project has none", async () => {
    await writeGlobal("research.yaml", spec("research", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("research", projectDir))
    expect(entry?.scope).toBe("global")
    expect(entry?.path).toBe(path.join(globalDir, "workflows", "research.yaml"))
  })

  it("lets the project scope shadow a global workflow of the same name", async () => {
    await writeGlobal("code-review.yaml", spec("global-version", 1))
    await writeProject("code-review.yaml", spec("project-version", 2))
    const entry = await Effect.runPromise(DagWorkflows.resolve("code-review", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.title).toBe("project-version title")
  })

  it("accepts the .yml extension", async () => {
    await writeProject("short.yml", spec("short", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("short", projectDir))
    expect(entry?.path).toEndWith("short.yml")
  })

  it("prefers .yaml over .yml within the same scope", async () => {
    await writeProject("both.yml", spec("yml-version", 1))
    await writeProject("both.yaml", spec("yaml-version", 1))
    const entry = await Effect.runPromise(DagWorkflows.resolve("both", projectDir))
    expect(entry?.title).toBe("yaml-version title")
  })

  it("returns undefined for an unknown name so the caller can report the searched paths", async () => {
    expect(await Effect.runPromise(DagWorkflows.resolve("missing", projectDir))).toBeUndefined()
    expect(DagWorkflows.searchPaths(projectDir)).toEqual([
      path.join(projectDir, ".opencode", "workflows"),
      path.join(globalDir, "workflows"),
    ])
  })

  it("still resolves a spec it cannot parse — the start path reports the real error", async () => {
    await writeProject("broken.yaml", "config: [unclosed")
    const entry = await Effect.runPromise(DagWorkflows.resolve("broken", projectDir))
    expect(entry?.scope).toBe("project")
    expect(entry?.title).toBeUndefined()
    expect(entry?.nodes).toBeUndefined()
  })
})

describe("DagWorkflows.list", () => {
  it("returns nothing when neither scope exists", async () => {
    expect(await Effect.runPromise(DagWorkflows.list(projectDir))).toEqual([])
  })

  it("merges both scopes, sorted by name, project shadowing global", async () => {
    await writeGlobal("shared.yaml", spec("global-shared", 1))
    await writeGlobal("only-global.yaml", spec("only-global", 4))
    await writeProject("shared.yaml", spec("project-shared", 2))
    await writeProject("a-first.yaml", spec("a-first", 1))

    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries.map((entry) => [entry.name, entry.scope])).toEqual([
      ["a-first", "project"],
      ["only-global", "global"],
      ["shared", "project"],
    ])
    expect(entries.find((entry) => entry.name === "shared")?.title).toBe("project-shared title")
    expect(entries.find((entry) => entry.name === "only-global")?.nodes).toBe(4)
  })

  it("ignores non-spec files and directories", async () => {
    await writeProject("real.yaml", spec("real", 1))
    await writeProject("notes.md", "not a spec")
    await fs.mkdir(path.join(projectDir, ".opencode", "workflows", "nested.yaml"), { recursive: true })

    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries.map((entry) => entry.name)).toEqual(["real"])
  })

  it("leaves title undefined when the spec declares none", async () => {
    await writeProject("untitled.yaml", "config:\n  name: from-config\n  nodes: []")
    const entries = await Effect.runPromise(DagWorkflows.list(projectDir))
    expect(entries[0]?.title).toBeUndefined()
    expect(entries[0]?.nodes).toBe(0)
  })
})

// The README advertises this committed spec as startable by name, so it has to
// survive the same decode a real start performs. Only the shipped example is
// checked — `.opencode/workflows/` is also where a contributor keeps their own
// specs, and those must not fail the suite.
describe("the repository's own workflow library", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../..")

  it("ships change-review as a valid start spec referencing existing prompt templates", async () => {
    const entry = await Effect.runPromise(DagWorkflows.resolve("change-review", repoRoot))
    expect(entry?.scope).toBe("project")

    const spec = Schema.decodeUnknownSync(StartSpec)(Bun.YAML.parse(await Bun.file(entry!.path).text()))
    const templates = await fs
      .readdir(path.join(repoRoot, ".opencode", "dag-prompts"))
      .then((files) => files.map((file) => path.basename(file, ".md")))

    for (const node of spec.config.nodes) {
      if (node.prompt_template.id) expect(templates).toContain(node.prompt_template.id)
      for (const dependency of node.depends_on) {
        expect(spec.config.nodes.map((other) => other.id)).toContain(dependency)
      }
    }
  })
})

