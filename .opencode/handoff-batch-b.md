# 批次 B 交接文档（新会话入口）

> 本会话（批 A 全链路）已极长，批次 B 在新对话执行。引用本文件 + 下述证据路径即可开工。

## 起点状态（交接时）
- 基线：**dev**（`bee78d7ed` 起算，开工前 `git fetch && git switch dev && git pull`）
- 批次 A 全闭环：Q1-Q6 引擎语义 + 接受期绑定校验 + flaky 根治（豁免清单已清零）+ 技术债清零（PR #185-#189 全合入）
- lint 棘轮：4852（CI 口径；本地 = CI − 10 生成物差，本地基线 ≤4842）——**只紧不松**
- 台账：.scratch/batch-a/issues/01-11（01-09 完成，10/11 closed）

## 批次 B 四组票（Ask Matt 路由：agent-ready，证据已在案）

### 组 1：U-1 / U-2 + Transport mid-stream-stall（一个 spec 三张票）
三个 abort-path 集成测试，同源同批。先 /to-spec 收敛三票边界，再逐票 /implement。

### 组 2：F3 / F4 测试卫生债
小票直接做（无需 grill），每票新上下文 /implement。

### 组 3：O1 remote config last-known-good 缓存
小 feature；离线降级的 last-known-good 语义在批 A 前置调研中有上下文（config-offline-degrade 已合入 dev，先读现状再定增量）。

### 组 4：S7 recovery INVENTED 推断 ⚠️
唯一带 bug 气味的——**必须走 /diagnosing-bugs**：先 tight feedback loop（一条命令红灯复现）再修，禁止先理论后复现。修复以回归测试收口。

## 证据路径（不用重新调查，票据直接引用）
- .opencode/promotion-review-round1/*.md（U-1/U-2/F3/F4/O1/S7/P8 全部 finding + 根因记录）
- .opencode/promotion-review-round2.yaml 相关证据（若引用深审轮次）

## 工程纪律（仓库铁律 + 本项目惯例）
- 分支：从 **dev** 切 `feat/**` 或 `fix/**`（AGENTS.md 原文写 main，本项目当前惯例：批 B 基于 dev——dev 领先 main 且为集成层）
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
