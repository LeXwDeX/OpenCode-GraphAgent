# 06 — Flaky：stdout 污染族根治（run-process ×9 + ShareNext 污染分量）

**What to build:** 非交互子进程 stdout 断言失败的根因修复：测试 LLM/fixture 输出污染了被测进程的 stdout，导致 `expect(stdout).toBe("...")` 精确匹配族在慢主机/并发下失败。按豁免清单已定位的根因修复（污染源隔离或断言确定性化），不削弱断言语义。

规格依据：.opencode/promotion-review-round1/exemption-manifest.md（13 项中 run-process ×9 + ShareNext 污染分量）+ Round 1/2 深审根因记录。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 污染源定位经可复现测试验证（修复前红、修复后绿）
- [ ] run-process 9 项断言不削弱、不删除，本地重复跑（≥5 次）稳定绿
- [ ] ShareNext 的 stdout 污染分量同步修复（计时问题归 07 票）
- [ ] opencode 包测试套全绿（除豁免清单剩余项）
