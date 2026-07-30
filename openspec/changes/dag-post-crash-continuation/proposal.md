## Why

DAG 节点执行由进程内 fiber 驱动；进程崩溃后，持久化读模型可能仍把节点记为 `running`，但原 fiber 已永久丢失。当前恢复逻辑会把 child Session 看似 `active` 且未过 deadline 的节点继续留在 `running`，同时不恢复执行、不安装 watcher，也没有任何 DAG 终态事件可触发 wake，导致 workflow 可能永久悬挂。

## What Changes

- 明确进程重启后的执行所有权语义：不存在当前进程执行 fiber 的 recovered-running 节点不得被当作仍在推进。
- 恢复时先投影已经完成或失败的 child Session；对仍为 `active`/`unknown` 且已失去执行所有权的节点，停止旧 child Session 并确定性发布 `NodeFailed`，不隐式重试 provider/tool 执行。
- 保留 deadline 优先语义：已过 deadline 的 recovered-running 节点继续以 `timeout` 失败；未过 deadline 或无 deadline 也不得无限保持 `running`。
- 让节点失败、依赖级联、workflow 终态与 parent wake 继续通过既有 DAG 事件链路发生，显式 replan/restart 仍是恢复业务工作的唯一入口。
- 新增真实 DagLoop 恢复集成测试，覆盖 EventV2、Projector、DagStore、DagLoop、child Session 状态判断和 wake eligibility，而不是只直接驱动 `WorkflowRuntime`。
- 删除或修订“active child Session 会自行通过正常 wake 产生 DAG 终态”的失效假设与相关测试。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `dag-scheduler-recovery`: 将失去当前进程执行所有权的 recovered-running 节点从“继续等待”改为“不自动重试、确定性终态化”，消除无 deadline 节点的永久悬挂。
- `dag-execution-engine`: 明确 node execution fiber 是进程本地执行所有权；恢复流程不得假定旧 provider turn 会继续，也不得在没有显式新执行尝试的情况下保留 `running`。

## Impact

- `packages/opencode/src/dag/runtime/recovery.ts`：恢复判定、旧 child Session 取消和终态发布。
- `packages/opencode/src/dag/runtime/loop.ts`：rehydration 对 reconciliation 结果的处理与恢复可观测性。
- `packages/opencode/test/dag/`：恢复单元测试和真实 DagLoop 层级集成测试。
- `openspec/specs/dag-scheduler-recovery`、`openspec/specs/dag-execution-engine`：修订恢复契约。
- 不修改数据库 schema、HTTP API、SDK 或 TUI 数据结构。
- 行为变化：进程重启时仍显示 active/unknown、但没有当前进程执行所有权的节点将失败并进入既有级联/唤醒流程，而不是无限保持 `running`。
