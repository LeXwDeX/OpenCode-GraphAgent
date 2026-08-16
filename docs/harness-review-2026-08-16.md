# Harness 评审：REJECT 通路与假并行（2026-08-16）

讨论背景：用户的 harness 底层思想——用并发空间换时间、用总编排与反复监督（loop）换最终代码质量。
目标：必须使用 DAG 的触发场景、模板优先、ask-matt 路由价值植入检查点、无需 skill 也能模拟 matt skill 工作。

## 一、根因确认：为什么从未见过检查点后的 replan

**是 harness 问题，不是模型一次通过。** 三个叠加的结构性原因：

1. **积木编译器无法表达纠正波。** `packages/opencode/src/dag/blocks.ts:141` 对任何依赖 review 的积木只生成
   `condition: ${review}.output.verdict == "ACCEPT"`。REJECT 时下游被跳过（`runtime/loop.ts:148`
   `condition_false`），不是回环。积木 DSL 里没有「REJECT 回到 coding」的语法。
2. **REJECT 把工作流终结成 FAILED，而 FAILED 不可变。** review 节点带 REJECT 正常完成
   （`runtime/capture.ts:142-150` 只在 payload/fingerprint 无效时才失败），但 `runtime/loop.ts:328-334`
   的 `unresolvedReviewOutcomes` 触发 `dag.fail("unresolved review outcome(s)")`。`dag.ts:535` 拒绝
   对终结工作流 replan；`dag.ts:755-763` reopen 只允许 `completed`——「failed and cancelled workflows
   are immutable」。结果：`orchestration-policy.md:257-270` Verdict Disposal Contract 的选项 1（extend）
   和选项 2（pause→replan→resume）在 REJECT 之后物理不可达，只剩开新工作流。
3. **运行时零自动 replan。** `loop.ts` 从不调用 replan；`max_node_replan_attempts` 只是手动 replan 上限。

生命周期层**支持**纠正波（`review-lifecycle.ts:173` `isCorrectionReview`；policy 写明
`REJECT → corrected implementation → verification(PASS) → new diff review`），但只能用手写低层
`nodes` 表达。`~/.config/opencode/workflows/` 下 14 个 spec 没有一个带纠正波，全部 `review → synthesize` 收尾。

### 意外发现：reopen 机制就是为 REJECT 设计的，但够不着

`dag.ts:727-733` 注释：被跳过的 dependent（`condition_false`）不算 executed，因此图在检查点处「实质终结」，
自然完成的工作流仍可通过 additive extend 重新打开。REJECT 场景恰好满足全部 reopen 条件：
review 带 REJECT 完成（checkpoint 候选，`report_to_parent` 默认 true）+ synthesize 被跳过 →
`executedDependents = 0` → `hasReportingLeafCheckpoint = true`。唯一阻塞是 `loop.ts` 抢先判 `failed`，
而 `reopenDenial`（`dag.ts:756`）只放行 `completed`。

**这不是缺失功能，是一条被自己堵死的既有通路。**

### harness 内部自相矛盾

`orchestration-policy.md:250` 明文：「A gate that successfully returns `REVISE` or `REJECT` is a
**completed node, not a failed node**」。运行时在节点层遵守（`capture.ts`），在工作流层违反
（`loop.ts:328-334`）。同一条规则两层不一致——建模错误，非取舍。

## 二、用户的两个已确认决策

1. **REJECT 通路**：选「让 review REJECT 保持 completed」。
2. **写集**：并行的任务不涉及同文件修改，因此必须并行且同一 worktree；有的「并行」实际上是
   并行 review / 并行探索——那些本来就是并行的。

## 三、方向 A：REJECT 通路

### A-1 隐藏耦合：`dag.complete` 自己会抛

自然完成调 `dag.complete`，而 `dag.ts:509-512` 在其内部也做 `unresolvedReviewOutcomes` 检查并抛
`ReviewGateError`（HTTP 处理器 `server/routes/instance/httpapi/handlers/dag.ts:22` 也识别它）。
只改 loop 不够。守卫有正当用途：拦 agent 用 `control(complete)` 抹平未接受的 review。

**方向**：把守卫从 `dag.complete` 上移到工具层（`tool/workflow.ts` 的 `control(complete)` 分支）。
自然完成放行，agent 抄近路仍被拦。守卫语义是「谁在调用」而非「图的状态」。

### A-2 变体：completed vs paused（A1 vs A4）

