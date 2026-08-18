# DAG 批次 Findings Register

- 验收 primary source：`docs/audit-dag-memory-goal-2026-08-18.md`（DAG 章节）
- 分支：`fix/dag-batch` → PR `dev`
- 收敛判据：连续两轮独立审阅（Spec 镜 + Standards 镜）零 findings + 模块门禁全绿
- 规格：`workflows/audit-fix-loop.md`
- 触发：用户指示在 GOAL run（PR #334）之后立即开工，不等合入

## 审计缺陷切片（输入项，非审阅 finding）

| ID | 严重性 | 切片顺序 | 状态 | 提交 |
|---|---|---|---|---|
| DAG-01 + DAG-02 | High | A（P0，审计明确要求一并修） | 完成（红-绿-变异×3 通过） | 待提交 |
| DAG-03 | Medium | B (P1) | 待办 | — |
| DAG-04 | Medium | C (P1，#316 机制部分；触发源不追查，按审计记录缺口） | 待办 | — |

## 切片 A 设计要点（探索定案）

- **运行时（DAG-01）**：`loop.ts` spawnReady 构造条件求值 `outputs` 时，对字符串依赖输出做与 replan-verdict 门（loop.ts:667）相同的 `parseJsonOption` 归一化；解析失败回退原字符串（纯文本输出维持现有 loudly-fail/false 语义）。
- **authoring（DAG-01）**：`checkpointGateDiagnostics` 追加「被 condition 引用的 checkpoint 必须声明 output_schema」，成为 authoring 期错误。
- **authoring（DAG-02）**：`validatePostCompile` 的 checkpoint 门不再随 `structural: false` 关闭（replan/extend fragment 内对生效）；`replanStructuralDiagnostics` 对 merged 图补跑 checkpoint 门（覆盖新 dependent 挂到既有 checkpoint 的跨 fragment 场景），`ReplanStructuralInput.merged` 类型补 `node_defaults`。
- 不触碰 audit「验证为正确」清单：数值比较 loudly-fail、review verdict 门 fail-closed、wake 持久化等。

## 模块门禁
- 未开始

## 审阅轮次

（每轮审阅结果记账于此；全部关闭后才具备发 PR 资格）

### Round 1
- 未开始
