# 功能深挖审计（第二批）：#316 触发源 / loop.ts 全量 / DAG 未审文件 / 组合根装配 / Effect v4 语义

深挖日期：2026-08-19
深挖对象：`dev` HEAD = `31bd2d4eb`（含首批审计基线 `f1c2c8c33` 之后全部 45 个提交，即首批 DAG-01..04 / MEM-01..03 / GOAL-01..04 修复的落点 + PR #338 supervision sweep）
前置文档：`docs/audit-dag-memory-goal-2026-08-18.md`（首批审计，其「局限」节 5 项遗留缺口即本次深挖范围）

## 方法与证据纪律

1. 五路只读 auditor 子代理并行：#316 触发源 + PR #338 sweep 审查、`loop.ts` 1738 行逐行重读、DAG 未审文件批、`packages/opencode` 之外组合根装配、effect-smol 参考实现语义查证（`Effect-TS/effect-smol@3a1128c`，`effect` 4.0.0-beta.98）。
2. 主会话交叉复核：子代理结论之间相互矛盾处以下文「交叉修正」节为准；每条 `file:line` 均出自子代理直读当前工作区源码，关键机制由第二路独立验证。
3. 测试未运行；并发/竞态结论为静态控制流阅读 + Effect 参考实现源码语义（不再是无依据推理，见第五路）。

## 首批修复复核结论

首批 11 项缺陷（DAG-01..04、MEM-01..03、GOAL-01..04）**全部已修或已按成文取舍处置**，修复签名逐项核对在位（`loop.ts:172` 字符串归一化、`validation.ts:621` output_schema 义务、`dag.ts:578` replanStructuralDiagnostics、`loop.ts:743` vetoHold、`summary-publisher.ts:170` interrupt 再抛、`global-lifecycle.ts:38` 有界 dispose、`memory.ts:506-529` 锁外 matcher + 后台维护、`goal/loop.ts` GOAL-01..04 各修复点、MEM-03 随 MEM-01 重构结构性抵消并记录于 `docs/findings/memory-batch-findings.md`）。首轮记忆/目标修复的正确性另由 effect-smol 语义查证反向确认（见「验证为正确」）。

## 交叉修正（子代理结论相互验证的关键产出）

**NEW-1 降级**。loop.ts 重读路发现 `loop.ts:323-325`（spawn 失败边界 `catchCause` 无 `Cause.hasInterrupts` 再抛）并判为 Medium：「teardown 中断 handler fiber → 中断被转换成持久 `nodeFailed`」。effect-smol 查证路**推翻其触发机制**：`exitFailCause`（`effect.ts` internal C:528-546）在 `fiber.interruptible && fiber._interruptedCause` 时逐层丢弃错误续延——**外部中断天然绕过 catchCause**（`Effect.test.ts:1303-1321` 钉死：外部 `Fiber.interrupt` 下 catchCause 不执行）；只有「自抛的 interrupt cause」（`Effect.failCause(Cause.interrupt(...))`，普通失败通道）才会被捕获。teardown 中断是外部的 → 该点不会在 dispose 期间发 `dag.nodeFailed`。残留价值为风格一致性 + 对未来自抛模式的防御，降级为 Low（收入低危批次）。

此修正同时巩固了 #316 判定（下节）：全仓没有能在 dispose 期间发出 `dag.*` 事件的路径。

---

## #316 判定：**可以关闭**（验收项逐条对账见下）

验收 1（exerciser 有界退出）/ 3（真实 server 关停）：`db626d4ba` 有界 dispose（10s `timeoutOption`）+ publisher interrupt 再抛已落地，CI（ci-test.yml）自该提交起 dev 分支连续 success（2026-08-18 起 5+ runs）。验收 2（根因证明）由本次深挖补齐：

