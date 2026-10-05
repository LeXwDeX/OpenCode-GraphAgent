# 内置提示词修复记录

## Why

2026 年 10 月 5 日的源码审计确认 24 项提示词事实或工具合同错配。用户要求说明步数上限，并处理改写工具、Claude 迁移、system-reminder 来源、DAG 状态和工具能力等问题。

## Scope

- 核实 agent.steps、Goal 每轮上限、步数计数和最终响应行为。
- 新增全局 maxToolCalls 配置。按实际工具调用计数；同一轮调用 3 个工具计 3 次。
- 用一个共享默认值和预算实现覆盖普通会话、Goal、子代理及两个运行时。移除 Goal 私有的 50 步上限。
- 修复达到步数上限后仍向模型提供执行工具的错配。
- 校正 Edit/Write 等工具说明。保留先读取已有文件的操作要求，明确现有工具的实际检查。
- 校正 .claude hooks 迁移提示，保留 .claude/skills 的兼容加载。
- 移除仅凭 system-reminder 文本标签就认定可信来源的指引。
- 校正 DAG 状态、模型层级、模板安装前提、结果类型、工具名称和反馈地址。
- 修复 Core 搜索工具的外部目录授权缺口，沿用现有 Location 路径解析和 leaf 权限策略。
- 保留用户已有改动和配置。不升级依赖，不改变 DAG 状态机和发布流程。配置 API 增加 maxToolCalls，并同步生成客户端。

## Approach

sol 负责实现和会审。luna 负责已确定方案的文本修订。astra 只做完成后的终审。

先按当前源码修正提示词的事实。安全边界已有明确产品合同的地方，补足运行时执行。`maxToolCalls` 默认 0，表示不限调用次数；正整数才启用限额。唯一默认常量放在 Core。各配置层不解码默认值，合并配置后再应用默认值。每次用户输入创建待用预算，包含该输入的模型请求启用预算；后续模型请求和压缩沿用预算。子代理使用相同配置，但独立计数。工具执行前同步占用预算，失败或权限拒绝不退回。预算耗尽后只请求文字总结。`agent.steps` 保留兼容，仍表示模型轮次。

Core 搜索沿用现有规范路径和 external_directory 授权，防止通过绝对路径、.. 或符号链接跳过目录权限。

## Acceptance

- 明确说明普通会话和 Goal 会话的默认上限及配置来源。
- 验证配置默认值、覆盖顺序和参数校验。验证并发调用分别计数，新用户输入重置，后续模型请求和压缩不重置。
- 新输入只在被模型请求消费时启用预算。撤回未消费的排队输入不能给当前任务补充额度；消息快照和预算在同一锁内取得。
- 预算耗尽后不执行额外工具。结构化结果工具也计数；预算不足时明确报告未完成结构化输出。
- 最后一步不提供执行工具，toolChoice 为 none；不与结构化输出要求冲突。
- 用回归用例验证最后一步、正常步骤、结构化输出和外部路径授权行为。
- 所有已确认错配都有修复映射；纯措辞建议只澄清边界。
- 运行工具链检查、受影响包 typecheck 和相关回归测试。若改变 DAG 生命周期或持久化，另运行 DAG gate。
- 更新两个生成客户端并检查生成幂等性，运行配置 HTTP 回归。
- 记录实际检查结果和未验证的范围。经 astra 终审后交付本地修改。

## 当前状态

提示词审计和修复已完成。初始方案的验证记录保留在下文。依据用户的系统一致性要求，本轮保留唯一配置并将默认值设为 0，表示不限调用次数。配置校验、HTTP 场景、客户端和文档已同步。AFK 提问输出已统一为用户暂时离开、由 Agent 自行判断最优解。相关回归、源码终端验收和 astra 最终方案及代码终审均通过。

## 用户最终合同

顶层配置项 `maxToolCalls` 可省略。全局默认值是 0，表示不限调用次数。唯一默认值和共享校验/helper 位于 `packages/core/src/session/tool-budget.ts`。配置读取现有的 `opencode.json` / `opencode.jsonc` 全局与项目层，并沿用已有配置合并规则。每层配置缺少该字段时保持未定义；完成配置合并后才应用默认值。字段必须是非负安全整数。0 不耗尽预算；正整数限制每个输入可执行的本地工具调用数。同一轮模型请求返回 3 个工具调用时，本地预算消耗 3。