| | A1 · complete-on-REJECT | A4 · pause-on-REJECT |
|---|---|---|
| 可用处置 | 只有 extend（reopen 要求 `addsNewNode`，天然只能追加） | 全部四种：extend / pause→replan→resume / 新工作流 / 有理由地停 |
| replan | 不可用（`dag.ts:535` 拒绝终结工作流） | 可用（工作流仍 live） |
| 父对话失职 | 无兜底 | `orchestrator_unresponsive` 看门狗生效（`loop.ts:1229`） |
| 改动量 | 小：两处守卫 | 中：需设计 pause 幂等（全节点已终结的图 resume 会立刻再撞 checkCompletion，须「先注入新节点才允许 resume」） |

A4 直接服务「反复监督 loop」诉求，且给非 ACCEPT 装上强制处置牙齿——`orchestration-policy.md:270`
自己承认终结检查点逃出了看门狗，A4 补上。
**建议**：A1 是通往 A4 的安全第一步；先跑通，有真实 loop 手感后再决定是否需要 A4。不要现在决定。

### A-3 响度（改成 completed 不会静默）

review 积木默认 `report_to_parent: true`（`blocks.ts:227`）→ 检查点唤醒父对话，携带
verdict + findings + required_actions。响度载体是 wake 而非终态状态字。
需补：`status` 输出里显式列出未解决 verdict（现在只能从终态原因串读到）。

## 四、方向 B：并行写集（假并行）

用户前提成立，但通往它的路上有三个互相咬合的阻塞，只拆一个会直接编译失败。

### B-1 序列化本身

`serializeWorkspaceWriters`（`blocks.ts:353-373`）无条件把所有 `coding`/`prototype` 串成链。最易改。

### B-2 真阻塞：canonical writer 假设

`implementationReviewRoute`（`blocks.ts:396-406`）要求唯一「被所有其他 writer 传递依赖」的 writer。
writer 真并行后该查找返回 `undefined` → 抛 `no canonical serialized implementation writer`。
**只删 B-1，带 review 的图全部编译不过。** 必须同时解。

### B-3 fingerprint 绑定

`review.implementation_node_id` 与 `DIFF_REVIEW_SCHEMA` 都假设单个实现节点。N 个并行 writer 时
「实现指纹」指谁？三方案：

| 方案 | 做法 | 评价 |
|---|---|---|
| **B3-a 聚合节点**（推荐） | 编译器为 review 路线注入只读汇聚节点，依赖全部 writer，输出 changed_files 并集 + 该点 HEAD 指纹；`implementation_node_id` 指它 | 保持 implementation 与 verification 独立，`validateDiffReview` 不动；多一个廉价节点，聚合过程可观测 |
| B3-b 复用 verify | verify 已被强制依赖每个 writer（`blocks.ts:394-400`），扩展 `VERIFICATION_SCHEMA` 带 fingerprint | 不加节点，但 implementation 与 verification 塌成同一个 |
| B3-c 指纹列表 | `implementation_node_id` 改数组 | 波及 schema、`validateDiffReview`、`reviewEvidenceKeys`、`unresolvedReviewOutcomes`、`isCorrectionReview`、review 契约文案——最大改动最小收益 |

旁证：`project-development-full.yaml:62` verify 指令已写「Bind results to the exact HEAD
fingerprint」——作者早就按「汇聚点取指纹」思考。B3-a 只是形式化。

### B-4 几乎免费的安全网

`IMPLEMENTATION_SCHEMA`（`blocks.ts:66-74`）已强制 `changed_files`。运行时可在汇聚点比对各 writer
申报文件集，实际重叠即大声失败。可先「默认并行 + 事后检测」，真踩到再考虑编译期 `write_set` 声明。

### B-5 边界：文件不重叠 ≠ 可以并行

同 worktree 并行写的共享状态：
- **生成物 / codegen**：`project-development-full.yaml:39-45` 的 `integration-slice` 明确负责
  generated-artifact wiring，即使源文件不重叠也不安全并行。
- **lockfile / 包管理器**：并发 `bun install` 直接互相破坏。
- **git HEAD 与暂存区**：writer 若自算指纹会读到别人写到一半的树——B3-a 的独立理由：指纹只在
  唯一汇聚点计算一次，writer 只管写文件、不碰 git。

结论：并行判据是「源文件、生成物、锁文件三者不重叠，且不触发共享构建」，要写进 plan 积木产出契约。

### B-6 config 仓库已过时的手写方案

`project-development-full.yaml:79-84` DELIVERY CONTRACT（写临时 md 只返回路径）是手工绕开上下文
膨胀的土办法。运行时 v1.0.15 Train B 已内建 output-by-reference（`runtime/output-ref.ts`：提交
绝对路径 → 记录 `content_ref`/`size`/`sha256`，报告区 `.opencode/workflow-reports/` 并自动
gitignore）。该 YAML 段落可删改原生能力；顺带修掉它写 `${TMPDIR}` 而非报告区、绕过完整性收据的问题。

