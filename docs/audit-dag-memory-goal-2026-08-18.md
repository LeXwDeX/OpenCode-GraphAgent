# 功能审计：DAG / MEMORY / GOAL 三模块缺陷与证据

审计日期：2026-08-18
审计对象：`origin/dev` = `f1c2c8c33`（内容等同 `origin/main` = `25a711b40`，即 PR #332 发布批次之后的当前状态）
审计范围：**功能性运行时缺陷**。配置类问题（YAML 模板内容、config knob 命名/默认值、prompt 文案、文档措辞、`LeXwDeX/opencode-dag-config` 仓库内容）不在本次范围内。

## 方法与证据纪律

1. 本地 `dev` 落后 `origin/dev` 25 个提交（缺 PR #313–#332）。审计在 `origin/dev` 的 detached worktree 上进行，避免对着过期代码下结论。
2. 该 worktree 以 `mode=fast` 重新索引为 codebase-memory 项目 `audit-dmg-20260818`（29826 nodes / 132182 edges，0 skipped）。
3. 三个模块由三个独立 auditor 子代理并行做首轮结构化排查（图工具 + coverage 校验）。
4. **本文档中每一条 `file:line` 引用与代码引文，均由主会话在上述 worktree 中直接读取源码复核过。** 子代理提出但复核不成立、或严重性被证据推翻的候选项已剔除或降级（见「复核中被推翻/降级的候选项」）。
5. 测试覆盖结论来自直接读取 `packages/opencode/test/**`（`fast` 索引不含 `*.test.ts`，因此这部分不依赖图索引）。

## 缺陷汇总

| ID | 严重性 | 置信度 | 模块 | 一句话描述 | 与 tracker 关系 |
|---|---|---|---|---|---|
| DAG-01 | High | Confirmed | DAG | 无 `output_schema` 的 reporting checkpoint 上的等值门恒为 false，整棵下游子树被静默跳过且工作流报 COMPLETED | PR #331 的不完整修复 |
| DAG-02 | High | Confirmed | DAG | `replan` / `extend` 完全不跑 `checkpointGateDiagnostics`，checkpoint 门禁在每次图变更路径上失效 | #325 的不完整修复 |
| DAG-03 | Medium | Confirmed | DAG | replan 裁决门在持久化 pause 终态失败时 **fail-open**，显式把内存调度器置为未暂停 | PR #331/#327 的不完整修复 |
| DAG-04 | Medium | Confirmed（机制）| DAG | summary publisher 把 interrupt 当成功日志吞掉；生产关停路径 uninterruptible 且无超时 | Known-#316（机制补齐，触发源仍未钉死）|
| MEM-01 | High | Confirmed | MEMORY | 周期 `prepare` 在 fence+lock 下内联跑 **3 次**模型调用（比 #324 描述的更广，含首轮 match） | Known-#324 debt 2，未偿付 |
| MEM-02 | Medium | Confirmed | MEMORY | `search` 跨 matcher 模型调用持有跨进程 identity flock | Known-#324 debt 2 后半 |
| MEM-03 | Low | Confirmed | MEMORY | 周期维护失败后用**维护前**快照渲染注入，仅 logWarning | New |
| GOAL-01 | High | Confirmed | GOAL | 崩溃丢失的 continuation 使目标被持久边界门永久搁死；**测试把错误行为钉住了** | PR #289 的过度修正 |
| GOAL-02 | Medium | Confirmed | GOAL | ESC pause 重试耗尽后仍保留 lease 注册与 active 行，却无条件清掉 `turnDriven` | PR #284 的不完整修复 |
| GOAL-03 | Low | Confirmed | GOAL | judge 传输/解析失败仍消耗 `turns_used` 并盖上 `last_judged_msg` | New |
| GOAL-04 | Low | Confirmed | GOAL | 启动扫描对非 idle 会话静默跳过，无日志、无重新武装 | New |

---

## DAG

### DAG-01（High）等值条件门在字符串输出上恒为 false，静默跳过整棵子树并把工作流标为 COMPLETED

**位置**：`packages/opencode/src/dag/runtime/eval.ts:133-147`、`packages/opencode/src/dag/runtime/loop.ts:141-156`、对照点 `packages/opencode/src/dag/runtime/loop.ts:664-672`

**证据 1 — 路径解析在字符串上返回 `undefined`，不报错**（`eval.ts:133-147`）：

```ts
function resolvePath(path: string, source: Record<string, unknown>): unknown {
  const parts = path.split(".")
  let current: unknown = source
  if (parts[0] && parts[0] in source) {
    current = source[parts[0]]
    parts.shift()
  }
  for (const part of parts) {
    if (current == null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
```

**证据 2 — 数值比较会 loudly fail，等值比较不会**（`eval.ts:56-70`）：

```ts
  if (op === ">" || op === "<" || op === ">=" || op === "<=") {
    if (typeof lhs !== "number" || !Number.isFinite(lhs))
      return { ok: false, error: `condition "${condition}": left operand resolved to ${describeOperand(lhs)}, expected a finite number` }
    ...
  }
  if (op === "==") return { ok: true, value: lhs === rhs }
```

`undefined === "ACCEPT"` → `false`，`{ ok: true, value: false }`，调度层走 skip 分支（`loop.ts:152-155`）：

