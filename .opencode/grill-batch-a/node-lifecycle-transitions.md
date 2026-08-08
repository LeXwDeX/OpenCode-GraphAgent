# DAG 节点生命周期转移表 v2（权威审查基准）

> **v2（2026-08-07，Round 2 修正）**：G1 re-time 门控按 ADR-0002 修正机制重写（`loop.ts:800` skip 合取项，非放行析取项）；T9 投影效果与 replay 节按 ADR-0003 修正机制同步（guard 前移到命令层，projector 纯幂等折叠）；新增说明「guard 拒绝非转移」。v1 的逻辑不变式（两旗正交、裁决必发生在送达之后）语义保留，仅机制表述与锚点修正。

来源：批次 A grilling Q6=(A) 交付物（`.opencode/grill-batch-a/CONTEXT.md`）+ repair-design 机制修正（cons-F1/imp-F1）。
用途：此后 DAG 引擎任何改版，**先对照本表审**——改的是哪条转移、提议者是谁、投影效果与 agent 可见信号是否保持。
标注：`[现状]` = 当前代码事实；`[目标]` = 批次 A 决议引入的变更（ADR-0001~0004）。

## 状态空间

**主状态**（workflow_node.status）：`pending` / `queued` / `running` / 终态 `completed` / `failed` / `skipped`

> **节点级无独立 `cancelled` 终态**（method-A 对齐实现）：`NodeCancelled` 事件投影为 `status=failed` + `error_reason='cancelled via replan'`，取消语义经 error_reason 承载，行永不持有 `status='cancelled'`（`NodeStatus` 枚举无 CANCELLED，`getValidNextNodeStatuses` 对任何 from 均不返回 cancelled）。工作流级 `cancelled`（`WorkflowStatusProjection.cancelled`）是合法独立终态，与节点级无关。见 T5。

**running 扩展维度**（子状态）：
| 维度 | 语义 | 契约来源 |
|---|---|---|
| `deadline_ms` | 绝对死线（admission 或裁决时刻计算） | [现状] |
| `timeout_extensions` | 本 attempt 升级计数（预算） | [现状] |
| `escalation_pending` | **裁决状态旗**：节点正在等待主 agent 裁决；由裁决写动作（extend/restart/cancel）或终态清除 | [目标] ADR-0001 |
| `wake_reported` | **投递状态**：升级 wake 是否已送达主 agent | [现状]，职责与上旗正交 |

## 转移表

| # | 从 | 事件（命令 → durable event） | 提议者 | 到 | 投影效果 | agent 可见信号 | 状态 |
|---|----|----|----|----|----|----|----|
| T1 | pending | nodeQueued | runtime spawnReady | queued | 置 admission 死线 | — | [现状] |
| T2 | queued | nodeStarted | runtime spawn | running | **清 escalation_pending + 重置 timeout_extensions=0**（新 attempt） | 子会话启动 | [现状] |
| T3 | running | nodeCompleted | 子会话结果 | completed | **清 escalation_pending**（终态无裁决对象） | 结果交付（终态交付臂） | [目标] ADR-0001 |
| T4 | running/queued | nodeFailed（reason + trigger） | 子会话失败 / watchdog cap / recovery | failed | **清 escalation_pending**；trigger 入 error 语义 | `[DAG Node Result]`/wake 承载 reason+trigger（错误即状态→处置依据） | [目标] ADR-0001 |
| T5 | pending/queued/running | nodeCancelled | replan cancel / workflow cancel | failed(cancelled) | **status=failed + error_reason='cancelled via replan' + 清 escalation_pending**（cancel 即裁决；节点级无独立 cancelled 终态，取消语义经 error_reason 承载） | 取消交付 | [目标] ADR-0001 |
| T6 | pending/queued | nodeSkipped | 依赖失败级联 | skipped | — | 跳过级联 | [现状] |
| T7 | failed | nodeRestarted | replan restart | running | 清旗 + 重置计数（新 attempt） | 重试 | [现状] |
| T8 | running | nodeTimeoutEscalated | **watchdog（提议者）** | running | timeout_extensions+1、escalation_pending=true、wake re-arm（wake_reported=false） | `[DAG Node Timeout]` wake（extend 或 cancel 的裁决请求） | [现状] |
| T9 | running | **NodeDeadlineExtended**（nodeID+新死线+裁决时计数） | 主 agent replan 带新 timeout → nodeExtendTimeout（持锁命令） | running | 移 deadline_ms、清 escalation_pending（裁决完成）、wake_reported=true（门控生效后为无害 no-op）；幂等（`status='running'` replay 防护，event id 去重） | 无新信号（裁决本身是对 T8 wake 的应答） | [目标] ADR-0003 |

