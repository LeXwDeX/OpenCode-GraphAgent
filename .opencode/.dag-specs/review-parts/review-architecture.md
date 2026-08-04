# PR #167 架构审查报告（只读）

审查基准：`git diff origin/dev...HEAD`（4 commits，13 文件：+286/−926）。已实测运行 `bun test dag-workflows/workflow-tool`（40 pass / 0 fail）作为测试证据。

## findings

**1. HIGH — `/dag-template-update` 运行时不可达：仅注册了 core plugin draft，未注册进应用 Command 服务**

命令只加在 `packages/core/src/plugin/command.ts:42-45` 的 `draft.update`，该 draft 落入 core v2 Command catalog（`packages/core/src/command.ts`），消费方只有 core plugin host（`packages/core/src/plugin/host.ts:95-97`），**不接入 TUI/会话命令面**。TUI 命令列表（`sync.tsx` → `GET /command`，`packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts:76-77`）与 slash 命令执行（`session/prompt.ts:1867-1871`，`commands.get` 未命中 → "Command not found"）都走 `packages/opencode/src/command/index.ts` 的 Command 服务。该服务只注册 `Default` 枚举内的命令（`index.ts:48-54`、dag-flow 注册于 `:94-100`）。dag-flow 先例（commit e14fdcdec）是**双注册**：core plugin draft + 应用 Default 枚举 + `command.test.ts:46-52` 注册断言；本 PR 只做了前者。后果：用户输 `/dag-template-update` 直接 "Command not found"，命令功能整体死代码。

推荐：仿 DAG_FLOW 在 `packages/opencode/src/command/index.ts` 的 `Default` + commands map 补注册，并在 `packages/opencode/test/command/command.test.ts` 加断言。

**2. MEDIUM — builtin scope 零测试覆盖，且删除的仓库自检测试无替代**

`packages/opencode/test/dag/dag-workflows.test.ts` 删除了唯一的真实 spec 校验（旧 L163-189：StartSpec 解码 + prompt_template.id/depends_on 引用完整性），全部保留测试（isName/resolve/list 14 个）不触达 builtin 分支；`workflow-tool.test.ts` 亦无 builtin 用例。新增面（`workflows.ts:51-56,86-88,117-120`、`workflow.ts:361,395-397`）零覆盖。`declare const` 无注入钩子，测试基建缺失是根因。结果：config repo 模板完全脱离本仓库 CI，模板间引用错误不再有任何自动守卫。

推荐：为 `builtinTemplates()` 提供可注入测试源（如可选参数/全局 hook），覆盖 resolve builtin 兜底、project/global 遮蔽 builtin、list 合并去重、`isBuiltinPath`/`builtinName`、searchedScopes 拼接；`generate.ts:44-57` 的 glob→map 逻辑可抽纯函数用临时 `DAG_TEMPLATES_DIR` 单测。

**3. MEDIUM — 文档与运行时三级 scope 不一致，dev 环境 /dag-flow 首步即失败**

- `dag-flow.txt:13` 仍写 "two scopes (project overrides global)"——运行时是三级（`workflows.ts:9-14`）；`:14` 称 global "curated by the opencode-dag-config repo"，实际 curated 快照的载体是 builtin 层（global 需先跑 update 才存在）。
- `workflow.md:84-85,483-484`（追加到每次 dag-flow 调用的 WorkflowFactsContent）同样只描述两 scope。
- `dag-flow.txt:17-20` 点名 4 个 saved workflow（design-decision-loop 等）——dev checkout（无 builtin、无 config repo）下解析不到，agent 按提示第一步就 "Saved workflow not found: ..."（`workflow.ts:412`），主流程在 dev 与 release 体验割裂。
- README 死链/过时：`README.md:253` 指向已删除的 `change-review.yaml`；`README.md:30`、`README.zh.md:27` "仓库附带三类参考图"已不成立；`README.zh.md:66-67` 两 scope 表缺 builtin 层。

推荐：三处文档统一为三级描述并注明 builtin 仅存在于 release 构建；README 死链改为指向配置仓库。

**4. MEDIUM — Windows runner `DAG_TEMPLATES_DIR` 路径未做 cygpath 转换（同文件不对称）**

`release-fork.yml:175` 写 `DAG_TEMPLATES_DIR=$GITHUB_WORKSPACE/dag-templates-src`，无任何转换；同 job 的 models.dev step（`:145-147`）对 `$RUNNER_TEMP` 显式做了 `cygpath -m`——作者在同一文件证明知道此坑。若 Windows bash 下 `GITHUB_WORKSPACE` 呈 MSYS 形（`/d/a/...`）或 Bun 无法解析混合分隔符路径，glob 零匹配 → **Windows 发布版静默丢失 builtin 模板**（generate.ts 空集不报错，`workflows.ts:51-56` 优雅降级为两级）。

推荐：与 models.dev 一致加 `cygpath -m`（保留 POSIX 与 Windows 双形态兼容写法），并在 build 步骤后加一步生成物校验（如 `bun -e` 检查二进制含模板名），防静默降级。

**5. MEDIUM — `/dag-template-update` prompt 锁语义两个缺口（纯 prompt 契约，无代码兜底）**