1. **穷尽阅读后不存在「dispose 期间自主持续发 `dag.*` 事件的组件」**。生产代码 `dag.*` 发布点仅 `dag.ts` 命令方法（398-895，经 `withWorkflowLock`）与 `loop.ts:543`（init 期孤儿-pending 合法化）；调用方要么在实例闭包内（随 teardown 死），要么是请求上下文。审计首批未读的三组件全部直读：`EventV2Bridge`（`event-v2-bridge.ts:35-62`）是纯消费者/转发器（host 级存活但自身不产生 `dag.*`）；`InstanceStore.disposeAll`（`instance-store.ts:166-192`）仅发 `server.instance.disposed`；`InstanceState` scope-close（`instance-state.ts:26-51`）= ScopedCache invalidate + interrupt。
2. **首批观察到的「警告流不止」机制唯一成立路径是 publisher 内层 exit-重抛的自抛 interrupt cause 被外层 catchCause 捕获**——即 `summary-publisher.ts:111-113` 内层刻意再抛的 interrupt 在旧外层 `catchCause`（无 hasInterrupts 检查）下变成 "failed to publish" 日志行。`db626d4ba` 已修（`summary-publisher.ts:169-173`），且该修复经 effect-smol 语义验证修的正是可捕获的那条路径（自抛 cause），行为测试注入 `Effect.failCause(Cause.interrupt(0))` 与语义吻合。
3. **外部中断路径**（真正的 teardown）在 Effect v4 下处处绕过 catchCause → 静默死亡而非事件风暴。dispose 期间迟到事件的 publisher `forkIn` 走「已关闭 scope → fiber 生而为死」语义（`E:5196-5198`），不 defect、不残留。
4. **PR #338 生产事故是 #316 的镜像补集，不是触发源**：事故签名是 dispose 后**彻底静默**（订阅/spawn fiber/watcher 全被收割、计数器冻结，`dag-node-supervision.test.ts:313-316` 断言冻结）——饿死，不是放大。sweep 治「节点 rot」；「工作流 rot」残留为新缺陷 SW-2（下文）。

验收 4（10 轮抓网）：未重跑抓网脚本；以 DAG-04 修复后 dev 全量 CI 连续绿 + 机制证明替代。若维护者要求严格对账可补跑。

---

## 缺陷汇总

| ID | 严重性 | 置信度 | 模块 | 一句话描述 |
|---|---|---|---|---|
| F1 | High | Confirmed（静态装配链） | GOAL/装配 | GoalLoop 未接 server 请求 node 图：headless serve/web/desktop 的 standing goal 首轮后停摆 |
| F2 | Medium | Confirmed（静态装配链） | DAG/装配 | Desktop sidecar 不建 AppLayer → DagSupervisionSweep 在桌面默认路径缺席 |
| SW-1 | Medium | Confirmed（机制）/量化未复现 | DAG/sweep | freeze window 按当前 config cadence 计算，replan 下调 timeout + re-time 闸门跳过 → 活节点被提前 `nodeFailed` 误杀 |
| SW-2 | Medium | Confirmed | DAG/sweep | sweep 只 settle 节点，无 host 级工作流终局推进/wake 投递 → 工作流 rot + 父会话永不知情 |
| DAG-05 | Medium | Confirmed | DAG/httpapi | `dag.start` HTTP 路由完全绕过 Workflow Authoring（checkpoint 门/output_schema 义务/profile 检查全缺席，deep 准入门客户端自证） |
| DAG-06 | Medium | Confirmed | DAG/recovery | 崩溃恢复把无 schema 的 running 节点以 `undefined` 完成——live/恢复不对称，replan 否决裁决凭空消失 |
| DAG-07 | Medium | Confirmed | DAG/capture | `validateAgainstSchema` 对无 `type` 的 object 型 schema 放行任意类型值——DAG-01 同后果藏在 schema 写法内部 |
| BLK-01 | Medium | Confirmed | DAG/blocks | 并行 writer 聚合的「mechanical」表述失实；未申报写入零检测，逃逸 union+fingerprint 绑定 |
| INV-A | Medium | Confirmed | DAG/文档 | 「一个用户目标至多一个 live DAG」在 CONTEXT.md 是 Invariant，实现是纯 convention（无任何引擎强制） |
| LOW 批 | Low | 各条见正文 | 多模块 | NEW-1(降级)/NEW-2/REC-1/BLK-02/BLK-03/CAP-02/SW-L1/SW-L2/F3/F6/F4/F5 |

---

## F1（High）GoalLoop 未接入 server 请求上下文 node 图

**位置**：`packages/opencode/src/goal/loop.ts:803`（`GoalLoop.node` 定义）；`packages/opencode/src/server/routes/instance/httpapi/server.ts:215-300`（app 组节点清单）；`packages/opencode/src/project/bootstrap.ts:80-85`（唯一消费点）

