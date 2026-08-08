# 批次 B 证据快照

**代码基线：** `dev@3e8368f37`
**用途：** 给每票的新任务/worktree 提供稳定证据；无需重新调查原始评审。
**原始来源：** 本地未追踪的 `.opencode/promotion-review-round1/*.md` 与 `.opencode/.dag-specs/evidence/*.md`。

## 组 1：abort-path 契约

### U-1 — Session fork 嵌套事务回滚

- 原始 finding 引用的 `packages/core/src/session.ts` 已过期；当前实现位于 `packages/opencode/src/session/session.ts` 的 `Session.fork`。
- fork 的消息/part 复制由一个外层 `db.transaction` 包裹，嵌套 `events.publish` 会进入 Effect-Drizzle SQLite savepoint。
- `packages/effect-drizzle-sqlite/src/effect-sqlite/session.ts` 已实现嵌套事务的 savepoint/rollback。
- `packages/opencode/test/session/fork-batch.test.ts` 已验证成功路径与事务/savepoint 数量，缺口仅是“部分发布成功后失败”的整体回滚。
- 目标契约、测试边界与非目标见 `.scratch/batch-b/abort-path-contracts.md`。

### U-2 — timeout 传播到底层 HTTP 取消

- `packages/llm/src/route/transport/http.ts` 对请求执行使用 `Effect.timeout`，对响应 stream 使用 `Stream.timeoutOrElse`。
- `packages/llm/test/transport-timeout.test.ts` 已覆盖 headers 挂起、body 从不发帧、正常完成、默认 timeout 与选项合并，但使用内存 HTTP client，不能证明真实 socket/response body 被取消。
- `packages/opencode/test/session/llm.test.ts` 已覆盖显式 Fiber interrupt 导致 provider response body 取消；本票必须验证“timeout 驱动”的取消，不能复制该场景。
- 验收必须使用真实 loopback `Bun.serve` + 生产 fetch-backed client，并以服务端可观察的 response cancellation 为主信号。

### Transport mid-stream-stall

- 当前 timeout suite 没有“合法首帧已交付，随后永久停顿”的场景。
- 本票验证逐帧间隔 timeout；可使用 TestClock，不承担真实 socket 取消证明。
- U-2 与本票都修改 `packages/llm/test/transport-timeout.test.ts`，必须先 02 后 03。

## 组 2：测试卫生债

### F3 — 固定订阅 settle sleep

- `packages/opencode/test/goal/e2e-loop.test.ts` 定义 `SUBSCRIPTION_SETTLE_MS = 200`，共有 8 个固定 `Effect.sleep` 等待点。
- `GoalLoop` 初始化主要读取实例状态并 fork 事件订阅；票据应以可观察 readiness/fence 或最小调度让步替代墙钟等待。
- 验收要求旧的固定 settle sleep 全部消失，并重复运行目标测试；不把生产行为修改当作默认方案。

### F4 — DagStore 双重断言

- `packages/opencode/test/dag/dag-timeout-escalation-fixes.test.ts` 有两处 `as unknown as DagStore.Interface`，原始证据只记录了第一处。
- 两处都需改为类型安全的 `Layer.mock`/fixture factory；不得只清一处。

## 组 3/4 与批 C

### O1 — remote config last-known-good

- PR #182/#189 前的现状已变化：`packages/opencode/src/config/config.ts` 在 remote transport/body 失败时会 warn + skip；HTML 登录页/auth 与 schema decode 仍硬失败。
- 剩余需求仅是持久化 LKG。实施前需裁决：缓存内容、稳定键、原子写与权限、何种失败允许回退、损坏缓存行为、TTL。
- 安全下限：缓存键不得含 header/token；LKG 不得掩盖 auth/decode 错误；损坏缓存只能 warn + skip。

### S7 — recovery INVENTED 推断

- `packages/opencode/src/dag/runtime/recovery.ts` 的 session checker 从最后一条 assistant finish 推断 active/terminal；tool-calls、unknown 或无 finish 会落入 active/unknown，并可能在 reconcile 中写入 `exec_failed`。
- `packages/opencode/src/dag/runtime/loop.ts` 在 `ownershipLost` 后会暂停 workflow，现有测试已覆盖该缓解；目前没有已复现的用户态缺陷。
- 只能按 `/diagnosing-bugs` 先建红灯反馈回路。若“durable transcript 已语义完成却被判 active 并写失败”无法稳定复现，结论应是无修复，不得凭静态推断改代码。

### P8 — spawnReady 复杂度

- `packages/opencode/src/dag/runtime/loop.ts` 的 `spawnReady` 对 ready 节点反复在全节点数组中 `.find`，静态复杂度为 `O(ready × nodes)`。
- 原始性能评审明确标记“>50 节点的实际调度开销未实测”；当前无用户痛点或 benchmark。
- 批 C 只记录观测结论；没有 trace/benchmark 证明影响时，以 no-code 关闭，不阻塞最终晋级。
