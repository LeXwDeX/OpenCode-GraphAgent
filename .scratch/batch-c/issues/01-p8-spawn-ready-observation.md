# 01 — P8：spawnReady 复杂度观测处置

**What to build:** 记录 `spawnReady O(ready × nodes)` 是否有实际性能证据。没有 trace/benchmark/用户痛点时，以 no-code 关闭；不得仅凭静态复杂度实施缓存或索引改造。

**Evidence:** `.scratch/batch-b/evidence.md#p8--spawnready-复杂度`
**Blocked by:** None
**Status:** deferred-nonblocking

- [ ] 搜集已有生产 trace、benchmark 或明确用户场景，不为本票新造大规模优化工程
- [ ] 无量化证据：记录“当前不做”与重开阈值，状态改 closed-no-code
- [ ] 有量化证据：另开 `/improve-codebase-architecture` 设计票，写明基线与目标
- [ ] 本观测票本身不改 `spawnReady`
