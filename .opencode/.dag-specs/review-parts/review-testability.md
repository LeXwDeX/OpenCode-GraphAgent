# PR #167 测试与覆盖审查报告

**测试执行证据**（全部在 `packages/opencode` 内）：
- `bun test test/dag/dag-workflows.test.ts` → **14 pass / 0 fail** ✓（34 expect 调用）
- `bun test test/dag/workflow-tool.test.ts` → **26 pass / 0 fail** ✓（80 expect 调用）
- `bun run typecheck`（tsgo --noEmit）→ **通过，零错误** ✓
- 额外：本地实测执行 release-fork.yml 的 nullglob 打包片段（空 glob → warning + rc=0 + 合法空 tar，M4 修复行为确认）

## 1. findings

| # | severity | title | description | evidence | recommendation |
|---|----------|-------|-------------|----------|----------------|
| F1 | **MEDIUM** | 删除仓库自检测试后，模板完整性校验失去全部回归保护 | 被删测试（旧 L163-189）是唯一锚点：`resolve("change-review")` → StartSpec decode → 每个 `prompt_template.id` 存在 → `depends_on` 引用有效。删除是**必要**的（98e4c0624 删除 4 个模板后旧测试会因 `entry!.path` 抛错），但**无替代**：config 仓库在 repo 外且无 CI 挂钩，"air-gapped installs ship the curated templates"（workflows.ts:12-14）的声明没有任何自动化校验 | `git diff` dag-workflows.test.ts 旧 L163-189（仅删除，无新增）；`rg builtin packages/opencode/test` 零命中 | 在两个仓库之一补锚点：config repo 加 CI（对每个 `*.yaml` 跑 StartSpec decode + prompt-template 引用校验），或本 repo 用 fixture spec 跑一次真实 decode 冒烟 |
| F2 | **MEDIUM** | builtin 三级 scope 全分支零测试覆盖——无注入钩子 | `builtinTemplates()`（workflows.ts:51-56）typeof 守卫在测试环境恒返回 `{}`，`declare const` 运行期无法注入。resolve builtin 兜底（workflows.ts:86-88）、list builtin 合并/遮蔽（workflows.ts:117-120）、`readWorkflowSpec` builtin 分支（workflow.ts:359-370，含缺失 fail 与 YAML 错误两路径）、`searchedScopes` builtin 提及（workflow.ts:395-399）在 40 个测试中全部不可达。project>global 遮蔽有测试（dag-workflows.test.ts:88-94），第三级的优先级契约零断言。**部分缓解**：14+26 个测试全部经守卫分支运行，隐式证明了无 ReferenceError | dag-workflows.test.ts:48-162 无任何 builtin 用例；workflow-tool.test.ts:1038-1184 无 builtin 引用 | 抽取注入面：将 `builtinTemplates()` 改为可注入/可 mock（或单测纯函数 `isBuiltinPath`/`builtinName`/`builtinEntry` + 带 stub map 的 resolve/list 用例），中成本关闭主要缺口 |
| F3 | **LOW/MEDIUM** | generate.ts 的 DAG_TEMPLATES_DIR 加载零测试，且存在测试约束 | `loadDagTemplatesData`（generate.ts:44-57）两个分支（env 未设→`"undefined"` 字面量；env 设→glob `*.yaml`→JSON）均无测试（`rg DAG_TEMPLATES_DIR|dagTemplatesData` 在 test/ 零命中）。关键路径"`"undefined"` 字面量 → define → typeof 守卫"（dev 运行依赖它）无回归保护。约束：import generate.ts 会触发顶层 `fetch(models.dev/api.json)`（generate.ts:24-26），测试需同时设 `MODELS_DEV_API_JSON` + `DAG_TEMPLATES_DIR` + 动态 import——可行但脆弱，解释了缺失 | generate.ts:44-59；`rg -n "DAG_TEMPLATES_DIR" packages --include='*.test.ts'` → 0 | 补一个双 env + 动态 import 的往返测试；或至少在 review 记录中显式接受该风险 |
| F4 | **LOW** | release-fork.yml bash 逻辑：nullglob 守卫**本地实测验证**，GITHUB_ENV 注入链有 Windows 转换缺失风险 | nullglob 片段（release-fork.yml:82-90）本地实测：有文件 → cp 执行 rc=0；空 glob → warning + 不执行 cp + tar 空目录 rc=0（M4 修复确认无 missing-operand 失败）。但 `DAG_TEMPLATES_DIR=$GITHUB_WORKSPACE/dag-templates-src`（release-fork.yml:172-175）无 `cygpath -m` 转换，而同文件 models.dev 步骤（release-fork.yml:145-147）显式转换——windows runner bash 下 GITHUB_WORKSPACE 为 POSIX 形 `/d/a/...`，原生 Bun 进程可能无法解析 → **Windows 发布版静默丢失 builtin 模板**（glob 空不报错）。本机无 Windows 无法验证 | release-fork.yml:82-90（实测）/ 172-175（静态）；本地 bash 复现输出 rc=0 无报错 | 与 models.dev 同款加 `cygpath -m` 转换（或用 `${{ github.workspace }}` 原生形变量）；最低限度在 release 后 smoke 断言二进制内置模板数 |
| F5 | **LOW** | M1 并发锁：现有锁测试与 `/dag-template-update` 的锁无关，update 锁结构性不可测 | dag-workflow-lock.test.ts:8-58 覆盖的是 `Dag.Service.extend` 同 workflow 串行化（mock DagStore 25ms sleep + `maxActiveReads===1`），是运行时锁，本 PR 未动。update 命令的 `.dag-update.lock`（dag-template-update.txt:67-78）是 **prompt 级契约**——无代码执行它，测试环境没有任何自动化手段验证（mkdir 原子性、重试、清理、陈旧锁无恢复均为 agent 行为） | dag-workflow-lock.test.ts 全文（未变更文件）；dag-template-update.txt:67-78 | 接受现状并显式声明：该锁只有靠 agent 按 prompt 执行 + 人工 review；或未来把锁逻辑下沉为可测代码 |
| F6 | **LOW** | 测试纪律：符合"测真实实现"要求，无逻辑复制 | resolve/list 测试用真实 tmpdir fs fixture + 真实函数（无复制查找逻辑）；workflow-tool 用真实 tool execute + 真实文件；锁测试用 `Layer.mock`（AGENTS.md 认可模式）。fixture 辅助函数（spec/savedSpec）是输入构造，非实现副本 | dag-workflows.test.ts:13-30, 71-162；workflow-tool.test.ts:1058-1059 | 无动作 |
| F7 | **LOW** | generate.ts:52 `\.ya?ml$` 的 `?` 是死代码；`.yml` 在打包链被静默丢弃 | glob 仅 `*.yaml`（generate.ts:51），`?` 分支不可达；release 打包 `dag-config/*.yaml`（release-fork.yml:83）与 update prompt 同。而运行时 `EXTENSIONS` 含 `.yml`（workflows.ts:33）——config repo 若放 `.yml`，对二进制与打包均不可见，依赖 repo 布局约定（U2） | generate.ts:51-52 | 三处统一为 `.ya?ml` 或显式文档化"config repo 只接受 .yaml" |
| F8 | **LOW** | builtin 内容绕过 1MB size 检查 | 文件分支有 size 检查（workflow.ts:376-380），builtin 分支无（workflow.ts:360-369）——构建期策展内容，风险低但属隐式信任面 | workflow.ts:359-370 vs 376-380 | 可接受，记录即可 |

