# 11 — Backlog：F8 spurious T8——watchdog 陈旧读每周期耗一个 cap 预算单位

**What to build:** 消除（或显式预算化）F8 spurious T8：watchdog 以陈旧快照读判定超时 → 发延长 → 重放 T8，每发生一次消耗一个 max_timeout_extensions 预算单位。代码自我记录为 cosmetic（loop.ts:860-868 注释："cap accounting still holds because the count did climb"），但语义上节点并未真正获得有效延长窗口却消耗了预算——极端场景下提前耗尽延长预算。
修复方向（裁决后实施）：
- 方案 A：延长判定前在 workflow lock 内重读节点状态（deadline/状态新鲜读），陈旧读不发延长——根治，注意不引入锁争用回归
- 方案 B：把"陈旧读引发的延长"与真实延长分开计数（预算只认真实延长）——改计数语义，影响面含恢复/审计
- 方案 C（维持现状 + 显式化）：把预算消耗语义写入 ADR 与转移表，加监控/测试断言行为，不改机制

**来源证据（批次 A 续作图终审 DEDUP-N3，severity=low，双方接受）：**
- loop.ts:860-868（机制与自我记录注释）、spawn.ts:192-198（watchdog 读路径）
- Q2 送达门控落地后仍存在（门控管的是 re-time 发起，不管陈旧读判定）
- 既有问题，非批次 A 回归
- accepted_by：reasoning N3（Notable）/ review-logic（CONFIRM pre-existing cosmetic）

**Blocked by:** None（独立设计决策）

**Status:** backlog（需先裁决 A/B/C，非 ready-for-agent）

- [ ] 裁决修复方向（A/B/C，含锁交互与预算语义影响面）
- [ ] 按裁决实施 + 测试（含陈旧读复现场景）
- [ ] 若 C：ADR + 转移表语义注记落地
- [ ] typecheck + dag 套件绿
