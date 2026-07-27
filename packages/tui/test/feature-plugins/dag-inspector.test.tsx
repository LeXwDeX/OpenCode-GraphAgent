/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { TuiPluginApi, TuiRouteCurrent, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { DagNode, DagWorkflowSummary } from "@opencode-ai/sdk/v2"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider } from "../../src/keymap"
import { createSignal } from "solid-js"
import dagInspectorPlugin from "../../src/feature-plugins/system/dag-inspector"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

const SESSION_ID = "ses_1"

const wfSummary = (overrides: Partial<DagWorkflowSummary> = {}): DagWorkflowSummary => ({
  id: "wf-1",
  title: "Test workflow",
  status: "running",
  nodeCount: 2,
  completedNodes: 0,
  runningNodes: 0,
  failedNodes: 0,
  skippedNodes: 0,
  queuedNodes: 0,
  ...overrides,
})

type RenderOpts = {
  workflows?: DagWorkflowSummary[]
  serverWorkflows?: DagWorkflowSummary[]
  nodes?: DagNode[]
  initialRoute?: TuiRouteCurrent
  summary?: (sessionID: string) => Promise<{ data: DagWorkflowSummary[] }>
}

function dagNode(overrides: Partial<DagNode> & { id: string }): DagNode {
  return {
    workflow_id: "wf-1",
    name: overrides.id,
    status: "pending",
    worker_type: "build",
    required: false,
    depends_on: [],
    ...overrides,
  }
}

async function renderDagInspector(opts: RenderOpts = {}) {
  const commands = new Map<
    string,
    NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]
  >()
  const [current, setCurrent] = createSignal<TuiRouteCurrent>(opts.initialRoute ?? { name: "dag", params: { sessionID: SESSION_ID } })
  let renderInspector: TuiRouteDefinition["render"] | undefined

  // Updatable workflow state for change detection.
  let workflowsState = opts.workflows ?? []

  // Trackable spies
  const nodesCalls: string[] = []
  const controlCalls: { dagID: string; operation: string }[] = []
  const commandCalls: unknown[] = []
  const navigations: { name: string; params?: Record<string, unknown> }[] = []
  const toasts: { variant?: string; message: string }[] = []
  const eventHandlers = new Map<string, (event: never) => void>()

  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const registerLayer = keymap.registerLayer.bind(keymap)
    keymap.registerLayer = (layer) => {
      layer.commands?.forEach((command) => commands.set(command.name, command))
      return registerLayer(layer)
    }
    const base = createTuiPluginApi({
      keymap,
      client: {
        dag: {
          summary: async (input: { sessionID: string }) =>
            opts.summary?.(input.sessionID) ?? { data: opts.serverWorkflows ?? workflowsState },
          nodes: async (input: { dagID: string }) => {
            nodesCalls.push(input.dagID)
            return { data: opts.nodes ?? [] }
          },
          control: async (input: { dagID: string; operation: string }) => {
            controlCalls.push(input)
            return { data: undefined }
          },
        },
        session: {
          command: async (input: unknown) => {
            commandCalls.push(input)
            return { data: undefined }
          },
        },
      } as unknown as TuiPluginApi["client"],
      state: {
        session: {
          dag: () => workflowsState,
        },
      },
      event: {
        on: ((type: string, handler: (event: never) => void) => {
          eventHandlers.set(type, handler)
          return () => eventHandlers.delete(type)
        }) as unknown as TuiPluginApi["event"]["on"],
      } as TuiPluginApi["event"],
    })
    const api = {
      ...base,
      route: {
        register(routes) {
          renderInspector = routes.find((route) => route.name === "dag")?.render
          return () => {}
        },
        navigate(name, params) {
          navigations.push({ name, params })
          setCurrent(params ? { name, params } : { name })
        },
        get current() {
          return current()
        },
      },
      ui: {
        ...base.ui,
        toast: (t: { variant?: string; message: string }) => toasts.push(t),
      },
    } satisfies TuiPluginApi

    void dagInspectorPlugin.tui(api, undefined, undefined as never)

    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                {(() => {
                  const route = current()
                  if (route.name !== "dag") return null
                  const params = "params" in route ? route.params : undefined
                  return renderInspector?.({ params })
                })()}
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await waitForCommand(app, commands, "dag.open")
  if (current().name === "dag") await waitForCommand(app, commands, "dag.close")
  // Give the initial fetchNodes a chance to resolve.
  if (workflowsState.length > 0) await waitForCondition(() => nodesCalls.length > 0)

  return {
    app,
    commands,
    navigations: () => navigations,
    commandCalls: () => commandCalls,
    toasts: () => toasts,
    nodesCalls: () => nodesCalls,
    controlCalls: () => controlCalls,
    setWorkflows: (wfs: DagWorkflowSummary[]) => {
      workflowsState = wfs
    },
    emitSummaryUpdate: (sessionID: string = SESSION_ID) => {
      eventHandlers.get("dag.workflow.summary.updated")?.({
        type: "dag.workflow.summary.updated",
        properties: { sessionID, summaries: workflowsState },
      } as never)
    },
    current: () => current(),
    setRoute: setCurrent,
  }
}

