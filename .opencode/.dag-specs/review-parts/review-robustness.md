所有关键证据已收集并验证（测试 14/14 通过、resolve 调用面确认、命令注册链确认、draft.update 创建语义确认）。以下是运行时健壮性审查报告。

---

# PR #167 运行时健壮性审查

## 1. Findings

| # | Severity | Title | Description | Evidence | Recommendation |
|---|----------|-------|-------------|----------|----------------|
| F1 | **HIGH** (unverified 行为) | Windows 构建 `DAG_TEMPLATES_DIR` 缺 cygpath 转换，1/3 平台发布版可能静默无内置模板 | `Extract Templates` 将 `$GITHUB_WORKSPACE/dag-templates-src` 裸写入 GITHUB_ENV；同一文件 22 行前的 models.dev step 对 `$RUNNER_TEMP` 显式 `cygpath -m`（说明作者已知 MSYS/原生路径混用坑），此步却无转换。若 Windows runner 下 Bun 无法解析该路径 → glob 0 模板 → 构建成功、发布照发、builtin 静默为空，仅 build 日志一行 "0 templates" | `.github/workflows/release-fork.yml:175` vs `:145-147` | 与 models.dev 同款防御：`DAG_TEMPLATES_DIR="$(cygpath -m "$GITHUB_WORKSPACE/dag-templates-src")"`，或改用原生 `${{ github.workspace }}` 上下文 |
| F2 | MEDIUM | builtin 注入缺失仅静默降级，无任何显式失败门禁 | env 存在但 glob 0（Windows 路径 bug、config repo 无 yaml、tar 空）→ `JSON.stringify({})` → 二进制无 builtin，release 照常成功。`generate.ts:55` 日志不参与 CI 判定。审查准则 3 的答案是：**静默降级，无显式报错路径**（与 models.dev `:158` warning 同构，属团队既有模式） | `script/generate.ts:51-56`、`release-fork.yml:87` | 在 package-templates job 或 build-cli 增加显式校验 step：模板数 > 0 否则 fail-loud（空 config repo 时发布中止而非静默发无 builtin 版） |
| F3 | MEDIUM | `/dag-template-update` 孤儿锁无恢复路径 | 锁用 `mkdir .dag-update.lock` 原子判定，但 prompt 无 mtime/age 检测、无强制清除、无"锁陈旧则接管"路径。agent 进程崩溃/被杀后锁永久残留，后续更新永远停在"another update is already running"，恢复只能靠用户手动 rmdir（提示词未指导） | `dag-template-update.txt:67-78` | 补充锁龄检测（如超过 N 分钟视为陈旧，允许接管）或明确指导用户删除锁目录的恢复步骤 |
| F4 | MEDIUM | 锁的父目录前置条件缺失：全新机器 ENOENT 误判 | 锁路径为 `<config dir>/workflows/.dag-update.lock`，目录创建指令（`:97`）位于 Failure handling 段，晚于锁步骤（`:70`"before downloading or merging"）。全新机器 `<config dir>/workflows` 不存在时 `mkdir` 报 ENOENT 而非 EEXIST，agent 可能误判"另一更新进行中"而停止 | `dag-template-update.txt:70,72,97` | 明确顺序：先 `mkdir -p <config dir>/workflows` 再取锁；并将 ENOENT 与 EEXIST 的判别写进提示词 |
| F5 | MEDIUM | builtin 新功能零测试覆盖，模板契约校验随旧测试删除而消失 | `builtinTemplates()`、resolve builtin 兜底、list builtin 合并、`isBuiltinPath/builtinName`、`readWorkflowSpec` builtin 分支、`searchedScopes` 提示全部无测试（测试环境守卫返回 `{}`，无注入钩子）。旧 "repository's own workflow library" 测试（模板 `depends_on`/`prompt_template.id` 完整性校验）删除后，config repo 模板与本仓库 CI 完全脱钩 | `test/dag/dag-workflows.test.ts`（14 测全过但无 builtin 用例）、`dag-workflows.test.ts:161-187` 删除块 | 在 config repo 加独立 CI 校验 spec 结构；本仓库可加 `DAG_TEMPLATES_DIR` 指向 fixture 的构建期注入测试（generate.ts 可直接单测） |
| F6 | MEDIUM | dag-flow.txt 与运行时三级 scope 及实际模板名漂移 | prompt 只描述 two scopes（`:13`）、称 global "curated by the opencode-dag-config repo"（`:14`）、指名 4 个**本 PR 已删除**的提交模板（`:17-20`）。开箱即用用户（未跑 update、无全局目录）的模板只在 builtin 层，但 prompt 引导的名字与二进制实际内容（构建时从 config repo HEAD 动态取）**零同步校验**——config repo 改名即解析不到 | `dag-flow.txt:13-20` | 补 builtin 层描述；删除/弱化固定模板名（改为"按 list() 输出选择"）；构建时校验 dag-flow.txt 提及名 ⊆ builtin 名或删名 |
| F7 | MEDIUM | 供应链 pin 缺失：release 与 update 均取 config repo HEAD | `actions/checkout` 无 `ref`（release-fork.yml:73-77）、codeload URL 固定 `refs/heads/main`（dag-template-update.txt:32）。任何推送到 config repo 的提交（包括恶意或意外）立即进入所有新发布二进制，且内置模板信任级声明弱（workflows.ts:12-14 仅说 "curated"） | `release-fork.yml:76`、`dag-template-update.txt:32`、`workflows.ts:12-14` | 至少 pin tag/commit 并在 workflow 注明；信任边界文档（builtin 与 dag.jsonc 同级）显式写入说明 |
| F8 | LOW | 备份文件 `.bak-*` 永久累积 | 每次 overwrite 生成一个带时间戳备份，无清理策略、无数量上限。已被 `list()` 的 EXTENSIONS 过滤不污染库列表，但长期更新磁盘持续膨胀 | `dag-template-update.txt:62-65` | 补充保留策略（如保留最近 N 份）或提示用户清理 |
| F9 | LOW | 锁重试次数未具体化 | "wait briefly and retry a few times"（`:75`）由 agent 自由裁量，无明确次数/间隔，行为不可复现 | `dag-template-update.txt:75-76` | 给出具体值（如 3 次 × 2 秒） |
| F10 | LOW | list 展示的 `builtin://name` 路径不可回填且报误导性错误 | 用户把列表路径回填 spec_path → `path.resolve` 折叠 `//` → 非 builtin 分支 → 报 "must be a .yaml or .yml file"（:416-417），而非提示用裸名 | `workflows.ts:58,131-133`、`tool/workflow.ts:415-418` | 路径分支对 `builtin://` 前缀给出"请用裸名"提示 |
| F11 | LOW | builtin 内容绕过 1MB 大小检查 | `MAX_WORKFLOW_SPEC_BYTES` 检查仅文件分支（:376-380），builtin 分支（:360-370）直接解析。构建期信任可接受，但 config repo 若被塞大文件 → 二进制膨胀 + 无防护 | `tool/workflow.ts:360-370` vs `:376-380` | 构建期 generate.ts 对模板体积设上限即可 |
| F12 | LOW | 空库消息中 builtin 提及为死代码 | `searchedScopes` 在 builtin map 非空时附加 builtin 文案，但 map 非空时 `list()` 必然含 builtin 条目 → `entries.length === 0` 永不成立 | `tool/workflow.ts:142-147,395-399` | 删除条件或接受为无害冗余 |
| F13 | LOW | build-cli checkout 未 pin `github.sha` 而 release `--target` 锚定 sha | workflow_dispatch 下默认检出分支 tip，构建期间新 push → 二进制与 tag 锚点不一致（低概率） | `release-fork.yml:124-126` vs `:264` | checkout 加 `ref: ${{ github.sha }}` |
| F14 | LOW | `.yml` 三处不一致：运行时支持、构建/打包/更新只认 `.yaml` | `EXTENSIONS` 含 `.yml`（workflows.ts:33），但 generate.ts glob（:51）、release 打包（:83）、update prompt 全只取 `*.yaml`；`\\.ya?ml$` 的 `?` 是死代码 | `workflows.ts:33`、`generate.ts:51-52` | 统一为 `.yaml` 或补齐 `.yml` |

