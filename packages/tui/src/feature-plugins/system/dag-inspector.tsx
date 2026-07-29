/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, Show, Switch, Match, createSignal, createEffect, onCleanup } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useBindings, useCommandShortcut } from "../../keymap"
import { Panel, PanelGroup, Separator } from "./diff-viewer-ui"
import {
  computeNodeRowIndex,
  computeWaves,
  dagControlAllowed,
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
  type DagControlOperation,
  type DagNode,
} from "./dag-inspector-utils"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"
const WORKFLOW_LIST_WIDTH = 32
// Node detail rows below the wave list: header, dependencies, error/output
// preview. Fixed so changing the selection never moves the footer.
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

function DagInspector(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
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
      setNodes((res.data ?? []) as DagNode[])
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
      run() {
        control("pause")
      },
    },
    {
      name: "dag.resume",
      title: "Resume selected workflow",
      category: "Workflow",
      run() {
        control("resume")
      },
    },
    {
      name: "dag.step",
      title: "Step selected workflow (run one node)",
      category: "Workflow",
      run() {
        control("step")
      },
    },
    {
      name: "dag.cancel",
      title: "Cancel selected workflow",
      category: "Workflow",
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
  const pauseShortcut = useCommandShortcut("dag.pause")
  const resumeShortcut = useCommandShortcut("dag.resume")
  const stepShortcut = useCommandShortcut("dag.step")
  const cancelShortcut = useCommandShortcut("dag.cancel")

  const selectedWorkflowSummary = createMemo(() => workflows().find((workflow) => workflow.id === selectedWorkflow()))
  const selectedNodeDetail = createMemo(() => orderedNodes().find((node) => node.id === selectedNode()))

  // Footer hints mirror the diff-viewer's `key label` vocabulary. Control
  // hints are contextual: only operations valid for the selected workflow's
  // status appear, so pause/resume never advertise a guaranteed no-op.
  const footerHints = createMemo(() => {
    const status = selectedWorkflowSummary()?.status
    return [
      { key: enterShortcut(), label: "open session", show: true },
      { key: pauseShortcut(), label: "pause", show: dagControlAllowed(status, "pause") },
      { key: resumeShortcut(), label: "resume", show: dagControlAllowed(status, "resume") },
      { key: stepShortcut(), label: "step", show: dagControlAllowed(status, "step") },
      { key: cancelShortcut(), label: "cancel", show: dagControlAllowed(status, "cancel") },
      { key: closeShortcut(), label: "close", show: true },
    ].filter((hint) => hint.show && hint.key !== "")
  })

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

  return (
    <box width="100%" height="100%">
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1} paddingRight={1}>
          <text fg={theme().text}>DAG </text>
          <text fg={theme().textMuted}>{selectedWorkflowSummary()?.title ?? "workflow inspector"}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>
            {workflows().length} {workflows().length === 1 ? "workflow" : "workflows"}
          </text>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={workflowLoad() === "loading" && workflows().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>Loading workflows...</text>
              </box>
            </Match>
            <Match when={workflowLoad() === "error" && workflows().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>Unable to load workflows</text>
              </box>
            </Match>
            <Match when={workflows().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>No workflows for this session</text>
              </box>
            </Match>
            <Match when={workflows().length > 0}>
              <PanelGroup axis="x">
                <Panel border="both" width={WORKFLOW_LIST_WIDTH}>
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (workflowScroll = element)}
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
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={selected() ? theme().primary : undefined}
                            onMouseUp={() => setSelectedWorkflow(wf.id)}
                          >
                            <text fg={selected() ? theme().background : statusColor(wf.status)} flexShrink={0}>
                              •
                            </text>
                            <box flexGrow={1} minWidth={0}>
                              <text fg={selected() ? theme().background : theme().text} wrapMode="none">
                                {wf.title}
                              </text>
                            </box>
                            <text fg={selected() ? theme().background : theme().textMuted} flexShrink={0}>
                              {formatDagProgress(wf)}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </scrollbox>
                </Panel>

                {/* The right pane draws its own left border on every content
                    block; the horizontal separators' ┬/├/┴ edge glyphs land in
                    the same column, forming one continuous frame around both
                    panes — the same construction as the diff-viewer's patch
                    pane next to its file tree. */}
                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start="edge-out" />
                  <box
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                    border={["left"]}
                    borderColor={theme().border}
                  >
                    <text fg={statusColor(selectedWorkflowSummary()?.status ?? "")} flexShrink={0}>
                      •
                    </text>
                    <text fg={theme().text}>{selectedWorkflowSummary()?.status ?? "unknown"}</text>
                    <Show when={actionMessage()}>
                      <text fg={theme().warning} wrapMode="none">
                        {actionMessage()}
                      </text>
                    </Show>
                    <box flexGrow={1} />
                    <text fg={theme().textMuted} flexShrink={0}>
                      {nodes().length} {nodes().length === 1 ? "node" : "nodes"} · {layers().length}{" "}
                      {layers().length === 1 ? "wave" : "waves"}
                    </text>
                  </box>
                  <Separator axis="x" start="edge" />
                  {/* Border lives on the wrapper, not the rows, so the left
                      edge stays continuous when the node list is shorter than
                      the viewport. */}
                  <box flexGrow={1} minHeight={0} border={["left"]} borderColor={theme().border}>
                    <scrollbox
                      ref={(element: ScrollBoxRenderable) => (nodeScroll = element)}
                      flexGrow={1}
                      minHeight={0}
                      verticalScrollbarOptions={{ visible: false }}
                      horizontalScrollbarOptions={{ visible: false }}
                    >
                      <For each={layers()}>
                        {(layer, layerIdx) => (
                          <>
                            {/* Blank spacer between waves keeps the blocks visually
                                separate; computeNodeRowIndex counts it for scrolling. */}
                            {layerIdx() !== 0 ? <box height={1} /> : null}
                            {/* Wave header: nodes at the same topological depth, NOT a barrier */}
                            <box flexDirection="row" gap={1} width="100%" paddingLeft={1} paddingRight={1}>
                              <text fg={theme().accent} wrapMode="none">
                                wave {layerIdx() + 1}
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
                                    paddingRight={1}
                                    backgroundColor={selected() ? theme().primary : undefined}
                                    onMouseUp={() => setSelectedNode(node.id)}
                                  >
                                    <Show
                                      when={node.status !== "running"}
                                      fallback={<Spinner color={selected() ? theme().background : theme().textMuted} />}
                                    >
                                      <text
                                        fg={selected() ? theme().background : statusColor(node.status)}
                                        flexShrink={0}
                                      >
                                        {dagNodeGlyph(node.status)}
                                      </text>
                                    </Show>
                                    <box flexShrink={1} minWidth={0}>
                                      <text
                                        fg={
                                          selected() ? theme().background : settled() ? theme().textMuted : theme().text
                                        }
                                        wrapMode="none"
                                      >
                                        {node.name}
                                      </text>
                                    </box>
                                    <text
                                      fg={selected() ? theme().background : theme().textMuted}
                                      wrapMode="none"
                                      flexShrink={0}
                                    >
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
                  </box>
                  <Separator axis="x" start="edge" />
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                    height={NODE_DETAIL_HEIGHT}
                    border={["left"]}
                    borderColor={theme().border}
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
                  {/* Bottom rail: closes the frame flush with the workflow
                      list's bottom border, mirroring the diff-viewer. */}
                  <Separator axis="x" start="edge-in" />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} paddingRight={1} border="none">
          <For each={footerHints()}>
            {(hint) => (
              <text fg={theme().text}>
                {hint.key} <span style={{ fg: theme().textMuted }}>{hint.label}</span>
              </text>
            )}
          </For>
        </Panel>
      </PanelGroup>
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
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