**证据链**：`GoalLoop.Service` 全仓唯一消费点是 `bootstrap.ts:80-85`（`Effect.serviceOption(GoalLoop.Service)` + `init()`）；`GoalLoop.node` 无任何图引用（全仓引用仅 `app-runtime.ts:133` / `bootstrap-runtime.ts:22` 两个 defaultLayer，而 `BootstrapRuntime` 零使用方）。httpapi `server.ts` 的请求上下文 app 组含 `Dag.node`/`Goal.node`/`Memory.node`/`SettingsHook.node`，**无 `GoalLoop.node`**。

**机制**：凡实例经 HTTP 请求加载（`instanceContextLayer` → node 图版 InstanceStore → bootstrap.run 在请求 fiber 上下文执行），`serviceOption(GoalLoop.Service)` 恒 None → idle 订阅与启动恢复扫描（`goal/loop.ts:688-781`）静默跳过。这正是 `server.ts:273-299` 注释里 SettingsHook/Memory（#311）刚修过的同一失败类，GoalLoop 被遗漏。

**受影响入口**：`opencode serve`、`opencode web`（`instance:false`，无人经 AppRuntime 加载实例）；Desktop sidecar（见 F2）；TUI/ACP 的**非 CWD 目录**请求（x-opencode-directory）。TUI/ACP 的 CWD 因启动副作用（`cli/cmd/tui.ts:261-263` → `worker.ts:87-90` checkUpgrade 加载 CWD 实例）碰巧被 arm。

**运行时影响**：headless server / web / desktop 上创建的 standing goal 在第一回合结束后停摆；崩溃恢复扫描不运行（GOAL-04 的 busy-retry 也随之缺席）。与首批 GOAL-01 的「silent stall」同类，但成因是装配缺失而非状态机缺陷。

**建议修法**：`GoalLoop.node` 加入 `server.ts` app 组（与 `SettingsHook.node` 同位），配 `test/server` wiring 回归断言（`server.ts:211-214` 注释的探针机制：断言请求上下文中 `GoalLoop.Service` 为 Some）。

## F2（Medium）Desktop sidecar 从不构建 AppLayer → DagSupervisionSweep 缺席

**位置**：`desktop/src/main/sidecar.ts:57-65`（直接 `import("virtual:opencode-server")` → `Server.listen`，不经 effectCmd）；`packages/opencode/src/dag/runtime/supervision-sweep.ts:239-241`（sweep fiber 只在 layer 构造时 fork 进 AppLayer scope）；`app-runtime.ts:140`（全仓唯一构建点）

**机制**：sweep 是 host 级防线（2026-08-18 生产事故的直接回应），但其存活绑定在 `AppLayer` 构造上；sidecar utility process 只调 `Server.listen`，AppLayer 永不构建 → 桌面默认路径（mac/win 内置 sidecar）上超时升级节点的 deadline 监督**不运行**。WSL 路径（拉起外部 `opencode serve`）不受影响（serve 的 effectCmd 保活 AppLayer）。

**建议修法**：sweep 的接线从「AppLayer 独占」改为 server 组装路径可达（或 sidecar 显式构建所需 host 层）；与 F1 同批修，共用 wiring 探针。

## SW-1（Medium）sweep freeze window 的 cadence 前提被 replan 打破 → 活节点误杀

**位置**：`packages/opencode/src/dag/runtime/supervision-sweep.ts:87-91`（窗口从当前持久化 config 推导）；`spawn.ts:120`（活 watcher cadence 固定在 spawn/re-time 时刻）；`loop.ts:1034-1037`（A1/Q2 re-time 闸门故意跳过）；`dag.ts:679`（replan replace 桶可改 running 节点 timeout_ms）

**机制**：窗口数学在 cadence 不变时成立（60s tick，needed = ⌈I/60s⌉+1，1 tick 余量）。但 replan 的 replace 桶可下调 running 节点的 `timeout_ms` 并持久化新 config，而 re-time 闸门在「deadline 未到且无 pending 升级」时**故意跳过 re-time、保留旧 watcher 旧 cadence**（N1 纪律）。此后 sweep 按新 config 算窗口、旧 watcher 按旧 cadence 动计数器：例 spawn 时 30min cadence、replan 改 10min → sweep 窗口 ≈11 ticks，父代理在 30min cadence 默许的裁决窗内、~11 分钟即被 `nodeFailed("timeout","swept")` 终局，子会话经 DagLoop handler 的 abortChild 被真实取消，进行中工作丢失。

**建议修法**：窗口取 `max(config cadence, DEFAULT)`；或从 durable 行（`NodeDeadlineExtended`/`NodeStarted` 的 deadline − timeout）反推实际 cadence。