## 2. unverified_claims

- **U1**：Windows runner 上 POSIX 形 `DAG_TEMPLATES_DIR`（`/d/a/...`）在原生 Bun 进程能否解析——若不能，Windows 发布版静默丢失 builtin 模板（release-fork.yml:172-175 vs :145-147 的 cygpath 不对称）。无 Windows 环境，无法本地验证。
- **U2**：opencode-dag-config 仓库根目录只含 `*.yaml`（顶层）——若有 `.yml` 或子目录会被打包与注入链静默丢弃（仓库私有，无法查看）。
- **U3**：`generate.ts` 返回的 `"undefined"` 字符串经 Bun.build define 注入后成为 `undefined` 关键字、触发 typeof 守卫——按 `OPENCODE_MODELS_DEV` 同构模式推断（生产已验证该机制），本地未跑 release 构建。
- **U4**：release 产出的二进制实际包含模板——仅静态验证 define 注入链 + CI job 图（config repo 私有，本地无法复现 release 构建）。
- **U5**：`/dag-template-update` 提示词行为（下载/合并/备份/锁/验证）无法自动化验证——纯 prompt 契约，只能靠 agent 执行后人工审计。

## 3. coverage_gaps

| path | untested_scenarios[] |
|------|---------------------|
| `packages/opencode/src/dag/workflows.ts` | resolve 的 builtin 兜底命中（L86-88）；list 的 builtin 条目合并/排序/被 project 与 global 遮蔽（L117-120）；`builtinTemplates()` 守卫的"有值"正分支（L51-56，测试只走空分支）；`isBuiltinPath`/`builtinName`（L126-133）；`builtinEntry`/`parseMeta` 经 builtin 路径（L135-137, 158-167） |
| `packages/opencode/src/tool/workflow.ts` | `readWorkflowSpec` builtin 分支两条失败路径：内容缺失 fail（L362-364）、YAML 解析错误（L365-368）；`searchedScopes` 追加 "the release's builtin templates" 的分支（L395-399，当前测试 env 下恒不触发） |
| `packages/opencode/script/generate.ts` | `loadDagTemplatesData` 两分支（L44-57）：env 未设返回 `"undefined"`；env 设时 glob 收集 → name 去扩展名 → JSON 序列化往返 |
| `.github/workflows/release-fork.yml` | package-templates 空 glob 路径（本地 bash 实测过，非 CI 实测）；Extract Templates 的 GITHUB_ENV 注入在 windows runner 的行为（U1） |
| 已删除测试的覆盖面（无替代锚点） | StartSpec decode 有效性；`prompt_template.id` 引用存在性；`depends_on` 完整性——模板迁到 config repo 后**任何地方**都没有自动化校验 |

## 4. summary

测试状态完全符合预期（14+26 pass、typecheck 干净），且测试纪律合规（测真实实现、Layer.mock 模式、无逻辑复制）；nullglob 空 glob 修复经本地实测确认行为正确。主要问题是 F1/F2：第三级 builtin scope 是新行为契约却零测试覆盖，且删除仓库自检测试后模板完整性校验在两侧仓库都没有锚点——这是 PR 最大的测试缺口，建议优先补注入面测试 + config repo CI。release 流水线（F4/U1/U4）只能静态审查 + 依赖 Windows runner 与 config repo 的后续实证，属已知不可本地验证面，其中 Windows 路径转换缺失是最值得在合并前修复的低成本风险点。