# MEMORY 批次（验收遗留）Findings Register

- 验收 primary source：`docs/audit-dag-memory-goal-2026-08-18.md`（MEMORY 章节）+ 产品→代码验收（f1c2c8c33→11cfafe9c）Spec 轴三项遗留
- 分支：`fix/memory-fence-scope` → PR `dev`
- 收敛判据：连续两轮独立审阅（Spec 镜 + Standards 镜）零 findings + 模块门禁全绿
- 规格：`workflows/audit-fix-loop.md`

## 处置项

| ID | 来源 | 处置 | 状态 | 提交 |
|---|---|---|---|---|
| MEM-01 后半（P1） | 审计 + 验收 (a)2 | prepareUnsafe `shouldMatch` 分支的 select matcher 移出 fence/lock：matcher 无锁跑，markMatched 经 `applyUpdate`（fence+lock 只包提交） | 完成（红-绿-变异通过） | 70291fbe4 |
| MEM-02（P2） | 审计 + 验收 (a)1 | `search` 的 identity fence 缩到 markMatched 提交；同查询合并从「持锁阻塞后来者」改为 turn 内 per-(session,turn,key) in-flight coalescing（进程内 Deferred），语义等价（后来者 reused:true、不耗 slot；失败/中断/retired 时唤醒降级而非挂起）且不再跨模型调用持 fence/lock | 完成（红-绿-变异通过；旧 coalescing 回归保持绿） | 70291fbe4 + f08548d6d + ef8d6b8d1 |
| MEM-03（P3） | 验收 (a)3 | 处置记录：已被 PR #333 的 MEM-01 重构结构性抵消——维护恒为后台（kickMaintenance），失败折入其 catchCause，维护前渲染是已声明设计（CONTEXT.md「render the pre-maintenance snapshot」）。旧的「维护前快照渲染注入」窗口随 inline maintain 一起消失。本行即处置记录。 | 已记录 | — |

## 设计要点

- `applyUpdate` 泛型化：`Update<A>` 透传结果，select 的 markMatched 提交经它返回 matched topics（供 render）。
- `select` 拆两半：`match()`（无 fence/lock）+ markMatched 提交（`applyUpdate`）。
- `search`：短临界区（进程内 lock）只做缓存 re-read/limit/queryCount++ 与 in-flight 登记；matcher 在任何 fence/lock 之外；同 key 后来者 await in-flight Deferred（进程内合并，语义与旧「锁内阻塞」等价）；提交走 `applyUpdate`。
- `prepareUnsafe` shouldMatch 分支：matcher 出 fence/lock；identity retired（applyUpdate 返回 None）时仍 clearSession（fail-closed 不变）。
- CONTEXT.md 最后一条 invariant 改写：fence 只包提交；同查询合并显式声明为进程内 in-flight coalescing。
- 锁序不变量：全程不出现 lock 内嵌 fence（KeyedMutex 不可重入 + 与 checkpoint 的 fence>lock 序相反会死锁）。

## 模块门禁
- 未开始

## 审阅轮次

### Round 1
- Spec 镜：**BLOCKING**（R-1 P1 + R-2/R-3 INFO）；Standards 镜：**BLOCKING**（F1 P1 与 R-1 同源 + F2-F5 INFO）。处置：
  - R-1/F1（P1）：in-flight 泄漏——失败/中断/retired 路径 deferred 永不完成 → coalesced awaiter 永久挂起、(session,key) 进程级 wedge。→ **已修**：runner 分支 `Effect.onExit`（对齐 kickMaintenance 槽位纪律）——每个退出路径先 `releaseIfOwner` 再把真实 Exit 打包进 deferred（deferred 永不失败，Exit 载荷即全部消息）；awaiter 按 Exit 分支：失败→`failed`、interrupt→failCause 传播、retired→`unavailable`。新增红绿测试「a failed first query never wedges the session key or its coalesced awaiter」（有界等待断言无挂起、无 wedge）+ 变异验证（去掉 onExit → 新测试与旧 coalescing 测试双红）。
  - R-2（INFO）：dereg→缓存写入窗口内第三个同查询会多耗一次调用。→ 已修：缓存写入提前到 `Effect.tap`（releaseIfOwner 之前），窗口闭合。
  - R-3（INFO）：等价声明只覆盖 happy path。→ CONTEXT.md 措辞已含失败路径降级语义。
  - F2（INFO）：CONTEXT.md「outside every fence/lock」对短注册临界区不真。→ 已改为「outside every fence + SHORT project-lock critical section (registration)」。
  - F3/F4/F5（INFO）：裸块、`!` 断言、命名不一致。→ 已修（裸块展开、get-then-check、统一 `selected`）。
