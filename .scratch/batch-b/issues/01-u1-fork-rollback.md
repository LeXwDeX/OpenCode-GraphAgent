# 01 — U-1：Session fork 中途失败整体回滚

**What to build:** 在真实 SQLite 的 `Session.fork` 集成测试中注入确定性中途失败，证明一个嵌套 durable publication 失败会回滚同一复制批次中已写入的消息/part 事件及投影。

**Spec:** `.scratch/batch-b/abort-path-contracts.md` 的 Requirement 1
**Evidence:** `.scratch/batch-b/evidence.md#u-1--session-fork-嵌套事务回滚`
**Branch:** `test/fork-rollback`
**Blocked by:** None
**Status:** ready-for-agent

- [ ] 复用 `packages/opencode/test/session/fork-batch.test.ts` 的真实 SQLite fixture；不写 adapter-only 替代测试
- [ ] 至少一个 message/part 发布完成后再确定性失败，旧实现若违约时测试能红
- [ ] 目标 session 无复制出的 durable events 与 projections，源 session 不变；Session Created 可保留
- [ ] 若红灯暴露生产缺陷，只做本契约所需的最小修复
- [ ] 在 `packages/opencode` 运行目标测试与 `bun typecheck`，结果附入票据
