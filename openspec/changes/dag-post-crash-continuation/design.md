## Context

DAG 节点执行同时存在两类状态：

1. SQLite/EventV2 中的持久状态，例如节点 `running`、`child_session_id` 和 `deadline_ms`。
2. `DagLoop.WorkflowEntry.fibers` 中的进程本地执行所有权，真正驱动 `SessionPrompt.prompt()`、timeout 和最终 `NodeCompleted`/`NodeFailed`。

进程崩溃会保留第一类状态并永久销毁第二类状态。当前 `reconcileWorkflow()` 在 child Session 看似 `active`/`unknown` 且 deadline 未过期时保留节点 `running`，但不会恢复 provider turn，也不会安装 completion watcher。由于 child Session 的终态不会自动变成 DAG 终态事件，这类节点可能永远悬挂。

项目的 V2 Session 约束明确规定：本地 Session drain 没有 durable execution identity，崩溃后的 provider work 不得在没有独立设计的情况下自动重试。恢复方案因此必须优先保证“不重复执行工具/副作用”和“workflow 最终可达终态”，不能把数据库中的 `active` 当作可恢复执行所有权。

## Goals / Non-Goals

**Goals:**

- 为 recovered-running 节点建立明确、可测试的执行所有权规则。
- 不自动重试 provider/tool work 的前提下消除永久 `running`。
- 继续复用既有 `NodeFailed`、依赖级联、workflow 终态和 wake delivery 链路。
- 保持已完成 child Session 的结构化输出恢复行为。
- 用真实服务层级的集成测试覆盖启动恢复，而不只测试纯 `WorkflowRuntime`。

**Non-Goals:**

- 不实现 durable provider-turn checkpoint 或工具调用 exactly-once。
- 不调用 `SessionExecution.wake()` 自动续跑崩溃前的 provider turn。
- 不引入集群执行所有权、lease 或远程 worker adoption。
- 不修改数据库 schema、HTTP API、SDK、TUI 或 replan 产品语义。
- 不在本 change 中大规模拆分 `DagLoop` 或重构 `planReplan`。

## Decisions

### D1: 进程本地 fiber 是 DAG 节点执行所有权的唯一证明

恢复后的 `WorkflowEntry.fibers` 初始为空。数据库中的 `status = running` 和 Session 的最后消息只能说明崩溃前的投影状态，不能证明当前进程仍有执行在推进。

因此，启动恢复扫描发现的每个 `running` 节点都必须在 `reconcileWorkflow()` 内完成一次确定性分类，函数返回后不得留下无当前进程 fiber 所有权的 `running` 节点。

**备选：**把 child Session 的 `active` 状态当作仍在执行。否决，因为当前 Session drain 是进程本地的，重启后没有执行所有权或终态桥接。

### D2: 已结算结果投影；未结算执行确定性失败

恢复分类顺序如下：

1. 无 `childSessionId`：发布 `NodeFailed(exec_failed)`。
2. child Session 已完成：沿用现有 output schema/captured output 判定，发布 `NodeCompleted` 或 `NodeFailed(verdict_fail)`。
3. child Session 已失败：发布 `NodeFailed(exec_failed)`。
4. child Session 为 `active` 或 `unknown`：
   - deadline 已过：先 best-effort cancel child Session，再发布 `NodeFailed(timeout)`，原因保持 `deadline exceeded on recovery`。
   - deadline 未过或未设置：先 best-effort cancel child Session，再发布 `NodeFailed(exec_failed)`，原因明确为 `execution ownership lost on recovery`。

取消失败不得阻止 DAG 终态化；失败应记录结构化 warning。投影器的终态守卫负责拒绝之后可能到达的过期 `NodeStarted`/`NodeCompleted`。

**备选：**等待 deadline。否决，因为无 deadline 节点仍会永久悬挂，且未来 deadline 也没有本地 timeout fiber 负责触发。

### D3: 恢复不隐式创建新执行尝试

