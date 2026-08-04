## Hit Summary

builtin 三级 scope 解析面已完整映射：`workflows.ts` 的解析/列举逻辑（project > global > builtin，first-match-wins）与 `tool/workflow.ts` 的消费路径（`readWorkflowSpec` builtin 分支、`searchedScopes` 提示）实现正确且自洽；esbuild define 注入机制已实测验证可用（JSON 对象值被正确包裹）。主要风险集中在**零测试覆盖**：builtin scope 无任何测试（`rg builtin` 在测试目录零命中），且被删除的仓库自检测试（旧 spec 解码校验）没有替代，导致 config repo 模板完全脱离本仓库测试套件。另有 2 个值得上报的边界问题（`list()` 展示的 `builtin://` 路径不可作为 `spec_path` 回填；空库消息中 builtin 提及是不可达死代码）。置信度：代码路径理解高，release 流水线实际产物中高（静态审查）。

## Key Symbols

- `packages/opencode/src/dag/workflows.ts:35` `export type Scope = "project" | "global" | "builtin"` — 新增第三级 scope
- `packages/opencode/src/dag/workflows.ts:50-56` `builtinTemplates()` — `typeof OPENCODE_DAG_TEMPLATES === "undefined"` 守卫，undefined（dev/test）→ `{}`
- `packages/opencode/src/dag/workflows.ts:77-90` `resolve()` — project/global 循环后 builtin 兜底
- `packages/opencode/src/dag/workflows.ts:102-123` `list()` — seen Map 去重，builtin 合并，`localeCompare` 排序
- `packages/opencode/src/dag/workflows.ts:126-133` `isBuiltinPath()` / `builtinName()` — `builtin://` 前缀解析
- `packages/opencode/src/dag/workflows.ts:158-167` `parseMeta()` — YAML 解析容错 + title/nodes 提取
- `packages/opencode/src/tool/workflow.ts:359-370` `readWorkflowSpec()` builtin 分支 — 内容缺失报错、YAML 解析失败路径
- `packages/opencode/src/tool/workflow.ts:395-399` `searchedScopes()` — 目录 + 条件性 builtin 提及
- `packages/opencode/script/generate.ts:36-59` `loadDagTemplatesData()` / `dagTemplatesData` — 构建期从 `DAG_TEMPLATES_DIR` 读快照
- `packages/opencode/script/build.ts:203` `OPENCODE_DAG_TEMPLATES: generated.dagTemplatesData` — define 注入点
- `packages/core/src/models-dev.ts:114,185-187` — `OPENCODE_MODELS_DEV` 既有同构先例

## Call Relationships

```
tool/workflow.ts resolveSpecPath (L401)
  └─ isName(specPath)? (L408)
       ├─ resolve(name, dir) → workflows.ts:77 → scopes() (project L144 → global L145) → builtinTemplates() (L86-88)
       │    └─ builtinEntry() (L135-137) → parseMeta() (L158)
       └─ path branch (L415-424) — 永不产生 builtin:// 路径（实测：// 被 path 规范化折叠）
readWorkflowSpec (L350)
  ├─ isBuiltinPath(filepath)? (L360) → builtinTemplates()[builtinName()] → YAML.parse (L365-368)
  │    └─ 缺失 → fail "Workflow spec not found: builtin://name" (L363)
  └─ 文件分支 (L372-389) — 含 1MB size 检查 (L376)，builtin 分支绕过
build 链: release-fork.yml (clone opencode-dag-config → tar *.yaml → artifact)
  → build-cli (下载解包 → DAG_TEMPLATES_DIR env, L160-175)
  → generate.ts:45 (env 读取) → generate.ts:59 (dagTemplatesData)
  → build.ts:203 (define) → workflows.ts:30 (declare const) → workflows.ts:54 (typeof 守卫)
```

## Execution Flows Involved

- `Flow: BuiltinResolution` — bare name → `resolve()` 三级查找 → builtin 兜底 → `readWorkflowSpec` builtin 分支 → YAML.parse → start/extend/replan 解码 (workflows.ts:86-88 → workflow.ts:360-369)
- `Flow: BuiltinInjection` — 构建期：`DAG_TEMPLATES_DIR` env → glob `*.yaml` → `JSON.stringify` → esbuild define → 编译进二进制；dev/test 下返回字面量 `"undefined"` → 守卫生效返回 `{}`（实测验证对象注入路径：`{"a":"b"}` 被正确编译为对象字面量）
- `Flow: LibraryListing` — `list()` 三级合并去重排序 → `[name] [scope] — title (N nodes)\n path` 输出（workflow.ts:149-162），builtin 条目路径显示为 `builtin://name`

## Related Test Files

- `packages/opencode/test/dag/dag-workflows.test.ts` — **无 builtin 覆盖**（isName/resolve 投影/全局/list 测试均不触达 builtin 分支）；已删除旧测试"the repository's own workflow library"（旧 L163-189，校验 change-review 可解码）
- `packages/opencode/test/dag/workflow-tool.test.ts:1038-1160` — saved workflows 段：bare name 解析、全局 scope 无外目录提示、not-found 消息（`toContain` 子串断言，容忍 builtin 提及追加）、list 双 scope 投影；同样无 builtin 用例