## SW-2（Medium）sweep 只 settle 节点，不推进工作流终局——「工作流 rot」残留

**位置**：`supervision-sweep.ts` 全局；对照 `loop.ts:331-369`（checkCompletion/dag.fail 全在 DagLoop 内）、`loop.ts:1281+`（wake 投递）、`loop.ts:1182-1195`（automation unregister 在实例 handler 内）

**机制**：实例已 teardown 时，sweep 的 NodeFailed 落库后没有任何 host 级角色推进工作流终局或唤醒父会话：工作流行停留 `running`、required 节点已 failed、wake 行永未投递、automation lease 注册泄漏（unregister 在已死的 handler 里）。要等实例重新 load 才由 `recoverWorkflow`（`loop.ts:1645-1654`）收敛。事故最痛的「节点 rot」被治好，「工作流 rot + 父永远不知道」还在。

**建议修法**：sweep settle 后追加 host 级 workflow 完成性检查 + wake 投递 + lease 清理（复用 `withWorkflowLock` 串行点），或在 sweep 判死时标记工作流需恢复、由下一实例 load 之外的路径推进。

## DAG-05（Medium）httpapi `dag.start` 绕过 Workflow Authoring

**位置**：`packages/opencode/src/server/routes/instance/httpapi/handlers/dag.ts:147-168`；对照 `dag.ts:340-364`

**证据**：payload config 是 `Schema.Unknown`，仅查 `nodes` 是数组后直接断言 `as Dag.WorkflowConfig`；`dag.create` 按设计只跑 `structuralDiagnostics`（不含 checkpoint 门与 output_schema 义务）。该豁免的安全性前提是「工具动作先过 authoring」（工具路径 `authoring.prepare(profile:"environment")` → `create`），此路由打破前提。handler 注释自称 "Same code path as the workflow tool's start action"——与事实不符。

**后果**：(1) 无 schema reporting checkpoint + 门控 dependent（DAG-01 危险形状）可零诊断创建——运行时字符串归一化救不了散文回复 → `condition_false` 静默跳子树、COMPLETED；(2) `mode:"deep"` 的 admission 记录可由调用端伪造（`fingerprintBrief` 是纯函数可自行计算）——deep 准入门变成客户端自证；(3) worker/model/prompt 资产解析全跳过。触发面：SDK 已生成该路由（identifier `dag.start`）、httpapi-exercise 契约演练在用；第一方 TUI 目前只用 `dag.control`。control（replan/extend）虽同样绕过 authoring，但被 `replanStructuralDiagnostics` 合并图复查兜住——唯 **start** 无任何等价复查。

**建议修法**：handler 内走 `authoring.prepare` + `validatePostCompile`（environment profile），或给 `dag.create` 加可选的等价校验入口；同步修正注释与 `test/server/httpapi-exercise/index.ts` 契约。

## DAG-06（Medium）崩溃恢复以 `undefined` 完成无 schema 的 running 节点——裁决丢失

**位置**：`packages/opencode/src/dag/runtime/recovery.ts:92-106`；对照 `spawn.ts:483-521`（live 路径取最后 text part 完成）

**证据**：恢复路径判定 sessionStatus=completed 后对无 schema 节点 `nodeCompleted(dagID, node.id, undefined)`，从不回读子会话消息。崩溃窗口 = 子会话已产出终稿但 NodeCompleted 未发布。后果：(a) 无 schema checkpoint 以裸字符串 `{"verdict":"replan"}` 回复的否决在恢复后凭空消失（`loop.ts:699-704` 读 `node.output` 为 undefined）——不暂停、不告警；(b) 门控 dependent `condition_false` 跳过；(c) 下游 input_mapping 降级占位符。可达面：运行时 replan 缝显式豁免 schema 义务（`requireOutputSchema:false`）+ DAG-05 的 HTTP start，无 schema reporting 节点仍是合法可达形状。退化旁支：`parseWorkflowConfig` 返回 undefined（行损坏）时有 schema 节点也落同分支。

**建议修法**：恢复时回读子会话最后 assistant text part（与 live 路径对称）；config 不可解析时按有 schema 处理（fail 而非 undefined 完成）。

## DAG-07（Medium）`validateAgainstSchema` 对无 `type` 的 object schema 放行任意值

**位置**：`packages/opencode/src/dag/runtime/capture.ts:96-117`

