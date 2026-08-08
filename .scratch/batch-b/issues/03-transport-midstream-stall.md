# 03 — Transport：合法首帧后的 stall 触发逐帧超时

**What to build:** 增加“合法 SSE 首帧已交付，连接随后永久停顿”的测试，固定 `Stream.timeoutOrElse` 是相邻帧间隔上界的契约。

**Spec:** `.scratch/batch-b/abort-path-contracts.md` 的 Requirement 3
**Evidence:** `.scratch/batch-b/evidence.md#transport-mid-stream-stall`
**Branch:** `test/midstream-timeout`
**Blocked by:** None（02 已完成）
**Status:** closed

- [x] 用 fence 证明 timeout 前合法首帧已经交付给消费者
- [x] 用 TestClock 越过下一帧间隔，随后得到现有 Transport/Timeout
- [x] 不引入真实墙钟 sleep，不改变 timeout 默认值与错误词汇
- [x] 完整 `transport-timeout.test.ts` 覆盖保持绿色
- [x] 在 `packages/llm` 运行目标测试与 `bun typecheck`

## 验证证据

- 基线：`dev@1a8635400f3f4b7c4985b06f0776e13d6f2e5e05`；分支：`test/midstream-timeout`。
- 实现提交：`1d5d08f76`；PR：[LeXwDeX/OpenCode-GraphAgent#194](https://github.com/LeXwDeX/OpenCode-GraphAgent/pull/194) → `dev`。
- 公开 seam：`LLMClient.stream(...)` 消费合法 SSE text delta；`Deferred` fence 只在 `text-delta` 的 `text === "Hello"` 已交付时解除，随后 `TestClock` 将 1000ms 帧间 timeout 推进到 2000ms。
- mutation 红灯：临时绕过 response stream 的 `Stream.timeoutOrElse` 后，首帧 fence 仍解除，但新增场景因 stream 未结束而 0 pass / 1 fail；mutation 已恢复，生产文件无 diff。
- `cd packages/llm && bun test test/transport-timeout.test.ts`：连续 3 次均为 8 pass、0 fail、16 expect；`bun typecheck`：`tsgo --noEmit`，exit 0。
- 现有生产实现满足 OpenSpec Requirement 3；无生产代码、timeout 默认值、错误词汇或 provider protocol 修改。
