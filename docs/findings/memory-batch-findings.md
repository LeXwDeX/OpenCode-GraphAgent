# MEMORY 批次（验收遗留）Findings Register

- 验收 primary source：`docs/audit-dag-memory-goal-2026-08-18.md`（MEMORY 章节）+ 产品→代码验收（f1c2c8c33→11cfafe9c）Spec 轴三项遗留
- 分支：`fix/memory-fence-scope` → PR `dev`
- 收敛判据：连续两轮独立审阅（Spec 镜 + Standards 镜）零 findings + 模块门禁全绿
- 规格：`workflows/audit-fix-loop.md`

## 处置项

| ID | 来源 | 处置 | 状态 | 提交 |
|---|---|---|---|---|
| MEM-01 后半（P1） | 审计 + 验收 (a)2 | prepareUnsafe `shouldMatch` 分支的 select matcher 移出 fence/lock：matcher 无锁跑，markMatched 经 `applyUpdate`（fence+lock 只包提交） | 完成（红-绿-变异通过） | 待提交 |
| MEM-02（P2） | 审计 + 验收 (a)1 | `search` 的 identity fence 缩到 markMatched 提交；同查询合并从「持锁阻塞后来者」改为 per-key in-flight coalescing（进程内 Deferred），语义等价（后来者 reused:true、不耗 slot）且不再跨模型调用持 fence/lock | 完成（红-绿-变异通过；旧 coalescing 回归保持绿） | 待提交 |
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
- 未开始