async function waitForCommand(
  app: Awaited<ReturnType<typeof testRender>>,
  commands: Map<string, unknown>,
  name: string,
  timeout = 2000,
) {
  const start = Date.now()
  while (!commands.has(name)) {
    if (Date.now() - start > timeout) throw new Error(`command "${name}" not registered`)
    await app.renderOnce()
    await Bun.sleep(5)
  }
}

async function waitForCondition(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("DagInspector", () => {
  test("/dag dispatches dag.open locally without submitting a model command", async () => {
    const returnRoute = { name: "session", params: { sessionID: SESSION_ID } }
    const viewer = await renderDagInspector({ initialRoute: returnRoute })
    try {
      expect(viewer.commands.get("dag.open")?.slashName).toBe("dag")
      viewer.commands.get("dag.open")!.run?.({} as never)
      await waitForCommand(viewer.app, viewer.commands, "dag.close")

      expect(viewer.navigations().at(-1)).toEqual({
        name: "dag",
        params: { sessionID: SESSION_ID, returnRoute },
      })
      expect(viewer.commandCalls()).toEqual([])
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("opening dag refreshes workflows from the server when sync state is empty", async () => {
    const viewer = await renderDagInspector({
      serverWorkflows: [wfSummary({ id: "wf-server", title: "Live server workflow", nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", workflow_id: "wf-server", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Live server workflow"))
      expect(viewer.nodesCalls()).toContain("wf-server")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("opening dag without visible workflows renders an explanatory empty state", async () => {
    const viewer = await renderDagInspector()
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("No workflows"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("switching sessions clears the previous server snapshot before the new fetch resolves", async () => {
    let resolveSecond: ((value: { data: DagWorkflowSummary[] }) => void) | undefined
    const second = new Promise<{ data: DagWorkflowSummary[] }>((resolve) => {
      resolveSecond = resolve
    })
    const viewer = await renderDagInspector({
      summary: (sessionID) =>
        sessionID === SESSION_ID
          ? Promise.resolve({ data: [wfSummary({ title: "Previous session workflow" })] })
          : second,
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("Previous session workflow"))
      viewer.setRoute({ name: "dag", params: { sessionID: "ses_2" } })
      await viewer.app.waitForFrame(
        (frame) => frame.includes("Loading workflows...") && !frame.includes("Previous session workflow"),
      )
    } finally {
      resolveSecond?.({ data: [] })
      viewer.app.renderer.destroy()
    }
  })

  test("mounting fetches nodes for the auto-selected workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      expect(viewer.nodesCalls()).toContain("wf-1")
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("changed summary for the open session triggers a node re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      // Update the workflow summary to show a change in completedNodes.
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 1 })])
      viewer.emitSummaryUpdate()
      await waitForCondition(() => viewer.nodesCalls().length > before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("summary for another session does not trigger a re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 1 })])
      // Emit for a different session — should be filtered out.
      viewer.emitSummaryUpdate("other_session")
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("unchanged summary does not trigger a re-fetch", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", completedNodes: 0 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      const before = viewer.nodesCalls().length
      // Don't change the workflow state — signature stays the same.
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("closing the inspector prevents further fetches", async () => {
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag", params: { sessionID: SESSION_ID, returnRoute: { name: "session", params: { sessionID: SESSION_ID } } } },
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      // Close the inspector — navigates away, unmounts the component.
      viewer.commands.get("dag.close")!.run?.({} as never)
      await Bun.sleep(20)

      const before = viewer.nodesCalls().length
      // After close, summary changes should NOT trigger fetches.
      viewer.setWorkflows([wfSummary({ id: "wf-1", completedNodes: 5 })])
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter navigates into the selected node's child session", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running", child_session_id: "child_ses_1" })],
    })
    try {
      viewer.commands.get("dag.enter")!.run?.({} as never)
      expect(viewer.navigations()).toContainEqual(
        expect.objectContaining({ name: "session", params: expect.objectContaining({ sessionID: "child_ses_1" }) }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("pressing Enter navigates into the selected node's child session", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running", child_session_id: "child_ses_1" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      viewer.app.mockInput.pressEnter()
      await waitForCondition(() => viewer.navigations().some((item) => item.name === "session"))
      expect(viewer.navigations()).toContainEqual(
        expect.objectContaining({ name: "session", params: expect.objectContaining({ sessionID: "child_ses_1" }) }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("pressing p pauses a running workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "running" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      viewer.app.mockInput.pressKey("p")
      await waitForCondition(() => viewer.controlCalls().length > 0)
      expect(viewer.controlCalls()).toContainEqual({ dagID: "wf-1", operation: "pause" })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("pressing p pauses a stepping workflow", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "stepping" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      viewer.app.mockInput.pressKey("p")
      await waitForCondition(() => viewer.controlCalls().length > 0)
      expect(viewer.controlCalls()).toContainEqual({ dagID: "wf-1", operation: "pause" })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("pressing p on a terminal workflow explains why pause is unavailable", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", status: "completed", completedNodes: 2 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "completed" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("build"))
      viewer.app.mockInput.pressKey("p")
      await waitForCondition(() => viewer.toasts().length > 0)
      expect(viewer.controlCalls()).toEqual([])
      expect(viewer.toasts().at(-1)?.message).toMatch(/completed.*cannot be paused/i)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("the inspector leaves a blank outer row below its footer", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "running" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => {
        const rows = frame.split("\n")
        const footer = rows.findIndex((row) => row.includes("open session"))
        return footer >= 0 && rows.slice(footer + 1).some((row) => row.trim() === "")
      })
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.enter toasts when the node has no child session yet", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1" })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "pending" })],
    })
    try {
      viewer.commands.get("dag.enter")!.run?.({} as never)
      expect(viewer.toasts().some((t) => /no session/i.test(t.message))).toBe(true)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("dag.close navigates back to the return route", async () => {
    const returnRoute = { name: "session", params: { sessionID: SESSION_ID } }
    const viewer = await renderDagInspector({
      initialRoute: { name: "dag", params: { sessionID: SESSION_ID, returnRoute } },
      workflows: [wfSummary({ id: "wf-1" })],
    })
    try {
      viewer.commands.get("dag.close")!.run?.({} as never)
      expect(viewer.navigations().at(-1)).toEqual(
        expect.objectContaining({ name: "session", params: { sessionID: SESSION_ID } }),
      )
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("changing workflow replaces subscriptions so only the new selection refreshes", async () => {
    const viewer = await renderDagInspector({
      workflows: [
        wfSummary({ id: "wf-1", completedNodes: 0, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 0, nodeCount: 2 }),
      ],
      nodes: [dagNode({ id: "n-1", workflow_id: "wf-1", name: "build", status: "running" })],
    })
    try {
      // Auto-selection picks wf-1; its initial fetch has resolved.
      await waitForCondition(() => viewer.nodesCalls().some((id) => id === "wf-1"))

      // Switch selection wf-1 -> wf-2.
      viewer.commands.get("dag.next_workflow")!.run?.({} as never)
      // The new selection fetches wf-2's nodes.
      await waitForCondition(() => viewer.nodesCalls().some((id) => id === "wf-2"))

      const before = viewer.nodesCalls().length
      // Now change ONLY wf-1's summary (the previously selected workflow).
      // Because the subscription now tracks wf-2's signature, wf-1's change
      // alone must NOT trigger a fetch.
      viewer.setWorkflows([
        wfSummary({ id: "wf-1", completedNodes: 1, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 0, nodeCount: 2 }),
      ])
      viewer.emitSummaryUpdate()
      await Bun.sleep(50)
      expect(viewer.nodesCalls().length).toBe(before)

      // Changing wf-2's summary DOES refresh (the active selection).
      viewer.setWorkflows([
        wfSummary({ id: "wf-1", completedNodes: 1, nodeCount: 2 }),
        wfSummary({ id: "wf-2", completedNodes: 2, nodeCount: 2 }),
      ])
      viewer.emitSummaryUpdate()
      await waitForCondition(() => viewer.nodesCalls().length > before)
    } finally {
      viewer.app.renderer.destroy()
    }
  })

  test("a failed node renders its error_reason in the inspector", async () => {
    const viewer = await renderDagInspector({
      workflows: [wfSummary({ id: "wf-1", failedNodes: 1, nodeCount: 1 })],
      nodes: [dagNode({ id: "n-1", name: "build", status: "failed", error_reason: "compile error in main.ts" })],
    })
    try {
      await viewer.app.waitForFrame((frame) => frame.includes("compile error in main.ts"))
    } finally {
      viewer.app.renderer.destroy()
    }
  })
})