- 父目录前置缺失：锁创建 `mkdir <config dir>/workflows/.dag-update.lock`（`dag-template-update.txt:72-74`）在 `<config dir>/workflows` 不存在时失败是 **ENOENT 而非 EEXIST**；"创建目录"指令在 L97 Failure handling 才出现，且措辞是 "before applying"，锁在下载前——agent 可能把 ENOENT 误判为"有并发更新"。
- 陈旧锁无恢复：agent 崩溃/被杀后 `.dag-update.lock` 永久残留，`L75-76` 只说"wait and retry, then stop"——此后该命令永远不可用，无 mtime/age 检测、无强制覆盖、无提示手工清除。

推荐：锁步骤前明确先 `mkdir -p <config dir>/workflows`；增加"若锁已存在，检查其 mtime 超时（如 >30min）则视为陈旧、报告并提示删除后重试"。

**6. LOW — `workflows.ts:16` 头注释残留 "same two-level scope"**

三级已落地但注释未更新（:9-14 已改为三级，:16 与之一句之隔自相矛盾）。推荐改为 "same multi-level scope" 或移除。

**7. LOW — 空库消息的 builtin 提及是不可达死代码**

`tool/workflow.ts:145` 的 empty-library 分支：builtin map 非空时 `list()` 必含 builtin 条目（`workflows.ts:117-120`）→ `entries.length === 0` 不成立；map 空时 `searchedScopes` 不追加 builtin 文案。分支只在"builtin 存在"时命中，文案永不出现。

**8. LOW — `list()` 展示的 `builtin://name` 路径不可回填 `spec_path`，与 dag-flow.txt 指引冲突**

`dag-flow.txt:16` 说 "pick by name or path"；builtin 条目路径（`workflows.ts:58,131-133`）经 `resolveSpecPath` 路径分支（`tool/workflow.ts:415-424`）会被 `path.resolve` 折叠 `//` 后报 "must be a .yaml or .yml file"。用户按文档回填即报误导性错误（正确用法是裸名，但文档未说清）。

**9. LOW — `.yml` 漂移：三层只认 `.yaml`，运行时认 `.yml`，`generate.ts:52` 的 `?` 是死代码**

运行时 `EXTENSIONS` 含 `.yml`（`workflows.ts:33`），但 generate.ts glob（`generate.ts:51`）、release 打包（`release-fork.yml:83`）、update prompt 全只匹配 `.yaml`；`/\.ya?ml$/` 中的 `?` 无输入可达。config repo 若放入 `.yml` 会被静默丢弃——布局契约全靠隐式约定，建议文档化或在 glob 统一。

**10. LOW — build-cli checkout 未 pin `ref: ${{ github.sha }}`，release tag 锚定旧 sha 竞态**

`release-fork.yml:122-126` checkout 默认分支 tip；`release` job `--target "${{ github.sha }}"`（`:264`）锚定触发瞬间的 commit。构建期间若分支有 push，二进制与 tag 指向不同 commit。低概率但存在；成本极低（加一行 `ref`）。

**11. LOW — `Entry.content` 死字段**

`workflows.ts:42-43,135-137` 设置 content，全仓库无消费者（start 路径重查 `builtinTemplates()`，`tool/workflow.ts:361`；list 输出不含）。注释标注为预留，可接受，但建议注明驱动场景（TUI 预览）避免误以为已接通。

## unverified_claims

- Windows runner bash 下 `$GITHUB_WORKSPACE` 的实际形态（`D:\a\...` vs `/d/a/...`）及 Bun 对混合分隔符路径的解析行为——决定 finding 4 是否实际触发；本地无法复现 windows-latest 环境。
- opencode-dag-config 仓库根目录只含顶层 `*.yaml`（无 `.yml`/子目录）——glob、release 打包、update prompt 三层假设成立与否无法本地验证。
- release 产物二进制确实包含模板（define round-trip 端到端）——仅静态验证 `build.ts:203` + `generate.ts:44-57`，与 `OPENCODE_MODELS_DEV` 先例同构，风险低。
- core v2 Command catalog（plugin draft 落点）是否被任何 TUI/会话表面消费——静态追踪显示无（`command.list` 路由与 session 均走应用 Command 服务），未做运行时验证。
- `"undefined"` 字符串经 Bun.build define 注入为 `undefined` 关键字语义——models 生产先例已证明，风险低。

## summary

总体架构方向正确：三级 scope（project > global > builtin）的解析/遮蔽/去重语义在代码层自洽，define 注入复用了 `OPENCODE_MODELS_DEV` 成熟先例（typeof 守卫、`"undefined"` 字面量降级均正确），release 双渠道（资产 + 内嵌）职责清晰，`package-templates` 与 build-cli 的耦合度合理，已修复项（ReferenceError 守卫、Entry 去重、空 glob、重复下载）均验证为正确修复而非回退。阻塞性问题只有一个但致命：`/dag-template-update` 命令只注册了 core plugin draft 一处，未按 dag-flow 先例接入应用 Command 服务，运行时不可达——发布前必须补注册。次要面（builtin 零测试、文档三级不一致、Windows 路径转换、锁语义缺口）应在合并前或紧随其后处理，其中 finding 4 若成立会导致 Windows 发布版静默丢失该 PR 的核心价值。