```ts
              if (!condResult.value) {
                yield* dag.nodeSkipped(dagID, nodeID, "condition_false").pipe(Effect.ignore)
                continue
              }
```

**证据 3 — 同一文件 500 行后的姊妹门做了字符串解析，本处没有**（`loop.ts:664-672`，PR #331 只补了这一处）：

```ts
                      // A checkpoint output can arrive as a raw string (no
                      // output_schema, or a string-typed child reply); parse it
                      // before matching the verdict so a string-typed
                      // {"verdict":"replan"} cannot bypass the gate (the spin
                      // behind issue #322).
                      const gateOutput = typeof node?.output === "string"
                        ? Option.getOrUndefined(parseJsonOption(node.output))
                        : node?.output
```

**证据 4 — 无 `output_schema` 的节点确实以裸字符串完成**（`spawn.ts:482-516`）：`if (input.outputSchema)` 分支走 `settleCapturedOutput`；`else` 分支 `const rawText = result.parts.findLast(...)`，最终 `dag.nodeCompleted(input.dagID, input.nodeID, rawText)`。

**证据 5 — authoring 主动把作者引导到这个形状**（`validation.ts:600-604`）：

```ts
          hint:
            `Gate "${dependent.id}" with condition: "${checkpoint.id}.output.<field> == ..." (e.g. on its verdict),`
```

`checkpointGateDiagnostics`（`validation.ts:584-609`）只检查 `conditionReference(dependent.condition) === checkpoint.id`，**从不要求该 checkpoint 声明 `output_schema`**；`conditionReferenceErrors`（`validation.ts:459-467`）同样只检查引用 id 在 `depends_on` 里。

**可达性**：Block 编译路径上 `verify` → `VERIFICATION_SCHEMA`、`review` 决策节点 → `GENERAL_VERDICT_SCHEMA`/`DIFF_REVIEW_SCHEMA`、`coding`/`prototype` → `IMPLEMENTATION_SCHEMA`（`blocks.ts:251,271,305-309`），**这些默认路径是安全的**。暴露面是：
- `synthesize` block：`reportToParent: block.report_to_parent ?? block.kind === "synthesize"`（默认 **true**）而 `outputSchema` 落到 `undefined`（`blocks.ts:300-309`）——一旦它有 dependents，就同时是「reporting checkpoint」且「无 schema」；
- 任何被作者显式设成 `report_to_parent: true` 的 `explore`/`plan`/`debug`/`synthesize` block（ultra-flow 的 gate checkpoint 正是这种形状，见 #323 里的 `cp-after-exploration`）；
- 全部 low-level `nodes:` 手写 checkpoint。

**为何是缺陷**：违反 `dag/CONTEXT.md` 不变量「Dependents of a reporting checkpoint must be gated on its output」。门存在但结构上惰性——它不是「按裁决放行」，而是**无条件否决**。与 PR #331 建立的一致性也自相矛盾：字符串归一化只补在裁决匹配上，没补在门禁真正依赖的 `evaluateCondition` 上。

**运行时影响**：checkpoint 通过 → 所有被门控的 dependent 以 `condition_false` 被跳过 → `spawnReady` 的 cascade 定点循环逐波发布 `NodeSkipped(orphan_cascade)`（`loop.ts:119-126`）→ `checkCompletion` 认为 `isComplete()` → `dag.complete(dagID, { skipReviewGate: true })`（`loop.ts:338`，**显式绕过 review gate**）。操作者看到的是一个状态为 **COMPLETED** 的工作流，而 checkpoint 之后的整个半图从未运行。无错误、无失败、无告警。

**测试覆盖**：未覆盖。`test/dag/dag-checkpoint-gate.test.ts` 全部是 authoring 层断言（`action: "start"`），没有任何用例在运行时把一个无 schema 的 checkpoint 输出喂给 `evaluateCondition`。

**建议修法**：`loop.ts:141-152` 在构造 `outputs` 时对字符串输出做与 `loop.ts:667` 相同的 `parseJsonOption` 归一化；并在 `checkpointGateDiagnostics` 中要求被门控引用的 checkpoint 声明 `output_schema`（否则该门在运行时不可满足），把它变成 authoring 期错误。

---

### DAG-02（High）`replan` / `extend` 跳过 `checkpointGateDiagnostics`，门禁在每次运行时图变更路径上失效

**位置**：`packages/opencode/src/dag/authoring.ts:136`、`packages/opencode/src/dag/validation.ts:974-984`

**证据 1 — 非 `start` 动作整体关闭结构检查**（`authoring.ts:136`）：

```ts
        structural: input.action === "start",
```

动作集合恰为 `start | extend | replan`（`authoring.ts:197-215` `decodeAction`）。

**证据 2 — `structural === false` 把 checkpoint 门与其余结构检查一起跳过**（`validation.ts:974-984`）：

```ts
    const diagnostics =
      input.structural === false
        ? []
        : [
            ...structuralDiagnostics({ ... }),
            ...checkpointGateDiagnostics(input.nodes, input.config.node_defaults),
          ]
```

**证据 3 — 全仓唯一调用点**：

```
packages/opencode/src/dag/validation.ts:584:export function checkpointGateDiagnostics(
packages/opencode/src/dag/validation.ts:983:            ...checkpointGateDiagnostics(input.nodes, input.config.node_defaults),
```

