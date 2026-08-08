# 08 — S7：诊断 recovery INVENTED 推断

**What to build:** 仅诊断“已语义完成的 durable transcript 被 recovery 判为 active/ownershipLost 并写入 `exec_failed`”是否可复现。当前票不预设存在缺陷，也不授权先改生产代码。

**Method:** `/diagnosing-bugs`
**Evidence:** `.scratch/batch-b/evidence.md#s7--recovery-invented-推断`
**Branch:** `test/recovery-diagnosis`
**Blocked by:** 无（07 已关闭）
**Status:** closed-no-fix

- [x] 第一项产出是一条确定性、快速、可由 agent 重复运行且能红灯的命令；在此之前不写理论/修复
- [x] 症状必须包含“durable transcript 语义完成”与“reconcile 实际写 failed”，不能只单测 helper 返回 active
- [x] 红灯成立后才列 3–5 个可证伪假设、最小化复现并另开独立修复票（未出现红灯，因此未进入该阶段）
- [x] 无法建立反馈回路时记录尝试和阻塞原因，以 no-fix 关闭（已建立反馈回路且症状未复现，按 no-fix 关闭）
- [x] 不把既有 ownershipLost → workflow pause 缓解误报为未覆盖

## 关闭证据

- 命令：`cd packages/opencode && bun test test/dag/dag-recovery-transcript-diagnosis.test.ts`
- 三次结果：均为 `2 pass / 0 fail`，约 `1.13s`。
- 完成态：真实 durable transcript `finish: "stop"` 经 `DagLoop.init → reconcileWorkflow` 后持久化为 `completed`，未写 `exec_failed`。
- 对照态：真实 durable transcript `finish: "tool-calls"` 经同一路径持久化为 `failed/exec_failed`，workflow 随后被既有 recovery-pause 置为 `paused`。
- 完整报告：`.scratch/batch-b/s7-diagnosis.md`；未创建票 09。
