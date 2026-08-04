All exploration complete. Here's the report.

---

## Hit Summary

PR #167 的 4 个 commit（676e0463e → 2ee59d874）将 DAG 参考模板从仓库内 `.opencode/workflows/` 抽离到独立配置仓库，新增 builtin 三级 scope（project > global > builtin）编译进二进制，新增 `/dag-template-update` 命令，并扩展 release 流水线打包模板资产。release-fork.yml 的 job 图、env 注入链、空 glob 守卫均已静态验证；builtin scope 在测试环境中**完全无覆盖**（无注入钩子），Windows 构建的 DAG_TEMPLATES_DIR 路径转换存在未决风险点。信心：高（源码侧），中（Windows runner 行为需 verify 波确认）。

---

## 1. Job Graph（release-fork.yml）

```
push(main/dev, paths=release-fork.yml) ──► register (if: push, no-op)
workflow_dispatch ──► package-templates (if: workflow_dispatch, ubuntu, contents: read)
                       │
                       ├──needs──► build-cli (if: workflow_dispatch, 3-OS matrix ×3)
                       │              └─ 每步再叠加 if: platforms=='' || contains(platforms, matrix.name)
                       └──needs──► release (if: inputs.create_release)
                                      └─ needs: [build-cli, package-templates]
```

- **if 条件**：`release-fork.yml:68` package-templates、`:105` build-cli 均门控 `github.event_name == 'workflow_dispatch'`（push 注册模式下全 skip，skip→needs 视为 success，不会级联失败）；`:221` release 门控 `inputs.create_release`（push 时 inputs 为空 → falsy → skip）。`:271` register 门控 `push`。
- **平台过滤在 step 级**（`:123/129/143/164/171/178/187/191/210` 每步重复 `if: inputs.platforms == '' || contains(...)`），job 级无法引用 matrix —— 注释已说明（`:102-104`）。selected-platforms 时被过滤的 matrix job 仍会跑但所有 step skip，不上传 artifact。

## 2. Env 注入链（验证通过）

```
package-templates: dist/*.yaml → tar -czf dag-templates.tar.gz → upload-artifact name=dag-templates (retention 7d)
  build-cli (needs package-templates):
    step "Download Templates Artifact" (:163-168) → dag-templates-artifact/dag-templates.tar.gz
    step "Extract Templates" (:170-175): tar -xzf -C dag-templates-src
        → echo "DAG_TEMPLATES_DIR=$GITHUB_WORKSPACE/dag-templates-src" >> $GITHUB_ENV
    step "Build CLI" (:177-182): env 块只有 OPENCODE_CHANNEL/OPENCODE_VERSION
        → DAG_TEMPLATES_DIR 经 GITHUB_ENV 自动继承，无需显式 env: ✓
```

build.ts:16 `await import("./generate.ts")` → generate.ts:44-60 读 `process.env.DAG_TEMPLATES_DIR` → `Bun.Glob("*.yaml").scan` → `JSON.stringify(templates)` → build.ts:203 `define: OPENCODE_DAG_TEMPLATES: generated.dagTemplatesData`。`DAG_TEMPLATES_DIR` 未设置时 generate.ts 返回字符串 `"undefined"`（generate.ts:52），经 esbuild/Bun define 原样注入为 `undefined` 关键字 → `typeof` 守卫命中 → 空 map。此 round-trip 与 `OPENCODE_MODELS_DEV`（generate.ts:33，models-dev.ts:185-187 同款 typeof+Object.keys 守卫）完全同构，是已验证的生产模式 ✓。

## 3. Empty-Glob 行为（M4 修复确认正确）

- `release-fork.yml:82-90`：`shopt -s nullglob` + 数组长度守卫，空 glob → `::warning::No templates found...` + **不执行 cp** → `tar -czf` 打空目录（`mkdir -p dist` 先于判断，tar 空目录合法）→ **warning + 空 archive，不失败** ✓。修复前的 bug 版本（2ee59d874 之前）是 `cp "${files[@]}" dist/` 无条件执行，空数组时 `cp dist/` 报 missing operand 使 step 失败。
- 空 archive → generate.ts glob 0 个文件 → `{}` → builtin scope 为空，二进制静默降级为无 builtin ✓。

## 4. Release 资产流 + --target 语义