- 结论：修复后进入 Round 2。

### Round 2
- Spec 镜：**BLOCKING**（Issue 1 P1 + Issue 2 INFO）；Standards 镜：**BLOCKING**（Issue 1 P1 同源 + 2/3/4 INFO）。处置：
  - Issue 1（P1）：onExit 括号只覆盖 select 管道——注册后的 `store.readTopics` 挂起（生产为 flock 磁盘 IO）期间被中断/失败会在括号附着前 unwind → 泄漏条目 + wedge。→ **已修**：整个尾部（readTopics + select 管道）包进同一 `Effect.gen(...).pipe(tap, onExit, exit)` 括号；mock 的 `readTopics` 加 `parkReads` 挂起钩子；新增红绿测试「an interrupted topics read releases the in-flight entry and never wedges the key」+ 变异验证（readTopics 挪出括号 → 翻红）。
  - Spec Issue 2（INFO）：in-flight key 无 turn 分量 → 新轮次的同文查询可能骑上一轮的 deferred，attached 但自身缓存不填充。→ **已修**：key 加入 turn origin（messageID）——合并严格 turn 内，跨轮重跑。
  - Standards 2（INFO）：awaiter 注释的 interrupt 机制描述不准（failCause 重抛在 awaiter，failed 映射在 search wrapper）。→ 已改写。
  - Standards 3（INFO）：测试注释宣称 interrupted 覆盖但原先无此测试。→ R2 新增的中断测试已补齐该覆盖。
  - Standards 4（INFO）：`undefined as void` 多余 cast。→ 已删。
- 结论：修复后进入 Round 3。

### Round 3
- Spec 镜：**PASS**，1 条 INFO；Standards 镜：**PASS**，2 条 INFO。处置：
  - R3-1（INFO）：CONTEXT.md 与 searchUnsafe 注释仍写 per-(session,key)，key 已 turn-scoped。→ 两处已改为 per-(session,turn,key)。
  - R3-2（INFO）：awaiter 注释「shares the cancellation」不符合 v4 语义（failCause 重抛由 wrapper catchCause 吸收，awaiter 仍以 failed 完成）。→ 已改写为准确机制。
  - register「待提交」歧义。→ 已改为实际提交哈希。
- 结论：非干净轮（INFO）。修复后进入 Round 4。

### Round 4
- Spec 镜：**PASS，no findings**（干净轮候选）。
- Standards 镜：**PASS**，2 条 INFO：R4-1 awaiter 注释把非中断失败的映射错归 wrapper catchCause（实际直接返回 failed）；R4-2 测试注释「flock'd disk I/O」不准（readTopics 无 flock，是 async fs）。→ 均已改写。
- 结论：非干净轮。修复后进入 Round 5。

### Round 5
- Spec 镜：**PASS，no findings**；Standards 镜：**PASS，no findings**（R4 两处措辞独立复核为准确）。
- 结论：**干净轮 2/2**。连续两轮零 findings → **MEMORY 验收遗留批次收敛**。

## 收敛结论

R1（双镜 BLOCKING：in-flight 泄漏 P1）→ R2（双镜 BLOCKING：括号窗口 P1 + turn 作用域）→ R3（双 PASS，3 INFO 措辞）→ R4（Spec 干净 + Standards 2 INFO 措辞）→ **R4+R5 连续两轮零 findings**。findings 轨迹：两轮 P1 并发缺陷（实装修复+回归测试）→ 纯措辞 → 零。

## 模块门禁（终态）

- memory 测试簇 95/95 绿（新增 5 条回归：fence-free ×2、failed-wedge、interrupted-read-wedge、原 coalescing 保持）
- `bun typecheck` + pre-push turbo 29/29 绿
- 全量套件 4164 tests：仅 2 失败为历次批次已在干净基线证实的 darwin 环境既有失败（help-snapshots、project-copy），与本批无因果
- 变异验证：fence 回置翻红 ×2（search/prepare）、onExit 移除翻红 ×2（wedge + coalescing）、readTopics 出括号翻红 ×1

## 交付

- 分支：`fix/memory-fence-scope`（基于 origin/dev 11cfafe9c）
- 提交链：70291fbe4（MEM-01/02 主体）→ f08548d6d（R1 exit-safe）→ ef8d6b8d1（R2 整尾括号 + turn key）→ 9094abcaa/04385af79/0c1919465（记账与措辞）
- PR → dev（Typecheck 门禁）
