探索完成。所有目标文件已读取，关键声明已对运行时源码逐条核验。以下为探索报告。

---

## Hit Summary

PR #167 的构建注入链、三级 scope 解析、命令注册、release 流水线在代码层面自洽：`typeof` 守卫（dev 无 define 时不抛 ReferenceError）、`seen` 去重、空 glob 均修复正确，prompt 的配置目录解析顺序与运行时（`flag.ts:63-64` + `global.ts:3,13` + xdg-basedir）**逐字一致**。主要问题集中在：**dag-flow.txt 描述"two scopes"与运行时三级不符**、**builtin 新功能零测试覆盖**、**README 死链/过时声明**、**prompt 锁语义两个缺口（父目录前置条件、陈旧锁无恢复）**。置信度：高（静态证据充分；仅 node 构建分发路径与 Windows xdg 行为留待 verify 波确认）。

---

## Key Symbols

- `packages/opencode/script/generate.ts:44` `loadDagTemplatesData()` — 读 `DAG_TEMPLATES_DIR` env，`Bun.Glob("*.yaml")` 根级扫描，`file.replace(/\.ya?ml$/, "")` 取名字，`JSON.stringify(templates)` 输出（unset 时返回字符串 `"undefined"`）；与 `loadModelsData()`（generate.ts:12-33）同构：同是"env 快照 → 字符串（JSON 或 `"undefined"`）→ 导出 → define 注入"模式
- `packages/opencode/script/generate.ts:59` `dagTemplatesData` — 模块顶层 await 导出；`build.ts:16` `await import("./generate.ts")`，`build.ts:203` 注入 `OPENCODE_DAG_TEMPLATES: generated.dagTemplatesData`（裸文本替换：JSON 字面量或 `undefined` 关键字，均合法表达式）
- `packages/opencode/src/dag/workflows.ts:30` `declare const OPENCODE_DAG_TEMPLATES: Record<string, string> | undefined` — 与 `packages/core/src/models-dev.ts:114,185-187` 的 `OPENCODE_MODELS_DEV` 守卫模式完全一致
- `packages/opencode/src/dag/workflows.ts:51` `builtinTemplates()` — `typeof` 守卫（未绑定标识符在 typeof 下安全，不抛 ReferenceError — 修复正确）
- `packages/opencode/src/dag/workflows.ts:77` `resolve()` / `:102` `list()` / `:135` `builtinEntry()` / `:126-133` `isBuiltinPath`/`builtinName`（`BUILTIN_PREFIX = "builtin://"` 在 :58）
- `packages/opencode/src/tool/workflow.ts:359-370` — `readWorkflowSpec` 的 builtin 分支（`isBuiltinPath` → 查 map → `Bun.YAML.parse(content)`）
- `packages/opencode/src/tool/workflow.ts:395-399` `searchedScopes()` — 空库/未找到提示附加 "the release's builtin templates"
- `packages/core/src/plugin/command.ts:41-45` — `draft.update("dag-template-update", ...)` 注册（与 dag-flow 的 :37-40 同模式）
- `.github/workflows/release-fork.yml:66-97` `package-templates` job、`:163-175` 下载/解压/`DAG_TEMPLATES_DIR` 环境注入

---

## Call Relationships

- **构建期**：`release-fork.yml:80-89`（打包 `dag-config/*.yaml`）→ `DAG_TEMPLATES_DIR` env（:175）→ `generate.ts:44` → `build.ts:16,203` define → 二进制常量 → `workflows.ts:51 builtinTemplates()` → `resolve()`（:86-88 兜底层）/ `list()`（:117-120）/ `tool/workflow.ts:360-364`
- **运行时名字解析**：`workflow(action:start)` → `tool/workflow.ts:408 resolveSpecPath`（isName 分支）→ `workflows.ts:77 resolve`（project → global → builtin）→ 返回 `builtin://name` 路径 → `:360` builtin 分支解析内容
- **命令面**：`command.ts:41-45` 注册 `/dag-template-update`（draft.update + `.txt` import，:11）；`/dag-flow` 同模式（:37-40）；`command/index.ts:51` 有 `Default.DAG_FLOW` 常量但**无** `DAG_TEMPLATE_UPDATE` 条目（是否必需 → unverified）
- **release 流水线**：`package-templates`（仅 workflow_dispatch，:68）→ `build-cli`（needs :101 + 自身 `if: workflow_dispatch` :105）→ `release`（needs 两者 + `create_release` 门，:220-221）；push 触发时三者全跳过、仅 `register` 跑 — **needs 链不因 push 中断** ✓