- release job（`:227-231`）`download-artifact@v4 + merge-multiple: true` 拉取**本 run 全部 4 个 artifact**（opencode-{linux,macos,windows} + dag-templates），无文件名冲突。
- `SHA256SUMS`（`:243-248`）glob `*` 覆盖 4 个二进制 + dag-templates.tar.gz；`shasum || sha256sum` 双 fallback。
- `gh release create ... --target "${{ github.sha }}"`（`:264`）→ 手动触发时 github.sha = 触发瞬间分支 HEAD commit，tag 精确锚定该 commit；`--prerelease` 当 `github.ref_name != "main"`（`:258-260`）。上传 `release-assets/*` 含 SHA256SUMS 本身 ✓。
- **风险点**：build-cli 的 checkout（`:124-126`）未指定 `ref: ${{ github.sha }}`，workflow_dispatch 下默认检出分支 tip —— 若构建期间分支有新 push，二进制可能来自更新的 commit 而 release tag 锚定旧 sha（低概率、构建-标签不一致）。release job 自身 checkout 同理（仅作 gh 上下文，无害）。
- **Windows 路径风险（候选 HIGH）**：models.dev step 对 `$RUNNER_TEMP` 显式做 `cygpath -m` 转换（`:145-147`），而 Extract Templates 的 `$GITHUB_WORKSPACE/dag-templates-src`（`:175`）**无任何转换**。Windows runner 的 bash 下 GITHUB_WORKSPACE 为 POSIX 形（`/d/a/...`），写入 GITHUB_ENV 后原生 Bun 进程读取该路径可能无法解析 → glob 0 模板 → **Windows 发布版静默丢失 builtin 模板**。作者在同一文件里已证明知道此坑（cygpath 行），此处遗漏高度可疑。无法本地验证 Bun@Windows 路径处理 → 列入 unverified，交 verify 波。

## 5. Test Coverage Inventory

**dag-workflows.test.ts（163 行，14 个测试，全部通过 diff 确认保留）**：

| describe | 数量 | 覆盖 |
|---|---|---|
| `isName` | 3 | 裸标识符 true；path 形/扩展名/`.`/`..`/空串 false；控制字符（NUL、换行）false |
| `resolve` | 7 | project 命中；global 回退；project 遮蔽 global；`.yml` 扩展；同 scope `.yaml` 优先于 `.yml`；未知名 undefined + searchPaths 顺序断言；**不可解析 spec 仍返回 entry**（title/nodes undefined） |
| `list` | 4 | 双 scope 皆空 → []；合并排序 + 遮蔽（project 优先）；忽略非 spec 文件与目录；无 title 时 title undefined、nodes=0 |

**删除的测试**（dag-workflows.test.ts 旧 165-187 行）：`change-review as valid start spec` —— 验证 `resolve("change-review", repoRoot)` 命中 project scope、`StartSpec` decode 通过、每个 `prompt_template.id` 存在于 `.opencode/dag-prompts/`、`depends_on` 引用有效。**删除一致性确认**：98e4c0624 删除了 4 个 tracked 模板（change-review.yaml / deep-review-dag-module.yaml / design-decision-loop.yaml / parallel-development-loop.yaml），测试会因 `entry!.path` 直接抛错而必挂 —— 删除是必要条件而非清理。但代价：模板间的 `depends_on`/prompt-template 引用完整性校验**从此没有任何自动化守卫**（配置仓库在 repo 外，无 CI 挂钩）。

**builtin scope 覆盖：无。** `builtinTemplates()`（workflows.ts:51-55）在测试环境 typeof 守卫返回 `{}`，`declare const` 无任何注入钩子（不像 config 可用 OPENCODE_CONFIG_DIR 重定向）。resolve 的 builtin fallback、list 的 builtin 合并/去重、`isBuiltinPath`/`builtinName`、tool/workflow.ts:360-370 的 builtin 读谱分支、`searchedScopes` 提示 —— 全部零测试。要测只能通过真实构建注入，测试基建缺失。

**workflow-tool.test.ts**（未改动文件，spot-check）：saved-workflows 段 6 个测试覆盖 tool 级 list/resolve 行为 —— start-by-name（project、global 均无外部目录权限询问）、未知名错误信息含两个搜索目录、list 双 scope 遮蔽输出（`shared [project] — project-shared title`）、list 空库提示。schema 负例段（:291-331）覆盖 action/operation 枚举。**builtin 相关消息分支（searchedScopes 拼接）同样零覆盖。**

**dag-workflow-lock.test.ts**（1 测试，未改动）：mock DagStore.getWorkflow 内 25ms sleep + activeReads 计数，unbounded 并发 2 次 `dag.extend("wf1")`，断言 `maxActiveReads === 1` —— 验证 extend 同 workflow 串行化锁语义。与本 PR 无交集，属上下文佐证。

## 6. CI 回归风险

