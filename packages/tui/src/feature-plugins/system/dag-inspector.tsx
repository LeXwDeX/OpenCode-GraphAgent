// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, Show, Switch, Match, createSignal, createEffect, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Spinner } from "../../component/spinner"
import { useBindings, useCommandShortcut } from "../../keymap"
import { selectedForeground, useTheme } from "../../context/theme"
import {
  computeNodeRowIndex,
  computeWaves,
  dagControlProgressMessage,
  dagControlUnavailableMessage,
  dagNodeGlyph,
  dagNodeHistoryLabel,
  dagStatusColor,
  formatDagDeadline,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  formatDagProgress,
  dagEscalationLabel,
  type DagControlOperation,
  type DagNode,
} from "./dag-inspector-utils"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"
// The workflow list is primary navigation, not ambient metadata, so it is
// always present. It only narrows on small terminals — never disappears.
const NAV_WIDTH_MAX = 32
const NAV_WIDTH_MIN = 18
const NAV_WIDTH_SHARE = 0.3
// Node detail content rows: header, dependencies, error/output preview. The
// detail block adds two padding rows on top; fixed so changing the selection
// never moves the footer.
const NODE_DETAIL_HEIGHT = 3

function scrollRowIntoView(scroll: ScrollBoxRenderable | undefined, index: number) {
  if (!scroll) return
  if (index < scroll.scrollTop) {
    scroll.scrollTo(index)
    return
  }
  if (index >= scroll.scrollTop + scroll.viewport.height) {
    scroll.scrollTo(index - scroll.viewport.height + 1)
  }
}

const ACTIVE_WORKFLOW_STATUSES = new Set(["running", "paused", "stepping"])