**证据**：required/properties 检查均以 `isSchemaObject(value)` 为前提——值非 object 时**整组跳过**而非报错；`{required:[...], properties:{...}}`（无 `type:"object"`）是合法常见写法。子代理 `submit_result` 提交字符串 → `ok:true` → 以字符串完成 → 门控 dependent 字段解析 undefined → `condition_false` 静默跳子树。与 DAG-01 同后果但 checkpoint **已声明** output_schema，authoring 检查满足，缺陷藏在 schema 写法内。`{type:"object", additionalProperties:false}`（无 properties）同样不设防；未知类型名（拼错 `strng`）permissive 通过（`capture.ts:207-208`）。

**建议修法**：schema 含 required/properties/additionalProperties 任一 object 语义关键字时，值非 object 即 fail；未知类型名报错。

## BLK-01（Medium）聚合器「mechanical」表述失实 + 未申报写入零检测

**位置**：`packages/opencode/src/dag/blocks.ts:407-412`（注释 + AGGREGATOR_CONTRACT）、ADR-0002

**证据**：注释宣称 "mechanically detects declared write-set overlap"——引擎从不计算交集/并集；检测由 explore 型 LLM worker 依契约执行，fingerprint 亦是 worker 对**已申报列表**自算 sha256。盲区：(1) **丢失写入**——writer 写了文件但未申报（或写完后节点失败，nodeFailed 路径不回滚工作区编辑），这些文件不在 union、不进 fingerprint，verify/review 绑定的「合并后状态」系统性遗漏；aggregator 有 shell 权限、本可机械 `git status` 对账而契约未要求；(2) 交叠漏检时无引擎侧二次校验。LLM-worker 聚合本身是 ADR-0002 成文取舍（可接受）；缺陷是保证表述失实 + 未申报写入无任何检测层。

**建议修法**：最小修 = 改注释/ADR 措辞为行为约定；进阶修 = aggregator 契约加 `git status` 机械对账（申报集 vs 实际变更集，差集即 fail）。

## INV-A（Medium）「一个用户目标至多一个 live DAG」是文档 Invariant，实现是 convention

**证据**：`dag.create`（`dag.ts:340-434`）不检查 session 是否已有 live workflow；workflow 工具 start（`tool/workflow.ts:607-675`）同样不查；automation lease 天然容忍多 DAG 并存（逐 workflow register，`owner()` 返回「任意 dag」）；跨进程无约束；崩溃恢复无差别收养。唯一「强制」在模型指引（workflow-routing.md / orchestration-policy.md）。违规后果有界（wake 模型容忍、goal 被「任一 dag」阻塞），但两个 live DAG 共享同一工作区时，ADR-0002 交给 plan discipline 的三不相交纪律跨工作流完全失配。

**处置选项**：(a) 引擎强制（create/工具 start 拒绝同 session 第二个 live workflow，或警告）；(b) CONTEXT.md 降格为 convention 并写明后果。二选一，消除分歧。

---

## 低危批次（LOW）