恢复流程不得调用 `spawnNode`、`SessionExecution.wake` 或重新提交旧 prompt 来延续 recovered-running 节点。需要继续业务工作时，parent orchestrator 必须通过既有 workflow `replan`/restart 创建一个显式新尝试。

这会把“可能重复执行副作用”的隐式恢复，转换为“旧尝试失败、后续尝试有明确控制事件”的可审计过程。

**备选：**自动把节点重置为 pending 并重跑。否决，因为工具调用和外部副作用没有 durable attempt identity 或 exactly-once 保证。

### D4: 恢复失败继续走标准 DAG 事件闭环

不增加新的节点状态或旁路恢复表。恢复只调用公开的 `Dag.Service.nodeCompleted/nodeFailed`：

- Projector 更新 read model；
- DagLoop 的既有节点终态 handler 更新 `WorkflowRuntime`；
- required failure 触发现有 workflow cancel；
- optional failure 允许既有调度继续；
- `report_to_parent` 和 workflow terminal 继续使用既有 durable wake eligibility。

`reconcileWorkflow()` 的返回统计改为反映实际结果，例如 `reconciled` 和 `ownershipLost`；不再暴露暗示节点仍可推进的 `leftRunning`，或至少强制该值在恢复后为零。

### D5: 增加真实 DagLoop 启动恢复集成夹具

新增测试应构造包含 Database、EventV2Bridge、DagProjector、DagStore、Dag.Service 和 DagLoop 的服务层，并以可控的 Session/SessionPrompt 服务替代真实 provider。

至少覆盖：

- active child + future deadline → cancel + `NodeFailed(exec_failed)`；
- active child + no deadline → cancel + `NodeFailed(exec_failed)`；
- active child + expired deadline → cancel + `NodeFailed(timeout)`；
- completed child + captured output → `NodeCompleted`；
- 恢复完成后 read model 不存在无本地所有权的 `running` 节点；
- 恢复产生的终态事件只投影一次，且不会触发 replacement spawn；
- wake-eligible node failure 仍可被既有 unreported wake 查询发现。

测试不得使用 `globalThis` mock；通过 Effect Layer 和现有 fixture 注入服务。

## Risks / Trade-offs

- **[恢复时可能放弃一个外部仍在运行的请求]** → 当前产品明确是进程本地执行；先调用 child Session cancel，并以终态投影守卫拒绝迟到事件。未来引入远程执行时必须先增加 durable ownership lease，再修改本契约。
- **[节点在未过 deadline 时更早失败]** → 这是执行所有权丢失后的真实状态，不是超时；使用 `exec_failed` 和明确 reason，让 orchestrator 可选择 replan/restart。
- **[required 节点恢复失败会取消 workflow]** → 复用既有 required failure 语义，避免新增仅用于恢复的状态机分支。
- **[取消 child Session 失败后仍可能出现迟到输出]** → 记录 warning，依赖 Projector 终态守卫保持 DAG read model 不被复活。
- **[集成夹具依赖较多、测试成本上升]** → 只覆盖启动恢复关键路径；纯调度排列组合继续留在快速单元测试中。

## Migration Plan

1. 先补恢复单元测试和服务层集成夹具，使当前行为以失败测试暴露。
2. 修改 `reconcileWorkflow()` 分类与取消顺序。
3. 调整 DagLoop rehydration 对恢复统计的处理与日志。
4. 运行 DAG 全量测试、core/opencode typecheck 和 HTTP exercise（确认无路由缺失）。
5. 部署无需数据迁移；已有悬挂 workflow 会在下一次实例启动/初始化时被确定性终态化。

回滚只需恢复旧 reconciliation 分支；不会涉及 schema 回退，但会重新引入 recovered-running 永久悬挂风险。

## Open Questions

- 本 change 使用现有 `exec_failed` trigger 并把 `execution ownership lost on recovery` 放入 reason。若后续需要按恢复故障单独统计，可另行增加 `recovery_lost` trigger；本次不扩展事件 schema。
