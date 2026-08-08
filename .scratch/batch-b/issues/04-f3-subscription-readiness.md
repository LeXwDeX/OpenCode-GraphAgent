# 04 — F3：用确定性 readiness 替代订阅 settle sleep

**What to build:** 清除 `packages/opencode/test/goal/e2e-loop.test.ts` 的 `SUBSCRIPTION_SETTLE_MS = 200` 与 8 个固定 settle sleeps，用可观察 readiness/fence 或最小调度让步同步 GoalLoop 订阅就绪。

**Evidence:** `.scratch/batch-b/evidence.md#f3--固定订阅-settle-sleep`
**Branch:** `test/goal-readiness`
**Blocked by:** None（03 已完成；代码写集独立）
**Status:** closed

- [x] 先证明每个 sleep 等待的具体事件/状态，不用另一个超时数值替换 200ms
- [x] 8 个固定 settle sleeps 全部删除或由同一确定性同步机制取代
- [x] 默认不改生产行为；确需生产 readiness 信号时先在票内写明边界
- [x] 目标测试连续运行至少 5 次稳定绿色
- [x] 在 `packages/opencode` 运行目标测试与 `bun typecheck`

## 完成证据

- Commit: `f77106bc03b5c4ec6816dd82d9bba8485974f790`（`test(goal): replace subscription settle sleeps`）
- PR: [#195](https://github.com/LeXwDeX/OpenCode-GraphAgent/pull/195) → `dev`
- TDD: 首场景保留 200ms sleep 时基线绿色；删除同步点后首次 idle 被漏掉，`judge call 1` 未触发；加入一次 `Effect.yieldNow` 后恢复绿色，再机械推广到其余 7 处。
- 验证：目标文件连续 5 次全绿（每次 8/8）；`packages/opencode` 的 `bun typecheck` 通过；提交钩子 lint 0 error、全仓 typecheck 29/29。
- 范围：旧常量与 8 个固定 sleep 全部消失；生产代码零 diff。