---

## 1. 完整构建期数据路径

`release-fork.yml:163-175`（download-artifact `dag-templates` → `tar -xzf` → `DAG_TEMPLATES_DIR=$GITHUB_WORKSPACE/dag-templates-src` 写入 GITHUB_ENV）→ `generate.ts:45` 读 env → `:51` `Bun.Glob("*.yaml").scan({cwd})`（仅根级，非递归）→ `:52` 名字去扩展名 → `:53` `Bun.file().text()` → `:56` `JSON.stringify(templates)`（值为 JSON 文本，esbuild define 裸粘贴为对象字面量；模板内引号/反斜杠由 stringify 正确转义，无注入面）→ `:59` 导出 → `build.ts:203` define → 编译进单文件二进制 → 运行时 `workflows.ts:51-56` 守卫后按名取用。**注**：`build-node.ts:23` 与 `packages/cli/script/build.ts:92` 只注入 `OPENCODE_MODELS_DEV`、未注入 `OPENCODE_DAG_TEMPLATES` → node 目标构建无 builtin（守卫优雅降级为两级）；"air-gapped installs ship the curated templates"（workflows.ts:12-14）仅对 bun 单文件构建成立（UNVERIFIED：node 构建是否属用户分发路径）。

## 2. dev 下 DAG_TEMPLATES_DIR unset 的行为

- `generate.ts:46-49`：打日志并返回字符串 `"undefined"` → define 注入裸 `undefined` 关键字 → `workflows.ts:54` `typeof ... === "undefined"` → 返回 `{}`。
- 源码 dev 运行（bun dev 无 define）：标识符未绑定，`typeof` 对未声明标识符不抛错 → 同路径返回 `{}`。**ReferenceError 守卫修复正确**（typeof 是唯一安全探测方式）。
- 后果链：`resolve` 返回 undefined（"not found"提示不含 builtin）→ `list` 空 → `searchedScopes`（tool/workflow.ts:397）不附加 builtin 提及。**全部优雅降级** ✓

## 3. 命令注册模式对比

`command.ts:41-45`：`draft.update("dag-template-update", (command) => { command.template = DAG_TEMPLATE_UPDATE_PROMPT; command.description = DagTemplateUpdateDescription })` — 与 dag-flow（:37-40）逐行同构（import 于 :11）。唯一不对称：`command/index.ts:51` 的 `Default` 枚举只有 `DAG_FLOW`，无 `dag-template-update`（该枚举用途未确认 — unverified；若 TUI/命令面依赖它，新命令可能不完整）。

## 4. dag-template-update.txt 逐节语义（M1/M2/M3）

- **配置目录（L16-24）**：`OPENCODE_CONFIG_DIR` env → xdg 平台目录（XDG_CONFIG_HOME，兜底 `~/.config/opencode`）。**与运行时逐字一致**：`flag.ts:63-64`（读 env）+ `global.ts:3,13`（xdg-basedir；macOS 默认 `~/.config/opencode`，非 Library/Application Support）✓ 已验证
- **下载（L26-37）**：固定 `codeload.github.com/LeXwDeX/opencode-dag-config/zip/refs/heads/main` — 未 pin tag/commit（与 release clone 同为 HEAD，可复现性弱，LOW）
- **干跑分类（L39-49）**：NEW/UNCHANGED/UPDATE + local-only 保留 ✓
- **合并 QA（L51-61）**：无 UPDATE 直合；有 UPDATE 时三选项（全覆盖先备份/全跳过/逐文件）+ 拒绝只加 NEW ✓
- **备份（L62-65）**：`<name>.yaml.bak-<YYYYMMDD-HHMMSS>` 放原文件旁；备份失败 → **中止该文件覆盖并报告，绝不无备份覆盖** ✓ **M2 满足**。备份文件 extname 为 `.bak-*`，被 `list()` 的 EXTENSIONS 过滤（workflows.ts:109-110）不会污染库列表 ✓
- **锁（L67-78）**：`mkdir .dag-update.lock` 原子判定（L72-74）、短暂等待重试数次（L75-76）、合并结束含失败时 `rmdir`（L77-78）✓ **M1 满足（存在+重试+清理）**。锁目录被 `list()` 的 `isFile()` 过滤（:108）✓
  - **缺口 A（M2/M3）**：锁在"下载前"创建（L70），但 `<config dir>/workflows` 不存在时 `mkdir` 失败是 **ENOENT 而非 EEXIST**；提示词只在 L97（Failure handling）说"applying 前创建目录" — 锁步骤的父目录前置条件缺失，顺序歧义，agent 可能误判 ENOENT
  - **缺口 B（M2/M3）**：陈旧锁无恢复路径 — agent 崩溃/被杀后 `.dag-update.lock` 永久残留，后续更新永远停在"another update is already running"；无 mtime/age 检测、无强制覆盖或提示手工清除
