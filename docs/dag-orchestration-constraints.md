# DAG 编排约束提示词（condition / skip / 恢复语义）

> **用途**：交给编写 DAG 工作流的 agent（编排者）作为硬约束规则。
> **背景**：`condition_false → markSatisfied` 缺陷（P0-1）已修复：skipped 现在是独立调度态，纯 skip 依赖会级联跳过下游。本文档描述**修复后**的引擎语义。历史缺陷分析见 `dag-bug-condition-skip-as-satisfied.md`。

---

## 规则 1：condition 门禁会级联——纯 skip 依赖的下游自动跳过

### 引擎语义（修复后）

`condition` 求值为 false 时节点被标记 `skipped`（终态，`condition_false`）。下游处置取决于依赖构成：

- **下游的依赖全部为 skipped** → 级联跳过（`orphan_cascade`），一波一波传播到整条子链。门禁拒绝会真正阻断纯门禁子图。
- **下游是混合 fan-in**（至少一个依赖 satisfied 或可降级的 failed-optional）→ 照常执行，skip 的上游以占位文本注入（见规则 3）。

```
gate (verdict=REVISE)
  └─ implement-A (condition: gate.verdict == "ACCEPT")  → skipped (condition_false)
       └─ integrate (仅依赖 implement-A)                  → skipped (orphan_cascade) ✅
            └─ audit (仅依赖 integrate)                    → skipped (orphan_cascade) ✅
```

### 约束

- 单点 condition 即可门控其**纯依赖**子链，不再需要给子图每个节点重复相同 condition。
- 若下游是混合 fan-in 且你希望它也被门控，仍需给该 fan-in 自己加 condition——混合 fan-in 的"继续执行"是有意的降级语义，不是缺陷。
- skip 是终态：级联一旦发生不可逆。若门禁拒绝后还想走修复路径，用 `report_to_parent: true` 唤醒父会话决策 replan，而不是依赖已 skip 的子链复活。

---

## 规则 2：condition 只能引用 depends_on 中的节点（现在 create 会直接拒绝）

### 引擎语义（修复后）

condition 求值时只收集 `node.depends_on` 直接依赖的输出。**`dag.create` 与 `replan` 现在校验 condition 引用**：可解析的 condition 若引用了不在 `depends_on` 中的节点，提交直接报错（fail-fast），不再静默得到 `condition_false`。

### 约束

- condition 中出现的每个 nodeID 都必须存在于该节点的 `depends_on` 数组中。
- 不可解析的表达式仍留给运行时 fail-loud，不要依赖格式错误的 condition"恰好为 false"。

```yaml
# ❌ create 时报错：condition 引用了 gate，但 depends_on 里没有 gate
- id: implement-core
  depends_on: [some-other-node]
  condition: 'gate.output.verdict == "ACCEPT"'

# ✅ 正确
- id: implement-core
  depends_on: [gate]
  condition: 'gate.output.verdict == "ACCEPT"'
```

---

## 规则 3：混合 fan-in 节点必须容忍上游 skip

### 引擎语义（修复后）

纯 skip 依赖的 fan-in 会被级联跳过（规则 1），**不再需要防护**。仍会执行的是混合 fan-in：部分上游 skipped、至少一个上游有真实产出。skip 的上游以 `"Dependency X skipped: condition_false"` 占位文本注入 input_mapping / prompt interpolation。

### 要求

- 混合 fan-in 的 prompt 必须显式说明如何处理 skip 的上游（如"如果某条输入标注为 skipped，在汇总中注明并跳过该项"）。
- 若混合 fan-in 在部分上游 skip 时不应执行，给它加 condition 显式门控。

---

## 规则 4：崩溃恢复会暂停工作流——父会话必须处置

### 引擎语义（recovery-pause）

进程崩溃重启后，恢复流程对无法从子会话持久状态证明结果的 running 节点**判失败**（`execution ownership lost on recovery` 等），这一保守判罚不会重试（恢复永不隐式重跑 provider 工作）。判罚后工作流**不会直接终态报废**，而是转 `paused`：

- 失败节点的下游保持 `pending`（可 replan 改线）。
- 父会话会收到 NodeFailed wake 消息（含 `execution ownership lost on recovery` 等原因）。

### 处置（父会话三选一）

1. **replan + resume（推荐）**：失败节点是终态不可变的，用**新 id** 提交替换节点，并把下游节点的 `depends_on` 改线到新 id，然后 `resume`。
2. **直接 resume**：接受失败语义。required 节点失败会把工作流归因为 `failed`（原因含具体节点 id）；optional 失败则降级继续。
3. **cancel**：放弃整个工作流。

### 约束

- **禁止**假设崩溃后工作流会自动继续或自动重跑丢失的节点。不会。
- 收到 ownership-lost wake 后必须在当轮处置（replan / resume / cancel），不要留着 paused 工作流不管。

---

## 规则 5：不要用中途 status 快照判定"卡死"

工作流执行中查询 status 时可能看到部分节点 pending——不一定是卡死，可能是调度器尚未拾取。判定卡死需要：`hasRunning()` 为 false、无 ready 节点、且 `!isComplete()`。

- **禁止**仅凭"有 pending 节点 + status=running"就判定卡死。
- 引擎自带 `orchestrator_unresponsive` 兜底：wake 投递后父会话当轮未对停摆工作流采取动作，工作流会被判 fail。收到 wake 里的 actionable 指令必须当轮响应。

---

## 规则 6：测试场景下占位 prompt 会导致子 agent 产出不可靠

压测中使用极简占位 prompt（如"输出一句话后结束"）时，部分子 agent 会产出幻觉内容（引用不存在的工作流 ID / 节点名）。

- 压测图若要验证 fan-in / 结构化输出的正确性，prompt 必须包含足够约束（如"只基于上游输入汇总，不要编造工作流 ID 或节点名"）。
- 否则子 agent 的幻觉输出会干扰对引擎行为的判断。

---

## 自检清单（编排者提交图之前过一遍）

- [ ] 每个 condition 引用的 nodeID 都在对应节点的 `depends_on` 中？（规则 2，create 会拒绝但别浪费一轮）
- [ ] 门禁 condition 的下游是纯依赖链还是混合 fan-in？混合 fan-in 需要自己的 condition 或 skip 容忍 prompt？（规则 1/3）
- [ ] 父会话的编排 prompt 是否涵盖崩溃恢复处置（ownership-lost wake → replan/resume/cancel）？（规则 4）
- [ ] 是否避免了对中途 status 快照的过度解读？（规则 5）
- [ ] 压测 prompt 是否足够约束，避免子 agent 幻觉？（规则 6）
