# H0/P0 harness 实现准备

状态：H0 已在基线 `6b0e213108c3902fe2147f47e7d3b44fd5ce8884` 实现并通过；P0 由并行执行者实施中。没有修改产品、运行 CI 或调用模型。TUI 的 `time.consumed` 元数据尚未整合，因此 H0 结果是基线证据，不能替代最终候选复验与冻结。

## 顺序与共同约束

1. 在指定 SHA 的独立树中实现并运行 H0；H0 不得连接外部模型。基线已完成，最终整合 SHA 仍须复验。
2. 在同一最终候选上运行 P0；P0 的结果必须通过 `scripts/performance-gate.ts`。
3. H0、P0 任一失败都不得冻结候选，也不得消耗剩余 10 次真实模型预算。
4. 两项通过后冻结候选 SHA、运行时、输入生成器、判分器和配置 hash；之后才允许执行协议中的 2 次单请求预检与 8 臂配对实验。

## H0：真实 host 请求链的零模型触发证明

目标是证明真实 host 请求从 session 入口经过 production request preparation 和 OpenCode adapter，实际触发 context folding，并把变换后的请求交给一个确定性本地捕获 provider。直接调用 Core 或离线调用 adapter 不合格。

### 实现接点

- 复用 host 的正常 session/request 入口和 `llm.transformParams` 接线；不另写一条测试专用 folding 路径。
- provider 使用测试进程内启动的 loopback HTTP server 接收最终请求并返回固定响应；不得读取用户 provider 配置、外部端点或凭据，也不得发起外部网络请求。
- enabled 和 disabled 使用同一输入、同一运行时、同一捕获 provider；除 folding 开关外配置保持一致。
- 输入由固定种子生成，包含可折叠的重复 tool output、protected recent window 和每个候选来源的 witness。至少有一个 qualified enabled 样本必须 `applied=true` 且 `foldedOutputs>0`。

### 白名单证据

每臂只保存：候选 SHA、配置 hash、固定输入 hash、enabled/disabled、host 状态、adapter 到达次数、`applied`、`foldedOutputs`、skip reason、变换前后序列化字节数、消息角色/工具调用结构摘要、witness hash 比对、原始 session 存储 hash 比对和副作用计数。不得保存 prompt、tool output 正文、provider/model 身份、session ID、配置路径或凭据。

### 必须断言

- enabled 请求确实到达 production adapter，且捕获 provider 只收到折叠后的请求；`applied=true`、`foldedOutputs>0`、输出字节数下降。
- disabled 请求确实到达同一路径，捕获 provider 收到与 host 准备结果一致的未折叠请求。
- 所有来源 witness 保留；protected recent window 不变；消息顺序、角色、tool call/result 配对和工具协议有效。
- 持久化 session 历史在请求前后 hash 相同；没有额外工具执行、重复 assistant 写入或自动 compact/history mutation。
- all-unique、all-protected、below-target、work-limit、budget-exhausted 控制样本都必须保守地不折叠：`applied=false`、`foldedOutputs=0`、固定 skip reason、请求不变；其中工作预算耗尽控制固定返回 `work-limit`。

建议把 host 集成测试放在现有 session/runner hot path 测试附近，把本地捕获 provider 和 fixture 放在测试目录，避免导出新的生产 API。具体文件名须在收到集成树后按当前源码布局确定。

### 基线 H0 已实现边界

- 测试位于 `packages/opencode/test/server/httpapi-sdk.test.ts`，走当前 `serverPathParity` 的唯一 `raw` 分支；这是实际 Node HTTP host，不声明不存在的第二条路径。
- enabled/disabled 使用同一目录、文件、prompt 形状与 loopback provider；每臂 7 次 provider 请求。`compaction.auto` 与 dynamic folding 都保持开启，未通过关闭自动全文压缩来隔离实验。
- 三组 source/witness 由六次真实 builtin `read` 执行产生，并通过 production provenance ledger。fixture 使用 500 行文本，实际 metadata 为未截断且不含动态 instruction。
- enabled outbound 的三个 source 都是引用相应 witness call ID 的占位；三个 witness 与存储完整结果逐字节一致。disabled 的 source 与 witness 均保持原文。
- 既有 history 的比较只删除允许后续新增的 `info.time.consumed`；消息身份、顺序、正文、工具输入/输出、结算状态及其余元数据必须完全一致。新增 assistant/step 单独计数。
- after 完整 history 的 read settlement 仍为六个 completed 且 call ID 唯一，不能只检查 before ID subset；provider request 数也固定为每臂 7 次。
- raw host 日志必须设置 `OPENCODE_PRINT_LOGS=1` 保存到私有目录，并由 `scripts/assess-h0-host-log.ts` 聚合。基线观察到实际 `targetTokens=54476`，最终 enabled diagnostic 为 `applied=true`、`foldedOutputs=3`；该值来自生产 diagnostic，不来自配置硬编码。
- 详细结果见 `h0-summary.json`，控制项分层与缺口见 `H0-CONTROL-COVERAGE.md`。原始 outbound、preassert 和完整 host 日志含临时路径或 session 标识，不得提交。

