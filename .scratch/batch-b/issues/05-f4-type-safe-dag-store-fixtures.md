# 05 — F4：移除 DagStore fixture 的双重类型断言

**What to build:** 清除 `packages/opencode/test/dag/dag-timeout-escalation-fixes.test.ts` 中两处 `as unknown as DagStore.Interface`，改用类型安全的 `Layer.mock` 或测试 fixture factory。

**Evidence:** `.scratch/batch-b/evidence.md#f4--dagstore-双重断言`
**Branch:** `test/dag-store-fixtures`
**Blocked by:** None（04 已完成；代码写集独立）
**Status:** closed

- [x] 两处双重断言都消失，不能只修原评审记录的第一处
- [x] fixture 缺少/签名漂移的方法能在 typecheck 时暴露
- [x] 不复制 DagStore 生产逻辑到测试
- [x] timeout escalation 目标测试行为与断言不削弱
- [x] 在 `packages/opencode` 运行目标测试与 `bun typecheck`

## 红绿验证（基线 `403461e831aa8cda65d449f4a873db1d1686b44f`）

- **红灯：** 直接删除两处 `as unknown as DagStore.Interface` 后，在 `packages/opencode` 运行 `bun typecheck`，退出码 2。`TS2740` 分别出现在原第 322、370 行：仅含 `getNode` 的对象缺少 `getWorkflow`、`listWorkflows`、`listBySession`、`listByProject` 与另外 13 个 `DagStore.Interface` 成员。
- **绿灯：** 改为 `Layer.mock(DagStore.Service)`，通过 `Layer.unwrap` 将类型安全的 store fixture 注入 `Layer.mock(Dag.Service)`；`bun typecheck` 退出码 0。
- **重复验证：** `bun test test/dag/dag-timeout-escalation-fixes.test.ts` 连续运行 3 次，每次均为 12 pass、0 fail、38 次断言。
- **范围验证：** 相对上述基线，生产文件零 diff；只修改目标测试与批次 B 的票 05/06。
