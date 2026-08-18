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
- 未开始