- **验证（L80-90）**：重读每个更新文件与归档副本**逐内容比对**（L85-86）+ `workflow(action:list)` 计数与变更名单（L87-89）+ 报告备份位置 ✓ **M3 满足（内容比较，非仅列表）**；并正确提示项目级 shadow 影响列表可见性
  - **缺口 C（LOW）**：内容比对不一致时无恢复动作（未提回滚备份/重试）
- **失败处理（L92-97）**：下载失败 verbatim 报告并停（L94-95）✓；解压失败报告并停（L96）✓；合并中途复制失败未明确覆盖（LOW）；锁清理覆盖"包括失败" ✓

## 5. dag-flow.txt 与运行时不一致（确认存在）

- **dag-flow.txt:13**："Reference templates are installed in **two scopes** (project overrides global...)" — 运行时是**三级**（project → global → builtin，workflows.ts:9-14）。builtin 层在 dag-flow.txt 中**完全缺失**；对开箱即用（未跑 update、无 config repo）用户，curated 模板恰恰只存在于 builtin 层，提示词描述的 global 层是空的
- **dag-flow.txt:14**："global ... curated by the `opencode-dag-config` repo" — 只有跑过 `/dag-template-update` 才成立；curated 快照的实际载体是二进制内置层
- **dag-flow.txt:17-20**：指名 4 个 saved workflow（design-decision-loop 等）— 这些是本次**删除**的提交模板（`git diff` 872 行删除）；dev checkout 无 config repo 时这些名字解析不到，agent 只能走 :21 的 "no close match" 兜底。提示词假设模板常驻，与实际可用性脱节
- **dag-flow.txt:16** "pick by name or path" — `list()` 对 builtin 项展示的路径是 `builtin://<name>`（workflows.ts:58,131-133），该路径**不能**作为 spec_path 回传：`resolveSpecPath` 走 path 分支后在 extname 检查失败（tool/workflow.ts:416-418，报 "must be a .yaml or .yml file"）— 误导性报错。应只按名选

## 6. 边界情况

- **空模板目录**：Glob 零匹配 → `{}` → `"{}"` → define 注入 `{}` → `typeof {}` 为 "object" → `builtinTemplates()` 返回 `{}` → 无 builtin 项 ✓（release 空 tar 时 `release-fork.yml:87` 打 warning，同样优雅）
- **非 yaml 文件**：`generate.ts:51` glob 过滤 ✓；release 打包 `dag-config/*.yaml`（release-fork.yml:83）✓；update prompt 指示取 `*.yaml` ✓ — 三层一致
- **名称冲突**：`resolve` 顺序 project→global→builtin（:79-89）+ `list` seen-map（:104-120）优先级一致，listing 不会广告 resolve 选不中的项 ✓；`dag-template-update.txt:101-103` 正确提示 shadow
- **`.yml` 漂移（LOW）**：运行时 `EXTENSIONS` 含 `.yml`（workflows.ts:33），但 generate.ts glob、release 打包、update prompt 全只认 `.yaml` → config repo 若未来放 `.yml` 模板，对 binary 和打包不可见
- **`generate.ts:52` 的 `\.ya?ml$` 中 `?` 是死代码**（glob 只匹配 `.yaml`）— 风格 nit