| ID | 位置 | 机制 |
|---|---|---|
| NEW-1（降级自 Medium） | `loop.ts:323-325` | spawn 失败边界 catchCause 无 hasInterrupts 再抛。外部中断经 Effect 语义绕过 catchCause，teardown 场景不触发；残留为风格一致性 + 对自抛 interrupt cause 模式的防御（对照同文件 730-737/1055-1062/1483-1490 惯例） |
| NEW-2 | `loop.ts:431-451` | recovery-pause 被**非终态原因**（30s 锁超时/store defect）拒绝后收养被放弃：NodeFailed 已持久化但无 runtime entry → 事件被 `runtimes.has` 过滤（802）、wake 边界要求 entry（1244）→ 静默搁死至重启（仅一条 WARN）。对照 verdict 门同型场景有两次重试 + fail-closed |
| REC-1 | `recovery.ts:69-74` | pending 节点 `cancelSession` 裸 yield，持续失败中止整个 reconcile → 该工作流本进程内永不被收养；同文件 else 分支（116-127）已有 catchCause 加固，属遗漏 |
| BLK-02 | `blocks.ts:265-270` | 聚合器 input_mapping 键碰撞：`foo-bar` 与 `foo_bar` 两个 writer 的 `-→_` 规范化映射到同一键，`Object.fromEntries` 后者静默覆盖前者——丢一个 writer 的 changed_files/summary（叠加 BLK-01 逃逸检测） |
| BLK-03 | `blocks.ts:277-278, 299-304` | 被改接到 ≥2 个聚合器的共享 verify 节点只映射**第一个**聚合器的 changed_files/fingerprint——双路由形状下第二条路由写集逃逸指纹绑定；无诊断 |
| CAP-02 | `capture.ts:77-93, 220-225`、`output-ref.ts:91-96` | 结构化输出关键路径无界计算成本：病态回溯 pattern `new RegExp` 应用于不限长输出可挂起校验；`uniqueItems` O(n²)；`captureOutputFileRef` 整读任意大小文件无上限。`draft` 动作让模型近乎零成本成为 pattern 作者 |
| SW-L1 | `supervision-sweep.ts` + `event-v2-bridge.ts:39-44` | sweep 上下文无 InstanceRef → 其 NodeFailed 事件 location 为空 → 活实例的 summary-publisher 按 directory 过滤跳过 → TUI 收不到该 settle 的 summary 推送（bootstrap 重取可见；durable 折叠不受影响） |
| SW-L2 | `prompt.ts:191` + sweep cancel 路径 | sweep 的 `promptSvc.cancel` 在无 ambient 实例时恒 die（代码已自认、cause 级恢复 + 专项测试）：意味着 sweep 永远无法自己取消仍存活的子会话，误杀路径（SW-1）的真实取消依赖活 DagLoop 的 abortChild 兜底 |
| F3 | `packages/tui/src/context/sync.tsx:286-292, 626-632` | goal.updated/cleared 是 ephemeral 事件（不进 durable 重放），`reconnected` 钩子只刷新 DAG 不刷新 goal → 断线期间错过的 `goal.cleared` 让侧栏**永久**显示过期目标（与 DAG 的 `refreshDagSummaries` 不对称） |
| F6 | `dag-inspector.tsx:726-734` + `config/keybind.ts` | 插件级第二条 palette 命令 `dag.cancel.active` 不在 keybind Definitions/CommandMap——不可重绑、不进 keybind 配置 schema（违反 AGENTS.md「plugin 级只注册 *.open」指引） |
| F4（记录） | `handlers/global.ts:16-23, 150` | `/global/event` 是 handleRaw + 裸 JSON.stringify，GlobalEventSchema 仅文档；summary payload 缺 schema 必需的 `id` 字段——未来切 schema 编码会整体丢事件（当前无害） |
| F5（记录） | `dag-event.ts:344-365` vs `event-manifest.ts` | 20 个 durable `dag.*` 事件被 bridge 广播上 GlobalBus 但不在 Definitions/SDK 事件联合——wire 上存在、类型面不可见的漂移（TUI 按设计只消费 summary，不受影响） |

---

## 四条不变量判定（首批遗留）

| 不变量 | 判定 | 证据 |
|---|---|---|
| A. 一个用户目标至多一个 live DAG | **不成立（结构性）**——INV-A，见上 | 无引擎强制，仅模型指引 |
| B. portable 不加载环境目录 / environment 验证模型可用性 | **成立** | `authoring.ts:121-124`（catalogs 仅 environment+loadEnvironment）；portable 的 prompt_template.id 不便携错误；environment 逐节点解析 dag-prompts/worker_types/`resolveModel` 对照真实 provider（`tool/workflow.ts:207-239`）；portable 按内容缓存、environment 永不缓存 |
| C. model-facing schema 隐藏身份字段 | **成立** | 工具 Parameters 无身份字段 + `onExcessProperty:"error"`（`tool/workflow.ts:265-279`）；子会话调用 die；`requireOwnedWorkflow` 拦跨会话；NodeSchema 无 `model`；admission 审计字段边界剥离（`authoring.ts:281-314`） |
| D. Runtime Admission 与 Authoring Check 职责分离 | **对工具/CLI 面成立；被 DAG-05 侵蚀一个入口** | 分离本身干净；replan 后新图有运行时合并图复查（`validation.ts:862-865`，terminal 豁免 + schema 义务豁免为有界成文取舍）；唯 httpapi start 两层同时缺席 |

## 验证为正确（本轮特意检查）

