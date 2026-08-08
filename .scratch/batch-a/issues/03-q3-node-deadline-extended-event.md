# 03 — Q3：NodeDeadlineExtended durable 事件 + guard 前移命令层

**What to build:** deadline 延长成为 durable 事件：NodeDeadlineExtended（nodeID + 新 deadline）入事件日志，废除直写 deadline 的旧路径。guard（延长是否被允许）前移到命令层执行——0 行 = 命令失败，编排器即时可观察（错误即状态）；事件只记录成功，projector 保持纯幂等折叠（确定性重放）。guard 拒绝不是转移，不进事件日志。

规格依据：ADR-0003-node-deadline-extended-event（Round 2 修订版）+ 转移表 v2 T9/T11。旧机制（publish 返回行数契约）已证伪——发布链丢弃返回值，禁止复用。

**Blocked by:** 01 — Q1：escalation_pending 裁决旗生命周期闭环（projector 折叠侧写集串行）

**Status:** closed（PR #186，merge commit `4ddeaf2fc`）

**Completion evidence:** 批次 A 实现与测试随 PR #186 合入 `dev`，并随 PR #188 通过 main 全量门禁。

- [x] Schema 定义 NodeDeadlineExtended + 入 EventManifest.Definitions
- [x] 命令层执行 guard：拒绝时命令失败并携带 typed 错误，编排器可区分拒绝与成功
- [x] 直写 deadline 旧路径废除（无遗留调用方）
- [x] projector 纯折叠：无事件发布、无返回值契约依赖
- [x] 恢复/replay 一致性测试（事件日志重放 ⟺ 活跃态）
- [x] dag 测试套件 + typecheck 绿
