# 批次 B 交接文档（新会话入口）

> 本会话（批 A 全链路）已极长，批次 B 在新对话执行。引用本文件 + 下述证据路径即可开工。

## 起点状态（交接时）
- 基线：**dev**（批 B 规划基线 `3e8368f37`；每票开工前重新同步最新 `dev`）
- 批次 A 全闭环：Q1-Q6 引擎语义 + 接受期绑定校验 + flaky 根治（豁免清单已清零）+ 技术债清零（PR #185-#189 全合入）
- lint 棘轮：4852（CI 口径；本地 = CI − 10 生成物差，本地基线 ≤4842）——**只紧不松**
- 台账：.scratch/batch-a/issues/01-11（01-09 完成，10/11 closed）

## 批次 B 四组票（审计后路由，证据已在案）

### 组 1：U-1 / U-2 + Transport mid-stream-stall（一个 spec 三张票）
三个 abort-path 集成测试，同源同批。规格已收敛到 `.scratch/batch-b/abort-path-contracts.md`，按 01→02→03 逐票 /implement。

### 组 2：F3 / F4 测试卫生债
小票直接做（无需 grill），每票新上下文 /implement。

### 组 3：O1 remote config last-known-good 缓存
批 A 已完成“网络/响应体失败时 warn + skip”；剩余增量只有持久化 last-known-good。先完成 `.scratch/batch-b/issues/06-o1-lkg-spec.md` 的小规格，再按 07 实现；不得重新实现离线降级。

### 组 4：S7 recovery INVENTED 推断 ⚠️
当前已有 ownership-lost 后暂停工作流的缓解，尚无用户态缺陷实证。**必须走 /diagnosing-bugs**：先建立一条确定性、快速、可红灯的复现命令；不能建立反馈回路则记录尝试并停止，不得先改生产代码。若红灯成立，另开修复票与新上下文。

## 证据路径（不用重新调查，票据直接引用）
- `.scratch/batch-b/evidence.md`：已追踪的稳定证据快照，含当前代码路径纠偏与验收边界；新 worktree 只依赖此文件
- `.opencode/promotion-review-round1/*.md`、`.opencode/.dag-specs/evidence/*.md`：原始本地评审产物，当前未追踪，仅用于复核来源，不作为跨 worktree 前置
- `.scratch/batch-b/abort-path-contracts.md`：U-1/U-2/mid-stream-stall 的已追踪规格；本地 OpenSpec 原件受 `.gitignore` 约束，不作为跨 worktree 前置

## 工程纪律（仓库铁律 + 本项目惯例）
- 分支：从最新 **dev** 切票据指定分支；生产 feature 用 `feat/**`，测试/规格债用 `test/**` 或 `docs/**`，均符合 branch-naming ruleset
- PR → dev：Typecheck 门禁；push dev 自动触发全量测试（Typecheck + Unit + E2E×2）
- 测试从包目录跑（packages/opencode 等），禁根目录；typecheck 用 `bun typecheck` 不用裸 tsc
- 每票一个新上下文会话执行（/implement 内含 /tdd），票间清上下文
- HTTP API 路由若被触及：再生 SDK（./packages/sdk/js/script/build.ts）+ 更新 httpapi-exercise 场景

## 收束清单（批 B + 批 C 全部完成后）
1. dev 全量 CI 绿 → 一次性 dev→main 晋级 PR（四项门禁）→ 手动 release-fork
2. 分支一并清理（用户确认后手跑，dcg 拦 agent 删除）：
   ```bash
   git worktree prune   # 先清 opencode/* 残留 worktree（git worktree list 查路径）
   git branch -d feat/dag-timeout-escalation feat/event-batch-publish feat/goal-pause-resume \
     feat/llm-request-timeout feat/session-runner-hotpath fix/config-offline-degrade \
     fix/deep-review-fixes review/dev-promotion <批B/C分支>
   ```
3. 台账惯例：新票记 .scratch/batch-b/issues/，完成翻 closed 附 PR/commit 实证

## 批 C（观测后再动，勿提前）
- P8 spawnReady O(ready×nodes)：当前规模无实感，挂 /improve-codebase-architecture 巡检候选，疼了再做