---

## 1. 解析顺序与遮蔽语义（含行号）

- **顺序**：`scopes()`（workflows.ts:142-147）= project（`.opencode/workflows`，L144）→ global（`Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config` + workflows，L145）；`resolve()` 先遍历两 scope 的 `.yaml`/`.yml`（L79-85，EXTENSIONS 顺序 L33 保证同 scope 内 `.yaml` 优先），builtin 仅在前两者均未命中时兜底（L86-88）。头注释 L9-14 一致。
- **list() 遮蔽一致性**：`seen` Map key=name、first-wins（L104），builtin 只在 `!seen.has(name)` 时并入（L117-120），与 resolve() 优先级严格一致——不会列出 resolve() 选不中的文件。
- **验证状态**：project>global 遮蔽有测试（dag-workflows.test.ts:88-94、workflow-tool.test.ts 双 scope 用例）；**project/global 遮蔽 builtin 零测试**。

## 2. builtin 数据流

- **声明**：`declare const OPENCODE_DAG_TEMPLATES`（workflows.ts:30），仅构建期存在；`builtinTemplates()` 用 `typeof` 守卫（L54）防 ReferenceError——dev/test 裸跑返回 `{}`。
- **注入链**：`generate.ts:45` 读 `DAG_TEMPLATES_DIR` env → 无 env 返回字符串 `"undefined"`（L47-48，define 后成为字面量 `undefined` → 守卫触发）；有 env 则 `new Bun.Glob("*.yaml").scan({cwd})`（L49）收集 → name 去扩展名（L50）→ `JSON.stringify`（L57）→ `build.ts:203` 注入 define。**已实测**：Bun build 对 `{"a":"b"}` 值正确编译为对象字面量（非 block statement），typeof 返回 "object"。
- **release 侧**：`release-fork.yml` package-templates job（clone `LeXwDeX/opencode-dag-config` → 仅打包根目录 `*.yaml` → tar artifact，L68-96）→ build-cli job 下载解包并写入 `DAG_TEMPLATES_DIR` env（L160-175）→ 与 `--compile` 定义值配套。
- **与先例同构**：`models-dev.ts:114,185-187` 的 `OPENCODE_MODELS_DEV` 完全相同模式（含 length 检查），生产已验证——机制可信。
- **dev/test 差异**：无 env → `"undefined"` 字面量 → 空 map → builtin scope 静默关闭，所有现有测试实际都跑在守卫分支上（隐式覆盖了守卫本身）。

## 3. readWorkflowSpec builtin 路径

- **解析**：`isBuiltinPath`（workflows.ts:126-128，`startsWith("builtin://")`）+ `builtinName`（L131-133，slice 前缀）。
- **内容缺失**：`content === undefined` → `Effect.fail("Workflow spec not found: builtin://name")`（workflow.ts:362-364）——与文件分支的 not-found 同文案风格。
- **YAML 失败**：`Effect.try` 包裹 `Bun.YAML.parse`（L365-368）→ `workflowSpecParseError`（L428-430）→ `Invalid workflow YAML builtin://name: <msg>`，与文件分支（L385-388）同形。
- **可达性**：builtin 分支只能由 `resolve()` 返回的路径触发。**实测**：用户直接传 `builtin://code-review.yaml` 作 spec_path 时，`path.resolve` 把 `//` 折叠成 `/`（POSIX `/abs/dir/builtin:/code-review.yaml`，win32 `C:\dir\builtin:\code-review.yaml`），`isBuiltinPath` 恒 false → 落入路径分支报"must be .yaml/.yml"或 not-found——**不可伪造，也不可达**。
- **绕过项**：builtin 内容跳过 1MB size 检查（L376-380 仅文件分支）与外目录权限提示——内容为构建期策展，可接受，但属隐式信任面。

## 4. list() 行为

- **去重**：seen Map 三级 first-wins（L104-120）；**排序**：`a.name.localeCompare(b.name)`（L121，unchanged）。
- **parseMeta 容错**（L158-167）：YAML parse 失败 catch → `{}`（L159-161）；title 需顶层字符串（L164）；nodes = `config.nodes` 数组长度（L165-166）；畸形 spec 照常列出（测试 dag-workflows.test.ts:117-123、156-161 覆盖文件侧；builtin 侧同函数未测）。
- **describe() 重构**（L149-153）：`.text().catch(() => undefined)` 拆出与 pre-PR 行为等价（pre-PR 的 catch 在 `.then(YAML.parse)` 之后，同样吞掉 unreadable 与 parse 错误）——**非行为修复，纯为共享 parseMeta**。
- **builtin 条目**：scope="builtin"、path=`builtin://name`、携带 content（L135-137）。`Entry.content` **当前无任何消费者**（start 路径重查 `builtinTemplates()[name]`，list 输出不含 content）——死字段，为未来 TUI/预览预留。