> **guard 拒绝非转移**：T9 命令（`nodeExtendTimeout`，`dag.ts:894` 持锁）在 `events.publish` 之前同步判 guard——节点已终态（running-guard）或 Q2 未送达（delivery-gate，ADR-0002）时命令返回 `0`、不发事件。这不是一条转移行（无新事件、无状态翻转），拒绝编码为**状态**（终态 / 持续 `escalation_pending`），编排器经 wake + 终态交付观察（公理 ②）。故本表无单独的「deadline extension rejected」转移行。

## 门控与不变式

- **G1 re-time 门控（A1 cap gate + 送达门控，loop.ts:800）**：re-time 放行 ⟺ `deadline 已过期 ∨ deadline=null ∨ (escalationPending ∧ wakeReported)`。实现为**两个 skip 合取项**（ADR-0002 Round 2 修正）：A1 跳过 `¬escalationPending ∧ deadline>now`，新增 Q2 跳过 `escalationPending ∧ ¬wakeReported`。两者均为 `continue`（skip）条件的合取项，**不可改回放行析取项**——放行析取项会被 `deadlineElapsed` 析取吞没，对公共路径 `[escalationPending ∧ ¬wakeReported ∧ deadline≤now]` 失效（cons-F1 旧病）。语义：未送达的升级不可被 re-time（裁决必发生在送达之后）；被跳过的节点保留过期死线，watchdog（`spawn.ts:111` 自续间隔 `Math.max(1_000, timeoutMs)`）再升级，wake 照常投递
- **G2 cap 上限**：extensions ≥ max_timeout_extensions → watchdog 提议 T4（trigger=timeout，reason 含计数）；计数只在 T8 成功时 +1，失败尝试不耗预算
- **G3 单一写权威**：一切节点状态变更走「dag 命令 → durable 事件 → projector」；行直写 = 破窗（`store.updateNodeDeadline` 直写由 T9 事件化废除，ADR-0003；guard 在命令层判，projector 纯折叠不返回行数）
- **G4 交付边界**：wake 投递条件 = `escalationPending ∨ (timeoutExtensions>0 ∧ terminal)`——两臂与旗子语义正交后自然正确。节点级谓词锚点 `loop.ts:949-953`，工作流级决策 `loop.ts:960-967`，summary 谓词 `store.ts:245-260`（`escalatedRows`：`escalation_pending=true ∧ status='running'`）
- **G5 锁域（ADR-0004）**：全部命令经 per-dagID KeyedMutex 串行 + 一行 `Effect.timeout("30 seconds")`（超时 = TimeoutException，guarded 记 warning 跳过，watchdog 自续重试）；**临界区内禁止异步等待**。命令持锁期间的 publish+projector 同步事务（`event.ts:320-326`）属命令自身工作，非被禁的长时间 async 等待，guard race-free

## watchdog 职责边界（转移提议者，非监督权威）

- 只做两件事：过期且预算未尽 → 提议 T8（`spawn.ts:181`）；预算耗尽 → 提议 T4（`spawn.ts:160`，+ 取消子会话）
- 不写节点行、不改旗子、不裁决、**从不调用 `nodeExtendTimeout`**（全仓 re-time 唯一路径是主 agent replan 经 `loop.ts:818`）
- 自续：每次提议后 sleep `escalateIntervalMs`（`= max(1s, nodeTimeout)`，`spawn.ts:111`）再读行——升级被裁决（T9/T7）则读到新死线安睡；未裁决则再升级，计数爬向 G2
- **已知瑕疵（入表待修，不另开工单）**：cap 路径先 `promptSvc.cancel` 子会话、后发 nodeFailed——副作用先于转移事件；应改为事件后处置

## 错误即状态（trigger 分类 → agent 处置依据）

nodeFailed.trigger ∈ { `timeout`（watchdog cap / 死线类）, `exec_failed`（执行层）, `verdict_fail`（契约层）, … }——wake 文案按 trigger 承载处置建议（extend/restart/cancel/接受），agent 依据状态而非原始堆栈做判断。

## replay 一致性（ADR-0003 后果）

事件日志含 T1-T9 全部转移 → 投影重建恢复**裁决后**的死线与计数（T9 携带绝对死线载荷）；直写时代的分歧（重建恢复旧死线）随 `updateNodeDeadline` 废除而消失。T9 projector 幂等：`status='running'` 条件确保崩溃重放时终态行 0 行 benign skip，不双写。
