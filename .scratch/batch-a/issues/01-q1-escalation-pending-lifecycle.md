# 01 — Q1：escalation_pending 裁决旗生命周期闭环

**What to build:** 节点到终态（completed/failed/aborted）或被取消时，裁决状态旗 escalation_pending 必清零——裁决不可能悬挂超过它所属的裁决周期。wake_reported 投递旗不受影响（两旗正交）。终态清旗发生在事件折叠侧，与既有的 NodeStarted/NodeRestarted 清旗点共同构成完整生命周期。

规格依据：ADR-0001-escalation-pending-semantics + 节点生命周期转移表 v2（Q1 行）。

**Blocked by:** None — can start immediately

**Status:** closed（PR #186，merge commit `4ddeaf2fc`）

**Completion evidence:** 批次 A 实现与测试随 PR #186 合入 `dev`，并随 PR #188 通过 main 全量门禁。

- [x] 节点终态转移（completed/failed/aborted）与取消路径清 escalation_pending
- [x] wake_reported 在清旗路径上不被触碰（两旗正交测试）
- [x] 已有 NodeStarted/NodeRestarted 清旗点保持不回退
- [x] replay/恢复场景下清旗经事件折叠重放一致
- [x] dag 测试套件 + typecheck 绿
