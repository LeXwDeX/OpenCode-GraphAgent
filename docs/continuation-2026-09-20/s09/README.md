# S09 可公开证据包

此目录只保存脱敏摘要、校验和与零模型证据检查脚本。没有复制以下内容：

- `xdg-*`、SQLite/WAL/SHM、cache、全局或项目配置；
- token、cookie、Authorization、provider endpoint 或模型连接配置；
- session ID、原始 prompt、模型完整回答、工具输出正文、用户路径或完整私有日志。

文件说明：

- `PROTOCOL.md`：下一次最小有效 S09 协议、停止规则、判分和资源预算。
- `v2-run-ledger.sanitized.json`：9/19 历史消费与剩余 10 次计划，不含 session/model/provider 身份。
- `benchmark-summary.json`：原始微基准的脱敏数值与可信度判定。
- `source-checksums.sha256`：用于追溯的非秘密源文件 hash；原文件没有复制进仓库。
- `scripts/assess-folding-log.ts`：只输出白名单聚合字段的 host 日志检查器，不调用模型。
- `scripts/assess-h0-host-log.ts`：校验同一隔离 raw HTTP H0 run 的 enabled/disabled diagnostic、实际 target 和测试结果；只输出聚合字段。
- `scripts/task-spec.ts`：四个 synthetic 任务、固定种子和外部判分；已移除 provider/model 身份及连接配置。
- `scripts/historical-context-folding-bench.ts`：可复跑的历史 v1 Core 微基准；仅用于复现旧结果，不能决定 P0。
- `scripts/performance-gate.ts` 与 `performance-result.example.json`：冻结门槛的结果判分器和输入模板；新的正确增量采样 runner 尚需在第二阶段实现。
- `fixtures/performance-gate-*.synthetic.json`：仅验证预算前性能门禁的正向输入与 fail-closed 绕过拒绝，不是实际性能证据。
- `H0-P0-HARNESS-PLAN.md`：零模型 host 触发与性能 runner 的实现/复验方案；H0 基线已通过，P0 和最终候选复验仍未完成。
- `h0-summary.json`：H0 基线的公开白名单汇总、私有工件 hash 与最终候选复验要求。
- `H0-CONTROL-COVERAGE.md`：raw HTTP host、OpenCode adapter 与 Core 控制项的证据层级、准确结果和剩余缺口。
- `ARTIFACT-GAPS.md`：没有归档的可执行部分及原因。

原始证据仍在本机临时目录中，不属于可提交工件。H0 完整 host 日志含 session ID、测试 provider 身份和临时路径；outbound 含 fixture 正文。它们只以逻辑名称和 SHA-256 出现在公开摘要中。临时目录可能被系统清理，因此公开摘要只用于交接，不替代原始证据的独立复核。