（其余命中只有 ADR 文档 `docs/adr/0003-reporting-checkpoint-gating.md:30`，其自述「Enforcement lives in `checkpointGateDiagnostics`, wired only into …」。）

**为何是缺陷**：`dag.ts:570-576` 的注释声称 replan 走的是「the create/replan parity the spec requires: one authority, two entry points」，但这份 parity 恰好在 checkpoint 门上不成立。ADR-0003 把 enforcement point 限定在 authoring 边界，而 authoring 边界又对 replan/extend 自我关闭——两者叠加后，**没有任何权威**在图变更路径上施加这条不变量。而 replan 正是编排器在每个纠偏周期都要走的路径，包括 replan 裁决门自己指示 parent 去做的那次。

**运行时影响**：一次 replan 可以把 dependent 直接挂到 reporting checkpoint 上且不带 `condition`。引擎会在 checkpoint 完成的瞬间 spawn 该 dependent——早于 parent 读到裁决。运行时兜底网（`loop.ts:670-703`）只认字面 `verdict: "replan"`；返回 `reject` / `fail` / `needs_changes` 的 checkpoint 会让未门控的 dependent 在已被否决的方向上继续跑，无门、无暂停、无诊断。

**测试覆盖**：未覆盖。`dag-checkpoint-gate.test.ts` 的 7 个用例全部使用 `action: "start"`。

---

### DAG-03（Medium）replan 裁决门在 pause 终态失败时 fail-open

**位置**：`packages/opencode/src/dag/runtime/loop.ts:681-703`

**证据**：

```ts
                        const paused = yield* Effect.gen(function* () {
                          const attemptPause = dag.pause(dagID).pipe(
                            Effect.map(() => true),
                            Effect.catch(() => Effect.succeed(false)),
                          )
                          if (yield* attemptPause) return true
                          if (yield* attemptPause) return true
                          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                          if (wf?.status !== "paused")
                            yield* Effect.logWarning("DagLoop pause on replan verdict failed", { dagID, nodeID })
                          return wf?.status === "paused"
                        })
                        entry.runtime.setPaused(paused)
```

两次尝试都失败且持久行不是 `paused` 时，`paused === false`，第 697 行**显式把内存 runtime 置为未暂停**，唯一后果是一条 WARN。调度抑制只作用于本次事件（`loop.ts:703`）：

```ts
                      if (!gateReplan && !entry.runtime.isStepMode()) yield* spawnReady(dagID)
```

**可达性**：`spawnReady` 会被后续任意刺激再次触发——`NodeCancelled`（`loop.ts:739` 附近）、`WorkflowStepped`（`loop.ts:787` 附近）、`WorkflowResumed`、`WorkflowReplanned`（`loop.ts:882` 附近）、`recoverWorkflow`（`loop.ts:465` 附近）；`getReadyNodes()` 只在 `this.paused` 时返回空，而该标志刚被置 false。

**为何是缺陷**：裁决门必须 fail-**closed**。PR #331 加固了瞬态情形（重试两次后查持久状态），但终态情形反向失败：正确动作是无论持久 pause 是否被拒都 `setPaused(true)`，代码做的恰好相反。另注：`Effect.catch` 只处理 error channel——`dag.pause` 抛出的 **defect** 会逃到 `guarded("NodeCompleted")`（`loop.ts:356-357`），整个 handler 被丢弃，pause 从未发生且连门专属的 WARN 都不会打。

**运行时影响**：checkpoint 返回 `verdict: "replan"`（显式否决）、持久 pause 被拒（例如工作流处于 `stepping`，或与并发控制操作竞争），工作流继续在被自己 checkpoint 否决的方向上调度。

**测试覆盖**：未覆盖（无用例注入持久性 pause 失败）。

---

### DAG-04（Medium，Known-#316）summary publisher 把 interrupt 当成功吞掉；生产关停 uninterruptible 且无超时

**位置**：`packages/opencode/src/dag/runtime/summary-publisher.ts:151-170`、`packages/opencode/src/server/global-lifecycle.ts:16-25`

**证据 1 — listener 边界把 interrupt cause 转成成功的日志行**（`summary-publisher.ts:163-170`）：

```ts
          return schedulePublishByDag(dagID, evt.location.workspaceID).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagSummaryPublisher: failed to publish summaries", { dagID, cause }),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)
```

`coalesceLatest` 内层刻意**重新抛出** interrupt（`summary-publisher.ts:111-113`）：

```ts
                if (Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)) {
                  return yield* Effect.failCause(outcome.cause)
                }
```

——但外层这个 `catchCause` 没有 `Cause.hasInterrupts` 再抛，作者在内层建立的取消语义在外层被抹掉。仓库内正确写法出现过三次（`spawn.ts:255-257`、`spawn.ts:545`、`loop.ts:1409-1411` 附近），此处是唯一例外。

**证据 2 — 生产关停路径无超时且不可中断**（`global-lifecycle.ts:17-25`）：

```ts
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : store.disposeAll()
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
```

exerciser 用 `bounded("disposeApps", ...)` 兜住，生产路径没有等价保护。这直接回答 #316 的验收项 3：**真实 server 关停走的是同一 dispose，且比测试路径更脆弱**。

