import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import { createOpencodeClient, type Config, type OpencodeClient, type Project } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { bootstrapDirectory, bootstrapGlobal, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { GlobalStore } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { ServerScope } from "@/utils/server-scope"
import { ServerConnection } from "@/context/server"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = createStore<State>({
      status: "loading",
      agent: [],
      command: [],
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return this.session_status[id]?.type !== "idle"
      },
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      mcp_ready: true,
      mcp: {},
      lsp_ready: true,
      lsp: [],
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })
})

describe("bootstrapGlobal", () => {
  test("keeps the first failure observable and clears it after a successful retry", async () => {
    let failConfig = true
    const existingProject: Project = {
      id: "existing-project",
      worktree: "/existing-project",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    }
    const [store, setStore] = createStore<GlobalStore>({
      ready: false,
      path: { state: "", config: "", worktree: "", directory: "", home: "" },
      project: [],
      provider,
      provider_auth: {},
      config: {} satisfies Config,
      reload: undefined as undefined | "pending" | "complete",
    })
    const sdk = createOpencodeClient()
    Object.defineProperty(sdk.global.config, "get", {
      value: async () => {
        if (failConfig) throw new Error("invalid config response")
        return { data: { model: "provider/model" } }
      },
    })
    Object.defineProperty(sdk.provider, "list", {
      value: async () => ({ data: { all: [], connected: [], default: {} } }),
    })
    Object.defineProperty(sdk.path, "get", {
      value: async () => ({ data: { state: "", config: "", worktree: "", directory: "", home: "" } }),
    })
    Object.defineProperty(sdk.project, "list", { value: async () => ({ data: [existingProject] }) })
    const queryClient = new QueryClient()
    const input = {
      serverSDK: sdk,
      scope: ServerScope.local,
      requestFailedTitle: "Request failed",
      translate: (key: string) => key,
      formatMoreCount: (count: number) => ` (+${count} more)`,
      setGlobalStore: setStore,
      queryClient,
    }

    const failed = await bootstrapGlobal(input)
    expect(failed).toHaveLength(1)
    const firstFailure = failed[0]
    if (!(firstFailure instanceof Error)) throw new Error("Expected the failed config request error")
    expect(firstFailure.message).toBe("invalid config response")
    expect(store.error).toBe(firstFailure)

    failConfig = false
    const retried = await bootstrapGlobal(input)
    expect(retried).toEqual([])
    expect(store.error).toBeUndefined()
    setStore("ready", true)

    failConfig = true
    const refreshFailure = await bootstrapGlobal(input)
    expect(refreshFailure).toHaveLength(1)
    expect(store.ready).toBe(true)
    expect(store.project).toEqual([existingProject])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = createOpencodeClient()
    const remote = ServerScope.fromServerKey(ServerConnection.Key.make("https://debian.example"))

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
