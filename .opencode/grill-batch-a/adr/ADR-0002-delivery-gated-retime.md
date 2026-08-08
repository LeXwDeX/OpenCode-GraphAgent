# ADR-0002: 送达门控的 re-time（Q2，D2 的修复）

- 状态：已接受（批次 A grilling，2026-08-07，决策 (a)；Round 2 机制修正，语义保留）
- 依赖：ADR-0001（旗子语义）

## 背景

re-time 门控（loop.ts:800 的 A1 cap gate）的 pending 臂只认 `escalationPending`，不认送达状态。主 agent 因不相干原因 replan 时若修改了升级节点的 timeout，会在 agent **从未见过该次升级**的情况下完成裁决并消费未送达的 wake（`store.updateNodeDeadline` 置 `wake_reported:true`，`store.ts:331`）——违反 §5-3「wake 主 agent」。

## 决策（Q2，机制修正后）

re-time 门控新增一个 **skip 合取项**：已升级但 wake 未送达的节点一律跳过 re-time——**裁决必发生在送达之后**成为结构不变式（G1）。

- **未送达的升级**（`escalationPending=true ∧ wakeReported=false`）→ 跳过 re-time：节点保留过期死线，watchdog 自续下个间隔再升级（计数照常爬向 G2 cap，偏安全侧），wake 照常投递
- restart/cancel **不加**送达门控（不改死线，不受 D2 威胁）
- `store.updateNodeDeadline` 的 `wake_reported:true` 写入在门控生效后退化为无害 no-op（送达早已 true）——D2 被结构性消灭，无需改写入逻辑

## 机制（Round 2 修正：skip 合取项，非放行析取项）

### re-time 是单路径，单门控点全覆盖

re-time 在整仓只有**一条触发路径**：`loop.ts:818` replan handler → `dag.nodeExtendTimeout`（`dag.ts:869-871`，全仓唯一调用点）→ `store.updateNodeDeadline`（`store.ts:321-343`，唯一的 deadline **延长**写）。`nodeExtendTimeout` 的全仓调用点仅 `loop.ts:818`；`deadline_ms` 的延长写点仅 `store.ts:331`（外加两个初始投影 `projector.ts:211`/`235` 的初始写，非延长）。watchdog（`spawn.ts:105` `makeDeadlineWatcher`）只提议 T8 `nodeTimeoutEscalated`（`spawn.ts:181`）与 T4 `nodeFailed`（`spawn.ts:160`），**从不**调用 `nodeExtendTimeout`；wake 投递路径（`loop.ts` 8 处 `tryDeliverWake`）从不写 deadline。**re-time 是单路径，单门控点即全覆盖。**

### 为什么 Round 1 表述在公共路径无效（cons-F1）

Round 1 把送达门控写成 re-time **放行条件的一个析取项**（"已升级且已送达即放行"），结果是它被公共路径的 `deadlineElapsed` 析取项淹没。真实的公共 case 是 `[escalationPending=true ∧ wakeReported=false ∧ deadline≤now]`——升级发生在死线过期之后（`NodeTimeoutEscalated` 投影 `projector.ts:382-405` 不动 `deadline_ms`，死线仍在过去）。在此 case 上 Round 1 公式不改变行为（被 `deadlineElapsed` 析取项覆盖，依旧放行 re-time，悄悄清旗消费未送达 wake——D2 病灶）；Round 1 只在罕见的 `[escalationPending=true ∧ deadline>now]` 上改变行为，而该 case A1 门控本就 skip（健康未来死线）。故 Round 1 在公共路径上无效。

### 精确编辑规格（loop.ts:800）

现状（A1 cap gate，只认 `escalationPending`，不认送达）：
```ts
if (!node.escalationPending && node.deadlineMs != null && node.deadlineMs > now) continue
```

修改后（A1 + 送达门控 G1，**新增 skip 合取项**）：
```ts
if (
  (!node.escalationPending && node.deadlineMs != null && node.deadlineMs > now) // A1: 死线健康且无待裁决 → 跳过（防循环改值绕 cap）
  || (node.escalationPending && !node.wakeReported)                            // Q2: 已升级但 wake 未送达 → 跳过（裁决必发生在送达之后）
) continue
```

`node.wakeReported` 已在 `NodeRow` 上（`store.ts:111`），replan handler 迭代的 `nodes` 即 `NodeRow[]`，无需新增读取。re-time 的放行条件等价于：

`re-time ⟺ (¬escalationPending ∧ (deadline≤now ∨ deadline=null)) ∨ (escalationPending ∧ wakeReported)`

两处皆为 **skip 条件的合取项**，不可改回放行析取项（会重蹈 cons-F1 旧病）。

## 验证（逐路径覆盖 + 为何解 cons-F1）

| 节点状态 | Round 1 行为 | 修改后行为 | 结论 |
|---|---|---|---|
| 已升级未送达 `escalationPending=true ∧ wakeReported=false ∧ deadline≤now`（公共路径） | 因 `escalationPending=true` 而 A1 **不** skip → re-time 触发，悄悄清旗消费未送达 wake（D2 病灶） | 新增 `(escalationPending && !wakeReported)` 命中 → **skip**。节点保留过期死线，watchdog（`spawn.ts:111`）自续再升级，wake 照常投递 | **公共路径结构性修复（cons-F1）** |
| 已升级已送达 `escalationPending=true ∧ wakeReported=true` | 放行 → re-time | 放行 → 编排器 replan 裁决落地（T9） | T9 正常 |
| 未升级死线健康 `¬escalationPending ∧ deadline>now` | A1 skip | A1 skip 不变 | 无变化 |
| wake 投递路径 / watchdog 路径 | 不延长 deadline | 不延长 deadline | 结构上无法绕过（从不调 `nodeExtendTimeout`） |

`store.updateNodeDeadline`（`store.ts:331`）的 `wake_reported:true` 写入：门控生效后只在已送达 case 触发（`escalationPending=true ∧ wakeReported=true`），此时 `wake_reported` 早已 true → no-op，ADR-0002 的「无害退化」成立。

## 后果

- `loop.ts:800` 一行条件修改（A1 + 新增 Q2 skip 合取项）
- 已知次生语义：投递滞缓时 extend 被推迟至送达后——agent 本就看不见未送达的升级，推迟即正确行为；投递有 bootstrap sweep + idle 边界兜底（G4 交付边界，节点级谓词 `loop.ts:949-953`、工作流级决策 `loop.ts:960-967`）
- 测试：未送达升级的 re-time 被拒（deadline 冻结 + watchdog 再升级）；送达后同 replan 放行
- 后 ADR-0003 落地建议：把送达门控的权威副本放进 `nodeExtendTimeout` 命令本身（命令持锁读行 `dag.ts:894` withWorkflowLock、skip 即不发事件），`loop.ts:800` 只留 A1 效率预过滤——两处同一谓词，无新机制（符合公理 ③）

## 修订记录

- **Round 2（本修订，2026-08-07）**：机制重写。Round 1 把送达门控写成 re-time 放行条件的析取项，被 cons-F1 证实对公共路径 `[escalationPending=true ∧ wakeReported=false ∧ deadline≤now]` 无效（被 `deadlineElapsed` 析取项淹没）。本修订改为 `loop.ts:800` 的 **skip 合取项** `(escalationPending && !wakeReported)`，直接作用于公共路径。**语义保留**（裁决必发生在送达之后）；状态保持 Accepted。伴随同步：`node-lifecycle-transitions.md` G1 重写、`CONTEXT.md` 决策树 Q2 行重写。