**未钉死的部分（对 #316 的诚实缺口）**：本次没有定位 dispose 期间持续发 `dag.*` 事件的组件。已排除的候选：`spawnNode` teardown 在 interrupt 时不发节点事件（`spawn.ts:545` 提前返回）；publisher 自身发出的 `dag.workflow.summary.updated` 不在 `SUMMARY_TRIGGER_EVENTS` 里，无法自触发。放大机制已证明，触发源未证明。

**测试覆盖**：`dag-summary-publisher.test.ts` / `dag-summary-publisher-behavior.test.ts` 存在，但均未覆盖 dispose 期间的 interrupt 语义。

---

## MEMORY

### MEM-01（High，Known-#324 debt 2）周期 `prepare` 在 fence+lock 下内联跑 3 次模型调用

**位置**：`packages/opencode/src/memory/memory.ts:474-505`；对照的成文规则在 `packages/opencode/src/memory/memory.ts:283-285`

**证据 1 — 模块自己写下的锁纪律**（`memory.ts:283-285`）：

```ts
    // Serialize the identity-liveness recheck and the per-project lock around
    // the store write only; the model calls that produce the update run
    // outside the fence/lock so a long reasoning call cannot wedge or leak it.
```

**证据 2 — `prepareUnsafe` 违反它**（`memory.ts:474-505`）：

```ts
      const live = yield* fence.withLiveIdentity(
        current.project.id,
        Effect.gen(function* () {
          yield* lock.withProject(current.project.id)(
            Effect.gen(function* () {
              const topics = yield* store.readTopics(current.project.id)
              const maintained = due
                ? yield* maintain({ ... })
                : topics
              const rendered = shouldMatch
                ? (yield* select({ ... })).rendered
                : (data.sessions.get(input.sessionID)?.turn.rendered ?? [])
```

`maintain`（`memory.ts:376-397` 的模型半部 `proposeMaintenance`）发起 **2 次** `modelCalls.generate`；`select`（`memory.ts:408` 起）再发 **1 次** matcher 调用。三次模型往返全部在 `memory-identity:<projectID>` 跨进程 flock + 项目内存互斥锁之内。

**比 #324 描述的更广**：issue 只指出 `prepareUnsafe` 的 due 分支跑 maintain。实际上 `shouldMatch` 分支的 `select` 也在锁内——即**每个会话首个真实用户轮**都会跨一次模型调用持有跨进程 identity flock，与 `turn_interval` 无关。

**可达性**：`SystemPrompt.memory` → `memory.prepare(...)`（`session/system.ts`）→ `prepare`（`memory.ts:519`）→ `prepareUnsafe`（`memory.ts:442`）。`Memory.node` 已在交付的 httpapi app 图中（PR #313），为生产活代码。

**运行时影响**：`model.ts` 已退役墙钟（见「验证为正确」），`CONNECT_TIMEOUT`/`IDLE_TIMEOUT` 各 60s 且每个 chunk 重置——这意味着一条持续流式的慢推理调用可以**任意长时间**持有该锁。等待者在 `EffectFlock` 的 5 分钟后拿到 `LockTimeoutError`：并发的 `/compact` checkpoint、`memory_search`、`/memory on|off`、worktree `remove`/`reset` 的 admission，以及 **identity upgrade**（`ProjectIdentityMigration.migrate` 用同一把 key）都会在 5 分钟僵持后失败。同时，落在 `turn_interval` 边界上的每个 prompt 都要串行等两次模型调用才能组装系统提示。

**修复要点**：把 `prepareUnsafe` 的 due 分支改为与 checkpoint 路径同构——复用 `kickMaintenance`/`backgroundMaintain` + `applyUpdate`（只有 commit 拿锁）；`select` 同理，只在写 `markMatched` 时拿锁。注意这会改变「周期维护同步」测试的语义（#324 已预告）。

---

### MEM-02（Medium，Known-#324 debt 2 后半）`search` 跨 matcher 模型调用持有 identity flock

**位置**：`packages/opencode/src/memory/memory.ts:577-600`

**证据**：

```ts
      // Cross-process identity guard (see checkpointUnsafe): MemoryIdentityFence
      // re-checks identity liveness under the identity lock before matching/writing.
      const live = yield* fence.withLiveIdentity(
        current.project.id,
        Effect.gen(function* () {
          return yield* lock.withProject(current.project.id)(
            Effect.gen(function* () {
              ...
              const topics = yield* store.readTopics(current.project.id)
              const selected = yield* select({ ... })
```

**为何是缺陷**：与 MEM-01 同类。即使接受「同查询合并」的刻意取舍，**跨进程 identity fence** 也不需要覆盖 matcher 调用，只需覆盖 `markMatched` 写入。代码注释只解释了 liveness recheck 的理由，**没有**声明「刻意跨模型调用持锁」——而 #324 的验收要求正是把这个取舍显式写进规格。

**运行时影响**：一次 `memory_search` 会在 matcher 模型调用期间阻塞 `/compact` checkpoint、`/memory` 开关、worktree `remove`/`reset` 的 admission 以及 identity upgrade，上限到 `EffectFlock` 的 5 分钟等待超时。

---

### MEM-03（Low，New）周期维护失败后用维护前快照渲染注入

**位置**：`packages/opencode/src/memory/memory.ts:482-495`

**证据**：

```ts
                ? yield* maintain({ ... }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.gen(function* () {
                        yield* Effect.logWarning("periodic MEMORY maintenance failed", { cause })
                        return topics
                      }),
                    ),
                  )
                : topics
```