## 五、方向 C：tier 判据与检查点处置

### C-1 tier 判据保持风险维度

不要换成「>2 / <=2 角色」。块数 full 6–9、lite 5–6，区分度低；块数 ≠ 并发数（review 展开 3 节点、
debug 展开 2）；角色数是风险的**结果**而非原因。`workflow-routing.md:50-57` 现有判据（可逆性、
跨模块、公共契约/并发/持久化/迁移/身份/授权/CI）是原因维度，保留。

### C-2 ask-matt 的正确植入位置

「路由作为 replan 判据」概念错位：ask-matt 是开局按情境选路；检查点问的是「给定 finding，什么最小波
能修掉」。选路 ≠ 处置，直接套用会导出「开新工作流」（`orchestration-domains.md:25` 明令禁止）。
落点：Verdict Disposal Contract（`orchestration-policy.md:257-270`）已有四个选项，缺的是选哪个的判据。
ask-matt 的情境分类当**处置分类器**：

| finding 性质 | 处置 | 契约选项 |
|---|---|---|
| 当前 scope 内、有界 | 同图追加纠正波，tier 不变 | 1 extend |
| 揭示跨模块/触边界，lite 形状覆盖不了 | 按 full 形状升级追加保障 lane | 1 extend（升级） |
| 情境判断错了（以为是变更，实为未知成因缺陷） | 唯一该重选路线的场景：debug backbone 新图 | 3 新工作流 |
| 无界 / 迷雾 | 见方向 D | — |

tier 升级 `workflow-routing.md:59-61` 已在暗示，提升为显式处置表即可。

## 六、方向 D：两个结构性缺口

### D-1 缺「决策而非交付物」路线

现有 7 条路线全是 deliverable 导向，缺「路还看不见」的情形（ask-matt 的 wayfinder 位置，即「深挖
设计方案」的真实缺口）。`technical-design-full` 假设一个图内产出 implementation-ready design；迷雾期
需要逐个消解决策点、跨 session 累积决策记录。产物是决策记录，跨图累积，机制需单独设计。

### D-2 父对话上下文卫生——直接威胁 loop 主张

每次检查点 wake 都往父对话堆上下文；反复 loop 的图会把父对话推出 smart zone（~150k），监督质量
随轮次单调下降，与「用反复监督换质量」正相反。harness 目前没有这个概念。ask-matt 的
phase boundaries（continue / clear / handoff / subagent / compact）是现成词汇表。
原语已有：output-by-reference 让父对话只拿 `content_ref` + 200 字摘要。缺的是把「wave 之间
父对话该压缩什么」写成契约，不是缺机制。

## 七、落地顺序（按解锁关系排序）

1. **恢复 REJECT 可达性**（本仓库，最小）。守卫从 `dag.complete` 移到 `tool/workflow.ts` 的
   `control(complete)`；`loop.ts:328-334` 不再 `dag.fail`。验收：REJECT 图断言 `completed`、
   reopen-extend 被接受。单独可验证，立刻第一次看到检查点后的 replan。
2. **决定要不要 A4**。第 1 步跑通后凭真实 loop 手感判断「只能 extend」够不够。唯一应等经验数据的选择。
3. **并行写集**（本仓库，原子改动）：B-1 解序列化 + B-2 汇聚节点替代 canonical writer + B3-a
   汇聚点指纹 + B-4 `changed_files` 重叠检测。拆开编译失败。
4. **提示词与 spec**（config 仓库，须等 1–3 落地并推进 `runtime-compat.json`）：
   处置分类表入 Verdict Disposal Contract；tier 升级显式化；plan 契约加三重不重叠判据；
   删 `project-development-full.yaml:79-84` 手写 DELIVERY CONTRACT；full spec「parallel slices」
   措辞与第 3 步同步发布（此前不诚实）。
5. **缺失路线与上下文卫生**（主要 config 仓库）：D-1、D-2，独立于前四步。

跨仓库铁律：1–3 是运行时（`blocks.ts` / `loop.ts` / `dag.ts` / `review-lifecycle.ts`），4–5 主要
config 仓库。按 `runtime-compat.json` 策略运行时先合并，同一 PR 推进 SHA 并更新模板。
第 3 步改变积木编译规则，属于「incompatible block rule」。

## 八、关键文件索引