## 5. searchedScopes() 与消息

- `searchedScopes()`（workflow.ts:395-399）：`searchPaths()` 两目录 + builtin map 非空时追加 `"the release's builtin templates"`。
- **not-found 消息**（L411-413）：`Saved workflow not found: "x". Searched <dirs>[ and builtin]...` —— builtin 提及仅在 map 非空时出现，语义正确。
- **空库消息**（L142-147）：`The workflow library is empty. Searched ...` —— **builtin 提及不可达死代码**：map 非空时 list() 必然包含 builtin 条目、`entries.length === 0` 不可能成立，而 map 空时 searchedScopes 不加 builtin 文案。
- **dag-flow.txt 与内置 scope 不一致**（上下文）：prompt 只描述两 scope（project/global），未提 builtin——agent 若回填 list() 展示的 `builtin://` 路径会失败（见 §3），但 prompt 引导使用裸名，实际可用。

## 6. 边界/边缘情况

| 边界 | 行为 | 行号 | 状态 |
|---|---|---|---|
| 空 builtin map（dev/test） | 守卫返回 `{}`，resolve 落 undefined，消息只提目录 | workflows.ts:54 | ✓ 隐式覆盖 |
| project/global 遮蔽 builtin | resolve L79-88 / list L117-119 一致 first-wins | — | ✓ 逻辑正确，无测试 |
| 畸形 builtin 内容 | list 仍列出（parseMeta catch）；start 报清晰 parse error | workflows.ts:159-161 / workflow.ts:365-368 | ✓ |
| `builtin://` 伪造 | 路径规范化折叠 `//`，不可达 builtin 分支（实测） | workflow.ts:360 | ✓ |
| list 展示路径不可回填 | `builtin://name` 含 `/` → isName=false → 路径分支报错 | workflow.ts:408-418 | ⚠️ UX 缺陷，非崩溃 |
| 1MB size 检查绕过 | builtin 内容不检查 | workflow.ts:376 vs 359-370 | ⚠️ 低风险（构建期信任） |
| `.yml`/嵌套目录静默丢弃 | glob 仅 `*.yaml` 顶层（generate.ts:49；release-fork L73-76 同）；L50 正则容忍 `.yml` 是死代码 | — | ⚠️ 依赖 config repo 布局 |
| `Entry.content` 无消费者 | 死字段 | workflows.ts:42-43 | ℹ️ 预留面 |
| **builtin 零测试覆盖** | 全新增面无测试；旧仓库自检测试删除后 config repo 模板完全脱离本仓库 CI 校验 | 测试文件 diff | 🔴 测试缺口 |

## unverified_claims（供 verify 波核对）

- **U1**：release 产出的二进制实际包含模板——仅静态验证 define 机制 + CI job 图；`--version` smoke test（build.ts）不触达 builtin 解析，无法本地跑通 release 构建（config repo 私有/外网）。
- **U2**：opencode-dag-config 仓库根目录只含 `*.yaml`（顶层）——若含 `.yml` 或子目录会被 glob/打包脚本静默丢弃。
- **U3**：`/dag-template-update` 写入目录与运行时读取目录一致（`OPENCODE_CONFIG_DIR` → 平台默认）——命令是 prompt 无代码路径，运行时用 `Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config`（workflows.ts:145）。
- **U4**：`build-cli` job 仅 `workflow_dispatch` 触发（release-fork.yml:106），push 触发只注册不构建——builtin 注入只存在于手动 release 产物，非 dev 构建。属设计意图，非缺陷。

## output_variables

- targets:
  - `builtinTemplates@packages/opencode/src/dag/workflows.ts:51`
  - `resolve@packages/opencode/src/dag/workflows.ts:77`
  - `list@packages/opencode/src/dag/workflows.ts:102`
  - `isBuiltinPath@packages/opencode/src/dag/workflows.ts:126`
  - `builtinName@packages/opencode/src/dag/workflows.ts:131`
  - `parseMeta@packages/opencode/src/dag/workflows.ts:158`
  - `readWorkflowSpec@packages/opencode/src/tool/workflow.ts:350`（builtin 分支 359-370）
  - `searchedScopes@packages/opencode/src/tool/workflow.ts:395`
  - `loadDagTemplatesData@packages/opencode/script/generate.ts:36`
- impacted_processes: [BuiltinResolution, BuiltinInjection, LibraryListing]
- test_anchors:
  - [dag-workflows.test.ts::DagWorkflows.resolve（无 builtin 用例）]
  - [dag-workflows.test.ts::DagWorkflows.list（无 builtin 用例）]
  - [workflow-tool.test.ts::workflow tool saved workflows@1038（无 builtin 用例）]
  - 已删除：dag-workflows.test.ts 旧 "repository's own workflow library"（spec 解码校验，无替代）
- ast_available: true（全文件直接精读 + git diff 比对 + 2 项运行时实测验证，未依赖图索引）