## P0：决定是否允许真实模型预算的性能 runner

P0 必须测量 production adapter 执行的完整增量成本，包括预算计算、扫描、相等比较、复制、fingerprint 和 witness 验证。历史 Core 微基准只能用于复现，不能替代 P0。

### 样本与执行模型

- 固定 `1MiB` 与 `8MiB` 两档序列化输入，各自含可折叠重复项、protected window 和 witness。
- 每次 repetition 在同一输入上成对运行基线与 folding；交替执行顺序，记录 `folding - baseline`，避免把公共序列化/启动成本算作增量。
- `1MiB` 先预热至少 5 次、正式至少 20 次；`8MiB` 先预热至少 3 次、正式至少 10 次。门槛沿用协议，不调整。
- 基线与 folding 的单次时延及其差值都必须是有限数；`folding - baseline` 的原始差值允许因噪声为负，必须按原值和执行顺序保存，禁止裁零或丢样。汇总 `p95IncrementalMs` 必须从完整 signed 差值序列计算，并保持有限非负；禁止用均值或两个绝对 p95 的差替代。负单点不会触发额外模型调用或改变样本选择。
- RSS 每档使用新子进程，先记录稳定 baseline，再记录该档 folding 的 peak，输出 `rssDeltaPeakMiB = peak - baseline`。历史绝对 peak 不可复用。

### 结果与控制组

- 两个正向 row 都必须明确 `applied=true`、`foldedOutputs>0`、`projectedOutputBytes < serializedInputBytes`，并证明 original/witness intact。
- 必须运行与 H0 同名的五类控制组；每项记录精确布尔值、`applied=false`、`foldedOutputs=0`、固定 skip reason 和 `requestUnchanged=true`。
- raw samples 单独保存为不含正文的数值 JSON，并计算 SHA-256；汇总 JSON 使用 `performance-result.example.json` 的 schema，交给 `performance-gate.ts` 判定。
- runner 或汇总器遇到缺失字段、null、NaN/Infinity、非整数计数、非布尔完整性标记、未知/重复 row 或 control 时必须失败，不得生成可通过结果。

### 冻结门槛

- `1MiB`：p95 增量不超过 25 ms，RSS delta peak 不超过 64 MiB。
- `8MiB`：p95 增量不超过 250 ms，RSS delta peak 不超过 256 MiB。
- 两档都满足输入字节范围、最小预热/重复次数、正向实际折叠、完整性和控制组约束。
- gate exit 0、raw samples checksum 可复算，候选 SHA 与 H0 完全一致，才可冻结。

## 最终候选最小检查表

1. TUI `time.consumed` 整合后记录最终 SHA，确认工作树和目标内容精确匹配。
2. 直接读取当前 prompt/session runner hot path 和测试接线；旧图中标记变化的测试不可作为当前源码证据。
3. 使用 Bun 1.3.14 重跑 H0，保存首轮私有日志、outbound 与 preassert，并用 assessor 验证 diagnostic。
4. 在同一 SHA 运行 P0、重算 raw sample SHA-256 与 signed pair 差值 p95；不能只信汇总 boolean。
5. H0、P0 与定向 gate 任一失败时，只允许本地修复和零模型复测。
6. 将最终候选 SHA、证据 hash 和 gate 输出写回 S09 台账；真实模型阶段仍严格受 `10 sessions remaining / 0 retry budget` 限制。
