# CONTEXT — 批次 A 设计 grilling（D2/D3 + escalation_pending 生命周期 / S5 锁超时）

状态记录文件：术语表 + 决策树 + 已定/未定。随 grilling 更新。

## 术语表（domain glossary）

| 术语 | 当前定义（代码事实） | 问题 |
|---|---|---|
| `escalation_pending` | node 列。escalate projector 置 true；NodeStarted/NodeRestarted 清 false；updateNodeDeadline 清 false；**终态不清** | 语义未定：是"有未送达的 wake"还是"等待裁决"？（Q1） |
| `wake_reported` | node 列。wake 送达后 true；escalate 时 re-arm false | 与 escalation_pending 职责边界模糊（D2 根因） |
| adjudication（裁决） | 主 agent 对升级节点的处置：extend（replan 带新 timeout）/ restart / cancel | extend 写入在事件日志之外（D3） |
| re-time | extend 落地动作：nodeExtendTimeout 重算死线（now + new timeout） | 门控见 loop.ts:800（A1 cap gate） |
| delivery boundary（交付边界） | wake 投递条件：`escalationPending ∨ (timeoutExtensions>0 ∧ terminal)` | 依赖 escalation_pending 语义（Q1 决定后复查） |
| 升级循环 | watchdog 超时 → nodeTimeoutEscalated（count+1, pending=true, wake re-arm）→ 主 agent 裁决 | 每轮消耗一个 count，21×cap 兜底 |
| workflow lock | KeyedMutex per dagID，单许可、不可重入、**无超时**（S5） | 静默死锁风险 |

## 设计公理（用户宏观原则，2026-08-07 确立，永久约束）

1. **状态流转优先**：节点生命周期以显式状态机为真相源；轮询/watchdog 只能是「转移提议者」，不得充当监督权威或直接写状态。
2. **错误即状态**：错误类别（error_class/trigger）是状态机的输入，由状态决定后续动作与 agent 的判断/处置依据（wake 文案承载）。
3. **奥卡姆剃刀**：解法需要复杂策略（新错误类族、per-caller 语义分支、特殊化处理）= 重新思考的信号；优先砍机制而非加机制。
4. **单一写权威**：节点状态一切变更走「dag 命令 → durable 事件 → projector」；直写行 = 破窗（现存唯一破窗 updateNodeDeadline，Q3 已决废除）。

## 决策树

- **Q1（根）：escalation_pending 的生命周期契约** → ✅ **已定：(b) 裁决状态旗**。「节点正在等待主 agent 裁决」；由裁决写动作清（extend / restart / cancel）**或**由终态清（NodeCompleted/NodeFailed 清旗——死掉的节点无需裁决，结果走终态交付臂）。投递是 wake_reported 的本职，两旗职责正交（D2 病灶即职责混用）。→ 落 ADR-0001
- **Q2：wake 未送达时 re-time 放不放行（D2）** → ✅ **已定：(a) 送达门控**（Round 2 机制修正：skip 合取项，非放行析取项）。`loop.ts:800` A1 skip 之外新增 Q2 skip 合取项 `(escalationPending && !wakeReported)`——已升级但未送达一律跳过 re-time（节点保留过期死线，watchdog `spawn.ts:111` 自续再升级，wake 照常投递，裁决必发生在送达之后）。放行条件等价于 `deadline≤now ∨ deadline=null ∨ (escalationPending ∧ wakeReported)`；不可写成放行析取项（会被 deadlineElapsed 析取吞没，对公共路径无效，cons-F1 旧病）。updateNodeDeadline 的 wake_reported:true 退化为无害 no-op。restart/cancel 不加门控（不改死线，不受 D2 威胁）。→ 落 ADR-0002（v Round 2）
- **Q3：deadline 变更入事件日志（D3）** → ✅ **已定：(a) 全量入日志**（Round 2 机制修正：guard 前移到命令层）。新增 durable 事件 `NodeDeadlineExtended`（nodeID + 新死线 + 裁决时 extension 计数），workflow 锁内发布，projector 幂等投影（event id 去重、replay-safe）；`nodeExtendTimeout` 改为标准「命令 → 事件 → 投影」形态，直写废除。guard（running-guard + Q2 送达门控）在命令层、`events.publish` 之前持锁同步判，`0/1` 是命令同步 Effect 返回（不经 publish 链——projector 返回值在 `event.ts:256-258` 被丢弃，imp-F1）；编排器经状态（终态 / 持续 escalation_pending）+ wake 观察拒绝（公理 ②）。成本：schema dag-event + DurableDefinitions + projector handler + dag.ts + 测试 + SDK event union 再生；无路由变化。→ 落 ADR-0003（v Round 2）
- **Q4+Q5（S5）：锁超时语义与参数** → ✅ **已定：被 Q6 奥卡姆重构收编**。原案（类型化错误类 + per-caller 语义）被否——违反公理 3；最终形态：withLock 外层一行 `Effect.timeout("30 seconds")`，复用 TimeoutException，零新错误类、零 per-caller 改动、watchdog 零特殊化（自续间隔天然重试，计数只在成功时 +1）。→ 并入 ADR-0004
- **Q6（收口）：批次 A 最终采纳范围** → ✅ **已定：(A)**。Q1-Q3 照旧 + S5 一行超时 + **节点生命周期转移表**作为权威审查基准（此后引擎改版先对照表审）。入表既有小疵：watchdog 强杀时 promptSvc.cancel 先于 nodeFailed 事件（应改为事件后处置，不另开工单）。→ 落 ADR-0004/0005