**已修复项确认**（无回退）：ReferenceError 守卫正确（`typeof` 语义，workflows.ts:54）；Entry 去重正确（seen-map，:104-120）；M4 空 glob 正确（`shopt -s nullglob` + 数组守卫，release-fork.yml:82-88）；重复下载 step 已删。**路径穿越检查**：`resolve()` 唯一调用方经 `isName`（拦截 `/`、`\`、extname、控制字符、`.` 开头）→ `path.join` 无穿越面；builtin map key 来自构建期 glob 文件名（非递归）→ 安全；`builtinName()` 仅作 map 索引与错误文案，无 fs 操作 → 安全。**parseMeta 容错**：恶意 YAML 只影响 title/nodes 元数据显示（类型守卫，:162-165），start 路径 fail-loud（workflow.ts:364-368）→ 满足"恶意 YAML 只影响元数据解析"。**下载/解压失败**：prompt 强制原文报错且停（:94-96），内容级 verify 兜底（:80-90）→ 满足准则 5。**失败传播**：package-templates 任一失败（clone/tar/upload）→ build-cli、release 全部 skip → run failed、无 release 产出 → fail-loud 中止正确。

## 2. Unverified Claims

1. **Bun@Windows 对 `D:\a\...` 风格 `DAG_TEMPLATES_DIR` 的 `Bun.Glob.scan({cwd})` 解析行为** —— 决定 F1 实际影响；无本地环境可验证
2. **GitHub Actions windows runner 的 bash 中 `$GITHUB_WORKSPACE` 实际形态**（`D:\a\...` 原样 vs MSYS 转换）—— F1 前提
3. **opencode-dag-config 仓库根目录布局**：顶层 `*.yaml` 假设、模板名集合、与 dag-flow.txt 所列 4 个名字（design-decision-loop 等）是否匹配 —— F6 实害
4. **node 构建产物（build-node.ts:23 未注入 define）是否属用户分发路径** —— 若 npm 分发则这些用户无 builtin
5. **release 二进制实际包含 builtin 模板** —— 无法本地构建验证（config repo 私有/外网），仅静态确认 define 链
6. **xdg-basedir 在 Windows 的实际回退路径**（dag-template-update.txt:22-24 仅声明 macOS/Linux）—— update 命令写入位置与运行时读取位置（workflows.ts:145）一致性

## 3. Failure Scenarios

| Scenario | Impact | Likelihood |
|----------|--------|------------|
| Windows runner `DAG_TEMPLATES_DIR` 不可解析 → 3 平台中 windows 版静默无内置模板，发布照常成功 | Windows 用户开箱即用无 curated 模板，无任何失败信号 | MEDIUM（cygpath 不对称是强信号，但 Bun@Windows 行为未证） |
| config repo 克隆失败 / tar 失败 / artifact 上传失败 | 整条 needs 链（build-cli + release）skip，run 失败、无 release 产出 —— 失败传播正确、fail-loud | LOW（网络/瞬时故障，手动重试即可） |
| config repo 空或无 `*.yaml` | warning + 空 tar → 全平台二进制无 builtin，release 照发（仅日志可见） | LOW（作者自控仓库） |
| `/dag-template-update` 执行中 agent 进程崩溃 → 孤儿锁 | 所有后续更新永久阻塞，需用户手动 rmdir 恢复；无提示指导 | MEDIUM（长任务中断概率非零） |
| 全新机器执行 `/dag-template-update` | 锁 mkdir ENOENT 被误判为并发冲突而中止更新 | MEDIUM（prompt 顺序歧义） |
| config repo 模板改名/损坏 YAML | 损坏 → list 容错、start 报清晰错误（✓）；改名 → dag-flow.txt 引导的名字解析不到，agent 走兜底多耗一轮 | MEDIUM（跨仓库契约无门禁） |

## 4. Summary

代码层健壮性整体良好：运行时三级解析/去重/容错/路径安全全部验证通过，release 失败传播是 fail-loud 中止（正确行为），已修复的 4 项确认无回退。主要风险集中在**边界静默性**：Windows 路径转换缺失（F1，修复成本一行）与 builtin 注入缺失无 CI 门禁（F2）会让发布版无声降级；`/dag-template-update` 作为纯 prompt 命令缺乏孤儿锁恢复与目录前置处理（F3/F4），崩溃恢复体验脆弱。测试缺口（F5）与 dag-flow.txt 模板名漂移（F6）是中等风险，需 config repo 侧 CI 或构建期校验补齐。无 CRITICAL 项，建议 F1/F2 修复后合并。