| 主题 | 文件 |
|---|---|
| 积木 DSL / 编译器 / 序列化 | `packages/opencode/src/dag/blocks.ts` |
| review 生命周期 / 裁决结算 | `packages/opencode/src/dag/review-lifecycle.ts` |
| 输出捕获与结算 | `packages/opencode/src/dag/runtime/capture.ts` |
| 调度循环 / checkCompletion | `packages/opencode/src/dag/runtime/loop.ts` |
| 工作流状态机 / extend / reopen / replan | `packages/opencode/src/dag/dag.ts` |
| output-by-reference | `packages/opencode/src/dag/runtime/output-ref.ts` |
| 路由器提示词 | `packages/core/src/plugin/command/workflow-routing.md` |
| 积木指南 | `packages/core/src/plugin/command/workflow-blocks.md` |
| 策略 / 裁决处置契约 | `packages/core/src/plugin/command/orchestration-policy.md` |
| 域冲突组合 | `packages/core/src/plugin/command/orchestration-domains.md` |
| 参考 spec 库 | `~/.config/opencode/workflows/*.yaml`（权威源 LeXwDeX/opencode-dag-config） |

## 九、用户已决策 / 待决策

已决策：REJECT 保持 completed（A1 起步）；写集必须真并行且同一 worktree（写集不重叠为前提）。
待决策（有数据后再定）：A1 之后是否上 A4（pause + 看门狗）。
明确不做：把角色数当 tier 判据；把 ask-matt 路由器当 replan 判据（只取情境分类做处置分类器）。

---

# 附篇：假并行深挖与修复设计（同日）

## A1 证据盘点

1. **假并行纯粹发生在编译期。** 运行时天生支持并行：每个工作流一个信号量
   （`runtime/loop.ts:432-434`、`dag.ts:462-463`，`max_concurrency` 默认 5），就绪节点并行 spawn。
   唯一拦截者是 `serializeWorkspaceWriters` 在编译期注入的依赖边。**删掉它并行就真实生效，
   运行时零改动。**
2. **所有子会话同一 worktree。** `spawn.ts:425-431` `sessions.create({parentID, title, agent,
   model, permission})` 不带 directory 覆盖——子会话继承工作流目录。符合「同一 worktree」前提。
3. **fingerprint 是 writer 自报的，下游只校验 echo 一致性。** 链路：writer 通过
   `IMPLEMENTATION_SCHEMA` 自报 `fingerprint`（无格式约束，纯提示词契约）→ 编译器用
   `input_mapping` 注入 reviewer 提示词 → reviewer 必须原样 echo
   （`review-lifecycle.ts:126-138` `validateReviewResult`）→ `settleCapturedOutput`
   （`capture.ts:142-150`）比对相等。它**不是**对工作树的密码学绑定。
   推论：「聚合指纹」在汇聚点计算一次即可，语义与现状完全兼容。
4. **`implementationReviewRoute` 的「no canonical serialized implementation writer」抛错
   （`blocks.ts:407-408`）目前是死代码。** 序列化总先构造全序，canonical 查找必然成功。
   删除序列化后它才可达——改造点正是这里：把 throw 换成聚合器注入。
5. **review 生命周期全部经由 `review.implementation_node_id` + `input_mapping` 工作**
   （`validateDiffReview` `review-lifecycle.ts:197-257`、`reviewEvidenceKeys`、
   `reviewImplementationFingerprint`、`isCorrectionReview`、recovery 路径
   `runtime/recovery.ts:188-190`）。只要聚合节点以 `IMPLEMENTATION_SCHEMA` 形状输出且
   mapping 指向它，**review 生命周期全部零改动**。
6. **explore agent 有 bash 权限、无写权限**（`agent.ts:200-211`：grep/glob/list/bash/read
   allow，`*` deny）——是聚合器 worker 的现成最佳人选（标准 tier，便宜）。
7. **只有 1 个测试钉死序列化**：`test/dag/blocks.test.ts:252`「serializes unordered workspace
   writers...」。`blocks.test.ts:229`（链式 prototype 案例）在保留链行为的设计下不受影响。
   `workflow-authoring.test.ts` 与 `dag-review-lifecycle.test.ts` 无钉死。

## A2 修复设计：两种模式，最小差异

在 `compileWorkflowBlocks`（`blocks.ts:118-133`）中：

**模式一：writers 全序（链）→ 行为不变。** 存在唯一「被所有其他 writer 传递依赖」的 writer
时，canonical 逻辑原样保留。链式图（如 `blocks.test.ts:229` 的 coding→prototype→verify→review）
编译结果一字不改。

**模式二：writers 无全序（真并行）→ 注入聚合节点。** 把现有的 throw 替换为：

