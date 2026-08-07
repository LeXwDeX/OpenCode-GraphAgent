# ADR-0003: NodeDeadlineExtended 入事件日志（Q3，D3 的修复）

- 状态：已接受（批次 A grilling，2026-08-07，决策 (a)；Round 2 机制修正，语义保留）
- 上游公理：设计公理 ④（单一写权威）

## 背景

`nodeExtendTimeout`（`dag.ts:869-871`）是 node 命令族唯一绕过事件日志的持久写（直写 `deadline_ms`，经 `store.updateNodeDeadline` `store.ts:321-343`）。后果：
1. 投影重建（replay）恢复延长前的旧死线——死线 = `now + timeout` 在裁决时刻计算，`now` 不在任何既有事件载荷中，分歧是结构性的
2. 无 durable 审计（谁/何时/第几次延长）

## 决策（Q3，机制修正后）

新增 durable 事件 **`NodeDeadlineExtended`**；`nodeExtendTimeout` 改为标准「命令 → 事件 → 投影」形态，直写废除。

- **载荷**：nodeID + 新死线（绝对 ms）+ 裁决时的 extension 计数（审计）
- **guard 前移到命令层**：`nodeExtendTimeout` 持 workflow 锁（`dag.ts:894` withWorkflowLock）、在 `events.publish` **之前**同步读行判 guard——guard 结果是命令的**普通 Effect 同步返回值**（`0` = 拒绝 / `1` = 成功），直接给调用方 `loop.ts:818`，**不经 publish 链**
- **projector 幂等投影**（纯折叠，event id 去重，replay-safe）：set `deadline_ms`、清 `escalation_pending`（ADR-0001 裁决清旗）

## 机制（Round 2 修正：guard 在命令层，非 projector 返回值）

### 为什么 Round 1 表述不可行（imp-F1）

Round 1 设想「running-guard 移入 projector 前置校验，projector 返回 0 行 = guard 拒绝，经 publish 暴露给调用方」。**不可行**：durable publish 在 `event.ts:320-326` 是 `Effect.uninterruptible` + `db.transaction(...)`，其内部 `commitDurableEventInner` 对每个 projector 执行 `for (const projector of list) { yield* projector(committed) }`（`event.ts:256-258`）——**projector 的返回值被丢弃**。projector 是折叠纯函数（公理 ①/G3），在 durable publish 事务内、不可发新事件。故 projector 层的 0 行结果**无法**经 publish 回到调用方。imp-F1 成立。

但 durable publish 的**同步/事务**特性同时给出解法：命令在 `events.publish` **之前**、持锁做 guard，guard 结果是命令的**普通 Effect 返回值**（不经 publish 链）。`notify` 的 fire-and-forget（listener 扇出）只针对 listener，不影响 projector 事务与命令返回。

### 落地规格

**(i) schema — 新增 durable 事件 `NodeDeadlineExtended`**（`packages/schema/src/dag-event.ts`，模板 `NodeTimeoutEscalated` `:293-303`）：
```ts
export const NodeDeadlineExtended = Event.define({
  type: "dag.node.deadline_extended",
  ...options,
  schema: { ...Base, nodeID: NodeID, deadlineMs: Schema.Number, timeoutExtensions: Schema.Number },
})
```
注册进 `DurableDefinitions`（`dag-event.ts:309-329`，紧跟 `NodeTimeoutEscalated`）。

> **SDK 再生**：manifest 动 → 按 AGENTS.md 不变量跑 `./packages/sdk/js/script/build.ts`（durable 事件进 event union；无 HTTP 路由变化）。

**(ii) dag.ts — `nodeExtendTimeout` 改为标准命令（废除直写，`dag.ts:869-871`）**：guard 前移到命令层，发事件前同步判：
```ts
const nodeExtendTimeout = Effect.fn("Dag.nodeExtendTimeout")(function* (lock, dagID, nodeID, newDeadlineMs) {
  const node = yield* store.getNode(dagID, nodeID).pipe(Effect.orDie)
  if (!node || node.status !== "running") return 0                       // running-guard：节点已终态（race-free：持 workflow 锁）
  if (node.escalationPending && !node.wakeReported) return 0             // Q2 送达门控（ADR-0002）：未送达不可 re-time
  yield* events.publish(DagEvent.NodeDeadlineExtended, {
    dagID, nodeID, deadlineMs: newDeadlineMs, timeoutExtensions: node.timeoutExtensions,
    timestamp: yield* DateTime.now,
  })
  return 1                                                               // 成功
})
```
- 返回的 `0/1` 是命令的同步 Effect 返回，直接给调用方 `loop.ts:818`，**不经 publish**——「guard 拒绝可观测」由命令层满足（非 publish 链）
- `store.updateNodeDeadline`（`store.ts:321-343`）**废除**（或降级为仅供 projector 内部复用）