配置示例中的 `maxToolCalls` 位于配置文件顶层：

```json
{ "maxToolCalls": 0 }
```

设置正整数可启用限额。例如 `{ "maxToolCalls": 50 }` 会将每个输入的调用次数限制为 50。省略配置项或显式设置为 0 都表示不限调用次数。

此配置管理本地工具调度。Copilot `providerOptions` 中同名的 `maxToolCalls` / `max_tool_calls` 是传给外部 Responses API 的 provider built-in 工具参数，作用于单个 response。它没有本地默认值或本地计数，也不会从顶层 `maxToolCalls: 0` 注入。外部服务自身的限制不由本地配置改写。

每个 session input 有独立预算；包含新输入的模型请求启用新预算。未消费的排队输入被撤回时，只删除其待用预算，当前任务的预算不变。消息快照与预算在同一把锁内取得。子代理读取相同配置，但有自己的预算。手动 `/goal` 新目标和 `/goal resume` 是新的用户输入，开始新预算。Goal 自动续轮沿用当前用户输入的预算。内部 compaction、Task stop、background-result、HookRewake、DAGwake、`submit_result` nudge、取消以及重新进入 loop 都沿用当前预算，不重置预算。预算在内存中；实例重启会重建预算。

预算按本地完整解析出的 tool-call 事件计数。事件在执行/结算 admission 入口占用一次；参数 schema 校验失败的完整事件也计数。opencode 的同一次请求中，同一 call ID 的 execute 与事件只计一次，第二次 execute 会被拒绝。Core 每次 dispatch 都占用预算，不因 call ID 重复而免费放行。工具失败不退还预算。半截输入或 parse 失败、没有形成完整事件时不计数。StructuredOutput 和 `submit_result` 同样计数。`agent.steps` 继续表示模型轮次，不应用 `maxToolCalls` 语义，也没有隐式轮次默认值。移除 Goal 原先固定的 50 轮硬上限。

Core 的模型配置路径只剥离原始 `tools` 和 `tool_choice` overlay，防止它覆盖运行时目录生成的工具集合以及 `toolChoice: none`。其他 HTTP overlay 保持原行为。

GitHub Copilot 在历史消息包含工具调用时需要 `_noop` 兼容工具。预算耗尽时保留其 schema，但仍发送 `toolChoice: none`，且拒绝执行该工具。

## 审计修复映射

下列 24 项来自最终审计的 confirmed 清单。路径表示对应修复或回归覆盖所在位置。

| ID    | 修复文件                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | `packages/core/src/session/tool-budget.ts`; `packages/core/src/session/runner/llm.ts`; `packages/opencode/src/session/prompt.ts`; `packages/opencode/src/session/llm.ts`; `packages/opencode/src/goal/goal.ts` |
| CMD-1 | `packages/opencode/src/command/template/create-hook.txt`                                                                                                                                                       |
| CMD-2 | `packages/opencode/src/command/template/import-claude-hooks.txt`                                                                                                                                               |
| DAG-1 | `packages/core/src/plugin/command/workflow.md`; `packages/core/src/plugin/command/orchestration-policy.md`; `packages/core/src/plugin/skill/create-dag-workflow.md`                                            |
| DAG-2 | `packages/core/src/plugin/command/workflow.md`; `packages/core/src/plugin/command/orchestration-policy.md`; `packages/opencode/src/tool/workflow.ts`                                                           |
| DAG-5 | `packages/core/src/plugin/command/workflow.md`; `packages/core/src/plugin/command/orchestration-policy.md`                                                                                                     |
| DAG-6 | `packages/core/src/plugin/command/workflow.md`; `packages/core/src/plugin/skill/create-dag-workflow.md`                                                                                                        |
| S2    | `packages/opencode/src/session/prompt/beast.txt`                                                                                                                                                               |
| S3    | `packages/opencode/src/session/prompt/plan-mode.txt`                                                                                                                                                           |
| S4    | `packages/opencode/src/session/prompt/default.txt`; `packages/opencode/src/session/prompt/anthropic.txt`; `packages/opencode/src/session/prompt/gemini.txt`                                                    |
| S7    | `packages/opencode/src/cli/cmd/github.handler.ts`                                                                                                                                                              |
| T1    | `packages/opencode/src/tool/edit.txt`; `packages/opencode/src/tool/write.txt`                                                                                                                                  |
| T12   | `packages/opencode/src/session/prompt/default.txt`; `packages/opencode/src/session/prompt/anthropic.txt`; `packages/opencode/src/session/prompt/trinity.txt`; `packages/opencode/src/session/prompt/kimi.txt`  |
| T2    | `packages/opencode/src/tool/shell/prompt.ts`                                                                                                                                                                   |
| T3    | `packages/opencode/src/tool/webfetch.txt`                                                                                                                                                                      |
| T4    | `packages/opencode/src/tool/websearch.txt`; `packages/opencode/src/tool/websearch.ts`; `packages/core/src/tool/websearch.ts`                                                                                   |
| T5    | `packages/opencode/src/session/prompt/gpt.txt`                                                                                                                                                                 |
| T6    | `packages/opencode/src/tool/submit_result.txt`                                                                                                                                                                 |
| T8    | `packages/core/src/tool/glob.ts`; `packages/core/src/tool/grep.ts`; `packages/core/test/tool-search-authorization.test.ts`; `packages/core/test/session/session-runner-hotpath.test.ts`                        |
| S6    | `packages/opencode/src/agent/agent.ts`; `packages/core/src/plugin/agent.ts`                                                                                                                                    |
| T10   | `packages/opencode/src/tool/edit.txt`                                                                                                                                                                          |
| T11   | `packages/opencode/src/tool/task.txt`                                                                                                                                                                          |
| T7    | `packages/opencode/src/session/prompt/gemini.txt`                                                                                                                                                              |
| T9    | `packages/core/src/tool/glob.ts`                                                                                                                                                                               |

