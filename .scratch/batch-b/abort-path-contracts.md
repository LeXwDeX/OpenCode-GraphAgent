# 批次 B：abort-path integrity 规格

**Status:** accepted
**Applies to:** 01 U-1、02 U-2、03 Transport mid-stream-stall
**Local OpenSpec source:** `openspec/changes/batch-b-abort-path-contracts/`（仓库规定 local-only；`openspec validate --changes` 已通过）

## 目标

三个边界目前只有实现/注释声明，没有真实失败路径证据：Session fork 嵌套发布失败时的批次回滚、HTTP timeout 对真实连接的取消传播、合法首帧后的逐帧间隔 timeout。本规格只补集成测试；红灯暴露违约时，才允许做对应契约所需的最小生产修复。

## Requirement 1：fork 复制批次原子回滚

系统 SHALL 在 `Session.fork` 的消息/part 复制批次中保持原子性：任一嵌套 durable event 发布失败时，同一外层事务内此前写入的复制事件及其投影全部回滚。

### Scenario：部分复制后嵌套发布失败

- WHEN fork 已创建目标 session，至少一个 message/part 发布完成，随后嵌套发布失败
- THEN fork 调用失败，目标 session 不存在本批复制出的 message/part projections 与 durable copy events
- THEN 源 session 的 message/part 保持不变
- THEN 复制事务外已经提交的目标 Session Created 记录可以保留

**设计裁决：** 必须扩展 `packages/opencode/test/session/fork-batch.test.ts` 的真实 SQLite fixture；adapter-only savepoint 测试不足以证明 EventV2/projector 共用外层连接。

## Requirement 2：provider timeout 取消真实 transport

系统 MUST 在 provider HTTP timeout 到期时，以现有 Transport/Timeout 结束 LLM stream，并取消仍在进行的真实 HTTP response stream，使 provider 端观察到连接或响应体取消。

### Scenario：真实 provider response 超时后仍保持打开

- WHEN loopback provider 已接收请求并返回超过 timeout 仍保持打开的 response stream
- THEN 客户端在有界时间内以现有 `LLMError` Transport/Timeout 失败
- THEN provider 在有界时间内观察到 response cancellation 或等价 request abort

**设计裁决：** 使用真实 `Bun.serve` loopback 与生产 fetch-backed client。以 response cancellation 为确定性主信号，request abort 可作补充；内存 HttpClient 和显式 Fiber interrupt 都不能替代本场景。

## Requirement 3：timeout 约束每个帧间隔

系统 SHALL 将 stream timeout 作为相邻数据帧之间的最大间隔，而不是只覆盖 response headers 或首帧等待。

### Scenario：合法首帧后永久停顿

- WHEN provider 在 timeout 内发出至少一个合法 SSE frame，随后不关闭且不再发送数据
- THEN timeout 前到达的 frame 已交付消费者
- THEN 停顿超过 timeout 后，stream 以现有 Transport/Timeout 失败

**设计裁决：** 使用 fence 证明首帧已交付，再用 TestClock 越过下一帧间隔；本场景验证 stream timing，不重复真实 socket 取消测试。

## 非目标与顺序

- 不要求把 fork session creation 与复制批次合并为同一事务。
- 不改变 timeout 默认值、错误词汇、retry policy 或 provider protocol。
- 01 → 02 → 03 串行落地；02/03 都修改 `packages/llm/test/transport-timeout.test.ts`。
- 若 Bun 在目标 CI 平台无法提供可重复的服务端取消信号，02 停在诊断结论，不能退化为重复断言 Timeout 错误。
