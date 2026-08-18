# DAG 批次 Findings Register

- 验收 primary source：`docs/audit-dag-memory-goal-2026-08-18.md`（DAG 章节）
- 分支：`fix/dag-batch` → PR `dev`
- 收敛判据：连续两轮独立审阅（Spec 镜 + Standards 镜）零 findings + 模块门禁全绿
- 规格：`workflows/audit-fix-loop.md`
- 触发：用户指示在 GOAL run（PR #334）之后立即开工，不等合入

## 审计缺陷切片（输入项，非审阅 finding）

| ID | 严重性 | 切片顺序 | 状态 | 提交 |
|---|---|---|---|---|
| DAG-01 + DAG-02 | High | A（P0，审计明确要求一并修） | 完成（红-绿-变异×3 通过） | 71ab1bdf6 |
| DAG-03 | Medium | B (P1) | 完成（红-绿-变异×2 通过） | 1c4f1ad7a |
| DAG-04 | Medium | C (P1，#316 机制部分；触发源不追查，按审计记录缺口） | 完成（红-绿-变异×2 通过） | db626d4ba |

## 切片设计要点（实现后回填）

- **A（DAG-01+02）**：
  - 运行时：spawnReady 条件求值前对字符串依赖输出做 `parseJsonOption` 归一化（与 replan-verdict 门同源）；非 JSON 回退原串（整串等值可用、字段路径仍 false、数值比较仍 loudly-fail）。
  - authoring：`checkpointGateDiagnostics` 追加「被门控 checkpoint 必须声明 output_schema」（authoring 期错误；运行时路径不要求——runtime-created 图按 CONTEXT.md 有意豁免 authoring 校验，`requireOutputSchema:false`）。
  - 门禁接线：`validatePostCompile` 的 checkpoint 门不再随 `structural:false` 对 replan/extend 关闭（fragment 内对生效）；`replanStructuralDiagnostics` 对 merged 图补跑 checkpoint 门（覆盖 fragment 挂到既有 checkpoint 的场景），**豁免持久图中已终态的 checkpoint**（裁决已交付，加波/重开是受 sanction 的模式——reopenDenial 加性重开的既有语义）。
  - 波及适配 2 个既有 harness（blanket `report_to_parent:true` 的 rev-view / stale-nodefailed 形状按门禁语义补 condition）；dag-wake-integration 的加波/重开场景经终态豁免自然兼容，无需改动。
- **B（DAG-03）**：pause 终态失败 fail-closed（恒 hold），`Effect.catch` → `Effect.catchCause`（hasInterrupts 再抛）折叠 defect；logWarning → logError（含 durableStatus）。
- **C（DAG-04）**：publisher 外层 catchCause 依 F1 模式 `hasInterrupts` 再抛；`disposeAllInstancesAndEmitGlobalDisposed` 加 10s 有界超时（`timeoutOption`——超时即放弃且不产生错误，保住 HttpApi dispose endpoint 的 `never` 错误通道），去掉 uninterruptible 包裹；Disposed 事件在超时/吞错后仍必落地；真实处置失败在非 swallow 路径仍传播。
  - 中断测试注入方式：scope-disposal 杀 fiber 的 cause 实测为 Die 而非 Interrupt（已实证），改用 `Effect.failCause(Cause.interrupt(0))` 在 store 边界直接注入 interrupt cause（goal e2e 既有模式），精确命中被修复的 catchCause 判别线。

## 模块门禁
- 切片级：每切片 dag 目标测试簇绿 + 包内 typecheck 绿 + 变异翻红验证（见上表）
- 全量套件：进行中

## 审阅轮次

（每轮审阅结果记账于此；全部关闭后才具备发 PR 资格）

### Round 1
- Spec 镜：**PASS**，3 条 Low INFO；Standards 镜：**PASS**，6 条 findings（F1-F6）。处置：
  - F1 + INFO-2（Medium）：ADR-0003 与新 enforcement 矛盾。→ **已同步**：Decision/Consequences/Deferred 改写为「validatePostCompile 全动作 + replanStructuralDiagnostics merged 图（终态豁免）+ create 刻意不动 + output_schema authoring 义务」，Deferred 首项标记 resolved。
  - F2 + INFO-1（Medium，需主裁决）：fail-closed 保持会被后续 NodeCompleted/NodeSkipped/stepped 的 durable-row re-sync 解除；且 Replanned 处理器从不重同步 paused（hold 也会闷死 corrective 派发）。用户裁决「解决所有已知问题」。→ **已实装**：`WorkflowEntry.vetoHold`——门设置、两处 re-sync 点（node 终态序言 + refreshControlFlags）尊重保持、三个父控制事件（Replanned/Resumed/Stepped）释放并重同步（Replanned 补上从未有过的 flag 重同步）；新增 2 条红绿测试（re-sync 存活 + replan 释放）+ 双向变异验证。
  - F3（Low）：global-lifecycle.test.ts 未用 `Option` 导入。→ 已删。
  - F4（Low）：loop.ts「normalization above」方向失准。→ 已改为指向 NodeCompleted 处理器。
  - F5（Low）：终态豁免措辞「delivered its verdict」对 failed/aborted/skipped 不真。→ 三处改为「settled and immutable」（CONTEXT.md/validation.ts×2）。
  - F6（Low, informational）：无 uninterruptible 的取舍记录。→ 无需动作（reviewer 确认 trade 正确）。
  - INFO-3（Low）：register 误记「3 个 harness 适配」。→ 已更正为 2（wake-integration 经终态豁免免改）。
- 结论：非干净轮。修复后进入 Round 2。

### Round 2
- 未开始