最终审计另列 6 项 advisory。它们也有对应文案或范围修正；DAG-3、DAG-4、DAG-7 和 SKILL-1 保留为 advisory 范围说明，不提升为运行时缺陷。

| ID      | 修复文件                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------- |
| S5      | `packages/opencode/src/session/system.ts`                                                               |
| S8      | `packages/opencode/src/cli/cmd/github.handler.ts`                                                       |
| DAG-3   | `packages/core/src/plugin/command/workflow.md`; `packages/core/src/plugin/skill/create-dag-workflow.md` |
| DAG-4   | `packages/opencode/src/dag/runtime/loop.ts`                                                             |
| DAG-7   | `packages/core/src/plugin/command/workflow.md`                                                          |
| SKILL-1 | `packages/core/src/plugin/skill/customize-opencode.md`                                                  |

## 初始方案验证记录

以下是采用默认 50 限额时完成的实际验证记录。它们准确记录了当时的测试结果，不代表本轮默认 0 的验收已经完成。

- 工具链：`bun run toolchain:check` 通过。
- Core 配置与共享预算，在 `packages/core` 运行 `bun test --timeout 30000 test/session/tool-budget.test.ts test/config/config.test.ts`：23 项通过、148 次断言；`bun run typecheck` 通过。
- Core runner，在 `packages/core` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun test --timeout 30000 test/session-runner.test.ts test/session-runner-model.test.ts test/session/session-runner-hotpath.test.ts --only-failures`：107 项通过、401 次断言。模型 wire 边界单测运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun test --timeout 30000 test/session-runner-model.test.ts`：13 项通过、27 次断言。Core typecheck 通过。
- Goal，在 `packages/opencode` 运行 `bun run test test/goal`：145 项通过、493 次断言。Core 和 OpenCode 的最终联合 typecheck 均通过。
- 工具合同：Core 搜索授权等用例运行 `bun test --timeout 30000 test/tool-search-authorization.test.ts test/location-mutation.test.ts test/session/session-runner-hotpath.test.ts`，29 项通过、153 次断言；`bun test --timeout 30000 test/tool-websearch.test.ts` 通过。OpenCode 在 `packages/opencode` 运行 `bun test --timeout 30000 test/tool/edit.test.ts test/tool/write.test.ts test/tool/webfetch.test.ts test/tool/websearch.test.ts test/tool/submit-result.test.ts test/tool/task.test.ts test/tool/shell.test.ts`：119 项通过、316 次断言。
- 配置 API，在 `packages/client` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run generate`，在 `packages/sdk/js` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run build`，两条命令各重复两次。24 个生成文件的两次 SHA-256 清单一致。SDK v2 Config、`config.get` 和 `config.update` 类型包含新字段。`packages/client` 当前生成器只覆盖 `server.session`，没有配置 payload 类型。
- JSON Schema，在 `packages/opencode` 两次运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run script/schema.ts /tmp/graphagent-config.schema.json`，输出哈希一致；字段是可选正整数，上限 `Number.MAX_SAFE_INTEGER`。
- HTTP API，在 `packages/opencode` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run test:httpapi`：coverage、auth、effect 三种模式各 236 项通过，0 失败、0 跳过。effect 模式有隔离测试进程的 DAG supervision/publisher 告警，命令最终成功。
- 所有本次相关局部 diff 的 `git diff --check` 通过。
- 会话集成，终审修复后在 `packages/opencode` 运行 `bun run test test/session/prompt.test.ts`：134 项通过，1 项既有跳过，0 失败，915 次断言。跳过用例是已停用 v2 projector 的提示事件测试。本次新增预算、步骤和排队输入用例均通过。
- LLM 适配器，在 `packages/opencode` 运行 `bun run test test/session/llm.test.ts test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts test/session/llm-request.test.ts`：94 项通过，1 项既有跳过，0 失败，338 次断言。
- Task，在预算选项透传后运行 `bun run test test/tool/task.test.ts`：30 项通过，0 失败，121 次断言。
- DAG 节点补交，在 `packages/opencode` 运行 nudge 相关定向测试：46 项通过。新增真实 spawnNode 用例验证预算耗尽时不重新获得调用额度，有剩余额度时可以补交结果。
- 最终预算及步骤回归，在 `packages/opencode` 定向运行 `test/session/prompt.test.ts`：16 项通过、0 失败、116 次断言。
- 终审修复回归：排队输入撤回不重置当前预算、新输入在消费时启用独立预算，两类用例各覆盖 AI SDK 和 native，共 4 项通过。修复后原有预算定向用例 10 项通过；OpenCode 包级 typecheck 通过。
- Copilot 兼容，在 `packages/opencode` 运行 `bun run test test/session/llm.test.ts`：66 项通过、0 失败。新增 3 项服务用例验证历史工具消息的 `_noop` schema、预算耗尽时的真实请求和意外 `_noop` 调用拒绝。
- DAG gate：Core 102 项通过，OpenCode DAG 735 项通过、1 项既有跳过，Schema manifest 3 项通过，TUI 61 项通过。行为和覆盖率门槛均通过。
- DAG gate 的 SDK 生成检查：最终原始 `bun run test:dag-core` 的行为和覆盖率检查通过；整条命令在 `git diff --exit-code` 处因本次预期的未提交生成文件差异退出 1。使用任务专属临时索引保存这 15 个文件的预期生成结果，仅将 SDK 的这一条 diff 与该基线比较；其余 Git 操作使用真实索引。最终 `bun run check:generated` 通过，生成结果没有新增漂移；单独运行剩余 TUI 用例，61 项通过。该结果验证本次输出的幂等性，不表示工作区与 HEAD 无差异。没有改动门禁或覆盖率门槛。
- 根目录 `bun run lint`：0 错误、4847 个告警，低于现有 4850 上限，命令通过。没有提高告警上限。
- 本次共享预算、会话实现、会话回归、Task 和修复记录的 Prettier 检查通过。

