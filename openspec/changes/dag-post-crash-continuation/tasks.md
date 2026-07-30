## 1. 恢复契约回归测试

- [x] 1.1 更新 `packages/opencode/test/dag/dag-recovery.test.ts`：active child + future deadline 预期 cancel 后 `NodeFailed(exec_failed)`，不再增加 `leftRunning`
- [x] 1.2 增加 active child + 无 deadline 的 ownership-loss 失败测试，验证节点不会保持 `running`
- [x] 1.3 更新 unknown/零消息 child Session 测试，验证 cancel、ownership-loss reason 和单一 `NodeFailed`
- [x] 1.4 保留并强化 expired deadline 测试，验证先 best-effort cancel、再发布 `NodeFailed(timeout)`
- [x] 1.5 保留 completed/failed child Session 与 structured output 恢复测试，确认已结算结果不会被误判为 ownership loss
- [x] 1.6 增加 cancel 失败测试，验证记录失败不会阻止 DAG 节点终态化

## 2. 确定性恢复实现

- [x] 2.1 在 `packages/opencode/src/dag/runtime/recovery.ts` 中将 recovered-running 的 active/unknown 分支改为确定性 ownership-loss 终态化
- [x] 2.2 对 active/unknown child Session 在发布 DAG 终态前调用注入的 cancel 操作，并将取消错误降级为结构化 warning
- [x] 2.3 保持 expired deadline 优先映射到 `timeout`，future/unset deadline 映射到 `exec_failed`
- [x] 2.4 使用稳定、可断言的 ownership-loss reason，并确保恢复流程不调用 `spawnNode`、`SessionPrompt.prompt` 或 `SessionExecution.wake`
- [x] 2.5 调整 `reconcileWorkflow()` 返回统计，移除或废弃误导性的 `leftRunning`，增加 ownership-loss 可观测计数
- [x] 2.6 更新 `packages/opencode/src/dag/runtime/loop.ts` 的恢复注释和日志，删除“旧执行会通过 normal wake 自行结算”的失效假设

## 3. DagLoop 真实恢复集成测试

- [x] 3.1 新建 DagLoop 恢复集成 fixture，组合 Database、EventV2Bridge、DagProjector、DagStore、Dag.Service、DagLoop，并通过 Effect Layer 注入可控 Session/SessionPrompt 服务
- [x] 3.2 测试启动恢复 active child + future/unset deadline：旧 child 被取消、节点投影为 failed、无 replacement Session 被创建
- [x] 3.3 测试启动恢复 expired deadline：节点投影为 failed、trigger/reason 保持 timeout 语义
- [x] 3.4 测试启动恢复 completed child + captured output：节点投影为 completed 且 output 保持一致
- [x] 3.5 测试 required recovered node 失败后的依赖级联和 workflow 终态，确认复用标准事件链路
- [x] 3.6 测试 `report_to_parent` 节点的恢复失败仍出现在 unreported wake 查询中
- [x] 3.7 测试恢复结束后 read model 中不存在无当前进程 fiber 所有权的 `running` 节点
- [x] 3.8 测试迟到 `NodeStarted`/`NodeCompleted` 不会复活已因 ownership loss 终态化的节点

## 4. 清理旧假设与文档

- [x] 4.1 搜索并修订代码注释、测试名称和 fixture 中关于 recovered active child 会自行产生 DAG terminal/wake 的表述
- [x] 4.2 确认没有重新引入 persistent polling watcher、detached fiber 或自动 provider retry
- [x] 4.3 确认恢复行为不需要数据库迁移、HTTP API 变更或 SDK 重新生成

## 5. 验证

- [x] 5.1 在 `packages/opencode` 运行新增的 recovery 单元测试与 DagLoop 恢复集成测试
- [x] 5.2 在 `packages/opencode` 运行 `bun test test/dag`
- [x] 5.3 在 `packages/opencode` 运行 `bun typecheck`
- [x] 5.4 在 `packages/core` 运行 `bun typecheck`，确认共享 DAG 类型与状态机契约未回归
- [x] 5.5 运行 `openspec validate dag-post-crash-continuation --strict`