**决策树状态：全部闭合（Q1✅ Q2✅ Q3✅ Q4/Q5→Q6 收编✅ Q6✅）。grilling 完成，共识达成。**

## 交付物清单

- ADR-0001 escalation_pending 裁决状态旗契约
- ADR-0002 送达门控 re-time（D2）—— **Round 2 修正**：skip 合取项（`loop.ts:800`），语义保留
- ADR-0003 NodeDeadlineExtended 入事件日志（D3）—— **Round 2 修正**：guard 前移到命令层（非 projector 返回值），保留 durable 事件/schema/SDK 再生/回放一致性
- ADR-0004 S5 奥卡姆版：一行超时（收编 Q4/Q5）
- ADR-0005 转移表基准（node-lifecycle-transitions.md **v2**：G1 skip 合取项 + T9 命令层 guard + guard 拒绝非转移说明）
- 实施顺序建议：Q1+Q2+Q3 一个 PR（escalation 生命周期闭环）；**Q3 的 SDK event union 再生（`./packages/sdk/js/script/build.ts`）为强制伴随步骤**；S5 一行超时并入或单独小 PR；转移表随实施落地后从 grill-batch-a 晋级至 .dag-specs

## 证据锚点

- D2：store.ts updateNodeDeadline（set escalation_pending:false + wake_reported:true）；loop.ts:800 re-time gate
- D3：dag.ts nodeExtendTimeout 无 events.publish / seq bump；投影重建恢复旧死线
- 终态不清：projector.ts escalate 置 true / NodeStarted:243、NodeRestarted:362 清 / NodeCompleted、NodeFailed 无清理
- 边界谓词：节点级 `loop.ts:949-953`（`escalationPending ∨ (timeoutExtensions>0 ∧ terminal)`）/ 工作流级决策 `loop.ts:960-967`；summary 谓词：`store.ts:245-260`（`escalatedRows`：`escalation_pending=true ∧ status='running'`）。注：`loop.ts:906-912` 实为 workflow-terminal 清理，非交付边界谓词；DAG 运行时无 3 分钟阈值（watchdog 自续间隔 = `Math.max(1_000, timeoutMs)`，`spawn.ts:111`）
- S5：dag.ts:298-305（KeyedMutex 注释：单许可不可重入，持锁者崩溃/挂起 = 静默死锁）；历史发现 S7 recovery INVENTED 推断同域
- 五轮 review 归档：.opencode/promotion-review-round1/arbitrate.md