astra 最终方案和代码终审通过，排队预算归属问题已复审解决。终审记录：`/tmp/graphagent-astra-prompt-fixes-review.json`。

验证均为本地操作。没有读取或写入配置凭据，没有外部写入，也没有安装本地二进制。

## 统一工具调用次数配置

- Why：用户要求系统一致性，由实现选择保留或移除；各模块不能分别设置工具调用次数上限。
- Scope：两个运行时、普通会话、Goal、DAG、子代理及配置 API 的统一工具调用预算。
- Approach：保留唯一 maxToolCalls 配置，默认 0 表示无限；正整数表示限额。共享默认值、校验和执行逻辑仍位于同一模块。各运行时和模块不增加私有上限。同步客户端、HTTP 场景、测试与说明。
- Acceptance：验证默认配置及显式 0 均不限调用次数，正整数限额仍有效。运行受影响包 typecheck、相关回归、客户端生成和配置 HTTP 验证，再由 astra 终审。

## 默认不限调用次数的本轮验证

本节只记录本轮实际运行的检查。

- Core 共享预算与配置校验已改为默认 0 表示不限调用次数，并接受非负安全整数。Core 相关 113 项测试、600 次断言和 Core typecheck 通过；详见 `/tmp/graphagent-global-tool-budget-unlimited-core.json`。
- Core 的默认配置和显式 0 分别执行了 52 次真实本地测试工具调用。OpenCode 的 AI SDK 和 native 两条路径也各覆盖默认配置和显式 0，共 4 项回归通过、52 次断言；每个用例执行一批 51 次真实 glob 调用，再在后续模型请求执行 1 次调用。52 个工具结果均完成，后续请求继续提供工具。
- OpenCode 的正整数限额、排队输入和原有步数控制定向回归：20 项通过、0 失败、150 次断言。LLM 四个适配文件：97 项通过、1 项既有跳过、0 失败、346 次断言。Goal 与 DAG 结构化结果回归：179 项通过、0 失败、591 次断言。
- JSON Schema 在 `packages/opencode` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run script/schema.ts /tmp/graphagent-config.schema.json`。生成结果中 `maxToolCalls` 是可选整数，最小值 0，最大值 `Number.MAX_SAFE_INTEGER`，没有 schema default。
- HTTP API 在 `packages/opencode` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run test:httpapi`。coverage、auth 和 effect 三种模式均以 236 项通过、0 失败、0 跳过结束。effect 模式打印隔离测试进程的 DAG supervision/publisher 告警；命令最终退出码为 0。
- `packages/client` 的 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run generate` 连续运行两次；9 个生成文件的 SHA-256 清单一致。该客户端生成器不包含配置 payload 类型。
- `packages/sdk/js` 的 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run build` 连续运行两次；15 个 v2 生成文件的 SHA-256 清单一致。生成的 `Config` 类型含可选 `maxToolCalls?: number`。
- `packages/opencode` 的 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run typecheck` 通过。
- 完整会话回归：在 `packages/opencode` 运行 `PATH=/tmp/node-v24.21.0-darwin-arm64/bin:$PATH bun run test test/session/prompt.test.ts`，138 项通过、1 项既有跳过、0 失败、967 次断言。

## AFK 提问回答

- Why：用户要求提问无人回答时，明确告诉 Agent 用户不在电脑前，并由 Agent 自行判断最优解。
- Scope：Core 和 OpenCode 提问工具共享的超时输出与提示说明。当前工具通过未回答超时表示用户暂时离开。
- Approach：在共享 QuestionGuidance 中统一说明用户不在电脑前。要求 Agent 依据任务、已有指令和证据自行选择最优解并继续执行。推荐选项仅作参考。自由回答问题没有候选项时，也可自行推断合理方案。保留原有授权边界、人工回答和主动拒答处理。
- Acceptance：现有两条工具路径均返回一致 AFK 指引。验证超时不会伪造用户回答，自由回答问题不会仅因缺少候选项而阻塞。运行现有提问测试、相关包 typecheck 和源码 TUI 超时回归，再由 astra 终审。

AFK 验证已完成：Core 与 OpenCode 的问题工具测试各 5 项通过；Core 问题服务 8 项通过、31 次断言；OpenCode 问题服务 21 项通过、58 次断言。两个包的 typecheck 通过。共享问题说明变更后，会话压缩和上下文定向回归 20 项通过、222 次断言。启用 `OPENCODE_TEST_TUI_SOURCE=1` 运行现有 TUI 超时场景，1 项通过、30 次断言。该场景验证模型收到 AFK 指引后继续读取文件，也验证人工回答和主动拒答路径。验证使用隔离源码进程和本地测试模型，没有安装二进制。

本轮最终方案和代码经 astra 终审通过，没有阻断项。终审记录：`/tmp/graphagent-astra-tool-budget-unlimited-review.json`。最终实现保留先前的排队预算归属修复，并明确 Copilot 外部 API 同名参数的独立语义。根目录 lint 复验为 4847 个告警、0 错误，低于原有 4850 上限。相关格式和 diff 检查通过。

### CR-001：统一 Goal 自动续轮的预算

原说明明确允许 Goal 每次自动续轮领取新预算。因此，自动续轮原有行为不是已确认的实现缺陷。系统一致性审查后，将该规则改为：同一用户输入驱动的 Goal、Hook 和 DAG 自动延续共享当前预算。手动设定新目标或恢复目标领取新预算。独立子代理会话仍独立计数。默认 `maxToolCalls: 0` 继续表示无限；Goal 不增加私有上限。