- **现有 CI（ci-typecheck/ci-test）零改动**；本 PR 只动 release-fork.yml，push 到 main/dev 仅触发 `register`（path-filtered），无新负担。
- 唯一共享面：`setup-bun` macOS cache saver（`:137`）—— 未改动，既有行为。
- job 级 skip 语义无级联失败风险（skip→needs success→下游同条件 skip）。
- **风险清单**：① Windows DAG_TEMPLATES_DIR 路径转换缺失（静默空 builtin，候选 HIGH）；② build-cli checkout 未 pin `github.sha` vs release `--target github.sha` 竞态（低概率 MEDIUM-LOW）；③ 配置仓库为空/不可达时 package-templates 行为（空=降级 ✓，克隆失败=job 失败 fail-loud，可接受）；④ `shasum -a 256 *` 在 release-assets 恒非空（dag-templates 必然存在）前提下安全。

## 其他值得 reviewer 关注的证据点

- `parseMeta` async + `.catch(() => undefined)`（workflows.ts:155-158）修复了旧 `describeContent` 同步 `Bun.YAML.parse` 对 malformed builtin 抛异常的路径 —— 现在 resolve/list 容忍、start 时 fail-loud（tool/workflow.ts:364-368 `Effect.try`），与文件路径行为一致 ✓。
- list 去重（workflows.ts:117-120 `seen.set` + `if (seen.has(name)) continue`）保证 builtin 被 project/global 遮蔽 ✓，与 resolve 优先级一致。
- `/dag-template-update`（103 行 prompt）：`mkdir` 原子锁 + 失败回退、备份失败即中止、内容级 verify、local-only 保留 —— 全部是 prompt 级契约，**无代码强制**（该命令完全由 agent 依 prompt 执行），属设计权衡而非 bug。
- dag-flow.txt 已更新为库引用（saved workflow 名字）+ 移除仓库内路径，与模板迁移一致 ✓。

---

## output_variables

- targets:
  - `package-templates job@.github/workflows/release-fork.yml:66-97`
  - `build-cli job@.github/workflows/release-fork.yml:99-216`
  - `release job@.github/workflows/release-fork.yml:218-266`
  - `builtinTemplates@packages/opencode/src/dag/workflows.ts:51-55`
  - `resolve@packages/opencode/src/dag/workflows.ts:73-89`
  - `list@packages/opencode/src/dag/workflows.ts:100-122`
  - `isBuiltinPath/builtinName/builtinEntry/parseMeta@packages/opencode/src/dag/workflows.ts:125-158`
  - `loadDagTemplatesData@packages/opencode/script/generate.ts:39-60`
  - `readWorkflowSpec@packages/opencode/src/tool/workflow.ts:350-391`
  - `searchedScopes@packages/opencode/src/tool/workflow.ts:393-398`
  - `DagTemplateUpdateDescription + command registration@packages/core/src/plugin/command.ts:15,42-44`
  - `dag-template-update.txt@packages/core/src/plugin/command/dag-template-update.txt:1-103`
  - `dag-flow.txt@packages/core/src/plugin/command/dag-flow.txt`
  - `OPENCODE_DAG_TEMPLATES define@packages/opencode/script/build.ts:203`
  - `dag-workflows.test.ts@packages/opencode/test/dag/dag-workflows.test.ts`（14 测试 + 1 删除）
  - `dag-workflow-lock.test.ts@packages/opencode/test/dag/dag-workflow-lock.test.ts:8-58`
  - `workflow-tool.test.ts saved-workflows@packages/opencode/test/dag/workflow-tool.test.ts:1038-1195`
- impacted_processes: [ReleaseForkPipeline, DagWorkflowResolution, DagTemplateUpdate]
- test_anchors:
  - `packages/opencode/test/dag/dag-workflows.test.ts::isName/resolve/list`
  - `packages/opencode/test/dag/workflow-tool.test.ts::workflow tool saved workflows`
  - `packages/opencode/test/dag/dag-workflow-lock.test.ts::Dag.Service workflow lock`
- ast_available: true

**unverified_claims（交 verify 波）**：
1. Bun@Windows 对 POSIX 形 `DAG_TEMPLATES_DIR`（`/d/a/...`）路径的解析行为 —— 决定 Windows 发布版是否静默丢失 builtin 模板（release-fork.yml:175 vs :145-147 的 cygpath 不对称）。
2. GitHub Actions windows runner bash 下 `$GITHUB_WORKSPACE` 的实际形态（/d/a/... vs D:\a\...）。
3. `"undefined"` 字符串经 Bun.build define 注入为 `undefined` 关键字的假设（models 同款已在生产证明，风险低）。