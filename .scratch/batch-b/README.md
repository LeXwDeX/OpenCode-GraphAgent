# 批次 B 执行台账

**规划基线：** `dev@3e8368f37`（PR #190）

**当前状态：** 规格与票据已就绪；实现代码尚未开始。

## 审计结论

- 批次 A 已经 PR #188 晋级 `main`；残余修复 PR #189 与交接 PR #190 已进入 `dev`。
- U-1/U-2/mid-stream-stall 的 OpenSpec 已完成并通过校验；仓库规定 `/openspec/` local-only，跨 worktree 使用已追踪镜像 `.scratch/batch-b/abort-path-contracts.md`。
- 原始 `.opencode/promotion-review-round1/` 与 `.opencode/.dag-specs/evidence/` 是未追踪本地文件；跨 worktree 统一引用 `.scratch/batch-b/evidence.md`。
- O1 不是直接实现票：离线降级已完成，剩余 LKG 的持久化、键、失效和安全边界需先写小规格。
- S7 只有静态 bug 气味；先诊断，不能复现就无代码收口。P8 维持批 C 的观测候选，不阻塞批 B。

## 串行顺序

1. 01 U-1 → 02 U-2 → 03 mid-stream-stall；02/03 写同一测试文件，禁止并行。
2. 04 F3 → 05 F4；两票只清测试债，不顺带改运行时。
3. 06 O1 规格 → 07 O1 实现。
4. 08 S7 诊断；只有红灯成立才新建独立修复票。
5. 批 B 全部处置 + 批 C P8 观测记录关闭后，执行 09 的 dev→main 晋级与 release-fork。

每票从最新 `dev` 创建符合仓库规则的分支，单独 PR → `dev`，单独新任务执行。票据完成时将状态改为 `closed`，附 PR、merge commit 与验证命令。