**为何是缺陷**：`maintain` 内部已经执行过 `store.updateTopics` 提交（`memory.ts:386-395`）。若失败发生在提交之后，恢复值 `topics` 是**维护前**快照，随后 `select`/渲染（`memory.ts:496-505`）基于它工作——本轮注入的 Memory 上下文与已落盘的持久修订不一致，且只有一条 `logWarning`，不向用户暴露冲突。

**运行时影响**：瞬态不一致（下一次 `prepare` 自愈），不是数据丢失。严重性 Low。

---

## GOAL

### GOAL-01（High）崩溃丢失的 continuation 使目标被持久边界门永久搁死；测试把错误行为钉住了

**位置**：`packages/opencode/src/goal/loop.ts:245-264`（门）、`packages/opencode/src/goal/goal.ts:746-749`（写入点）、`packages/opencode/test/goal/e2e-loop.test.ts:1836-1906`（钉错的测试）

**证据 1 — 门的实现与自述理由**（`loop.ts:245-264`）：

```ts
      // issue #285 — durable boundary gate (scan path only). ...
      // While the session window still ends on that same message, no new progress has landed —
      // re-judging would inflate turns_used and dispatch a duplicate continuation. ...
      if (scanResume && goalState.last_judged_msg) {
        const win = yield* sessions.messages({ sessionID, limit: 20 }).pipe(...)
        const lastSeen = [...win].reverse().find((m) => m.info.role === "assistant")
        if (lastSeen && lastSeen.info.id === goalState.last_judged_msg) return
      }
```

**证据 2 — 只有 continue 提交会写 `last_judged_msg`**（`goal.ts:746-749`）：

```ts
          // issue #285: record the judged boundary for the durable scan gate.
          ...(judged !== undefined ? { last_judged_msg: judged } : {}),
```

`blocked` 分支（`goal.ts:713-721`）与 `resume`（`goal.ts:561-575`）都不写不清；`GoalState.advance`（`state.ts:62`）原样带下去。

**证据 3 — 测试明确把这个场景当成「应跳过」并断言不派发 continuation**（`e2e-loop.test.ts:1871-1906`）：

```ts
  // Commits one continue evaluation ahead of the (re)boot — models a process
  // that crashed right after the commit, before the continuation produced an
  // assistant message.
  const commitPriorBoundary = (sid: SessionID) => ...

  it.instance("scan with an unchanged boundary skips re-evaluation (no inflation)", () =>
      ...
      expect(judgeCalls).toBe(0)
      expect(continuationCalls).toBe(0)
      const g = yield* goal.load(sid)
      expect(g?.turns_used).toBe(1)
```

**为何是缺陷**：门把两种状态混为一谈——
- 「边界已判定，continuation 已完成」→ 跳过是正确的（避免 turn 膨胀 + 重复派发）；
- 「边界已判定，continuation 随进程崩溃丢失」→ 跳过是**错误的**，因为重启后不存在任何在飞的 continuation，跳过意味着没有任何东西会驱动这个目标。

测试同时断言了 `judgeCalls === 0`（正确：不该重判，否则 turns 膨胀）和 `continuationCalls === 0`（错误：目标被留在 `active` 且无驱动者）。正确行为应是 **跳过 judge、但仍派发 continuation**。

**可达性与永久性**：窗口是「continue 提交 / `resume` kick 之后、下一条 assistant 消息落库之前」的崩溃。`/goal resume` 返回 `type: "kick"`（`goal.ts:831-835`），由 prompt.ts 派发，同样落在这个窗口内。搁死是**跨重启永久的**：每次启动扫描都命中同一个门而 `return`，`last_judged_msg` 因为不再判定而永不推进。D6 zombie 守卫也救不了它——`isStaleZombie` 要求 `turns_used === 0`（`loop.ts:90-101`），而此时 `turns_used >= 1`。唯一出路是用户主动向该会话发消息（走 `scanResume=false` 的活 idle 路径）。

**运行时影响**：这正是 #283 / #289 想消灭的 silent-stall 类问题——目标持久停在 `active`，无驱动、无日志、无暂停原因，直到用户偶然与该会话交互。

**测试覆盖**：**测试钉住了错误行为**（`e2e-loop.test.ts:1889-1906`）。修复必然要改这条断言：把 `expect(continuationCalls).toBe(0)` 改为 `toBe(1)`，同时保留 `judgeCalls === 0` 与 `turns_used === 1`。

---

### GOAL-02（Medium）ESC pause 重试耗尽后仍保留 lease 注册与 active 行，却无条件清掉 `turnDriven`

**位置**：`packages/opencode/src/goal/goal.ts:246-270`

**证据**：

```ts
      if (paused) {
        yield* automation.unregister(sessionID, { kind: "goal", id: paused.goal_id ?? "legacy" }).pipe(
          Effect.ignore,
        )
      } else {
        yield* Effect.logError(
          "goal pause on cancel failed after retries — goal may resurrect on next idle",
          { sessionID, cause: lastCause ? Cause.pretty(lastCause) : "unknown" },
        )
      }
      turnDriven.delete(sessionID)
      return paused
```

