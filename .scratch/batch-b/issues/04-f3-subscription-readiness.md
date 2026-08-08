# 04 — F3：用确定性 readiness 替代订阅 settle sleep

**What to build:** 清除 `packages/opencode/test/goal/e2e-loop.test.ts` 的 `SUBSCRIPTION_SETTLE_MS = 200` 与 8 个固定 settle sleeps，用可观察 readiness/fence 或最小调度让步同步 GoalLoop 订阅就绪。

**Evidence:** `.scratch/batch-b/evidence.md#f3--固定订阅-settle-sleep`
**Branch:** `test/goal-readiness`
**Blocked by:** None（03 已完成；代码写集独立）
**Status:** ready-for-agent

- [ ] 先证明每个 sleep 等待的具体事件/状态，不用另一个超时数值替换 200ms
- [ ] 8 个固定 settle sleeps 全部删除或由同一确定性同步机制取代
- [ ] 默认不改生产行为；确需生产 readiness 信号时先在票内写明边界
- [ ] 目标测试连续运行至少 5 次稳定绿色
- [ ] 在 `packages/opencode` 运行目标测试与 `bun typecheck`
