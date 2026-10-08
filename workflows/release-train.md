# Release Train（发布列车）

一条从 issue 清理到正式发版的批次交付循环。全程 SpecGit 化：issue → delivery PR → CI 门禁 → 合并 → 发版。所有条目先处理完，再统一处理 PR 问题——batch 住操作，不逐个排队。

## Trigger

人工发起：用户说"发版 / 跑一趟发布列车"，且满足发车条件——main 上无开放 delivery PR。

## Steps

1. **验车**：确认 main 分支当前提交的 CI 全绿，核对 Issue 与已合入 main 的交付。实时读取原生默认分支（当前为 main）；面向 main 的 delivery PR 通过 closing keywords（`Closes #N`）关闭关联 Issue——开 PR 时必须带上本班次的全部 closing 行。合并后分别回读 PR 合并状态和全部关联 Issue 状态。
2. **复盘**：对目标子系统做完整性复盘（每次发车指定一个；本轮为 MEMORY ON：`/init` 盖章 `project.time_initialized` → `/memory on` → `memory_search` 可用的启用链路，外加写入路径验证）。发现按 specgit 粒度开 issue——一个独立可验证的 WHY 一个 issue。
3. **Checkpoint**：呈现发现清单、Issue 候选、修复计划和本班车范围。仅在现有授权未覆盖本次范围或正式发布时补齐确认；已有明确授权不重复询问。
4. **修复班车**：读取 `specgit-native` 技能及 `specgit --help` / `specgit --schema`。用 `issue --inspect` 查重，复用同一 WHY 的 Issue；新规格包含 Why、Scope、Approach、Acceptance。用 `specgit issue <n> <n> ...` 选择规格，从 main 切出 `fix/**` 分支实施。通过本机检查、提交和推送后，用 `specgit pr` 聚合到目标为 main 的 PR，保留已有正文和 closing references，评审准备完成后用 `pr --ready` 标记就绪。Issue/PR 写入前用 `--dry-run` 预览。PR 上 CI 失败时在原交付追加修复；合并后暴露的回退建立新 fix Issue。
5. **发版**：main 合并后、触发 `release-fork` 前，先写 series 文件——按 `.github/RELEASE_NOTES_TEMPLATE.md` 渲染并提交 `.github/releases/vX.Y.Z.md`。版本号是 `release-version.ts` 的机械推导（`graphagent-v*` 标签上的 patch+1，不读 commit 类型），系列文件必须以推导出的版本命名；渲染 fail-closed，失败即阻断发版。随后 `release-fork` 触发正式版。
6. **Brief**：一趟车一份收尾汇报——本班次 issue 清单、PR、CI 结论、版本号与 release 链接、遗留（进下一班车的条目）。

## Rules

- 用 `specgit pr --status` 和有时间上限、稳定 session ID 的 `specgit watch` 观察当前 PR head，读取 JSON 中的实际检查结论。exit 0 仅表示读取成功；当前提交的全部必需门禁通过后才按现有授权使用原生 gh/glab 合并。合并和 Issue 关闭分别回读，checks goal 不代表 lifecycle 完成。
- v1 的 finish、bind、生成式 acceptance workflow 和本地 merge guard 已退役；不重新生成或依赖这些资产，不削弱 GitHub 必需门禁。
- 合并只用 merge commit（`gh pr merge --merge`）；压缩合并和变基合并已禁用，避免分支和 worktree 追踪失效。
- `.specgit.yaml` 是每个检出各自的本地配置；新检出或 worktree 先执行 AGENTS.md 中的 `specgit init` / `specgit setup`。
- `specgit status` 是离线本地证据；checkpoint 分支不匹配时返回所属分支或使用独立 worktree，不丢弃其他交付的 checkpoint。
- 正式发布必须在用户明确授权范围内；已有授权不重复询问。预览、配置偏好和 hook 通知均不增加授权。
- 回退（合并后 CI 挂）永不静默：开 issue、进下一班车、在 Brief 中显式列出。
