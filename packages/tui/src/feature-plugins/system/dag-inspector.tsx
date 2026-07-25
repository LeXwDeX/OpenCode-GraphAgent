/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { Spinner } from "../../component/spinner"
import { TextAttributes } from "@opentui/core"
import { useBindings, useCommandShortcut } from "../../keymap"
import {
  computeWaves,
  dagControlProgressMessage,
  dagControlUnavailableMessage,
  formatDagError,
  type DagControlOperation,
  type DagNode,
} from "./dag-inspector-utils"
import type { DagWorkflowSummary } from "@opencode-ai/sdk/v2"

const id = "internal:system-dag-inspector"
const ROUTE = "dag"

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

  const selectedWorkflowSummary = createMemo(() => workflows().find((workflow) => workflow.id === selectedWorkflow()))

  const statusColor = (status: string) => {
    if (status === "completed") return theme().success
    if (status === "failed") return theme().error
    if (status === "running") return theme().textMuted
    if (status === "pending" || status === "queued") return theme().textMuted
    if (status === "skipped" || status === "cancelled") return theme().textMuted
    return theme().text
  }

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <box
        flexDirection="row"
        width="100%"
        flexShrink={0}
        justifyContent="space-between"
        border={["bottom"]}
        borderColor={theme().borderSubtle}
      >
        <box flexDirection="column" paddingBottom={1}>
          <text fg={theme().text} attributes={TextAttributes.BOLD}>
            DAG Inspector
          </text>
          <text fg={theme().textMuted}>Workflow execution overview</text>
        </box>
        <text fg={theme().textMuted}>
          {workflows().length} {workflows().length === 1 ? "workflow" : "workflows"}
        </text>
      </box>

      <box flexDirection="row" width="100%" flexGrow={1} minHeight={0} gap={1}>
        {/* Left column: workflow list */}
        <box width="25.5%" minWidth={20} border={["right"]} borderColor={theme().borderSubtle}>
          <box flexDirection="column" width="100%" paddingRight={1} gap={1}>
            <box flexDirection="row" width="100%" justifyContent="space-between">
              <text fg={theme().text} attributes={TextAttributes.BOLD}>
                Workflows
              </text>
              <text fg={theme().textMuted}>{workflows().length}</text>
            </box>
            <Show when={workflowLoad() === "loading"}>
              <text fg={theme().textMuted}>Loading...</text>
            </Show>
            <Show when={workflowLoad() !== "loading" && workflows().length === 0}>
              <text fg={theme().textMuted}>No workflows</text>
            </Show>
            <For each={workflows().slice(0, 10)}>
              {(wf) => (
                <box
                  flexDirection="column"
                  width="100%"
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => setSelectedWorkflow(wf.id)}
                  style={{ backgroundColor: selectedWorkflow() === wf.id ? theme().backgroundMenu : undefined }}
                >
                  <box flexDirection="row" width="100%" gap={1}>
                    <text fg={selectedWorkflow() === wf.id ? theme().accent : theme().textMuted} flexShrink={0}>
                      {selectedWorkflow() === wf.id ? "›" : " "}
                    </text>
                    <text
                      flexShrink={0}
                      style={{
                        fg: statusColor(wf.status),
                      }}
                    >
                      •
                    </text>
                    <text fg={theme().text} wrapMode="word">
                      {wf.title}
                    </text>
                  </box>
                  <box paddingLeft={4}>
                    <text fg={theme().textMuted}>
                      {Number(wf.completedNodes)}/{Number(wf.nodeCount)} nodes · {wf.status}
                    </text>
                  </box>
                </box>
              )}
            </For>
          </box>
        </box>

        {/* Right column: node tree in topological waves */}
        <box flexGrow={1} minWidth={0} paddingLeft={1}>
          <Show
            when={selectedWorkflow()}
            fallback={
              <text fg={theme().textMuted}>
                {workflowLoad() === "loading"
                  ? "Loading workflows..."
                  : workflowLoad() === "error"
                    ? "Unable to load workflows"
                    : "No workflows for this session"}
              </text>
            }
          >
            <box flexDirection="column" width="100%" gap={1}>
              <box
                flexDirection="column"
                width="100%"
                flexShrink={0}
                paddingBottom={1}
                border={["bottom"]}
                borderColor={theme().borderSubtle}
              >
                <box flexDirection="row" width="100%" justifyContent="space-between">
                  <box flexDirection="column">
                    <text fg={theme().textMuted}>Selected workflow</text>
                    <text fg={theme().text} attributes={TextAttributes.BOLD}>
                      {selectedWorkflowSummary()?.title ?? "Unknown"}
                    </text>
                  </box>
                  <box flexDirection="row" gap={1}>
                    <text fg={statusColor(selectedWorkflowSummary()?.status ?? "")}>•</text>
                    <text fg={statusColor(selectedWorkflowSummary()?.status ?? "")}>
                      {selectedWorkflowSummary()?.status ?? "unknown"}
                    </text>
                  </box>
                </box>
                <text fg={theme().textMuted}>ID: {selectedWorkflow()}</text>
              </box>

              <Show when={actionMessage()}>
                <text fg={theme().warning} wrapMode="word">
                  {actionMessage()}
                </text>
              </Show>

              <box flexDirection="row" width="100%" justifyContent="space-between">
                <text fg={theme().text} attributes={TextAttributes.BOLD}>
                  Execution
                </text>
                <text fg={theme().textMuted}>
                  {nodes().length} {nodes().length === 1 ? "node" : "nodes"} · {layers().length}{" "}
                  {layers().length === 1 ? "wave" : "waves"}
                </text>
              </box>

              {/* Wave header: nodes at the same topological depth, NOT a barrier */}
              <For each={layers()}>
                {(layer, layerIdx) => (
                  <box
                    flexDirection="column"
                    width="100%"
                    paddingLeft={1}
                    border={["left"]}
                    borderColor={theme().borderSubtle}
                  >
                    <box flexDirection="row" width="100%" justifyContent="space-between">
                      <text fg={theme().accent} attributes={TextAttributes.BOLD}>
                        Wave {layerIdx() + 1}
                      </text>
                      <text fg={theme().textMuted}>
                        {layer.length} {layer.length === 1 ? "node" : "nodes"}
                      </text>
                    </box>
                    <For each={layer}>
                      {(node) => (
                        <box
                          flexDirection="column"
                          width="100%"
                          onMouseUp={() => setSelectedNode(node.id)}
                          style={{ backgroundColor: selectedNode() === node.id ? theme().backgroundMenu : undefined }}
                        >
                          <box flexDirection="row" gap={1} width="100%">
                            <text fg={selectedNode() === node.id ? theme().accent : theme().textMuted} flexShrink={0}>
                              {selectedNode() === node.id ? "›" : " "}
                            </text>
                            <Show when={node.status !== "running"} fallback={<Spinner color={theme().textMuted} />}>
                              <text
                                flexShrink={0}
                                style={{
                                  fg: statusColor(node.status),
                                }}
                              >
                                •
                              </text>
                            </Show>
                            <text fg={theme().text} wrapMode="word">
                              {node.name}
                            </text>
                            <text fg={theme().textMuted}>[{node.worker_type}]</text>
                          </box>
                          <Show when={node.depends_on.length > 0}>
                            <box paddingLeft={4} paddingRight={1}>
                              <text fg={theme().textMuted} wrapMode="word">
                                depends on {node.depends_on.join(", ")}
                              </text>
                            </box>
                          </Show>
                          <Show when={node.status === "failed" && node.error_reason}>
                            <box paddingLeft={4} paddingRight={1}>
                              <text fg={theme().error} wrapMode="word">
                                ⚠ {formatDagError(node.error_reason!)}
                              </text>
                            </box>
                          </Show>
                        </box>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>

      {/* Footer: shortcut hints */}
      <box flexDirection="row" gap={2} flexShrink={0} border={["top"]} borderColor={theme().borderSubtle}>
        <text fg={theme().textMuted}>↑/↓ node</text>
        <text fg={theme().textMuted}>←/→ workflow</text>
        <Show when={enterShortcut()}>
          <text fg={theme().textMuted}>{enterShortcut()} open session</text>
        </Show>
        <text fg={theme().textMuted}>p pause</text>
        <text fg={theme().textMuted}>r resume</text>
        <text fg={theme().textMuted}>x cancel</text>
        <Show when={closeShortcut()}>
          <text fg={theme().textMuted}>{closeShortcut()} close</text>
        </Show>
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
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
