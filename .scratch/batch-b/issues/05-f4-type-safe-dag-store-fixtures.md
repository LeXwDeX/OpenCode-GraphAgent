# 05 — F4：移除 DagStore fixture 的双重类型断言

**What to build:** 清除 `packages/opencode/test/dag/dag-timeout-escalation-fixes.test.ts` 中两处 `as unknown as DagStore.Interface`，改用类型安全的 `Layer.mock` 或测试 fixture factory。

**Evidence:** `.scratch/batch-b/evidence.md#f4--dagstore-双重断言`
**Branch:** `test/dag-store-fixtures`
**Blocked by:** None（04 已完成；代码写集独立）
**Status:** ready-for-agent

- [ ] 两处双重断言都消失，不能只修原评审记录的第一处
- [ ] fixture 缺少/签名漂移的方法能在 typecheck 时暴露
- [ ] 不复制 DagStore 生产逻辑到测试
- [ ] timeout escalation 目标测试行为与断言不削弱
- [ ] 在 `packages/opencode` 运行目标测试与 `bun typecheck`
