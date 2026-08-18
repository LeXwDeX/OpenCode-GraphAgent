# Workflow: audit-fix-loop（审计缺陷修复固定点循环）

Primary source：`docs/audit-dag-memory-goal-2026-08-18.md`（验收依据的唯一 source of truth）。
本规格取代此前 /private/tmp 下的全部 loop 文档与 findings register（已灭失）。

## 目的

以「开发切片 → 独立审阅 → 发现问题 → 修复 → loop 回审阅」的固定点循环，把审计文档中的缺陷按模块收敛到**零 findings**，每个模块分别以 PR → dev 落地。

## Runs

| Run | 模块 | 分支 | 缺陷集 | 触发 |
|---|---|---|---|---|
| 1 | GOAL | `fix/goal-batch`（已建，基于 origin/dev） | GOAL-01..04 | 立即 |
| 2 | DAG | `fix/dag-batch`（Run 1 合入后从新 dev 切出） | DAG-01..04 | Run 1 PR 合入 dev（事件触发） |

MEMORY（MEM-01..03）已在多轮循环中偿付（PR #333 合入 dev），不再重跑。

## 硬边界

- PR 只发 `dev`；禁止发 dev→main PR、禁止 release、禁止直推 `main`/`dev`。
- 验收依据 = 审计文档缺陷条目（位置证据 + 建议修法 + 测试覆盖缺口）及其「建议处置顺序」；不扩大审计面（审计未读区段的缺陷不在本轮范围）。
- 所有审阅发现入账 findings register，全部关闭后才具备发 PR 资格。
- 测试不从仓库根运行；typecheck = 在 `packages/opencode` 内 `bun typecheck`。

## 单次 run 流程

### 0. 准备
- GOAL run：先以独立 `docs(audit)` 提交把审计文档入库（两个 run 共同的验收依据必须先进 dev）。创建 `docs/findings/goal-batch-findings.md`。
- DAG run：确认 dev 基线已含 GOAL 修复 + 审计文档，切 `fix/dag-batch`。创建 `docs/findings/dag-batch-findings.md`。

### 1. 切片开发（按审计「建议处置顺序」）
- GOAL run：GOAL-01（P0）→ GOAL-02（P2）→ GOAL-03 → GOAL-04
- DAG run：DAG-01 + DAG-02（P0，审计明确要求一并修）→ DAG-03（P1）→ DAG-04（P1）

每个切片：
1. **红**：按审计「测试覆盖」缺口先写/改回归测试，测试必须先在当前代码上失败。
2. **绿**：按审计「建议修法」最小实现；每个缺陷一个独立提交（提交信息引用缺陷 ID）。
3. **变异**：临时回退实现 → 第 1 步测试必须翻红 → 恢复（证明测试真的钉住了该缺陷）。
4. **门禁**：目标测试簇 + `bun typecheck` 绿。

### 2. 审阅轮（固定点循环主体）
每轮并行派遣**两个互相独立、只读**的审阅子代理（不得复用开发者推理上下文，只看 diff + 审计文档 + 仓库规约）：
- **Spec 镜**：diff 逐条对照审计文档对应缺陷条目的验收要求；
- **Standards 镜**：diff 对照仓库 AGENTS.md、Effect 规则、`src/goal|dag` 的 CONTEXT.md 与测试 fixture 规约。

每个 finding 必须含：ID、严重度、file:line、证据引文、要求动作；写入 findings register。
- 有 findings → 逐条修复（修复同样走红-绿门禁）→ 回到审阅。
- **连续两轮全部审阅零 findings = 模块收敛**。

### 3. 模块门禁
- `bun typecheck`（packages/opencode 内）绿；
- 全量测试套件绿（packages/opencode 内运行）；
- diff 自检：改动仅落在对应模块源码 + 测试 + docs。

### 4. Checkpoint（唯一人工介入点，push right）
PR 发起前交付一份决策 brief：
- diff 概览（按缺陷分列文件/行数）；
- findings register 全部条目的关闭证据；
- 全量测试 + typecheck 结果；
- PR 标题与正文草稿（conventional 格式）。

用户批准 → `gh pr create --base dev` → 附 PR 链接与 CI run 链接收口。

**条件 checkpoint（仅当发生时）**：某切片建不出红测试——审计验收失去可验证依据，暂停等待用户裁决降级或停。DAG-04 触发源不属于此类：审计文档已给出无复现时的交付边界（见下），无需人工裁决。

## Run-specific 设计要点（探索阶段已定案，实施者直接遵循）

### GOAL run
- **GOAL-01**：`src/goal/loop.ts` 边界门从「抑制驱动」改为「只抑制重判」——引入 `boundaryGateHit` 标志，命中时跳过 judge + `updateAfterJudge`（不膨胀 turns_used），fall-through 到共享 continuation 派发段恢复驱动；gate-hit 分支写 `evaluatedRevisions` 做同 revision 去重。改写 `test/goal/e2e-loop.test.ts:1890-1910` 钉错的断言：judgeCalls=0、continuationCalls=1（pollWithTimeout 信号）、turns_used=1。
- **GOAL-02**：`src/goal/goal.ts` `pauseForUserCancel` 把无条件 `turnDriven.delete` 移入成功分支；失败分支保留 turnDriven，使持久态(active)/lease(已注册)/进程内标记三者一致，再次 ESC 仍走 pause 快路径。`test/goal/turn-scope.test.ts` 用写坏 goal_state payload 注入确定性 defect 覆盖。
- **GOAL-03**：`src/goal/goal.ts` `updateAfterJudge` continue 分支对失败 judge 预算中性：parseFailed 时不递增 turns_used、不盖 last_judged_msg；consecutive_parse_failures 计数与 MAX=3 自动暂停不变。改 GOAL-FP-01-18b e2e 测试：poll 信号换 consecutive_parse_failures>=1，turns_used 断言 0。
- **GOAL-04**：`src/goal/loop.ts` `scanForActiveGoals` busy skip 记 logInfo + deferred 列表；主循环后同一 scan fiber 内单次有界重试（2s），仍 busy 则 logWarning 收口（会话自身 idle 事件仍是驱动者）。扩展现有 busy-session 测试经 `logLines` 断言跳过日志。

### DAG run
- **DAG-01+02（一并修）**：`loop.ts:141-156` 条件求值前对字符串输出做与 `loop.ts:667` 相同的 `parseJsonOption` 归一化；`checkpointGateDiagnostics` 追加「被门控引用的 checkpoint 必须声明 output_schema」；把 checkpoint 门接入 replan/extend 路径（`authoring.ts:136` 的 structural 不再对非 start 动作整体关闭结构检查）。回归用例覆盖 `action: "replan"` 与运行时字符串输出两条。
- **DAG-03**：`loop.ts:681-703` pause 终态失败改 fail-closed `entry.runtime.setPaused(true)`；`dag.pause` 的 defect 纳入同一处理（不只 error channel）。
- **DAG-04**：`summary-publisher.ts:151-170` 外层 catchCause 依 `spawn.ts:255-257` 既有模式补 `Cause.hasInterrupts` 再抛；`global-lifecycle.ts:16-25` 生产 disposeAll 加有界超时（参照 exerciser 的 bounded 形状）。回归测试以程序注入事件覆盖 dispose 期间 interrupt 语义。**触发源不追查**，按审计文档原样记录为已知缺口（#316 验收项 3 已由审计回答）。

## 完成定义

两个 run 各自满足：连续两轮零 findings + 模块门禁全绿 + findings register 全部关闭 + PR → dev 创建成功且 CI 运行链接已附。至此循环终止。
