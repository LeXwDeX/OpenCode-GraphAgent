# 09 — 收束：dev → main 晋级 PR

**What to build:** 全部批次 A 与 flaky 票合入 dev 且 dev CI 真绿后，开 dev→main 晋级 PR：全量门禁（Typecheck + Unit Tests + E2E linux + E2E windows）通过即合并，使 main 恢复可 release-fork 状态。

**Blocked by:** 01、02、03、04、05、06、07、08 全部合入 dev

**Status:** ready-for-agent

- [ ] dev 最新 push 的 CI 四项检查全绿（Typecheck、Unit、E2E linux、E2E windows）
- [ ] 豁免清单清零或逐项重新裁决留档
- [ ] PR 描述附批次 A 交付清单（Q1/Q2/Q3/S5 + flaky 根因修复）与两轮深审 PASS 证据链接
- [ ] 合并后 main 可手动 release-fork