**为何是缺陷**：PR #284 加的重试循环 + 大声日志是修复的正确一半。失败分支与模块内其他所有 pause 点不对称——`pauseGoal`（`loop.ts:114-119`）、`pause`（`goal.ts:534` 附近）、派发失败处理（`loop.ts:564` 附近）都把 pause 与 `automation.unregister` 成对处理。这里在耗尽后：持久行仍 `active`、lease 注册仍在，**而 `turnDriven.delete(sessionID)` 无条件执行**——进程内的 ESC 来源信息被丢掉，持久态与 lease 却仍宣称「goal 拥有该会话且处于活跃」。

**运行时影响**：ESC + 三次 pause 写入失败后，下一个 idle 事件重入 `afterIdle`，`status === "active"` 通过、claim 成功（注册完好）、`shouldPreempt` 返回 false（ESC 不产生用户消息，`goal.ts:240-245` 的注释已承认这点），目标复活并派发用户已显式中止的 continuation。日志让它可见，但没让它自洽；丢掉 `turnDriven` 还意味着**复活轮上的第二次 ESC 不再走 goal pause 快路径**。

**测试覆盖**：只钉了成功路径。`test/goal/turn-scope.test.ts:76-110` 在健康 DB 上验证 pause 与无活跃目标时的 no-op，没有用例注入持续性 DB 失败。

---

### GOAL-03（Low）judge 传输/解析失败仍消耗 turn 预算并盖上 `last_judged_msg`

**位置**：`packages/opencode/src/goal/judge.ts:84-89`（fallback）、`packages/opencode/src/goal/goal.ts:733-749`（应用点）

**证据**：

```ts
    Effect.catchCause(() =>
      Effect.succeed({
        verdict: "continue",
        reason: "judge transport error (timeout or network) — counting toward pause budget",
        parseFailed: true,
      } satisfies JudgeResult),
    ),
```

continue 分支随后无条件自增并记录边界：

```ts
        const turnsUsed = GoalState.nni(state.turns_used + 1)
        ...
          ...(judged !== undefined ? { last_judged_msg: judged } : {}),
```

**为何是缺陷**：fail-open 本身是成文的刻意设计（一次抖动不应停摆，由 `MAX_CONSECUTIVE_PARSE_FAILURES` 兜底），`judge.ts:70-84` 的注释解释得很清楚。真正不一致的是**预算记账**：一次 judge 从未返回裁决的轮次，仍然消耗用户 `max_turns` 的一格，并且仍然像真判过边界一样盖上 `last_judged_msg`（后者与 GOAL-01 的搁死风险叠加）。计数器在任一成功时重置（`goal.ts:693` 附近），因此在间歇性成功的不稳定 provider 下可以无限烧预算而永不触发自动暂停。

**运行时影响**：不可靠 judge 模型下目标预算被未评估的轮次吃掉，导致提前「预算耗尽」暂停。可通过 `/goal resume` 恢复，严重性 Low。

**测试覆盖**：测试把当前行为当作预期钉住（`test/goal/judge.test.ts:99-145` 断言 `parseFailed: true` + `verdict: "continue"`；`test/goal/goal.test.ts:641-710` 断言计数器爬到自动暂停）。「失败 judge 应对预算中性」这一点没有任何断言。

---

### GOAL-04（Low）启动扫描对非 idle 会话静默跳过，无日志、无重新武装

**位置**：`packages/opencode/src/goal/loop.ts:666-679`

**证据**：

```ts
    const scanForActiveGoals = Effect.fnUntraced(function* (snapshot: ReadonlyArray<SessionID>) {
      for (const sessionID of snapshot) {
        const current = yield* status.get(sessionID)
        if (current.type !== "idle") continue
        yield* triggerEvaluation(sessionID, true).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("goal startup scan failed for session", { sessionID, cause: Cause.pretty(cause) }),
          ),
        )
      }
    })
```

**为何是缺陷**：注释（`loop.ts:656-659`）以「a session mid-turn is skipped and will be driven by its own turn-end idle event」为理由。这在本进程启动的轮次上成立，但扫描发生在 boot、本进程尚未启动任何轮次之时；注释自己也承认「At startup the status map is empty (get defaults to idle), so this only filters sessions that genuinely flipped busy between bootstrap and the scan」。该 `continue` 是裸跳过：无日志、无重试义务——与 lease 的 `blockedGoalClaims` 重触发机制（记录重试义务）不同。快照在 builder 期一次性捕获，没有任何路径重新武装扫描。

**运行时影响**：窄但真实的恢复漏洞——在扫描时刻显示 busy 的会话既不被评估也不被记录，目标持久停在 `active` 且休眠，直到无关的用户交互。因为窗口需要 boot 期恰好 busy，实际概率低，故 Low。

---

## 验证为正确的部分（本次特意检查并确认无缺陷）

