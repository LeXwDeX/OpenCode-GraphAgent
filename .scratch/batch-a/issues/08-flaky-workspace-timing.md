# 08 — Flaky：workspace sync 计时预算稳定化

**What to build:** workspace sync 历史回放测试（20s 超时）在慢 CI 主机上压线失败。处置同 07 票：信号等待替代墙体时间，或证据支撑的预算调整。若根因并非计时（先诊断后修——诊断优先于理论， tight feedback loop 先行），按实际根因修复并记录。

规格依据：exemption-manifest.md（workspace sync 项）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 先复现并确认根因（计时 vs 其他），根因记录入票
- [ ] 修复后本地重复跑（≥5 次）+ 模拟负载下稳定绿
- [ ] 无新增固定 sleep 反模式
