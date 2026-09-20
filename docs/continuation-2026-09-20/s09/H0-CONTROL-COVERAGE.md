# H0 控制项证据映射

候选基线：`6b0e213108c3902fe2147f47e7d3b44fd5ce8884`。运行时：Bun 1.3.14，darwin arm64。当前独立树没有对应的新图索引；以下结论来自当前源码精确读取和定向执行，不能外推为图覆盖完整。

## 真实 raw HTTP host 层

`packages/opencode/test/server/httpapi-sdk.test.ts` 的 `proves S09 H0 folding through the real host and local provider` 通过真实 Node HTTP host、生产 session/LLM/AI SDK adapter 和 loopback `TestLLMServer` 执行。当前 `serverPathParity` 只调用 `scenario("raw")`，所以这里只声明 raw HTTP 路径。

该测试的 enabled/disabled 各发出 7 次 provider 请求。六个 `read` 调用由正常 host builtin 执行并进入生产 provenance ledger；没有直接伪造数据库 tool part。最终 outbound 按 `tool_call_id` 逐项核对三个 source 占位和三个逐字节完整 witness。持久层核对既有消息身份、顺序、正文、工具输入/输出、状态和元数据；只忽略候选整合后允许新增的 `info.time.consumed`。完整 after history 仍只有六个已完成且 call ID 唯一的 read settlement，排除了旧 subset 检查遗漏新工具重放的情况。

生产 diagnostic 在同一隔离 run 中记录 14 条 conversation 评估：enabled/disabled 各 7 条。enabled 的实际 `targetTokens` 全部为 54476；最终 diagnostic 为 `applied=true`、`foldedOutputs=3`、`estimatedBefore=100814`、`estimatedAfter=69329`。disabled 全部为 `applied=false`、`foldedOutputs=0`、`skipReason=disabled`。这是运行时解析结果，不是把配置公式写死当成证据。

同一 host 运行还实际观察到 `below-target` 和 `all-sources-protected` 的保守跳过。它们发生在正向历史构建期间，不是独立冻结的控制 fixture。最终 provider-visible 请求证明 protected recent 文本完整；精确的 4 steps/16000 tokens 边界由下列 Core case 负责。

结果：1 pass、0 fail、18 filtered out、56 assertions。完整日志含 session ID、临时路径和测试 provider 身份，仅保存在私有临时目录；`h0-summary.json` 只公开聚合值和 SHA-256。

## OpenCode adapter 层

命令：`bun test test/session/context-folding.test.ts --timeout 30000`，结果 11 pass、0 fail、49 assertions。

- `fails closed when final AI SDK input, body, outer fields or order differ from the bound history`：changed input/body/outer/order 全部不应用，`skipReason=mapping-mismatch`。
- `fails closed when final Native input, body or order differs from the bound history`：Native adapter 同样保守拒绝。
- `fails closed when bound history metadata evidence changes`：comparison/outer metadata 变化均拒绝。
- `fails closed for an incomplete result mapping` 与 visible ID collision case：不完整或歧义映射不应用。

这些是 adapter 定向测试，不是 HTTP host 实跑。

## Core planner/projection 层

命令：`bun test test/session/context-folding.test.ts test/session/context-folding-projection.test.ts`，结果 41 pass、0 fail、7304 assertions。

- source protection：U09 验证全部 occurrence 都在 recent window 时返回 `all-sources-protected`；U12 验证 instruction 文件与动态 instruction 同时不能作为 source 或 witness。
- recent token 下限：U11 验证保护范围超过四步，直到 16000 tokens，并保持 parallel siblings 一起受保护。
- below target：`plans only above the soft target, not below or equal` 验证等于目标时 `below-target` 且不折叠，高于目标才进入规划。
- changed identity/body 与 stale fingerprint：`rejects missing, truncated, stale, reordered, or body-mismatched witness mappings` 和 `binds the captured fingerprint to the actual request, identity, budget, and final wire IDs` 验证请求、identity、budget、wire ID 或正文变化时保持原请求并返回保守 skip。
- work limit：resource-limit 四个 case 覆盖超深/超大/稀疏/候选过多、退化 fingerprint bucket、超大预算输入和 mapping 数量上限，结果均不应用并返回 `work-limit` 或对应 fail-closed 结果。
- collision 完整比较：U18 强制 fingerprint collision 后仍比较完整 identity，没有把不同正文当成重复项。

这些是 Core 单元测试，不是 adapter 或 HTTP host 实跑。

## 尚未覆盖为独立 HTTP 控制的项目

changed body/identity、精确 16000-token 边界、stale fingerprint 和 work-limit 没有各自新增 raw HTTP fixture。现有分层证据覆盖其实现边界，且不需要为 H0 触发证明扩写重复测试。最终候选仍必须在 TUI `time.consumed` 整合后重跑 H0；P0 未完成前不得冻结或调用真实模型。
