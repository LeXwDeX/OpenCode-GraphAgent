# ADR-0004: workflow lock 超时——奥卡姆版一行 timeout（Q4/Q5 被 Q6 收编）

- 状态：已接受（批次 A grilling，2026-08-07，Q6 决策 (A)）
- 上游公理：设计公理 ③（奥卡姆剃刀）
- 取代：Q4 原案（WorkflowLockTimeoutError 类型化错误类 + per-caller 语义，估算 50-100 行）——被否，违反公理 ③

## 背景

`withWorkflowLock` = `workflowLocks.withLock(dagID)(body)`（dag.ts:311-312），KeyedMutex 单许可、不可重入、无超时。已知危害：锁不释放 = 该 workflow 全部命令无限期静默排队。

关键事实（奥卡姆判决依据）：
1. 编译期 witness 已防住已知死锁类（重入）——WorkflowLock 类型只有 withWorkflowLock 能铸造
2. DB 为 effect-drizzle-sqlite 同步驱动，临界区是同步 DB 写——健康时亚秒级，不可能无限挂起；静默冻结只能由**未来回归**（临界区内引入异步等待）引入
3. S5 是防御性/假想发现（五轮 review 无实际死锁观测），不是已观测 bug

## 决策

**一行有界超时**，无其他机制：

```ts
workflowLocks.withLock(dagID)(Effect.suspend(() => body(lockWitness))).pipe(Effect.timeout("30 seconds"))
```

- 复用 Effect 内建 `TimeoutException`——零新错误类
- 超时覆盖「等锁 + 持锁全程」——临界区同步 DB 写下，30s 仍在临界区 = 已有大病，打断并大声报错即正确行为
- 零 per-caller 改动：运行时 handler 的 guarded catchCause 自动接住记 warning；用户命令经既有错误通道冒泡（可重试）；watchdog 自续间隔（escalateIntervalMs ≥1s）天然重试
- watchdog **零特殊化**：extension 计数只在 escalate 成功时 +1，失败尝试不消耗 cap 预算——监督语义零损耗
- 常量 30s 单一全局值（DEFAULT_WORKFLOW_CONFIG 或 dag.ts 具名常量），不分档——分档为未来预付复杂度

## 后果

- dag.ts 一行 + 一常量
- 测试：spec 阶段定（导出常量跑 ~30s it.live 争用测试，或信任 Effect.timeout 仅测无争用路径不回归）
- 剩余风险（接受）：错误类型是通用 TimeoutException 而非专属——日志与错误文本可辨识，无消费者需要程序化区分
- dag.ts 注释强化：临界区内禁止异步等待（公理 ① 的锁域表述）
