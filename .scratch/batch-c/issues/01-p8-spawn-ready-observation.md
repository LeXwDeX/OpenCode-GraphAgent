# 01 — P8：spawnReady 复杂度观测处置

**What to build:** 记录 `spawnReady O(ready × nodes)` 是否有实际性能证据。没有 trace/benchmark/用户痛点时，以 no-code 关闭；不得仅凭静态复杂度实施缓存或索引改造。

**Evidence:** `.scratch/batch-b/evidence.md#p8--spawnready-复杂度`
**Branch:** `docs/p8-observation`
**Blocked by:** None
**Status:** closed-no-code

- [x] 搜集已有生产 trace、benchmark 或明确用户场景，不为本票新造大规模优化工程
- [x] 无量化证据：记录“当前不做”与重开阈值，状态改 closed-no-code
- [x] 有量化证据：另开 `/improve-codebase-architecture` 设计票，写明基线与目标（本次无量化证据，因此未开票）
- [x] 本观测票本身不改 `spawnReady`

## 关闭结论

- 已复核 promotion evidence 与 DAG deep-review 报告；只有静态 `O(ready × nodes)` 推断。
- 未发现生产 trace、可重复 benchmark 或明确用户场景能把可感知延迟归因到 `spawnReady`。
- 当前不增加索引或缓存；在没有收益基线时，这类状态会扩大一致性与失效维护面。
- 本票仅记录裁决，生产代码零改动。

## 重开阈值

满足任一条件时重开独立性能设计票：

1. 用户态或生产 profile 将调度延迟明确归因到 `spawnReady`。
2. 可重复 benchmark 显示 `spawnReady` 占一次 wake 调度耗时的 10% 以上。
3. 实际工作流规模长期超过当前评审采用的 50 节点观察区间。

重开后必须先记录基线、目标与代表性图规模，再选择索引或缓存方案。
