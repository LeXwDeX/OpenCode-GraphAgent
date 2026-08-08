# 09 — 收束：批 B+C 后 dev → main → release-fork

**What to build:** 批 B 所有票关闭、批 C P8 完成观测处置后，确认最新 `dev` 全量 CI 绿色，发 dev→main 晋级 PR；四项门禁全绿后合并并手动运行 release-fork。

**Blocked by:** 01–08 全部关闭；`.scratch/batch-c/issues/01-p8-spawn-ready-observation.md` 已处置
**Status:** blocked

- [ ] 最新 dev push 的 Typecheck、Unit Tests (linux)、E2E Tests (linux/windows) 全绿
- [ ] 每票 PR/merge commit/验证命令已回填，S7 若确认缺陷则其独立修复票也关闭
- [ ] dev→main PR 描述列出批 B 交付与批 C no-code/benchmark 裁决
- [ ] 四项 main PR 门禁全绿后合并
- [ ] release-fork 从 main 成功产出正式版，再执行用户确认过的分支/worktree 清理