**(iii) projector — 新增 T9 投影（纯折叠，幂等，紧随 `NodeTimeoutEscalated` handler `projector.ts:382-405`）**：
```ts
yield* events.project(DagEvent.NodeDeadlineExtended, (event) =>
  db.update(WorkflowNodeTable)
    .set({
      deadline_ms: event.data.deadlineMs,
      escalation_pending: false,      // ADR-0001：裁决清旗
      wake_reported: true,            // 门控生效后为无害 no-op（送达早已 true）
      seq: event.durable!.seq, time_updated: toMillis(event.data.timestamp),
    })
    .where(and(
      eq(WorkflowNodeTable.workflow_id, event.data.dagID),
      eq(WorkflowNodeTable.id, event.data.nodeID),
      inArray(WorkflowNodeTable.status, ["running"]),   // replay-safe 幂等：终态行 0 行（benign）
    ))
    .run().pipe(Effect.orDie))
```
projector **不判 guard、不发事件、不返回行数**——符合公理 ①/G3。条件 `status='running'` 仅作 replay 幂等防护（崩溃重放时节点可能已终态，0 行 benign skip）。

**(iv) loop.ts:818 调用点 — 返回值语义不变**：`loop.ts:827-838` 现有 `written<0 / written===0 / written>0` 三分支逻辑无需改动；`written===0` 仍表示 guard 拒绝（命令同步返回，非 publish），handler 跳过新 watcher 安装。

### 拒绝如何对编排器可观察（公理 ②「错误即状态」）

编排器**不**经 row-count 观察（那是 runtime 内部信号，供 `loop.ts` handler 决定 watcher 安装）；编排器经**状态** + wake 观察：

| 拒绝原因 | 命令返回 | 状态落点 | 编排器观察通道 |
|---|---|---|---|
| 节点已终态（running-guard 拒） | `0` | 节点 `completed/failed/...` | wake 经 T3/T4/T5 交付终态结果（`[DAG Node Result]`） |
| Q2 未送达（delivery-gate 拒） | `0` | `escalation_pending=true` 持续、`wake_reported=false` | watchdog 自续再升级 / wake 交付该次升级裁决请求（`[DAG Node Timeout]`） |

## 一致性论证

- **公理 ①**（状态流转优先）：projector 纯折叠，命令唯一写权威。
- **公理 ②**（错误即状态）：拒绝编码为终态 / 持续 `escalation_pending`，wake 承载。
- **公理 ③**（奥卡姆）：零新错误类、零 per-caller 分支；复用 wake + 终态交付。
- **公理 ④ / G3**（单一写权威）：`nodeExtendTimeout` 直写废除，改 `命令 → NodeDeadlineExtended → projector`；现存唯一破窗关闭。
- **G5 锁域**：命令持锁期间 publish + projector 同步完成（`event.ts:320-326` 事务），guard race-free；命令本身的工作（publish+projector）非临界区内被禁的长时间 async 等待，外层一行 `Effect.timeout("30 seconds")`（ADR-0004）覆盖。

## 后果

- schema：`packages/schema` dag-event 定义 + `DurableDefinitions` 收录（durable）
- projector：新增 T9 handler；SDK event union 再生（AGENTS.md 不变量：manifest 动 = SDK 再生）
- dag.ts 重写 `nodeExtendTimeout`（guard 前移到命令层）；`store.updateNodeDeadline` 直写废除；`loop.ts:818` 调用点返回值三分支不变
- **回放一致性**：事件日志含 T9 → 投影重建恢复**裁决后**的死线与计数（T9 携带绝对死线载荷）；直写时代的分歧（重建恢复旧死线）随 `updateNodeDeadline` 废除而消失
- 测试：延长事件投影幂等（重放不双写）、re-time 门控（ADR-0002）联动、replay 一致性、guard 拒绝时命令返回 `0`
- 附带：watcher 的 re-time 感知未来可从轮询演进为订阅——门已打开，本 ADR 不要求

## 修订记录

- **Round 2（本修订，2026-08-07）**：机制重写。Round 1 设想「guard 移入 projector 前置校验，0 行 = guard 拒绝经 publish 暴露」，被 imp-F1 证伪——projector 返回值在 `event.ts:256-258` 被丢弃，无法经 publish 回到调用方。本修订把 guard 前移到**命令层**（`nodeExtendTimeout` 持锁、`events.publish` 之前同步判），`0/1` 是命令同步 Effect 返回（不经 publish 链）；projector 退化为纯幂等折叠（`status='running'` 仅 replay 防护，行数有意忽略）。**保留不变**：durable 事件 `NodeDeadlineExtended`、schema 定义、`DurableDefinitions` 收录、SDK 再生、回放一致性约束。编排器经状态（终态 / 持续 `escalation_pending`）+ wake 观察拒绝（公理 ②）。状态保持 Accepted。伴随同步：`node-lifecycle-transitions.md` T9 投影效果与 replay 节同步、CONTEXT.md 决策树 Q3 行同步。
