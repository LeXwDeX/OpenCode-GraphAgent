# Batch A Implement — 图编排 Manifest

## reference_template
`parallel-development-loop`（global，13 节点）——保护脊柱保留：
audit-module-wave（模块波本地审查，PASS|LOOP|BLOCKED）→ wire-modules（单一集成/提交所有者）→ simulate-wired-system（reasoner 纯逻辑推演）→ verify-wired-system（确定性验证）→ 三路 fresh review → arbitrate-final-review（唯一终审）→ finalize-delivery（仅 PASS 条件放行）。

## 任务注入
`.scratch/batch-a/issues/01-08`（09 为 dev→main 收束票，CI 全绿后在图外执行）。
规格依据：`.opencode/grill-batch-a/`（CONTEXT.md + ADR-0001~0004 + node-lifecycle-transitions.md v2，Round 2 doc 审核 PASS 冻结版，基线 dev@5330b15a9）。

## 展开（expand）
参考图的 develop-core / develop-adapters / develop-tests 三个泛模块槽替换为 8 个票据实现节点：

| 节点 | 票据 | 依赖 |
|---|---|---|
| impl-q1 | 01 裁决旗清旗 | freeze-contract |
| impl-q2 | 02 送达门控 re-time | freeze-contract |
| impl-s5 | 05 锁一行超时 | freeze-contract |
| impl-flaky-stdout | 06 stdout 污染族 | freeze-contract |
| impl-flaky-ws | 08 workspace 计时 | freeze-contract |
| impl-q3 | 03 事件+guard 前移 | impl-q1（projector 写集串行） |
| impl-sdk | 04 SDK 再生 | impl-q3 |
| impl-flaky-share | 07 ShareNext 计时 | impl-flaky-stdout（同文件串行） |

## 剪裁（prune_decisions）
| node | prune_reason | replacement_coverage |
|---|---|---|
| develop-core | 泛槽与已审计的票据分解不匹配 | 8 个票据节点按审计后写集分工，含测试切片（各票 TDD 自带） |
| develop-adapters | 同上 | 同上（03/04 覆盖 schema/SDK 适配面） |
| develop-tests | 测试切片并入各票 TDD | 每票先写失败测试再实现；review-tests 终审覆盖矩阵 |
| freeze-design | 设计已在图外冻结（两轮 doc 审核 PASS） | 改为 freeze-contract：只核验票据写集互斥并产出结构化契约，不重做设计 |

## 写集互斥表
- q1：projector 折叠侧 + dag 测试（清旗族）
- q2：runtime/loop.ts re-time 发起点 + 门控测试
- q3：schema 事件定义 + EventManifest + dag.ts 命令路径 + projector handler + 测试
- sdk：packages/sdk/js 生成物 + 消费者类型对齐
- s5：dag.ts withWorkflowLock 包装层（唯一区域）+ 测试
- flaky-stdout：test/cli/run + src/share/share-next.ts + 相关 fixture
- flaky-share：test/share 计时部分（06 已合入其依赖报告）
- flaky-ws：workspace sync 测试（+ 根因所需最小 src，须记录）
已知同文件异区：s5 与 q3 同 dag.ts（区域互斥：锁包装层 vs 命令路径）；q1 与 q3 同 projector（已串行）。

## Git 纪律
- 所有 impl 节点禁止任何 git 操作（add/commit/stash/branch/push）
- wire-modules 是唯一提交所有者（typecheck + 套件 + lint 全绿后单 commit）
- PR 由父会话在终审 PASS 后开（分支 feat/batch-a → dev）

## 审查门禁义务
arbitrate-final-review 必须审计本 manifest：每个 prune 有 prune_reason + replacement_coverage，缺任一禁止 PASS（fail-closed）。

## 续作记录（Continuation）
原图 dag_024a09546ffevmMvS3M6v0I1Av 于 audit PASS、wire-modules 提交 17f10f0ce 之后 terminal failed——两个 spawn 期配置错误：impl-q3（{{freeze-contract}} 非直接依赖，已由 impl-q3b 替换并完成）与 verify-wired-system（replan 片段遗漏 input: repo）。
终态不可逆 → 按续作合约起新图 batch-a-continue：
- reused_nodes：freeze-contract、impl-q1/q2/q3b/s5/flaky-stdout/flaky-ws/flaky-share/sdk、audit-module-wave（PASS）、wire-modules（提交 17f10f0ce）——全部完成且经审计，不重跑
- 续跑尾部：verify-wired（修复 input 绑定）→ simulate-wired + 三路 review → arbitrate-final → finalize
- 尾部节点一律从真实仓库状态（git show HEAD + 票据 + grill 文档）取证，不注入可能为空的旧输出（fail-closed）
