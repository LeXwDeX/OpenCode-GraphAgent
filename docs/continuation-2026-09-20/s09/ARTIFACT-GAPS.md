# S09 可运行工件边界

## 已归档

- 四任务 fixture、固定种子、prompt 与外部判分已经脱敏归档为 `scripts/task-spec.ts`。它不包含 provider/model 身份或 host 配置。
- v1 Core 微基准已归档为 `scripts/historical-context-folding-bench.ts`。设置 `S09_CORE_SRC=/absolute/candidate/packages/core/src` 后可复跑；它忠实保留历史测量方法及其缺陷，只用于复现。
- host 日志白名单检查器 `scripts/assess-folding-log.ts` 已用正向折叠、disabled、多 session 和缺诊断 fixture 验证。
- H0 raw HTTP host 测试已实现在 `packages/opencode/test/server/httpapi-sdk.test.ts`；公开摘要是 `h0-summary.json`，混合双臂日志检查器是 `scripts/assess-h0-host-log.ts`。
- 历史 9/19 台账、微基准数值、协议与源 hash 已归档。

## 故意没有复制

原 v2 live driver 没有复制为可执行工件，原因不是临时目录方便，而是它当前不满足续跑标准：

1. 硬编码了 provider/model 身份、measurement config、旧工作树、端口和 Bun 绝对路径；公开归档禁止保留模型连接配置。
2. 仍用 `assistant.length > promptIndex` 和 1.5 秒稳定窗口判断 user turn 完成，存在把既有 tool-loop assistant 消息误认成本轮完成的风险。
3. 记录真实 session ID、模型身份与最多 2000 字符完整模型回答，不符合本交接的最小公开证据边界。
4. 只按 assistant 记录限制 12，没有把 conversation 与 compaction 的全部 outbound provider 请求统一计入硬上限。
5. 没有实现 H0 的真实 outbound capture、witness/保护内容 hash、原始历史 hash 与副作用 ledger 断言。
6. 性能 runner 没有按配对 repetition 增量和 RSS delta 采样；历史 1 MiB 门槛已经失败。

原 v2 offline precheck 也没有原样复制，因为它绑定临时绝对路径、旧 provider/model 身份和 ephemeral tree hash，并会覆写 manifest/report。它的非秘密结论已经收入 handoff、协议与 task spec。

## 第二阶段必须补齐

1. 在 TUI `time.consumed` 整合后的最终候选 SHA 上重跑 H0；基线通过不等于最终冻结。
2. P0 性能 runner：同 repetition 的 enabled-disabled 增量样本、独立进程 RSS baseline/delta、输出字节和全部 fail-open 控制。
3. 真实模型 pair driver：通过 CLI 或外部环境注入候选路径、Bun、provider/model 和非秘密 measurement override；不读取或输出凭据；使用明确的 session idle/completed 事件而不是消息数量猜测完成。
4. driver 输出仅含本地私有原始工件；公开导出器只产生 hash、长度、计数和白名单诊断。

完成最终 H0 复验与 P0 且两者通过后才可冻结真实模型 driver。当前目录足以避免 fixture、协议、台账、旧基准和 H0 聚合证据只存在临时目录；它没有伪装成一个已可安全调用模型的 runner。
