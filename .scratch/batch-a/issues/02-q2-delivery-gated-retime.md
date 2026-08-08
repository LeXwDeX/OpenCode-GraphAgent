# 02 — Q2：送达门控 re-time（watchdog 提案者门控）

**What to build:** wake 已送达未裁决期间，watchdog 不得抢占式 re-time。按 v2 机制实现：在 re-time 唯一写路径的发起点加 skip 合取项（escalationPending 且裁决未完成 ⇒ 跳过），而非放行析取项——deadline 驱动的初始升级路径不受影响，watchdog 保持纯提议者（提案不改状态）。

规格依据：ADR-0002-delivery-gated-retime（Round 2 修订版）+ 转移表 v2 G1 门控不变式。旧机制（放行析取臂）已证伪，禁止复用其表述。

**Blocked by:** None — can start immediately

**Status:** closed（PR #186，merge commit `4ddeaf2fc`）

**Completion evidence:** 批次 A 实现与测试随 PR #186 合入 `dev`，并随 PR #188 通过 main 全量门禁。

- [x] skip 合取项落在 re-time 唯一发起点，全 re-time 触发路径逐条覆盖（测试枚举，不只抄规格）
- [x] 初始升级（deadline ⟹ 首次 wake）不受门控影响
- [x] 裁决写入后 re-time 能力恢复的测试
- [x] watchdog 无状态写（仅提案）的断言保持
- [x] dag 测试套件 + typecheck 绿
