# 07 — Flaky：ShareNext 计时预算稳定化

**What to build:** ShareNext 合并测试（15s 超时）在慢 CI 主机上压线失败。以发布就绪信号等待替代墙体时间等待（测试 AGENTS.md 的 pollWithTimeout 惯用法——等信号不等 sleep），或给出经证据支撑的预算调整；禁止单纯放大超时掩盖真实竞态。

规格依据：exemption-manifest.md（ShareNext 项）+ 测试 AGENTS.md「Synchronizing With Concurrent Work」节。

**Blocked by:** 06 — Flaky：stdout 污染族根治（同一测试文件，写集串行）

**Status:** closed（PR #186，merge commit `4ddeaf2fc`）

**Completion evidence:** flaky 稳定化与验证随 PR #186 合入 `dev`，并随 PR #188 通过 main 全量门禁。

- [x] 修复走信号等待惯用法；若改预算须附 CI 计时证据
- [x] 本地重复跑（≥5 次）+ 模拟负载下稳定绿
- [x] 无新增 Effect.sleep 等待 forked fiber 的反模式
