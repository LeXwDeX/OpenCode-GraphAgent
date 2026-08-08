# 02 — U-2：HTTP timeout 传播到真实 response 取消

**What to build:** 使用 loopback `Bun.serve` 与生产 fetch-backed HTTP client，证明 provider timeout 不只返回 Transport/Timeout，还会取消仍打开的真实响应流。

**Spec:** `.scratch/batch-b/abort-path-contracts.md` 的 Requirement 2
**Evidence:** `.scratch/batch-b/evidence.md#u-2--timeout-传播到底层-http-取消`
**Branch:** `test/transport-abort`
**Blocked by:** 01（同一 OpenSpec 串行落地）
**Status:** blocked

- [ ] fixture 提供“请求已接收”与“response 已取消”的有界 fence，禁止用固定 sleep 猜时序
- [ ] timeout 后断言现有 `LLMError` Transport/Timeout 形状
- [ ] 服务端确定性观察到 response stream cancellation；request abort 只作补充信号
- [ ] 不用内存 HttpClient 或显式 Fiber interrupt 重复现有覆盖
- [ ] 在 `packages/llm` 连续运行目标测试至少 3 次并运行 `bun typecheck`