## 其他发现（供 review/verify 波）

1. **零新增测试（MEDIUM）**：`dag-workflows.test.ts` 无任何 builtin 测试（仅 project/global fixture）；`workflow-tool.test.ts` 无 builtin 引用（:1039 只有 global scope env 重定向）。新功能面（三级优先级、builtinEntry、parseMeta 重构、typeof 守卫、searchedScopes）全部无测试。被删的 "repository's own workflow library" 测试是唯一真实 spec 校验
2. **README 死链/过时（MEDIUM, docs）**：`README.md:253` 引用已删除的 `./.opencode/workflows/change-review.yaml`；`README.zh.md:27` "仓库已经附带三类强约束参考图"（已不成立）、`:66-67` 两 scope 表缺 builtin 层
3. **`Entry.content` 死字段（LOW）**：`builtinEntry`（workflows.ts:135-137）设置，但 `readWorkflowSpec` 重新查 `builtinTemplates()`（tool/workflow.ts:360-364），全仓库无消费方
4. **release-fork.yml**：job 图静态分析通过（push 触发不断链、`download-artifact` merge-multiple 将 `dag-templates.tar.gz` 带入 release 资产 — 与头部注释 :24-25 一致，属意图）；config repo 未 pin tag（LOW）；`tar -xzf` 在 windows-latest runner 可用（bsdtar）
5. **已修复项确认**：ReferenceError 守卫 ✓（typeof 语义安全）、Entry 去重 ✓（seen-map）、M4 空 glob ✓（Array.fromAsync 空集安全）、重复下载删除 ✓（最终 diff 中 build-cli 仅一个下载 step）

## Related Test Files

- `packages/opencode/test/dag/dag-workflows.test.ts` — resolve/list 仅 project/global；**builtin 无覆盖**（移除的 library 测试是唯一真实 spec 校验）
- `packages/opencode/test/dag/workflow-tool.test.ts:1039` — global scope 经 OPENCODE_CONFIG_DIR 重定向的集成测试（可作为 builtin 测试锚点）
- `packages/opencode/test/dag/dag-config.test.ts` — config dir env 重定向模式参考

## output_variables

- targets:
  - `loadDagTemplatesData@packages/opencode/script/generate.ts:44`
  - `dagTemplatesData@packages/opencode/script/generate.ts:59`
  - `builtinTemplates@packages/opencode/src/dag/workflows.ts:51`
  - `resolve@packages/opencode/src/dag/workflows.ts:77`
  - `list@packages/opencode/src/dag/workflows.ts:102`
  - `builtinEntry@packages/opencode/src/dag/workflows.ts:135`
  - `readWorkflowSpec@packages/opencode/src/tool/workflow.ts:350`
  - `searchedScopes@packages/opencode/src/tool/workflow.ts:395`
  - `command.ts:41` `/dag-template-update` 注册
  - `dag-template-update.txt`（L16-103 全文件）
  - `dag-flow.txt:13-21`
  - `release-fork.yml:66-97,163-175`
- impacted_processes: [WorkflowLibrary 名字解析（resolve/list/start）、/dag-template-update 命令、release 流水线模板打包与注入]
- test_anchors: [dag-workflows.test.ts, workflow-tool.test.ts:1039, dag-config.test.ts]
- ast_available: true（codebase-memory-mcp 已索引本 repo，head 2ee59d874；本次探索以 git diff 为准，未依赖图查询）

**留给 verify 波的 unverified_claims**：① `build-node.ts`（target: node, src/node.ts）与 `packages/cli/script/build.ts` 产物是否为用户分发路径（决定缺 define 的严重性）；② `command/index.ts:51` Default 枚举是否需要 dag-template-update 条目；③ xdg-basedir 在 Windows 的实际回退路径（prompt 仅声明 macOS/Linux）；④ 本 repo 8 个未跟踪模板与 builtin 名是否冲突（本地 shadow）；⑤ `bun test dag-workflows/workflow-tool` 实测通过性。