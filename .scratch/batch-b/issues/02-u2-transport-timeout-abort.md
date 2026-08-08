# 02 — U-2：HTTP timeout 传播到真实 response 取消

**What to build:** 使用 loopback `Bun.serve` 与生产 fetch-backed HTTP client，证明 provider timeout 不只返回 Transport/Timeout，还会取消仍打开的真实响应流。

**Spec:** `.scratch/batch-b/abort-path-contracts.md` 的 Requirement 2
**Evidence:** `.scratch/batch-b/evidence.md#u-2--timeout-传播到底层-http-取消`
**Branch:** `test/transport-abort`
**Blocked by:** 01（同一 OpenSpec 串行落地）
**Status:** closed

- [x] fixture 提供“请求已接收”与“response 已取消”的有界 fence，禁止用固定 sleep 猜时序
- [x] timeout 后断言现有 `LLMError` Transport/Timeout 形状
- [x] 服务端确定性观察到 response stream cancellation；request abort 只作补充信号
- [x] 不用内存 HttpClient 或显式 Fiber interrupt 重复现有覆盖
- [x] 在 `packages/llm` 连续运行目标测试至少 3 次并运行 `bun typecheck`

## 验证证据

- 基线：`dev@55dd345491de4542dbf6fa7a4ba126a2c23104c4`；分支：`test/transport-abort`。
- 实现提交：`8ec1ef192`；PR：[LeXwDeX/OpenCode-GraphAgent#193](https://github.com/LeXwDeX/OpenCode-GraphAgent/pull/193) → `dev`。
- 真实 transport：公开 `LLMClient.stream(...)` 经 `FetchHttpClient.layer` 请求 loopback `Bun.serve`；2 秒有界 fence 分别证明请求已接收与服务端 response `cancel()` 已触发。
- mutation 红灯：临时移除 response stream 的 `Stream.timeoutOrElse` 后，新增场景在 1 秒测试边界超时，0 pass / 1 fail；mutation 已恢复，生产文件无 diff。
- `cd packages/llm && bun test test/transport-timeout.test.ts --timeout 30000`：连续 3 次均为 7 pass、0 fail、14 expect；`bun typecheck`：`tsgo --noEmit`，exit 0。
- 现有生产实现满足 OpenSpec Requirement 2，无生产代码修改；Requirement 3 留给 03 票。