**MEMORY**
- **#324 debt 1（SSE 逐 chunk 存活判定）已真正偿付。** `model.ts:13-14` 把 `CONNECT_TIMEOUT` 与 `IDLE_TIMEOUT` 分成两个独立 60s 预算；`drainWithLiveness`（`model.ts:84-124`）在遍历 `result.fullStream` 的**每次**迭代都 `arm(input.idleTimeout)`，且先重置再判断 `part.type === "error"`，因此没有任何 chunk 种类（含 reasoning delta）被排除在看门狗重置之外。生产路径已无墙钟：`make`（`model.ts:48-67`）只在 `input.timeout !== undefined` 时套 `Effect.timeoutOrElse`，而生产 `layer` 构造 `make({ execute })` 不传 `timeout`。
- **#328 的 json 词保证**：`requireJsonToken`（`model.ts:71-74`）在 system/prompt 都不含 `/json/i` 时追加 `JSON_HINT`，且在每次 `generate` 上生效（`model.ts:53`）。
- **#313 的装配修复在可枚举的图上是完整的**：`Memory.node` 在 httpapi `server.ts` 的 app 图中，`Memory.defaultLayer` 在 `AppLayer`；`BootstrapLayer` 不含 Memory，但其唯一消费者 `project/bootstrap.ts` 走 `Effect.serviceOption` 并按设计 no-op。
- 迁移「先写持久副本再消费 legacy」三阶段实现正确（`identity-migration.ts:106-184`），`sameContent` 正确忽略 controller-owned 元数据（`identity-migration.ts:52-71`）；legacy 文件删除前重读比对（`admission.ts:129-139`、`243-250`）；admission 缓存只在 `unresolved === 0` 时写入，worktree `remove`/`reset` 先 invalidate 再 `ensure` 并传完整目录快照；`writeSnapshot` 以 manifest 发布为单一提交点（`store.ts:239-268`）；strict/lenient 读分离正确；global identity 下 inert 正确；后台维护 fiber 绑定 layer scope 且槽位释放无泄漏。

**GOAL**
- **单事务 transition 语义正确**（`goal.ts:335-413`）：读、`decide`、写/删全在一个 `db.transaction(..., { behavior: "immediate" })` 内，外包 `Effect.uninterruptible`，事件在提交后才发布；接口上每个持久变更都走这个 seam。
- **终态 done 正确**：`goal_outcome` 插入与 `goal_state` 删除同事务，不留中间清理义务。
- **revision / goal_id 栅栏正确**：`matchesExpected` 在事务内的 `decide` 回调中求值，延迟裁决无法应用到被替换的目标或已 bump 的 revision。
- **generation fence 未跨 provider 执行**：`prepareIfIdle` 返回延迟的 `AfterFence`，`handoff` 在 `activate` 后释放会话锁再返回 `result`，GoalLoop 在锁外 await；`promptIfIdle` 仍是最终 idle 守卫，Goal 从不用裸 `prompt` 驱动轮次。
- **lease 优先级正确**：`owner()` 先返回任何 `dag` 再返回 `goal`，最后一个 DAG unregister 的 dag→非 dag 转换在 per-session 锁下原子计算。
- **loop fiber 生命周期与订阅清理正确**：`registerFiber` 中断前任，`clearFiberIf` 按身份作用域且不中断；idle 订阅与扫描 fiber 都 `forkScoped`。
- **judge snippet 窗口一致**：`JUDGE_RESPONSE_SNIPPET_CHARS = 4000` 与调用方 `.slice(-4000)` 及 `renderJudgeUserPrompt` 的再切片一致。
- `/goal resume` 命令路径确实接线（`goal.ts:807-835`），返回 `kick` 由 prompt.ts 派发。

**DAG**
- `spawn.ts` 的 `makeDeadlineWatcher` 在各失败模式下正确（store 读重试而非终止监督、瞬态 defect 视为「无法否证所有权」、上限与升级均重试并重抛 interrupt），`Effect.ensuring` 中断 watcherFiber 无泄漏。
- watcher 替换先中断旧 watcher 再覆写；终态 handler 在 `NodeCompleted` 与 `NodeSkipped` 上都中断。
- 三个 adoption 入口都在首次 yield 前同步预留 `recovering`、经 `Effect.ensuring` 释放、并以原子 `store.tryClaimAdoption(dagID)` 收口。
- 陈旧事件仲裁正确：节点终态 handler 重读持久行并丢弃状态已不匹配的事件；`refreshControlFlags` 从 DB 重建 pause/step 标志。
- rev-view 过滤正确：所有重建输入都用 `store.getCurrentNodes`，被取代的行无法重新播种失败。
- **有 `output_schema` 的节点若未成功调用 `submit_result` 会 fail（`verdict_fail`）而非以字符串完成**（`capture.ts:143-150` `settleCapturedOutput`），且该判定为 live 路径与崩溃恢复共用——这正是 DAG-01 未命中默认 block 路径的原因。
- review 裁决门 fail-closed：`reviewVerdict`（`review-lifecycle.ts:323-327`）要求对象并拒绝字符串。
- `evaluateCondition` 的数值比较在非数/非有限操作数上 loudly fail（与 DAG-01 的等值比较形成对照）。
- wake 持久性（#326）：`loop.ts:1384-1424` 在持有 lease 时于 admit 时刻持久化 `wake_reported`，lease 丢失/generation 竞争降级为稍后重试，正确重抛 interrupt。

## 复核中被推翻/降级的候选项

