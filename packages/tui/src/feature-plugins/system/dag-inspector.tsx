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
  dagControlProgressMessage,
  dagControlUnavailableMessage,
  dagNodeGlyph,
  dagStatusColor,
  formatDagDuration,
  formatDagError,
  formatDagOutputPreview,
  type DagControlOperation,
  type DagNode,
} from "./dag-inspector-utils"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"
const WORKFLOW_LIST_WIDTH = 32

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

  const statusColor = (status: string) => dagStatusColor(theme(), status)

  return (
    <box width="100%" height="100%">
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
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
                              {Number(wf.completedNodes)}/{Number(wf.nodeCount)}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </scrollbox>
                </Panel>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start="edge-out" />
                  <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
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
                          {/* Wave header: nodes at the same topological depth, NOT a barrier */}
                          <box flexDirection="row" gap={1} width="100%" paddingLeft={1}>
                            <text fg={theme().textMuted} wrapMode="none">
                              wave {layerIdx() + 1} · {layer.length} {layer.length === 1 ? "node" : "nodes"}
                            </text>
                          </box>
                          <For each={layer}>
                            {(node) => {
                              const selected = () => selectedNode() === node.id
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
                                    fallback={<Spinner color={selected() ? theme().background : theme().textMuted} />}
                                  >
                                    <text fg={selected() ? theme().background : statusColor(node.status)} flexShrink={0}>
                                      {dagNodeGlyph(node.status)}
                                    </text>
                                  </Show>
                                  <box flexGrow={1} minWidth={0}>
                                    <text
                                      fg={
                                        selected()
                                          ? theme().background
                                          : node.status === "running"
                                            ? theme().text
                                            : theme().textMuted
                                      }
                                      wrapMode="none"
                                    >
                                      {node.name}
                                    </text>
                                  </box>
                                  <text fg={selected() ? theme().background : theme().textMuted} flexShrink={0}>
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
                  <Separator axis="x" start="edge-in" />
                  <Show when={selectedNodeDetail()}>
                    {(node) => (
                      <box flexDirection="column" paddingLeft={1} flexShrink={0}>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme().text} wrapMode="none">
                            {node().name}
                          </text>
                          <text fg={theme().textMuted} wrapMode="none">
                            {node().worker_type}
                            {node().model_id ? ` · ${node().model_id}` : ""}
                            {formatDagDuration(node().started_at, node().completed_at)
                              ? ` · ${formatDagDuration(node().started_at, node().completed_at)}`
                              : ""}
                          </text>
                        </box>
                        <Show when={node().depends_on.length > 0}>
                          <text fg={theme().textMuted} wrapMode="none">
                            depends on {node().depends_on.join(", ")}
                          </text>
                        </Show>
                        <Switch>
                          <Match when={node().error_reason}>
                            <text fg={theme().error} wrapMode="word">
                              {formatDagError(node().error_reason!)}
                            </text>
                          </Match>
                          <Match when={formatDagOutputPreview(node().output)}>
                            <text fg={theme().textMuted} wrapMode="word">
                              {formatDagOutputPreview(node().output)}
                            </text>
                          </Match>
                        </Switch>
                      </box>
                    )}
                  </Show>
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} border="none">
          <Show when={enterShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>open session</span>
              </text>
            )}
          </Show>
          <Show when={pauseShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>pause</span>
              </text>
            )}
          </Show>
          <Show when={resumeShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>resume</span>
              </text>
            )}
          </Show>
          <Show when={stepShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>step</span>
              </text>
            )}
          </Show>
          <Show when={cancelShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>cancel</span>
              </text>
            )}
          </Show>
          <Show when={closeShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>close</span>
              </text>
            )}
          </Show>
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
