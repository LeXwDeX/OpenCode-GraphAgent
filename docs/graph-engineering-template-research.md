# Graph Engineering 样板调研与迁移建议

> 调研日期：2026-08-03
> 范围：只研究、比对和提出迁移方案；未搬运模板、未修改产品代码。

## 结论先行

1. 用户所说的 “graph engineering” 最可能指个人仓库 [`codejunkie99/graph-engineering`](https://github.com/codejunkie99/graph-engineering)：仓库名完全匹配，且明确包含 task graph 原则和 9 个可粘贴 workflow。不过它只有一次提交，不是行业标准或框架官方仓库。
2. 真正适合向 `opencode-dag` 搬“可执行图样板”的强来源是 [`CodeGraphContext/GraphARC`](https://github.com/CodeGraphContext/GraphARC)。它把 Graph Engineering 做成分阶段示例，并实现 admission、预算、typed state、write allowlist、trace 和 fresh-context verifier；但当前 README 标注版本 `0.1.1`、API 尚不稳定，因此应搬拓扑和约束语义，不应引入它的 Python/LangGraph runtime。
3. 本项目已经拥有 diamond、并行 reviewer、claim verification、单一 arbiter、并发/节点/重试上限和单 workspace 写入纪律，而且多数约束比 `codejunkie99/graph-engineering` 更可执行。最值得补的不是再复制一套相同 YAML，而是：假边检查、拓扑选择的 stop rule、确定性证据门、动态子图 admission、每节点写入白名单和机器可读停止原因。
4. `reasoner.md` 没进入现有 `change-review` 不是因为 Graph Engineering 上游提供了模板却漏搬；上游根本没有代码 reasoner。更关键的是，本机 reasoner 自己声明只推演 ROADMAP/设计，禁止直接审已写 diff。最终采用两种合规接法：设计模板里直接推演设计；开发模板完成接线后，把真实执行路径整理成 `system_logic` 再推演，随后由 fresh-context reviewer 用代码和测试查证。预测永远不能直接充当 review 证据。

## 1. “Graph Engineering”最可能对应什么

当前没有一个被普遍接受的 “Graph Engineering 官方规范”。网上至少有三个不同层次的来源：

| 优先级 | 来源 | 身份与可信边界 | 本次用途 |
|---|---|---|---|
| 1 | [`codejunkie99/graph-engineering`](https://github.com/codejunkie99/graph-engineering) | 标题完全匹配的个人仓库；README 将知识图谱和任务图并列；只有一次提交 | 回答“你说的那个仓库最可能是哪一个”，提取 task graph 原则和 KG prompts |
| 2 | [`CodeGraphContext/GraphARC`](https://github.com/CodeGraphContext/GraphARC) | CodeGraphContext 组织维护的早期实现；README 自称 governed agent runtime，列出 43 次提交和 `0.1.1` 不稳定状态 | 找可执行 graph stages、runtime contracts、reviewer/evidence 样板 |
| 3 | [Anthropic《Building effective agents》](https://www.anthropic.com/engineering/building-effective-agents) | 一手工程文章，给出生产中常见的 workflow 形状 | 校验 chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer 的适用条件 |
| 4 | [Google Research《Towards a science of scaling agent systems》](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) | 180 个配置的受控研究；给出并行任务收益、顺序任务惩罚和错误放大数据 | 为 stop rule 和集中式 arbiter 提供证据 |
| 5 | [Anthropic 多 agent Research 系统复盘](https://www.anthropic.com/engineering/multi-agent-research-system) | 生产系统复盘；解释 orchestrator-worker、并行搜索、fresh contexts、artifact handoff | 校验并行研究和上下文隔离，不作为固定 DAG 的唯一答案 |

因此，“官方”应理解为“各项目作者自己的原始仓库/文档”，不能把任一项目包装成行业标准。

## 2. `codejunkie99/graph-engineering` 可迁移内容

### 2.1 任务图原则：适合迁移

原始文件：[`graph-engineering/references/task-graphs.md`](https://github.com/codejunkie99/graph-engineering/blob/master/graph-engineering/references/task-graphs.md)。

| 原则 | 原用途 | `opencode-dag` 适配方式 | 当前覆盖 |
|---|---|---|---|
| 删除假边 | 仅当下游真的需要上游结果时才连边 | 在 start/replan 前增加 edge lint：每条 `depends_on` 必须声明被消费的 artifact/field 或控制原因 | 文档要求显式依赖，但没有证据表明 runtime 会拒绝“不消费输出”的边 |
| Diamond | `plan → parallel workers → separate verify → one merge owner` | 固化为 workflow library 基础骨架，verifier 使用独立 child session，arbiter 单一所有者 | 已基本覆盖：parallel review、claim verification、arbiter |
| Stop rule | 只对可独立拆分的工作启用多 agent | admission brief 增加 `parallelizable_slices`、`shared_context_need`、`tool_density` 决策记录；顺序工作退回单 agent | 已有 Execution Mode Selection，但可加入更明确的顺序惩罚检查 |
| Human gate | 不可逆动作前才要求人类批准 | 将 deploy/publish/delete/refund 等动作前置为 `report_to_parent` checkpoint，用户批准后才 extend/replan | 有深度准入和 LLM gate，缺少通用的不可逆动作人类门模板 |
| 四项 guardrail | 循环上限、单文件单 writer、路由写死、agent 数硬上限 | 映射到 `max_node_replan_attempts`、write-set owner、代码/条件路由、`max_total_nodes`/`max_concurrency` | 多数已有；write set 主要靠编排纪律，尚非 runtime allowlist |

Google 的受控研究支持这里的 stop rule：并行可拆任务中集中式协调提升显著；严格顺序任务中，多 agent 反而下降 39–70%；独立 agent 的错误放大高于集中式 orchestrator。数字和实验边界见 [Google Research 原文](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)。

### 2.2 九个 paste-ready workflows：选择性迁移

原始文件：[`WORKFLOWS.md`](https://github.com/codejunkie99/graph-engineering/blob/master/WORKFLOWS.md)。这些主要是**知识图谱提示词**，不是代码工作流 DAG。

| 组 | 上游模板 | 适用场景 | 建议 |
|---|---|---|---|
| 教学 | `/kg-tutor` | 逐阶段教授知识图谱 | 不进入 reviewer 库；若产品要提供 KG 教学，可做独立 skill |
| 建模 | `/kg-scope`、`/kg-schema` | 能力问题、实体/关系、ontology | 可转成 `scope → schema-gate` 设计图；与代码 review 无关 |
| 抽取 | `/kg-extract`、`/kg-relations`、`/kg-events` | 分源抽取、证据 span、事件节点 | 仅在新增 KG 产品能力时迁移；保留 provenance/output schema 思想 |
| 质量与融合 | `/kg-fuse`、`/kg-eval` | 去重、precision/recall、数据泄漏、可逆 merge | `/kg-eval` 是唯一 reviewer 提示，但审的是 KG 指标，不是代码 diff |
| 服务 | `/kg-rag` | 图检索对比 vector baseline | 可作为未来 GraphRAG workflow，不应塞进当前 DAG reviewer |

该仓库 [`SKILL.md`](https://github.com/codejunkie99/graph-engineering/blob/master/graph-engineering/SKILL.md) 中的 “LLM-as-reasoner over paths” 指知识图谱路径推理，不是本项目的代码/设计 reasoner。上游没有 `reasoner.md` 或 code-reviewer agent 样板。

## 3. GraphARC 中更值得搬的可执行样板

GraphARC README 的 [Quickstart](https://github.com/CodeGraphContext/GraphARC#quickstart) 明确列出 stage 0–6 和 capstone。建议搬**图形、节点契约和失败语义**，不要复制 Python runtime。

### 3.1 第一批：直接转成 YAML/prompt templates

| 样板 | 原始文件 | 用途 | `opencode-dag` 适配 |
|---|---|---|---|
| Earned loop | [`stage1_loop.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage1_loop.py) | `discover → act → verify → repeat`，只有验证失败才获得下一轮 | 对应 bounded `extend/replan`；每轮新节点 ID，保留 verdict disposal contract |
| Typed verify/retry | [`stage2_claims.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage2_claims.py) | 抽取 claim、校验、有限重试 | 转成 `output_schema` + claim verification + `max_node_replan_attempts` |
| Bounded fan-out | [`stage3_fanout.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage3_fanout.py) | 并行、失败隔离、去重、汇总 | 做通用 research/review fan-out；assembler 必须报告缺失 worker，不能静默忽略 |
| Investigation loop | [`stage4_investigation.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage4_investigation.py) | 调查、评估进展、收敛或停止 | 把“无新证据/目标满足/轮数上限”转成结构化 StopReason |
| Fresh verifier | [`stage5_verifier.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage5_verifier.py) | 新上下文 reviewer + 确定性证据锚 | 强化 `change-review`：先验证引用/测试/日志存在，再交给 LLM reviewer 裁决 |

### 3.2 第二批：需要 runtime 能力

| 样板/机制 | 原始来源 | 价值 | 迁移前提 |
|---|---|---|---|
| Stage 0 deterministic DAG | [`stage0_dag.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage0_dag.py) | 无模型的 `load → split → count → report` 基线 | 允许确定性函数节点，或把它们映射到现有 tool/build worker |
| Provenance memory | [`stage6_memory.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/stage6_memory.py) | claim 来源、替代关系、召回 | 需要明确 durable artifact/claim schema；不要和 session transcript 混为一体 |
| Research capstone | [`capstone.py`](https://github.com/CodeGraphContext/GraphARC/blob/main/grapharc/examples/capstone.py) | `recall → plan → fan-out → verify → answer → remember` | 先完成证据契约和 memory provenance，再做完整模板 |
| Admission linter | [README admission gate](https://github.com/CodeGraphContext/GraphARC#the-admission-gate) | 动态子图在执行前检查 kind、edge policy、预算、深度、无环 | 在 `start/extend/replan` 增加 dry-run/check-only 语义和拒绝码 |
| Runtime contracts | [GraphARC runtime 说明](https://github.com/CodeGraphContext/GraphARC#what-it-adds-on-top-of-langgraph) | typed state、write allowlist、预算、JSONL trace/replay/diff | 需要产品代码；优先做 write allowlist 和 machine-readable StopReason |

GraphARC 自己也写明 router 映射、Pydantic validator 等仍有窄缺口，且 API 不稳定。因此它应是设计输入，不应成为新依赖。

## 4. Anthropic 官方样板对 reviewer 的补强

Anthropic 将常用形状分为 prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer；官方最小实现位于 [`claude-cookbooks/patterns/agents`](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents)。

对本项目最有价值的是以下四项：

1. **Parallel sectioning 与 voting 分开**：不同 reviewer 维度属于 sectioning；同一漏洞问题多次独立审查属于 voting。不要把两者都写成“并行 reviewer”。[原文](https://www.anthropic.com/engineering/building-effective-agents#workflow-parallelization)还直接用多 prompt 审代码漏洞作为 voting 示例。
2. **Orchestrator-workers 只用于子任务无法预知的工作**：固定 review dimensions 用静态 DAG；未知文件/未知调查方向才让 orchestrator 动态拆分。[原文](https://www.anthropic.com/engineering/building-effective-agents#workflow-orchestrator-workers)。
3. **Evaluator-optimizer 必须有清晰验收标准和可测改进**：适合 `implement → fresh review → targeted repair`，不适合无终止条件的“继续优化”。[原文](https://www.anthropic.com/engineering/building-effective-agents#workflow-evaluator-optimizer)。
4. **Fresh-context evaluator 不信 builder 自评**：[`evaluator.md`](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/agents/evaluator.md)要求先读 spec、diff、截图/日志，再返回 `PASS/NEEDS_WORK`；缺证据默认失败。[配套 README](https://github.com/anthropics/cwc-long-running-agents#the-quality-loop)把它与 default-FAIL evidence contract、build/evaluate/rebuild 有界循环组合起来。

本项目现有 child session 已天然提供上下文隔离；缺口主要在“确定性证据锚”和“每个验收条件默认未通过，直到证据被实际读取”。

## 5. 与当前项目逐项对照

### 已有且不应重复搬运

| 能力 | 当前证据 | 判断 |
|---|---|---|
| Diamond/并行分工 | `packages/core/src/plugin/command/workflow.md:205-243` | 已有 parallel fan-out 和 assembler |
| 多维 reviewer + arbiter | `packages/core/src/plugin/command/workflow.md:247-323` | 已有 architecture/logic/style 分离及单一裁决者 |
| claim verification | `packages/core/src/plugin/command/orchestration-policy.md:185-201` | 比上游抽象 diamond 更强，要求未验证 claim 先核实 |
| 有界循环/预算 | `packages/core/src/plugin/command/workflow.md:446-448`、`orchestration-policy.md:292-300` | 已有 concurrency、replan、total nodes、timeout |
| 单 workspace 写入纪律 | `packages/core/src/plugin/command/workflow.md:455-459` | 已有 disjoint write sets / propose-then-assemble，但主要靠约定 |

### 必须补的空位

| 空位 | 具体落点 | 验收方式 |
|---|---|---|
| 假边审计 | workflow lint 或 plan-audit prompt | 每条依赖说明消费的字段/artifact/控制语义；无说明拒绝或告警 |
| 证据默认失败 | reviewer 前的 deterministic evidence node | 引用文件/行、测试日志、截图不存在时，reviewer 不得 ACCEPT |
| 机器可读 StopReason | workflow/node terminal output | 至少区分 goal_met、no_progress、round_cap、budget_cap、human_stop、evidence_missing |
| 动态 topology admission | `extend/replan` dry-run checker | 检查节点 kind、边策略、预算、深度、无环，返回全部拒绝码且零副作用 |
| 写入白名单 | node contract/runtime | 节点只能改声明的文件/路径或 state fields；违规 fail closed |

## 6. 为什么 `reasoner.md` 没加进 reviewer

### 6.1 可核验证据

1. 本机文件在 `/Users/suntao/.config/opencode/agents/reasoner.md`，不在仓库的 `.opencode/agent(s)/` 中。仓库跟踪的 review agents/templates 只有 `.opencode/dag-prompts/review-{arch,logic,style}.md` 和 `.opencode/workflows/change-review.yaml`。
2. reasoner 的输入契约只接受 `roadmap | design_doc | system_logic`；其说明明确写着“design-phase reasoning, not code review”，并禁止对已经写出的 diff 做 code quality review。
3. `change-review.yaml:14-19` 的 survey 目标是 uncommitted changes、`git status` 和 `git diff`。直接把 reasoner 接在 survey 后面会违反 reasoner 自己的输入与职责边界。
4. `packages/core/src/plugin/command/orchestration-domains.md:4-8` 已写入 “reasoner-style logic prober”；同文件 `:67-82` 的 Deep Speculation 也已经描述 logic simulator。说明概念层并没有忘记 reasoner，缺的是一个可复用的设计审查 YAML。
5. runtime 在 `packages/opencode/src/dag/runtime/spawn.ts:81-90` 按 `worker_type` 查 agent，找不到就以 `unknown worker_type` 失败。当前共享模板只用 `explore/general/build`，而个人 reasoner 没进入项目配置；直接硬编码会破坏模板可移植性。

Git 历史也支持“不是时间顺序导致的遗漏”：reasoner-style playbook 出现在提交 `cca49e8a6`，可复用 `change-review` 后来才在 `3477d9080` 加入，但仍只使用通用 built-ins。提交信息没有给出作者明确理由，所以下述“可移植性 + 契约边界”是基于代码的最强推断，不冒充历史事实。

### 6.2 正确接法

不要把现有 reasoner 直接塞进 diff reviewer。推荐三类参考图分工：

```text
设计深挖：internal grill → reasoner(逻辑推演) → fresh audit → PASS/LOOP/BLOCKED → 定稿

项目开发：冻结设计 → 并行模块 → 局部复审 → 接线 → reasoner(system_logic) ─┐
                                                    tests/logs ──────────────┼→ 并行 reviewer → arbiter
                                                    actual diff ─────────────┘

既有项目：并行探索 → 并行 reviewer → claim verifier → arbiter → PASS/局部 LOOP/BLOCKED
```

其中：

- `reasoner` 的输出是 graded insights，不是 PASS/BLOCKING；它只能暴露矛盾、边界和覆盖洞。
- 开发图若需要“预演代码执行情况”，先由唯一接线节点输出真实实现的 `system_logic`，再让 reasoner 推演 execution traces、hypotheses 和 `unverified_claims`；reasoner 不直接给 diff 判分。
- reviewer 必须逐条用 diff、代码、测试和日志核实 reasoner 的预测。预测是搜索方向，不是证据。
- 如果要让仓库模板使用个人 reasoner，应把它作为项目 agent 明确纳入并测试，或提供 capability resolution/fallback；不能假设所有用户都有同名全局 agent。

这与 Anthropic fresh-context evaluator 的原则一致：看起来合理不等于正确，缺少验收证据时必须 `NEEDS_WORK`。[原始 evaluator](https://github.com/anthropics/cwc-long-running-agents/blob/main/claude-code-config/.claude/agents/evaluator.md)。

## 7. 许可证与署名

| 来源 | 许可证 | 搬运约束 |
|---|---|---|
| `codejunkie99/graph-engineering` | [MIT](https://github.com/codejunkie99/graph-engineering/blob/master/LICENSE)，Copyright 2026 codejunkie99 | 允许复制、修改、再发布；复制模板或 substantial portions 时保留版权和完整许可声明 |
| GraphARC | [MIT](https://github.com/CodeGraphContext/GraphARC/blob/main/LICENSE) | 允许把 Python 示例改写成项目原生 YAML/TypeScript；保留版权和许可声明 |
| Anthropic Claude Cookbooks | [MIT](https://github.com/anthropics/anthropic-cookbook/blob/main/LICENSE)，Copyright 2023 Anthropic | 复制 notebook/prompt 的 substantial portions 时保留版权和许可 |
| Anthropic `cwc-long-running-agents` | [Apache-2.0](https://github.com/anthropics/cwc-long-running-agents/blob/main/LICENSE) | 分发时附许可证；修改文件显著标明改动；保留相关 copyright/attribution；若上游包含 NOTICE，随分发保留 |
| `npubird/KnowledgeGraphCourse` | [原仓库](https://github.com/npubird/KnowledgeGraphCourse)未发现 LICENSE | 不直接复制课件/PDF；只链接原文。若搬 `graph-engineering` 的独立英文归纳，则按其 MIT 文件并保留 credits |

建议新增统一第三方说明文件，至少记录：来源仓库、原始文件 URL、commit SHA、许可证、改写范围和本项目文件位置。模板里的 attribution 注释不能因为 YAML/Markdown “不是代码”而删除。

## 8. 本期落地决策

本期只增加或调整模板与文档，不修改 runtime/API：

1. 新增 `design-decision-loop`：内部 grill → reasoner → fresh audit → `PASS | LOOP | BLOCKED` → 定稿。
2. 新增 `parallel-development-loop`：并行模块开发与接线后，用 reasoner 推演真实 `system_logic`，再并行 review，由唯一 arbiter 裁决。
3. 将 `deep-review-dag-module` 定位为中高规模参考拓扑：Agent 可按任务扩展或剪枝，但必须保留 claim verification、arbiter 和 PASS-only finalization。
4. 所有剪枝强制记录 `prune_reason` 与 `replacement_coverage`；所有 LOOP 只新增前一局部波次的修正、复审和裁决节点，禁止构造环或重启终态节点。
5. 假边 runtime lint、动态 topology admission、write allowlist 和通用配置入口留到后续版本；本期只把这些约束写进 Agent/模板协议。