- 子代理最初把 DAG-01 判为「默认 block 路径即命中」。复核 `blocks.ts:251,271,305-309` 与 `capture.ts:143-150` 后**推翻**：`verify`/`review`/`coding`/`prototype` 均声明 schema，且缺 `submit_result` 会 fail 而非以字符串完成。暴露面收窄为 `synthesize` 默认 reporting、作者显式 `report_to_parent: true` 的无 schema block、以及 low-level 手写节点。严重性仍为 High（后果是静默 COMPLETED），但可达性描述已按证据改写。
- 子代理把 GOAL-01 描述为「blocked → resume」路径。复核后发现该路径下 tail assistant 通常已推进、门不命中；**真正的机制**是「continue 提交 / resume kick 之后、下一条 assistant 落库之前崩溃」，且 `e2e-loop.test.ts:1871-1906` 把这个场景当成「应跳过」显式钉住。结论更强而非更弱。
- 子代理的 MEM-02（原编号）称「维护提交后失败导致渲染陈旧」置信度 Likely。复核确认代码事实成立，但影响为瞬态自愈，**降级为 Low**（本文 MEM-03）。
- 子代理的 GOAL-02（原编号，启动扫描 busy 跳过）评 Medium。依据代码自述「启动时 status map 为空、默认 idle」，**降级为 Low**（本文 GOAL-04）。
- 关于 `Goal.resume` 无生产调用方的初步怀疑**推翻**——是我的 `rg -r` 误用（`-r` 是替换标志）污染了输出；实际接线在 `goal.ts:807`。

## 局限

1. **未运行测试套件。** 所有并发/竞态结论来自静态阅读控制流，未做动态验证。DAG-01/02/03、MEM-01/02、GOAL-01/02 的修复都应配回归测试后再动态确认。
2. **#316 触发源未钉死。** DAG-04 证明了放大机制与生产暴露面，但未定位 dispose 期间持续发 `dag.*` 事件的组件；未阅读 `EventV2Bridge.listen`、`InstanceStore.disposeAll`、`InstanceState` scope-close 实现。
3. **`loop.ts`（1668 行）未逐行读完。** 已读约 62-160、300-360、374-500、543-712、725-800、1220-1290、1380-1424 等区段；`~160-300`、`~945-1107`、`~1290-1380`、`~1520-1639` 未读。这些区段内的缺陷不会被本次发现——DAG 的**否证性结论不具备穷尽性**。
4. **DAG 模块内未审计的文件**：`blocks.ts` 的 `aggregateParallelWriters`（#299 并行 writer 聚合）、`templates/*`、`workflows.ts`、`admission.ts`、`recovery.ts`、`capture.ts` 的 `validateAgainstSchema`（cyclomatic 29 / cognitive 56，且直接在 structured-output 路径上）、`output-ref.ts`、`tool/workflow.ts` 主体、httpapi dag handlers。未验证的不变量：「一个用户目标至多一个 live DAG」、`portable` 不加载环境目录 / `environment` 验证模型可用性的分工、model-facing schema 隐藏身份字段、Runtime Admission 与 Authoring Check 的职责分离。
5. **Effect v4 / effect-smol 语义未查证参考实现**：DAG-04 关于 scope finalizer LIFO 顺序与 `Effect.forkIn` 在关闭中 scope 上行为的推理未对照 `effect-smol` 源码。`Effect.catchCause` 捕获 interrupt cause 这一点已由代码内三处 `Cause.hasInterrupts` 显式再抛的既有写法反证成立。
6. **索引覆盖为 best-effort。** `check_index_coverage` 对所引用路径报 `no_recorded_issue`，但按工具自身声明这不构成完整性证明；`*.test.ts` 全部不在 `fast` 索引内，测试相关结论均来自直接文件读取。
7. **未审计 `packages/opencode/src` 之外的消费者**（TUI / desktop / CLI 各自的组合根），因此若存在 packages/opencode 之外的 Memory / Goal / Dag 消费者，本次不会发现其装配缺陷。

## 建议的处置顺序

| 优先级 | 动作 |
|---|---|
| P0 | DAG-01 + DAG-02 一并修：`loop.ts` 条件求值前做字符串归一化；`checkpointGateDiagnostics` 追加「被门控 checkpoint 必须声明 `output_schema`」；把 checkpoint 门接入 `replanStructuralDiagnostics`（或让 `structural` 不再对 replan/extend 整体关闭）。回归用例覆盖 `action: "replan"` 与运行时字符串输出两条。 |
| P0 | GOAL-01：把边界门从「抑制驱动」改为「抑制重判」——命中门时跳过 judge 但仍派发 continuation。必须同步修改 `e2e-loop.test.ts:1889-1906` 的 `continuationCalls` 断言。 |
| P1 | DAG-03：pause 终态失败时改为 `entry.runtime.setPaused(true)` fail-closed；并把 `dag.pause` 的 defect 纳入同一处理。 |
| P1 | MEM-01：`prepareUnsafe` 的 due 分支与 `shouldMatch` 分支改用 `backgroundMaintain` / `applyUpdate` 形状，仅提交拿锁。归入 #324。 |
| P1 | DAG-04：`summary-publisher.ts:166` 补 `Cause.hasInterrupts` 再抛；`global-lifecycle.ts` 的 `disposeAll` 加有界超时。归入 #316（触发源仍需独立定位）。 |
| P2 | GOAL-02：pause 耗尽时保持 `turnDriven` 或同步 unregister，使持久态、lease、进程内标记三者自洽。 |
| P2 | MEM-02：把 identity fence 缩到 `markMatched` 写入；并在规格中显式声明「同查询合并」这一取舍（#324 验收项）。 |
| P3 | MEM-03、GOAL-03、GOAL-04。 |