- **首批全部修复在位且完整**（见「首批修复复核结论」）；悬空依赖角落已覆盖（fragment 依赖已取消节点被 `planReplan` 拒绝，`core/dag/core/replan.ts:159`）。
- **loop.ts 排除的疑点**：`spawnReady` 未过滤 `getNodes`（upsert 同 id 不双行 + 陈旧图竞态被投影守卫响亮拒绝）；upsert 不重置状态（terminal 进 ignore 桶不重注册）；evalLock 内等信号量（permit 在 fork fiber 内获取，7 处调用点均在 evalLock 内）；双重 `automation.claim`（持锁只读快照不消耗注册）；cascade 定点循环（排除已 skipped 集合，单调收敛）；孤儿 pending 收养（三重守卫：recovering 预留/状态守卫/跨实例 ownsWorkflow）。
- **effect-smol 五项语义钉死**（`Effect-TS/effect-smol@3a1128c`）：scope finalizer 严格 LIFO、先置 Closed 再跑 finalizer；forkIn 已关闭 scope → 子 fiber 未启动即死（非 defect）；catchCause 与 interrupt（外部绕过/自抛可捕获，`Effect.test.ts:1303-1321/1873-1877`）；timeoutOption 超时返回 None 且**等落败方死透**（软上限，硬切断需 disconnect）；`Effect.cached`（TTL=∞）**缓存任何 exit 包括失败与中断**。
- **三处业务用法与语义一致**：DAG-04 修复成立（且修的正是可捕获路径）；`global-lifecycle` 注释与 v4 语义逐字对应；memory in-flight Deferred 是对 `Effect.cached` 失败缓存缺陷的刻意规避（只缓存成功、失败不毒化后续查询）。
- **SDK 事件面无断链**：TUI 消费的 19 个事件类型全部在 `EventManifest.Definitions` + 生成 SDK；TUI 无手写复制类型（全部 re-export SDK）；异步获取均有 stale guard + onCleanup。
- **capture/admission/workflows/output-ref/错误映射**各正确面见 DAG 批审计「验证为正确」节（capture 槽生命周期对称、review 指纹恢复侧保守 fail、workflows 遮蔽优先级一致、httpapi 错误映射 409/404/500 分类正确）。
- **组合根全量矩阵**：`run`/`export`/`import`/`github`/`pr`/`stats`/`debug`/`models`/`mcp`/`agent`/`session`/`plugin` 等 effectCmd 默认 instance:true 入口 Memory/Dag/Goal/GoalLoop/Sweep 齐备；`attach`/`account`/`providers`/`db` 纯客户端无消费。

## 局限

1. 测试未运行；F1/F2 是静态装配推导（推导链每跳有 file:line 依据，但未跑进程实证），建议以 wiring 探针测试补存在性断言后定案。
2. SW-1 的量化（30→10min、~11 分钟误杀）是窗口数学推演，未写复现用例。
3. graph 索引 generation `2026-08-19T01:37:28Z`（full，metadata_match），仅用于导航；coverage 为 best-effort 信号。
4. 「不存在持续发布组件」基于 `events.publish(DagEvent.` 模式 grep + 导入结构推断，应读作「未找到」而非「证明不存在」。
5. 首批审计未覆盖的 `templates/*`、`config.ts`、`model.ts`、`review-lifecycle.ts`、httpapi 中间件实现等仍未审计（DAG 批只审了指定文件）。
6. TUI worker 内 node 图与 AppLayer 双 InstanceStore 的双缓存/去重范围未深挖（多目录 + 重载场景值得单独立项）；`BootstrapRuntime` 疑似死代码未判定。

## 处置顺序

Issue 映射：#340=F1、#341=F2、#342=SW-1、#343=SW-2、#344=DAG-05、#345=DAG-06、#346=DAG-07、#347=BLK-01、#348=INV-A、#349=LOW 批、#350=/memory-on UX；#316 已补根因证明评论（见上）。

| 优先级 | 动作 |
|---|---|
| P0 | F1 + F2 一并修（GoalLoop.node 入 server app 组 + sweep 可达性；共用 wiring 探针回归） |
| P1 | SW-1（窗口取 max/从 durable 行反推）；SW-2（sweep 后工作流终局 + wake + lease 清理）；DAG-05（start 过 authoring）；DAG-06（恢复回读子会话）；DAG-07（object 语义关键字收紧） |
| P2 | BLK-01（措辞 + 可选 git status 对账）；INV-A 决策（强制或降格）；NEW-2；REC-1 |
| P3 | LOW 批其余（BLK-02/03、CAP-02、SW-L1/L2、F3、F6、NEW-1 防御性修补）；F4/F5 记录性观察转维护决策 |
