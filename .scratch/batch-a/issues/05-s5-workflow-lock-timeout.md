# 05 — S5：withWorkflowLock 一行超时（奥卡姆版）

**What to build:** 工作流锁获取加 30 秒上限——withWorkflowLock 外层一行 Effect.timeout，复用 TimeoutException：零新错误类、零 per-caller 改动、watchdog 零特殊化（自续间隔秒级重试天然继续，延长计数只在成功延长时 +1）。禁止引入新错误类型或按调用方分支。

规格依据：ADR-0004-lock-timeout-occams + CONTEXT.md 决策树 Q6。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 唯一改动点在 withWorkflowLock 包装层（一行 + 常量）
- [ ] 30s 超限产生 TimeoutException，编排器按既有 error_class 分诊规则处置
- [ ] 无新错误类、无 per-caller 分支的断言
- [ ] watchdog 自续行为在锁超时后仍正确的测试
- [ ] dag 测试套件 + typecheck 绿
