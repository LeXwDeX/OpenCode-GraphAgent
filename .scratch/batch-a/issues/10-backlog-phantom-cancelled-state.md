# 10 — Backlog：phantom cancelled 节点态（N1-T5 规格-实现漂移）

**What to build:** 消除节点级状态空间中 phantom `cancelled` 态的规格-实现漂移，二选一收敛：
- 方案 A（对齐实现）：状态空间与转移表 T5 取消节点级 `cancelled` 目标态——NodeCancelled 事件维持现投影（status=failed + error_reason 承载取消语义），T5 改写为 to=failed(cancelled)；同步转移表 v2、CONTEXT.md 状态机词汇。
- 方案 B（对齐规格）：projector 产出真正的节点级 `cancelled` 终态，审计全部读节点状态的消费方（调度资格、wake 汇总、TUI 展示、恢复路径）对新终态的处置，测试覆盖。
先做设计裁决（影响面 A≪B：B 触及终态判定函数 isNodeTerminalStatus 与全部消费方），再按裁决实施。

**来源证据（批次 A 续作图终审 DEDUP-N1-T5，severity=low，四方接受）：**
- projector.ts:35,348：NodeCancelled → status=failed；无任何投影产出节点级 cancelled
- 转移表 v2 T5 声明 to=cancelled——规格侧存在、实现侧不可达
- 纠错记录：reasoner 曾以 store.ts:452/462 为证，被 review-logic 纠正——那两处查的是 WorkflowTable，工作流级 cancelled 是合法状态，与节点级无关
- 运行时影响：零（取消语义经 error_reason 保留）；批次 A 仅向 cancelled 投影补 EP:false，漂移系既有
- accepted_by：reasoning N1（附错误证据）/ review-logic（PARTIAL，证据已纠正）/ review-architecture I1 / review-tests GAP-T5

**Blocked by:** None（独立设计决策）

**Status:** backlog（需先设计裁决，非 ready-for-agent）

- [ ] 设计裁决 A/B（含消费方影响面清单）
- [ ] 按裁决实施 + 测试
- [ ] 转移表 v2 与 CONTEXT.md 状态机词汇同步
- [ ] typecheck + dag 套件绿