function cancelActiveWorkflow(api: TuiPluginApi) {
  const current = api.route.current
  const params = ("params" in current ? current.params : undefined) as { sessionID?: string } | undefined
  const sessionID = params?.sessionID
  if (!sessionID) {
    api.ui.toast({ variant: "info", message: "No session selected for DAG cancellation" })
    return
  }
  void api.client.dag
    .summary({ sessionID })
    .then((response) => {
      const active = (response.data ?? []).filter((workflow) =>
        ACTIVE_WORKFLOW_STATUSES.has(workflow.status),
      )
      if (active.length === 0) {
        api.ui.toast({ variant: "info", message: "No active DAG workflow to cancel" })
        return
      }
      if (active.length > 1) {
        api.ui.toast({ variant: "info", message: "Multiple active workflows; select one in the DAG inspector" })
        api.route.navigate(ROUTE, { sessionID, returnRoute: current })
        api.ui.dialog.clear()
        return
      }
      const workflow = active[0]
      if (!workflow) return
      void api.client.dag.control({ dagID: workflow.id, operation: "cancel" }).then(() => {
        api.ui.toast({ variant: "info", message: `Workflow ${workflow.title} cancel requested` })
        api.ui.dialog.clear()
      })
    })
    .catch((error: unknown) => {
      api.ui.toast({
        variant: "error",
        message: `DAG cancel failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
}

function DagInspector(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  // The plugin-facing theme omits the resolver flags selectedForeground needs,
  // so the full theme comes from the context, as in the diff viewer.
  const themeState = useTheme()
  const dimensions = useTerminalDimensions()
  // Navigation stays on screen at every width; it yields columns to the wave
  // list instead of vanishing, which is what a primary navigation pane owes.
  const navWidth = createMemo(() =>
    Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, Math.floor(dimensions().width * NAV_WIDTH_SHARE))),
  )
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | { sessionID?: string; returnRoute?: { name: string; params?: Record<string, unknown> } }
      | undefined

  const [selectedWorkflow, setSelectedWorkflow] = createSignal<string | undefined>(undefined)
  const [selectedNode, setSelectedNode] = createSignal<string | undefined>(undefined)
  const [nodes, setNodes] = createSignal<DagNode[]>([])
  const [fetchedWorkflows, setFetchedWorkflows] = createSignal<ReadonlyArray<DagWorkflowSummary> | undefined>()
  const [workflowLoad, setWorkflowLoad] = createSignal<"loading" | "loaded" | "error">("loading")
  const [actionMessage, setActionMessage] = createSignal<string | undefined>()
  let workflowScroll: ScrollBoxRenderable | undefined
  let nodeScroll: ScrollBoxRenderable | undefined

  const workflows = createMemo(() => {
    const sid = params()?.sessionID
    if (!sid) return []
    const synced = props.api.state.session.dag(sid)
    return synced.length > 0 ? synced : (fetchedWorkflows() ?? [])
  })

  // Refresh authoritative state when the inspector opens. Summary events are
  // ephemeral, so the shared sync slice can legitimately be empty after a
  // missed event even though the workflow exists on the server.
  createEffect(() => {
    const sessionID = params()?.sessionID
    if (!sessionID) {
      setFetchedWorkflows([])
      setWorkflowLoad("loaded")
      return
    }
    setFetchedWorkflows([])
    setSelectedWorkflow(undefined)
    setSelectedNode(undefined)
    setNodes([])
    setActionMessage(undefined)
    setWorkflowLoad("loading")
    void props.api.client.dag
      .summary({ sessionID })
      .then((response) => {
        if (params()?.sessionID !== sessionID) return
        setFetchedWorkflows(response.data ?? [])
        setWorkflowLoad("loaded")
      })
      .catch(() => {
        if (params()?.sessionID !== sessionID) return
        setWorkflowLoad("error")
      })
  })

  // Keep a valid workflow selected: adopt the first workflow when nothing is
  // selected or the previous selection disappeared (e.g. session switch).
  createEffect(() => {
    const wfs = workflows()
    const sel = selectedWorkflow()
    if (sel && wfs.some((w) => w.id === sel)) return
    setSelectedWorkflow(wfs[0]?.id)
  })

  // Fetch nodes for the selected workflow. Guard against stale responses: if the
  // user switched workflows between fetch-start and fetch-resolve, discard the result.
  const fetchNodes = async (dagID: string) => {
    try {
      const res = await props.api.client.dag.nodes({ dagID })
      // Discard if the user selected a different workflow while this fetch was in flight.
      if (selectedWorkflow() !== dagID) return
      setNodes(res.data ?? [])
    } catch {
      if (selectedWorkflow() !== dagID) return
      setNodes([])
    }
  }

  // Per-workflow summary signature for change detection. Only re-fetch nodes
  // when the selected workflow's node-level state actually changes.
  let lastSignature = ""

  const signatureFor = (wfId: string): string => {
    const sid = params()?.sessionID
    if (!sid) return ""
    const wfs = props.api.state.session.dag(sid)
    const wf = wfs.find((w) => w.id === wfId)
    if (!wf) return ""
    return `${wf.nodeCount}:${wf.completedNodes}:${wf.runningNodes}:${wf.failedNodes}`
  }

  createEffect(() => {
    const wf = selectedWorkflow()
    if (!wf) {
      setNodes([])
      lastSignature = ""
      return
    }
    // Snapshot the signature at open time so the first summary event after
    // open has something to compare against.
    lastSignature = signatureFor(wf)
    void fetchNodes(wf)
    // Re-fetch nodes only when a summary event for THIS session indicates the
    // selected workflow's node-level state changed. Summary events for other
    // sessions and unchanged summaries do not trigger a fetch.
    const sid = params()?.sessionID
    const off = props.api.event.on("dag.workflow.summary.updated", (event) => {
      if (!sid || event.properties.sessionID !== sid) return
      const sig = signatureFor(wf)
      if (sig === lastSignature) return
      lastSignature = sig
      void fetchNodes(wf)
    })
    onCleanup(() => off())
  })

  const layers = createMemo(() => computeWaves(nodes()))

  // Flattened topological order — the traversal order for keyboard navigation.
  const orderedNodes = createMemo(() => layers().flat())

  // Keep a valid node selected as node data changes (replan can remove nodes).
  createEffect(() => {
    const ns = orderedNodes()
    const sel = selectedNode()
    if (sel && ns.some((n) => n.id === sel)) return
    setSelectedNode(ns[0]?.id)
  })

  // Keep the selected workflow visible in the (unsliced) scrollable list.
  createEffect(() => {
    const sel = selectedWorkflow()
    if (!sel) return
    const index = workflows().findIndex((w) => w.id === sel)
    if (index === -1) return
    const scrollSelected = () => scrollRowIntoView(workflowScroll, index)
    scrollSelected()
    requestAnimationFrame(scrollSelected)
  })

  // Keep the selected node visible inside the wave list.
  createEffect(() => {
    const sel = selectedNode()
    if (!sel) return
    const row = computeNodeRowIndex(layers(), sel)
    if (row === undefined) return
    const scrollSelected = () => scrollRowIntoView(nodeScroll, row)
    scrollSelected()
    requestAnimationFrame(scrollSelected)
  })

  const moveNode = (delta: number) => {
    const ns = orderedNodes()
    if (ns.length === 0) return
    const idx = ns.findIndex((n) => n.id === selectedNode())
    const next = idx === -1 ? 0 : Math.min(ns.length - 1, Math.max(0, idx + delta))
    setSelectedNode(ns[next]?.id)
  }

  const moveWorkflow = (delta: number) => {
    const wfs = workflows()
    if (wfs.length === 0) return
    const idx = wfs.findIndex((w) => w.id === selectedWorkflow())
    const next = idx === -1 ? 0 : Math.min(wfs.length - 1, Math.max(0, idx + delta))
    setSelectedWorkflow(wfs[next]?.id)
  }

  const control = (operation: DagControlOperation) => {
    const wf = selectedWorkflow()
    if (!wf) return
    const workflow = workflows().find((item) => item.id === wf)
    const unavailable = dagControlUnavailableMessage(workflow?.status, operation)
    if (unavailable) {
      const message = unavailable
      setActionMessage(message)
      props.api.ui.toast({ variant: "info", message })
      return
    }
    setActionMessage(dagControlProgressMessage(operation))
    void props.api.client.dag
      .control({ dagID: wf, operation })
      .then(() => {
        setActionMessage(`Workflow ${operation} requested`)
        return fetchNodes(wf)
      })
      .catch((error: unknown) => {
        const message = `DAG ${operation} failed: ${error instanceof Error ? error.message : String(error)}`
        setActionMessage(message)
        props.api.ui.toast({
          variant: "error",
          message,
        })
      })
  }

  const enterNode = () => {
    const node = orderedNodes().find((n) => n.id === selectedNode())
    if (!node) return
    if (!node.child_session_id) {
      const message = "Node has no session yet"
      setActionMessage(message)
      props.api.ui.toast({ variant: "info", message })
      return
    }
    props.api.ui.dialog.clear()
    props.api.route.navigate("session", {
      sessionID: node.child_session_id,
      returnRoute: params()?.returnRoute,
    })
  }

  const close = () => {
    const returnRoute = params()?.returnRoute
    props.api.ui.dialog.clear()
    props.api.route.navigate(returnRoute?.name ?? "home", returnRoute?.params)
  }

  const commands = [
    {
      name: "dag.close",
      title: "Close DAG inspector",
      category: "Workflow",
      run: close,
    },
    {
      name: "dag.enter",
      title: "Enter selected node's session",
      category: "Workflow",
      run: enterNode,
    },
    {
      name: "dag.down",
      title: "Select next DAG node",
      category: "Workflow",
      run() {
        moveNode(1)
      },
    },
    {
      name: "dag.up",
      title: "Select previous DAG node",
      category: "Workflow",
      run() {
        moveNode(-1)
      },
    },
    {
      name: "dag.next_workflow",
      title: "Select next DAG workflow",
      category: "Workflow",
      run() {
        moveWorkflow(1)
      },
    },
    {
      name: "dag.previous_workflow",
      title: "Select previous DAG workflow",
      category: "Workflow",
      run() {
        moveWorkflow(-1)
      },
    },
    {
      name: "dag.pause",
      title: "Pause selected workflow",
      category: "Workflow",
      namespace: "palette",
      run() {
        control("pause")
      },
    },
    {
      name: "dag.resume",
      title: "Resume selected workflow",
      category: "Workflow",
      namespace: "palette",
      run() {
        control("resume")
      },
    },
    {
      name: "dag.step",
      title: "Step selected workflow (run one node)",
      category: "Workflow",
      namespace: "palette",
      run() {
        control("step")
      },
    },
    {
      name: "dag.cancel",
      title: "Cancel selected workflow",
      category: "Workflow",
      namespace: "palette",
      run() {
        control("cancel")
      },
    },
  ]

  useBindings(() => ({
    commands,
    bindings: props.api.tuiConfig.keybinds.gather(
      "dag",
      commands.map((command) => command.name),
    ),
  }))

  const closeShortcut = useCommandShortcut("dag.close")
  const enterShortcut = useCommandShortcut("dag.enter")

  const selectedWorkflowSummary = createMemo(() => workflows().find((workflow) => workflow.id === selectedWorkflow()))
  const selectedNodeDetail = createMemo(() => orderedNodes().find((node) => node.id === selectedNode()))

  // Footer advertises only the cursor-level affordances. Control operations
  // (pause/resume/step/cancel) are unbound by default and reached through the
  // command palette, so they never crowd this row.
  const footerHints = createMemo(() =>
    [
      { key: enterShortcut(), label: "open session" },
      { key: closeShortcut(), label: "close" },
    ].filter((hint) => hint.key !== ""),
  )

  // 1s tick driving the running-node deadline countdown. Only active while the
  // selected node is actually counting down — idle inspectors don't re-render.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const detail = selectedNodeDetail()
    if (!detail || (detail.status !== "running" && detail.status !== "queued")) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const statusColor = (status: string) => dagStatusColor(theme(), status)
  // Readable foreground against the primary-filled cursor row, the same helper
  // the select dialog uses for its active option.
  const selectedFg = () => selectedForeground(themeState.theme, themeState.theme.primary)

  return (
    <box width="100%" height="100%">
      {/* Title row — identity, subject, scale. Bold reserved for identity. */}
      <box flexDirection="row" gap={1} flexShrink={0} paddingTop={1} paddingLeft={2} paddingRight={2}>
        <text fg={theme().text} flexShrink={0}>
          <b>DAG</b>
        </text>
        <box flexGrow={1} minWidth={0}>
          <text fg={theme().textMuted} wrapMode="none">
            {selectedWorkflowSummary()?.title ?? "workflow inspector"}
          </text>
        </box>
        <text fg={theme().textMuted} flexShrink={0}>
          {workflows().length} {workflows().length === 1 ? "workflow" : "workflows"}
        </text>
      </box>

      <box flexGrow={1} minHeight={0} flexDirection="row" marginTop={1}>
        {/* Navigation pane — a distinct region marked by the panel surface and
            its own padding rhythm rather than a drawn frame. Always present. */}
        <box
          width={navWidth()}
          flexShrink={0}
          minHeight={0}
          backgroundColor={theme().backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
        >
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (workflowScroll = element)}
            flexGrow={1}
            minHeight={0}
            verticalScrollbarOptions={{ visible: false }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            <For each={workflows()}>
              {(wf) => {
                const selected = () => selectedWorkflow() === wf.id
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    width="100%"
                    backgroundColor={selected() ? theme().backgroundElement : undefined}
                    onMouseUp={() => setSelectedWorkflow(wf.id)}
                  >
                    <text fg={statusColor(wf.status)} flexShrink={0}>
                      •
                    </text>
                    <box flexGrow={1} minWidth={0}>
                      <text fg={theme().text} wrapMode="none">
                        {wf.title}
                      </text>
                    </box>
                    <text fg={theme().textMuted} flexShrink={0}>
                      {formatDagProgress(wf)}
                      {dagEscalationLabel(wf) ? ` ${dagEscalationLabel(wf)}` : ""}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </box>

        {/* Content pane — waves and nodes. */}
        <box flexGrow={1} minWidth={0} minHeight={0} paddingTop={1} paddingLeft={2} paddingRight={2}>
          <box flexGrow={1} minHeight={0}>
            <Switch>
              <Match when={workflowLoad() === "loading" && workflows().length === 0}>
                <Spinner color={theme().textMuted}>Loading workflows...</Spinner>
              </Match>
              <Match when={workflowLoad() === "error" && workflows().length === 0}>
                <text fg={theme().error}>Unable to load workflows</text>
              </Match>
              <Match when={workflows().length === 0}>
                <text fg={theme().text}>No workflows for this session</text>
                <box marginTop={1}>
                  <text fg={theme().textMuted}>
                    {"Run /dag-auto <task> inside a session to start an orchestration"}
                  </text>
                </box>
              </Match>
              <Match when={workflows().length > 0}>
                {/* Status line — state colour plus muted scale, one row. */}
                <box flexShrink={0}>
                  <text wrapMode="none">
                    <span style={{ fg: statusColor(selectedWorkflowSummary()?.status ?? "") }}>
                      {selectedWorkflowSummary()?.status ?? "unknown"}
                    </span>
                    <span style={{ fg: theme().textMuted }}>
                      {" · "}
                      {nodes().length} {nodes().length === 1 ? "node" : "nodes"} · {layers().length}{" "}
                      {layers().length === 1 ? "wave" : "waves"}
                    </span>
                    <Show when={actionMessage()}>
                      <span style={{ fg: theme().warning }}> · {actionMessage()}</span>
                    </Show>
                  </text>
                </box>
                <scrollbox
                  ref={(element: ScrollBoxRenderable) => (nodeScroll = element)}
                  flexGrow={1}
                  minHeight={0}
                  marginTop={1}
                  verticalScrollbarOptions={{ visible: false }}
                  horizontalScrollbarOptions={{ visible: false }}
                >
                  <For each={layers()}>
                    {(layer, layerIdx) => (
                      <>
                        {/* Blank spacer between waves keeps the blocks visually
                                separate; computeNodeRowIndex counts it for scrolling. */}
                        {layerIdx() !== 0 ? <box height={1} /> : null}
                        {/* Wave header: nodes at the same topological depth, NOT a barrier.
                                Bold title plus muted count, like the sidebar's MCP section. */}
                        <box flexDirection="row" gap={1} width="100%">
                          <text fg={theme().text} wrapMode="none">
                            <b>wave {layerIdx() + 1}</b>
                          </text>
                          <text fg={theme().textMuted} wrapMode="none">
                            · {layer.length} {layer.length === 1 ? "node" : "nodes"}
                          </text>
                        </box>
                        <For each={layer}>
                          {(node) => {
                            const selected = () => selectedNode() === node.id
                            const settled = () =>
                              node.status === "completed" ||
                              node.status === "skipped" ||
                              node.status === "cancelled" ||
                              node.status === "aborted"
                            return (
                              <box
                                flexDirection="row"
                                gap={1}
                                width="100%"
                                paddingLeft={2}
                                backgroundColor={selected() ? theme().primary : undefined}
                                onMouseUp={() => setSelectedNode(node.id)}
                              >
                                <Show
                                  when={node.status !== "running"}
                                  fallback={<Spinner color={selected() ? selectedFg() : theme().textMuted} />}
                                >
                                  <text fg={selected() ? selectedFg() : statusColor(node.status)} flexShrink={0}>
                                    {dagNodeGlyph(node.status)}
                                  </text>
                                </Show>
                                <box flexShrink={1} minWidth={0}>
                                  <text
                                    fg={
                                      selected()
                                        ? selectedFg()
                                        : node.status === "failed"
                                          ? theme().error
                                          : settled()
                                            ? theme().textMuted
                                            : theme().text
                                    }
                                    wrapMode="none"
                                  >
                                    {node.name}
                                  </text>
                                </box>
                                <text fg={selected() ? selectedFg() : theme().textMuted} wrapMode="none" flexShrink={0}>
                                  {node.worker_type}
                                </text>
                              </box>
                            )
                          }}
                        </For>
                      </>
                    )}
                  </For>
                </scrollbox>
                {/* Node detail — a distinct region on the panel surface, fixed
                    height so selection changes never move the footer. */}
                <box
                  flexShrink={0}
                  marginTop={1}
                  height={NODE_DETAIL_HEIGHT + 2}
                  flexDirection="column"
                  paddingTop={1}
                  paddingBottom={1}
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={theme().backgroundPanel}
                >
                  <Show when={selectedNodeDetail()}>
                    {(node) => (
                      <>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme().text} wrapMode="none" flexShrink={0}>
                            {node().name}
                          </text>
                          <text fg={theme().textMuted} wrapMode="none">
                            {node().worker_type}
                            {node().model_id ? ` · ${node().model_id}` : ""}
                            {formatDagDuration(node().started_at, node().completed_at)
                              ? ` · ${formatDagDuration(node().started_at, node().completed_at)}`
                              : ""}
                            {dagNodeHistoryLabel(node()) ? ` · ${dagNodeHistoryLabel(node())}` : ""}
                          </text>
                          <Show when={formatDagDeadline(node().status, node().deadline_ms, now())}>
                            {(deadline) => (
                              <text wrapMode="none" flexShrink={0}>
                                <span style={{ fg: theme().textMuted }}>·</span>{" "}
                                <span style={{ fg: deadline() === "overdue" ? theme().error : theme().warning }}>
                                  {deadline()}
                                </span>
                              </text>
                            )}
                          </Show>
                        </box>
                        <Show when={node().depends_on.length > 0}>
                          <text fg={theme().textMuted} wrapMode="none">
                            depends on {node().depends_on.join(", ")}
                          </text>
                        </Show>
                        <Switch>
                          <Match when={node().error_reason}>
                            <text fg={theme().error} wrapMode="none">
                              {formatDagError(node().error_reason!)}
                            </text>
                          </Match>
                          <Match when={formatDagOutputPreview(node().output)}>
                            <text fg={theme().textMuted} wrapMode="none">
                              {formatDagOutputPreview(node().output)}
                            </text>
                          </Match>
                        </Switch>
                      </>
                    )}
                  </Show>
                </box>
              </Match>
            </Switch>
          </box>
        </box>
      </box>

      {/* Footer hints — key in text colour, label muted, full width. */}
      <box flexDirection="row" gap={2} flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <For each={footerHints()}>
          {(hint) => (
            <text fg={theme().text} wrapMode="none">
              {hint.key} <span style={{ fg: theme().textMuted }}>{hint.label}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <DagInspector api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "dag.open",
        title: "Open DAG inspector",
        slashName: "dag",
        category: "Workflow",
        namespace: "palette",
        run() {
          const current = api.route.current
          const sessionID = "params" in current ? current.params?.sessionID : undefined
          api.route.navigate(ROUTE, {
            sessionID,
            returnRoute: current,
          })
          api.ui.dialog.clear()
        },
      },
      {
        name: "dag.cancel.active",
        title: "Cancel active DAG workflow",
        slashName: "dag-cancel",
        category: "Workflow",
        namespace: "palette",
        run() {
          cancelActiveWorkflow(api)
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
