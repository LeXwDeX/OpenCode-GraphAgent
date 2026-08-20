# Release Train（发布列车）

一条从 issue 清理到正式发版的批次交付循环。全程 SpecGit 化：issue → delivery PR → CI 门禁 → 合并 → 发版。所有条目先处理完，再统一处理 PR 问题——batch 住操作，不逐个排队。

## Trigger

人工发起：用户说"发版 / 跑一趟发布列车"，且满足发车条件——dev 上无开放 delivery PR。

## Steps

1. **验车**：确认 dev 分支 CI 全绿（push 触发的 Typecheck + 全量测试），open issue 与已合入 dev 的交付一一对应（合并到 main 时 GitHub 才自动关 issue，开着 ≠ 未处理）。
2. **复盘**：对目标子系统做完整性复盘（每次发车指定一个；本轮为 MEMORY ON：`/init` 盖章 `project.time_initialized` → `/memory on` → `memory_search` 可用的启用链路，外加写入路径验证）。发现按 specgit 粒度开 issue——一个独立可验证的 WHY 一个 issue。
3. **Checkpoint（唯一的阻塞确认）**：呈现复盘报告——发现清单、新建 issues、修复计划、本班车范围——一次确认。确认后连续执行到发版，不再打断。
4. **修复班车**：`specgit issue <n> <n> ...` 把全部新 issue 绑进一个 delivery（多 issue 一 PR），从 main 切出 `fix/**` 分支，TDD 修复，PR → dev。PR 上 CI/TDD 失败 → 原 delivery 内追加 commit 修复；已合入 dev 后才暴露的回退 → 开新 fix issue 进下一班车。
5. **升级**：修复 PR 合并、dev push 全量绿后，立即开 dev → main PR（protect-main 全量门禁：Typecheck + Unit Tests + E2E 双平台）。全程监控，失败即修。
6. **发版**：main 合并后、触发 `release-fork` 前，先写 series 文件——按 `.github/RELEASE_NOTES_TEMPLATE.md` 渲染并提交 `.github/releases/vX.Y.Z.md`（版本号由 latest tag + commit 类型推导；渲染 fail-closed，失败即阻断发版）。随后 `release-fork` 触发正式版。issue 随 dev→main 合并自动关闭。
7. **Brief**：一趟车一份收尾汇报——本班次 issue 清单、PR、CI 结论、版本号与 release 链接、遗留（进下一班车的条目）。

## Rules

- SpecGit 铁律优先：`specgit finish` 非 0 不请求合并；不削弱 policy；只认 `--json`。
- 发布已由步骤 3 的确认授权，正式版不再二次询问。
- 回退（合并后 CI 挂）永不静默：开 issue、进下一班车、在 Brief 中显式列出。
