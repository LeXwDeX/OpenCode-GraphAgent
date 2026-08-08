# 03 — Transport：合法首帧后的 stall 触发逐帧超时

**What to build:** 增加“合法 SSE 首帧已交付，连接随后永久停顿”的测试，固定 `Stream.timeoutOrElse` 是相邻帧间隔上界的契约。

**Spec:** `.scratch/batch-b/abort-path-contracts.md` 的 Requirement 3
**Evidence:** `.scratch/batch-b/evidence.md#transport-mid-stream-stall`
**Branch:** `test/midstream-timeout`
**Blocked by:** 02（共同修改 `packages/llm/test/transport-timeout.test.ts`）
**Status:** blocked

- [ ] 用 fence 证明 timeout 前合法首帧已经交付给消费者
- [ ] 用 TestClock 越过下一帧间隔，随后得到现有 Transport/Timeout
- [ ] 不引入真实墙钟 sleep，不改变 timeout 默认值与错误词汇
- [ ] 完整 `transport-timeout.test.ts` 覆盖保持绿色
- [ ] 在 `packages/llm` 运行目标测试与 `bun typecheck`