- 新节点 `${review.id}--aggregate`（沿用 `--` 子节点命名惯例，碰撞时按现有
  `uniqueDuplicates` 抛错）；`depends_on` = 全部 writer。
- `worker_type: explore`（只读 + bash，可跑 `git rev-parse` / 内容哈希）；`required: true`；
  `report_to_parent: false`。
- `input_mapping`：逐一绑定每个 writer 的 `output.changed_files`（顺带 `summary`）。
- `output_schema` 复用 `IMPLEMENTATION_SCHEMA`（union changed_files + 单一 fingerprint）→
  `validateDiffReview` 等所有下游检查零改动。
- 契约文案：比对各 writer 申报写集，**有交集则不提交、直接失败**（大声报错）；无交集则
  提交并集 + 在汇聚点计算的一次性 fingerprint（对 union 文件内容做哈希，报告所用命令）。
- **改写 verify 的 writer 依赖为依赖聚合节点**（preserve 非-writer 依赖）；
  review 的 `implementation_node_id` 指向聚合节点；review `input_mapping` 的三个键
  （`implementation_changed_files` / `implementation_fingerprint` / `verification`）不变，
  仅源节点 ID 变化。

## A3 重叠门禁的位置与残余风险

- 门禁放在聚合点：intersection of `changed_files` == ∅ 是 writer 契约的机械验证。
  能抓住：同文件双写、`package.json`/`bun.lock` 双改、同一 codegen 输出双写。
- 抓不住的残余：不同生成文件但共享构建缓存目录、并发 `bun install` 的锁争用。
  → 写进 plan 积木产出契约与 `workflow-blocks.md`：并行判据 =「源文件、生成物、锁文件
  三者不重叠，且不触发共享构建」。这是计划纪律，不是引擎能单独兜底的。

## A4 附带缺陷（同 PR 可顺手修）

1. **verify 的指纹契约是空头支票。** `BLOCK_CONTRACTS.verify`（`blocks.ts:111`）写「Bind
   evidence to the supplied implementation fingerprint」，但编译器从不给 verify 注入任何
   `input_mapping`——「supplied」并不存在。修复：把聚合/canonical 节点的
   `changed_files`+`fingerprint` 绑进 verify 的 `input_mapping`（verify 已依赖该节点，
   数据依赖与图依赖一致）。
2. **verify FAIL 的终态表现混乱。** verify FAIL → review 被条件跳过（`condition_false`）→
   required review 的 skip 不算 failure → 工作流最终死于
   「unresolved review outcome(s)」（`loop.ts:328-334`）——原因串误导。属 Direction A
   的 REJECT 通路改造的邻域，一并考虑。

## A5 改动清单（原子）与波及面

| 文件 | 改动 |
|---|---|
| `src/dag/blocks.ts` | 删 `serializeWorkspaceWriters`；新增聚合预处理 pass（在 `requireValidReviewRoutes` 之前）；`implementationReviewRoute` 的 throw 点改为聚合器注入；verify 指纹绑定 |
| `test/dag/blocks.test.ts` | 重写 :252 为并行断言；新增：聚合器形状、用户块名碰撞、部分序（A→B 且 C 独立）、链式图零变化 |
| `packages/core/src/plugin/command/workflow-blocks.md:150-151` | 「compiler serializes unordered writers」改写为并行 + 聚合器 + 三重不重叠判据 |
| config 仓库（后置 PR） | `project-development-full` 的「parallel slices」措辞自此真实；plan 指令加三重不重叠契约；`runtime-compat.json` 推进（属 incompatible block rule） |

**运行时文件零改动**：`loop.ts` / `dag.ts` / `spawn.ts` / `review-lifecycle.ts` / `capture.ts` /
`recovery.ts` 均不需要动。已持久化的工作流不受影响（编译只发生在 create 时）。

## A6 关键判断记录

- 为什么聚合器而不是复用 verify 当指纹源：`validateDiffReview:236-238` 要求 verification
  传递依赖 implementation——二者同一节点会直接违反；聚合器保持两者独立，零检查改动。
- 为什么聚合器用 explore：只读 + bash 恰好覆盖「读树、算哈希、跑 git rev-parse」，
  标准 tier 成本低，无写权限杜绝聚合器自己改工作树。
- 为什么不做编译期 `write_set` 声明字段：`IMPLEMENTATION_SCHEMA` 已强制 `changed_files`，
  事后机械检测覆盖了大部分场景；声明字段是积木 DSL 的 schema 变更，等真实踩坑再加。
- 为什么保留链式 canonical：最小差异原则——当前能编译的链式图编译结果完全不变，
  行为变化只发生在「曾经被强行串行」与「曾经编译失败」两类图上。
