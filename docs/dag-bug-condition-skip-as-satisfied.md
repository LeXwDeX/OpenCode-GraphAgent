# DAG 模组缺陷与改进清单（P0–P2）

> **来源**：DAG 模组全盘审计（性能 / 运行闭环 / 场景覆盖 / TUI）+ 压测工作流 `dag_067ef539cffe6fbuucCw7L5nko` 实证
> **报告日期**：2026-07-25（P0-1 实证）/ 2026-07-27（全量审计整合）
> **分级标准**：P0 = 语义正确性破坏或核心链路死路；P1 = 静默行为偏差、性能热点、契约自相矛盾；P2 = 语义弱化、死代码、UX 缺口

---

## 总览

| 编号 | 级别 | 标题 | 类型 |
|------|------|------|------|
| [P0-1](#p0-1) | P0 | condition_false 被当作 satisfied，门禁拒绝被下游完全无视 | 正确性（已实证） |
| [P0-2](#p0-2) | P0 | max_concurrency 只限流 LLM 调用，子会话被急切创建，QUEUED 是死状态 | 正确性 + 性能 |
| [P0-3](#p0-3) | P0 | 连续单步（step）是状态机死路 | 正确性 |
| [P1-1](#p1-1) | P1 | create 不校验 depends_on 引用 / 重复节点 ID / max_total_nodes | 正确性 |
| [P1-2](#p1-2) | P1 | sanitizer 破坏性替换损坏 diff/代码产出物，与 diff-review 契约矛盾 | 正确性 |
| [P1-3](#p1-3) | P1 | spawnReady 每节点重复全量读，O(ready × nodes) 查询 | 性能 |
| [P1-4](#p1-4) | P1 | getWorkflowSummaries JS 聚合 + 事件热路径前置查询 | 性能 |
| [P1-5](#p1-5) | P1 | 失败节点无法通过 replan restart 重跑（必须换新 ID），工具描述未告知 | 使用陷阱 |
| [P2-1](#p2-1) | P2 | required 节点失败 → 工作流终态是 cancelled 而非 failed | 语义 |
| [P2-2](#p2-2) | P2 | 崩溃恢复对 running 节点一律判失败，required 级联即整流程报废 | 语义（**已修复：recovery-pause**） |
| [P2-3](#p2-3) | P2 | orchestrator_unresponsive 兜底的触发时机依赖未钉死的 promptIfIdle 语义 | 风险（**已验证关闭+契约测试**） |
| [P2-4](#p2-4) | P2 | 死代码/死状态：ViolationTable、ARCHIVED、NodeStatus.PAUSED/ABORTED | 清理 |
| [P2-5](#p2-5) | P2 | inline 模板走临时文件写读删，spawn 热路径纯多余 I/O | 性能 |
| [P2-6](#p2-6) | P2 | condition DSL 表达力不足，且只能引用直接依赖 | 场景 |
| [P2-7](#p2-7) | P2 | HTTP API 不对称：无 start / extend | 场景 |
| [P2-8](#p2-8) | P2 | TUI：Inspector 无滚动、列表截断与导航不一致、无 step 控制、配色两套 | UX |
| [P2-9](#p2-9) | P2 | summary 进度不计 skipped，工作流"跑完了但分子不满" | UX |
| [P2-10](#p2-10) | P2 | pause 语义（不停止在跑节点）无任何文档/UI 提示 | UX |

---

<a id="p0-1"></a>
## P0-1：condition_false 被当作 satisfied，门禁拒绝被下游完全无视

> **状态**：已确认（经工作流 `dag_067ef539cffe6fbuucCw7L5nko` 终态验证）
> **严重度**：Critical — 语义正确性缺陷，门禁形同虚设

### 摘要

当一个节点的 `condition` 求值为 false 时，节点发布 `NodeSkipped(condition_false)`，但调度层把 **skipped 与 completed 等价处理为 `satisfied`**。由于调度器把 `satisfied` 集合视为"依赖已满足"，**所有依赖该节点的下游节点会照常调度执行**——即使该节点是一个质量门禁且刚刚拒绝了放行。

结果是：门禁返回 `REVISE`/`REJECT` → 实现节点被 condition 跳过 → 但实现节点的下游（集成、验证、审计）仍然全部执行，最终审计甚至返回 `ACCEPT`。**整个质量门控链路形同虚设。**

### 复现

#### 工作流信息

| 字段 | 值 |
|------|-----|
| Workflow ID | `dag_067ef539cffe6fbuucCw7L5nko` |
| Title | engine-stress-review-pipeline |
| Parent Session | `ses_067f06f1bffeAmDFfH51NmNBl5` |
| 模式 | standard |
| 终态 | completed |

#### 图结构（相关部分）

```
quality-gate (required, output_schema: verdict)
  ├── implement-core   (condition: quality-gate.output.verdict == "ACCEPT")
  ├── implement-docs   (condition: quality-gate.output.verdict == "ACCEPT")
  │
  implement-cli        (condition: quality-gate.output.verdict == "ACCEPT", depends_on: implement-core)
       │
    integrate          (depends_on: implement-cli, implement-docs)  ← 无 condition
       ├── verify-unit   (depends_on: integrate)
       └── verify-e2e    (depends_on: integrate)
            │
       diff-review      (depends_on: verify-unit, verify-e2e, output_schema: verdict)
            │
       final-audit      (required, depends_on: diff-review, output_schema: verdict)
            │
       tail-telemetry   (depends_on: final-audit)
```

#### 预期行为

quality-gate 返回 `REVISE` → condition 求值 false → implement-* 被跳过 → **整条下游链不应执行**（无实现产物可集成/验证/审计）。

#### 实际行为（终态快照）

| 节点 | 状态 | 说明 |
|------|------|------|
| quality-gate | completed, verdict=**REVISE** | 子 agent 合法分析仲裁结果后拒绝放行 |
| implement-core | **skipped** (condition_false) | 正确跳过 |
| implement-docs | **skipped** (condition_false) | 正确跳过 |
| implement-cli | **skipped** (condition_false) | 正确跳过 |
| integrate | **completed** | ❌ 依赖的两个节点都被 skip，却仍然执行 |
| verify-unit | **completed** | ❌ 不应该运行 |
| verify-e2e | **completed** | ❌ 不应该运行 |
| diff-review | **completed**, verdict=ACCEPT | ❌ 不应该运行 |
| final-audit | **completed**, verdict=**ACCEPT** | ❌ 门禁拒绝了，审计却通过了 |
| tail-telemetry | **completed** | ❌ 不应该运行 |

**工作流整体 completed**——门禁拒绝被完全无视，整条链跑完并"通过"。

### 根因分析（已修正定位）

> 早期版本将根因定位在 `loop.ts` condition 分支内联 `markSatisfied`——**不准确**。当前源码中 condition 分支只发布 NodeSkipped 事件；skip≡satisfied 的合流发生在下述 **三个独立位置**，修复必须同时覆盖，否则任一遗漏路径都会在重建/单步时复现该缺陷。

**位置 ①：NodeSkipped 事件处理器（活跃路径）** — `packages/opencode/src/dag/runtime/loop.ts:318-353`

```ts
for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped]) {   // ← skip 与 complete 共用一个处理器
  yield* events.subscribe(def).pipe(
    ...
    if (entry.runtime.isActive(evt.data.nodeID as string)) {
      entry.runtime.markSatisfied(evt.data.nodeID as string)          // ← skip 被当作 satisfied
      if (!entry.runtime.isStepMode()) yield* spawnReady(dagID)       // ← 随即放行下游
    }
```

**位置 ②：`toSchedulingNodes` 重建映射（恢复/replan 重建路径）** — `loop.ts:36-51`

```ts
export const SUCCESS_TERMINAL = new Set(["completed", "skipped", "aborted"])  // ← skip 归入成功终态

export function toSchedulingNodes(nodes) {
  return nodes.map((n) => ({
    ...
    status: SUCCESS_TERMINAL.has(n.status)
      ? ("satisfied" as const)     // ← 从 DB 重建 WorkflowRuntime 时 skip 再次变 satisfied
      : ...
```

**位置 ③：`Dag.step` 的同款内联映射** — `packages/opencode/src/dag/dag.ts:356-385`（单步计算 ready 集合时复制了同一映射）

**调度器侧的放大机制** — `packages/core/src/dag/core/scheduling.ts:50-109`

```ts
markSatisfied(nodeID: string): void {
  this.satisfied.add(nodeID)       // ← skip 的节点进了这里
  ...
}

getReadyNodes(): string[] {
  const ready = this.graph
    .getExecutableNodes(new Set([
      ...this.satisfied,           // ← 下游据此判定依赖"已满足"
      ...[...this.unsatisfied].filter((id) => !this.required.has(id)),
    ]))
    ...
}
```

`satisfied` 集合同时承载"成功完成"与"被 condition 跳过"两种语义，调度器无法区分。**WorkflowRuntime 只有 satisfied/unsatisfied/running/pending 四态，没有 skipped**——节点 STATUS 层有 `SKIPPED`（`types.ts:37`）和 `SkipReason.CONDITION_FALSE`（`types.ts:49-56`），但调度态丢失了这一信息。

#### 语义断裂链

```
condition == false
  → NodeSkipped(condition_false) 发布
    → 事件处理器 markSatisfied（skip 当 success）      [位置①]
    → 重建时 SUCCESS_TERMINAL 映射为 satisfied          [位置②③]
      → 下游 getExecutableNodes 判定依赖已满足
        → resolveInputMapping 注入 "Dependency skipped: no output" 文本作为下游输入
          → 下游带着占位文本照常执行
            → 整条链跑完，门禁形同虚设
```

注意最后一环：下游并非"拿不到输入而失败"，而是 `resolveInputMapping`（`loop.ts:112-125`）会把 skip 依赖降级为一段说明文本注入 prompt——这是为"可选分支降级"设计的机制，但在门禁场景下变成了"用占位文本继续跑完全链"。

#### 设计张力：为什么不能简单地把 skip 全部级联

| 场景 | 当前行为（skip≡satisfied） | 期望行为 |
|------|---------------------------|----------|
| 门禁拒绝 → 实现链跳过 | 下游照常执行 ❌ | 下游级联 skip |
| 可选分支跳过 → 主链继续（fan-in 有其他 satisfied 依赖） | 下游执行 ✅ | 下游执行 ✅（合法场景，必须保留） |
| condition 跳过 → fan-in 汇总 | fan-in 收到占位文本仍执行 | 至少让 fan-in 可区分 skip 与 success |

关键区分点：**下游是否"纯依赖" skipped 节点**。有任一 satisfied 依赖的 fan-in 继续执行是合法降级；全部依赖都 skip 的子树继续执行则是缺陷。

### 修复建议

#### 方案 A：引入 skipped 调度态 + 纯依赖级联（推荐）

1. `WorkflowRuntime` 增加 `private readonly skipped: Set<string>` 与 `markSkipped(nodeID)`
2. `getReadyNodes` 判定依赖满足时，`{satisfied ∪ skipped}` 仍可解锁下游，**但**一个节点若其依赖全部 ∈ skipped（无任何 satisfied），则该节点自动级联 skip（发布 `NodeSkipped(orphan_cascade)` 复用现有 SkipReason）
3. `isComplete()` 将 skipped 计入终态集合（保持现有完成判定不回归）
4. **三处合流点同步修改**：位置① NodeSkipped 处理器改调 `markSkipped`；位置② `SUCCESS_TERMINAL` 拆分为 `{completed, aborted} → satisfied`、`{skipped} → skipped`；位置③ `Dag.step` 内联映射同步（建议顺手消除该重复，复用 `toSchedulingNodes`）
5. 可选：节点级 `skip_propagation: cascade | allow_downstream` 配置覆盖默认级联策略

#### 方案 B：condition_false → markUnsatisfied（最小改动，不推荐）

`markUnsatisfied` 仅对 required 节点级联（`scheduling.ts:60-75`），非必需节点的下游会永远卡 pending 导致 `isComplete()` 永假、工作流悬挂；补非必需级联变体后实质上等于方案 A 的劣化版，且把 skip 混入 unsatisfied 又制造新的语义合流。

#### 方案 C：编排层声明传播策略

`condition_propagation: skip_subtree` 类声明。可作为方案 A 第 5 步的配置面，不建议单独作为修复（默认行为仍是坏的）。

**推荐方案 A**——级联只影响纯依赖 skipped 的子树，保留"可选分支跳过→主链继续"合法场景；且三处合流点一次收敛，重建/单步路径不留后门。

#### 回归测试清单

- 门禁拒绝 → 全下游级联 skip、工作流 completed（非 cancelled）
- fan-in 一个依赖 skip 一个 completed → fan-in 照常执行且输入含 skip 说明文本
- 级联 skip 后进程重启（走 `toSchedulingNodes` 重建）→ 不复活下游
- stepping 模式下 condition_false → 级联 skip 不触发 auto-advance

---

<a id="p0-2"></a>
## P0-2：max_concurrency 只限流 LLM 调用，子会话被急切创建，QUEUED 是死状态

**位置**：`packages/opencode/src/dag/runtime/spawn.ts:97-156`、`loop.ts:79-230`

`spawnReady` 对每个 ready 节点立即执行 `spawnNode`，而 `sessions.create`（L97）与 `NodeStarted` 事件发布（L119）都发生在 **semaphore 取许可之前**（L156 才 `take(1)`）。后果链：

- 100 个 ready 节点 → 瞬间创建 100 个子会话、发布 100 条 `NodeStarted`、100 个节点在 DB 中全部变为 `running`
- `NodeStatus.QUEUED` 全代码库**无任何发布点**（`transitionToNodeEvent` 对 QUEUED 返回 null）——状态机死状态
- UI（sidebar `▶N running`、Inspector spinner）显示全部"运行中"，用户无法分辨真实并发是 5
- 排队等待计入 deadline 是有意设计（正确），但大扇出下队尾节点"未执行先超时"，且全程显示 running

**修复**：会话创建与 `NodeStarted` 移入 permit 内；取 permit 前发布 queued 语义（新增 NodeQueued 事件或延迟 NodeStarted）。注意联动：`recovery.ts` 对 running 节点的收敛逻辑、deadline 计算起点（保持 spawn 时刻不变）都要复核。

---

<a id="p0-3"></a>
## P0-3：连续单步（step）是状态机死路

**位置**：`packages/core/src/dag/core/types.ts:187-188`、`dag.ts:356-385`、`loop.ts:446-463`

`dag.step` 的守卫要求 `当前状态 → STEPPING` 是合法迁移，而 `getValidNextWorkflowStatuses(STEPPING) = [RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED]`——**不含 STEPPING**。完整时序推演：

1. `running` 下 step → 状态 `stepping`，运行 1 个节点 ✓
2. 节点完成，stepMode 阻止 auto-advance（正确）✓
3. 再次 step → `InvalidTransitionError(stepping → stepping)` ✗
4. 唯一出路 `resume` → 但 `WorkflowResumed` 处理器清 stepMode 并 `spawnReady` **全量并发放行** ✗

即"逐节点调试"只能走一步；第二步要么报错要么失控全放。`dag-step-semantics.test.ts` 只测了第一步，无连续 step 用例，故未暴露。

**修复**：迁移表允许 `STEPPING → STEPPING`（幂等 re-step，projector 的 `WorkflowStepped` 投影 from 列表同步加 `"stepping"`），或 stepped 节点完成后自动回落 running。TUI 侧同步补 step 命令（见 P2-8）。

---

<a id="p1-1"></a>
## P1-1：create 不校验 depends_on 引用 / 重复节点 ID / max_total_nodes

**位置**：`dag.ts:296-317`（create 校验段）、`scheduling.ts:12-21`（buildGraph）

- **悬空依赖静默丢边**：`buildGraph` 对不存在的依赖 `if (graph.hasNode(dep))` 静默跳过 → **依赖 ID 打错字的节点变成根节点立即执行**。replan 路径有完整引用校验（`planReplan` 第 2 步），create 没有——不对称。
- **重复节点 ID 静默合并**：`addNode` 去重、projector `onConflictDoUpdate` 覆盖；`ErrorCode.DUPLICATE_NODE_NAME` 定义了但无人使用。
- **max_total_nodes 只在 replan 检查**（`dag.ts:462`）：初始 config 500 节点直接放行，与 P0-2 叠加 = 瞬间 500 个子会话。

**修复**：create 增加三项校验，全部拒绝式（fail fast），错误信息对齐 replan 的措辞。

---

<a id="p1-2"></a>
## P1-2：sanitizer 破坏性替换损坏 diff/代码产出物，与 diff-review 契约矛盾

**位置**：`packages/opencode/src/dag/templates/sanitize.ts:16-28`、`loop.ts:130`

`sanitize` 把所有 <code>```</code> 替换为 <code>``</code>、行首 `system:` 替换为 `[REDACTED]:`、`you are now a` 替换为 `[REDACTED]`，并作用于**所有上游节点输出**（`resolvedMapping = sanitizeInput(...)`）。而 `review-lifecycle.ts` 的 diff-review 契约**要求**下游收到真实的 diff/patch 工件——任何含 code fence 的 diff、含 "system:" 的日志都会被静默改写，**审查者审的是被篡改的补丁**。防注入与工件保真当前不可兼得。

**修复方向**（按侵入度递增）：
1. 对 `review.phase == "diff"` 声明的 implementation 工件字段豁免 sanitize
2. 改破坏性替换为包裹式中和（如 `<untrusted-output>` 定界 + 转义），保留原文
3. 按 worker_type / 字段级 sanitize 策略配置

---

<a id="p1-3"></a>
## P1-3：spawnReady 每节点重复全量读，O(ready × nodes) 查询

**位置**：`loop.ts:89`（condition 分支）、`loop.ts:111`（input_mapping 分支）

每个 ready 节点最多两次 `store.getNodes(dagID)` 全表读，一轮调度 N 个 ready 节点 = 最多 2N 次全量查询。**修复**：每轮 `spawnReady` 开头读一次 nodes 快照并复用（condition 求值与 mapping 解析都只需要终态依赖的 output，快照一致性足够）。

---

<a id="p1-4"></a>
## P1-4：getWorkflowSummaries JS 聚合 + 事件热路径前置查询

**位置**：`packages/core/src/dag/store.ts:226-257`、`summary-publisher.ts:104-120`

- `getWorkflowSummaries` 拉取 session 下**所有**节点行到内存计数；每个 `dag.*` 事件后触发（50ms 去抖动缓解突发）。长会话累积多个 100 节点工作流后，每次事件突发 = 数千行读取。改 `GROUP BY workflow_id, status` 一行等价。
- 节点事件不带 sessionID，publisher 在**去抖动之前**每事件做一次 `getWorkflow` 查询（L109-112）。100 节点事件突发 = 100 次前置查询。可加 dagID→sessionID 短 TTL 缓存，或把去抖动窗口提到查询之前。

---

<a id="p1-5"></a>
## P1-5：失败节点无法 replan restart 重跑，必须换新 ID——工具描述未告知

**位置**：`packages/core/src/dag/core/replan.ts:108-110`、`replan.ts:133`（终态 ignore）

`planReplan` 规定 `restart` 仅对 **running** 节点合法；failed 等终态节点出现在 fragment 中直接进 ignore 桶。即**失败节点想重试必须换一个新节点 ID 重新添加**。这是符合"终态不可逆"铁律的有意设计，但 `workflow.ts` 工具 schema 的 restart 描述（"Re-spawn this running node"）没有把这个陷阱讲透——父 agent 大概率先试 restart 失败节点、收到 ignore 静默结果后困惑。

**修复**：restart 非 running 节点时返回**显式错误提示**（"failed 节点请以新 ID 添加替代节点"），而非静默 ignore；工具描述补一句陷阱说明。

---

<a id="p2-1"></a>
## P2-1：required 节点失败 → 工作流终态 cancelled 而非 failed

**位置**：`loop.ts:238`（`checkCompletion`：`hasRequiredFailure() → dag.cancel`）

必需节点失败的工作流终态是 `cancelled`，与用户主动取消不可区分；TUI 把 failed 标红、cancelled 置灰——**必需节点炸了显示为灰色**，归因被弱化。wake 消息同样只说 "Workflow cancelled"。建议改走 `dag.fail(dagID, "required node failed: <ids>")`，同时更新依赖该语义的测试与工具描述（当前描述"If true and this node fails, the workflow is cancelled"需同步）。

---

<a id="p2-2"></a>
## P2-2：崩溃恢复对 running 节点一律判失败

> **状态**：已修复（recovery-pause，分支 `fix/dag-recovery-pause`）

**位置**：`recovery.ts:93-99`（判罚保留）+ `loop.ts` `recoverWorkflow`（处置改变）

**原病理**：ownership lost 的 running 节点一律 `nodeFailed("execution ownership lost")`，不重试——有意的保守设计。但叠加 required 级联（P2-1）后：**重启一次进程 = required 链上任何在跑节点失败 = 整个工作流终态报废**，且终态节点不可变、终态工作流不可 replan，父 agent 收到的是无可修复的死亡通知。

**否决的方案**（本文档旧版建议）：ownership lost 且 deadline 未到的节点回落 `pending` 由 spawnReady 自动重拾取。**自动重拾取就是未经显式控制的新 execution attempt**，正面违反模块自身契约（`loop.ts` 恢复注释："a new execution attempt must come from explicit workflow control"，与 `core/session/runner/llm.ts` 的恢复铁律同源；该铁律经 07-27 实证为有效——双代码锚点、AGENTS.md 更新后 47 提交零漂移；其解除路径是完成显式恢复设计而非删除条款），且有崩溃循环与子会话副作用重放风险。

**实施的修复（recovery-pause）**：崩溃判罚保留（发明性失败照旧 `failed`，铁律无损），但当恢复过程**发明**了失败（ownership lost / 无子会话 / deadline 离线到期）且工作流原为 running 时，转 `paused` 而非放任 spawnReady+checkCompletion 立即级联 skip 并焊死终态：

- **关键洞察**：暂停发生在级联之前，下游节点保持 `pending`——pending 可被 replan 改线，failed/skipped 终态不可。旧行为下 n2 已 skipped、工作流已 failed，同一 replan 根本无法提交。
- 父 agent 收到 durable NodeFailed wake（paused 工作流本就处于投递边界）+ actionable 指令，三选一：`replan`（新 id 替换节点 + 下游改线）→ `resume` 复活；直接 `resume`（接受失败语义，走 P2-1 归因终态）；`cancel`。
- 再次崩溃时已 paused、无 running 节点，恢复幂等——无崩溃循环。
- 配套修复一个被此设计暴露的既有缺陷：`WorkflowResumed` 处理器只调 `spawnReady` 不调 `checkCompletion`，全节点已终态的 paused 工作流 resume 后永久悬挂。
- 回归测试：`dag-loop-recovery-integration.test.ts` 新增三组契约（pause-then-resume 终态归因 / 下游可 replan / 全终态 resume 不悬挂）。

---

<a id="p2-3"></a>
## P2-3：orchestrator_unresponsive 兜底的触发时机假设未钉死

> **状态**：已验证关闭（07-27 源码实证）+ 契约测试钉死

**位置**：`loop.ts`（`tryDeliverWake`）

投递 wake 后循环立即重读批次，无未上报行且工作流停摆即 `dag.fail(dagID, "orchestrator_unresponsive")`。该逻辑隐含假设 `promptIfIdle` 等到父 turn 完整结束才 resolve。

**实证结果**（`prompt.ts` `promptIfIdle` 实现）：`state.startIfIdle` 返回 wait handle，末尾 `yield* wait.value` 阻塞至完整 `runLoop`（父 turn）完成——**误杀窗口不存在**，假设成立。

**回归防护**：该假设是 session 层契约而非 DAG 层可控行为，因此防护落在 `test/session/prompt.test.ts`（"idle-only prompt resolves only after the full provider turn completes"）：provider 流未完成时 promptIfIdle 必未 resolve，流完成后才 resolve Some。若未来有人把 promptIfIdle 改成 admission 即返回，此测试会先于线上误杀暴露。

---

<a id="p2-4"></a>
## P2-4：死代码 / 死状态清理

| 项 | 证据 | 处置建议 |
|---|---|---|
| `WorkflowViolationTable` | 只有读方法（listViolations/queryViolations/countBySeverity），全库无写入点，HTTP/TUI 不暴露 | 接上（sanitizer 命中、ceiling 命中、unresponsive 判罚天然是 violation）或删除 |
| `WorkflowStatus.ARCHIVED` | 迁移表允许终态→ARCHIVED，但无 archive 事件定义、无发布点 | 删除或补 archive API |
| `NodeStatus.PAUSED` / `ABORTED` | 无节点级暂停 API；aborted 无发布点 | 从迁移表移除或明确 roadmap |
| `NodeStatus.QUEUED` | 见 P0-2，随 P0-2 修复激活 | 激活 |

---

<a id="p2-5"></a>
## P2-5：inline 模板走临时文件写读删

**位置**：`templates/resolve.ts:68-82`。注释自认"simulating the template-file read path"——spawn 热路径上 3 次纯多余磁盘 I/O + 无谓的失败面（tmpdir 权限/磁盘满）。直接用字符串。

---

<a id="p2-6"></a>
## P2-6：condition DSL 表达力不足，且只能引用直接依赖

**位置**：`runtime/eval.ts:32-54`、`loop.ts:89-104`

- 仅支持单个二元比较（`a.output.x == v`），无 `&&`/`||`、无存在性判断、无 contains
- condition 的 outputs map 只装 **direct dependsOn**（`loop.ts:91-94`），引用间接上游会静默 undefined → 比较恒 false → 静默 skip（叠加 P0-1 后下游还照跑）
- 字符串与数字比较 `>` 会得到 NaN 比较恒 false，无告警

**建议**：至少补 `&&`/`||` 与 `exists()`；对引用了非直接依赖的 condition 在 create/replan 校验期报错（静默 false 是最坏的失败模式）。

---

<a id="p2-7"></a>
## P2-7：HTTP API 不对称——无 start / extend

**位置**：`server/routes/instance/httpapi/handlers/dag.ts`

control 支持 pause/resume/cancel/complete/step/replan，但**无 extend、无 start**——外部系统无法通过 HTTP 发起或追加工作流，只能由 agent 工具面发起。若 HTTP 面定位为完整控制面，需补齐并同步 SDK 再生成（`./packages/sdk/js/script/build.ts`）与 `test/server/httpapi-exercise` 场景。

---

<a id="p2-8"></a>
## P2-8：TUI Inspector / 面板缺陷合集

**位置**：`packages/tui/src/feature-plugins/system/dag-inspector.tsx`、`sidebar/dag-panel.tsx`

| 问题 | 位置 | 说明 |
|---|---|---|
| 无滚动容器 | inspector L379-501 | 节点树 `<For>` 平铺，40+ 节点溢出屏幕；键盘选中可移动到不可见区域（无 scroll-into-view） |
| 列表截断与导航不一致 | L341 `slice(0, 10)` vs L153-159 moveWorkflow 全量列表 | 第 11 个工作流可被选中但列表看不到 |
| 无 step 控制 | — | 后端有 stepping 状态、面板显示黄色 stepping，TUI 无法触发/继续单步（受 P0-3 制约） |
| replan/extend 不可见 | — | `replanAttempts`、节点取消/替换/重启历史、`WorkflowReplanned` 计数均不呈现 |
| 节点详情缺失 | — | 无输出预览、无耗时（started_at/completed_at 有数据不渲染）、无模型标注、无 deadline 倒计时 |
| footer 快捷键硬编码 | L505-517 | `p/r/x/↑↓/←→` 写死，命令实际走 `keybinds.gather("dag", ...)` 可重绑；close/enter 用了动态 `useCommandShortcut`，同文件内不一致 |
| 两套状态配色 | inspector L295-302 vs dag-panel L13-21 | inspector 缺 paused/stepping 分支（落默认色），panel 里是 warning 黄；running/pending/skipped/cancelled 在 inspector 全是 textMuted | 

**建议**：提取共享 status→color 映射；补 scrollbox + scroll-into-view；节点行加耗时/模型/输出摘要；footer 全部走 `useCommandShortcut`。

---

<a id="p2-9"></a>
## P2-9：summary 进度不计 skipped

**位置**：`store.ts:242-250`（只计 completed/running/failed）

进度显示 `completed/total`，条件跳过的节点永远不进分子——"3/5 · completed" 的工作流看起来像没跑完。skipped 应并入完成侧或单独列出（`⊘N`），schema `DagWorkflowSummary` 加 `skippedNodes` 字段后需再生成 SDK。

---

<a id="p2-10"></a>
## P2-10：pause 语义无提示

pause 只停新 spawn，运行中的子会话继续跑（合理设计），但工具描述、HTTP 文档、TUI toast 均无一处说明"暂停 ≠ 停止正在跑的节点"。补一句话成本极低。

---

## 附带观察（非缺陷，交接留档）

### 观察 1：final-audit 输出引用了错误的工作流 ID

final-audit 的结构化输出为：
```json
{"verdict":"ACCEPT","summary":"...工作流 dag_0679ada90ffeAHIyYfUv8WlxE0 已完成执行，4 节点（discover → {migrate-a, migrate-b condition:false} → assemble fan-in）..."}
```

- 引用的 `dag_0679ada90ffeAHIyYfUv8WlxE0` **不是**本工作流（`dag_067ef539cffe6fbuucCw7L5nko`）
- 描述的节点（discover/migrate-a/migrate-b/assemble）**不存在于本图**
- 可能原因：(a) 子 agent 在测试场景下幻觉编造；(b) 跨工作流上下文污染

**建议**：若是 (b)，排查子会话上下文是否混入其他工作流数据；若是 (a)，压测应使用更具约束性的 prompt。

### 观察 2：此前"永久卡死"诊断已被推翻

工作流执行中途查询 status 时 7 个节点显示 pending，当时诊断为"永久卡死"，但工作流最终 completed——这些节点随后被正常调度。**中途 status 快照不能判定卡死**，需配合 `isComplete()` / `hasRunning()` 等运行时方法。（另见 P0-2：大扇出下 pending/running 的显示语义本身有失真。）

---

## 修复优先级路线

```
第一批（正确性，可并行）：
  P0-1 skipped 调度态 + 级联       ← 三处合流点一次收敛
  P0-3 STEPPING→STEPPING 迁移      ← 一行迁移表 + projector from 列表
  P1-1 create 三项校验             ← 对齐 replan 已有逻辑

第二批（需要设计推演）：
  P0-2 permit 内建会话             ← 联动 deadline/recovery/QUEUED 语义
  P1-2 sanitize 豁免策略           ← 联动 review 契约
  P1-5 restart 显式报错

第三批（性能 + 清理 + UX）：
  P1-3 / P1-4 / P2-*

已完成：P0-1 / P0-3 / P1-1 / P1-5（报错面）/ P2-1 / P2-2（recovery-pause）/ P2-3（验证关闭+契约测试）/ P2-4（violation 读面清理）/ P2-5 / P2-6（引用校验）/ P2-8（TUI 对齐）/ P2-10（文案）
```

---

## 相关文件

| 文件 | 关键行 | 内容 |
|------|--------|------|
| `packages/opencode/src/dag/runtime/loop.ts` | 36-51, 318-353 | SUCCESS_TERMINAL 映射 / NodeSkipped→markSatisfied（**P0-1 根因**） |
| `packages/opencode/src/dag/runtime/loop.ts` | 88-104, 112-130 | condition 求值分支 / resolveInputMapping + sanitize 注入点 |
| `packages/opencode/src/dag/runtime/spawn.ts` | 97-156 | 会话急切创建（**P0-2 根因**） |
| `packages/opencode/src/dag/dag.ts` | 296-317, 356-385 | create 校验段（P1-1）/ step 守卫与内联映射（P0-3） |
| `packages/core/src/dag/core/scheduling.ts` | 50-113 | markSatisfied / getReadyNodes / isComplete |
| `packages/core/src/dag/core/types.ts` | 37-56, 156-200 | NodeStatus.SKIPPED / SkipReason / 迁移表 |
| `packages/core/src/dag/core/replan.ts` | 108-133 | restart 仅限 running / 终态 ignore（P1-5） |
| `packages/opencode/src/dag/templates/sanitize.ts` | 16-28 | 破坏性替换（P1-2） |
| `packages/core/src/dag/store.ts` | 226-257 | JS 聚合（P1-4）/ skipped 不计数（P2-9） |
| `packages/opencode/src/dag/runtime/eval.ts` | 32-54, 92-107 | evaluateCondition / resolvePath（求值逻辑本身正确，DSL 弱见 P2-6） |
| `packages/opencode/src/dag/runtime/recovery.ts` | 93-99 | ownership lost 判罚（P2-2，处置已改 recovery-pause） |
| `packages/tui/src/feature-plugins/system/dag-inspector.tsx` | 295-302, 341, 505-517 | 配色 / 截断 / footer（P2-8） |

---

## 关键会话 ID（交接用）

| 角色 | Session ID |
|------|-----------|
| 工作流父会话 | `ses_067f06f1bffeAmDFfH51NmNBl5` |
| quality-gate 子会话（返回 REVISE） | `ses_067ee102bffeQVj8nS1Jti7eet` |
| arbitrate 子会话 | `ses_067eebfe6ffe7tpZPn5m2EiV2U` |
| final-audit 子会话（返回 ACCEPT，引用错误 workflow ID） | `ses_06799fb9fffer5U2WPoyRYo3Jx` |
| integrate 子会话（skip 后仍执行） | `ses_0679b57baffexlZR1vLYr7VOwa` |
