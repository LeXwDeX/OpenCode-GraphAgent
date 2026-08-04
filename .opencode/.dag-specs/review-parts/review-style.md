## 风格与惯例审查报告（PR #167）

审查范围：`git diff origin/dev...HEAD`（4 commits）全部 TS/TSX 与 YAML 变更。已核实：40 个 dag 相关测试全部通过（`bun test dag-workflows workflow-tool`，0 fail）；验证了 explore 波的关键声明。

### 1. findings

| # | severity | 标题 | 说明 | evidence | 建议 |
|---|----------|------|------|----------|------|
| 1 | **HIGH** | `DAG_TEMPLATES_DIR` Windows 路径未转换，同文件内 cygpath 先例被遗漏 | build-cli 的 Extract Templates 步骤把 POSIX 形 `$GITHUB_WORKSPACE/dag-templates-src` 直接写入 `GITHUB_ENV`；同一文件 30 行前 models.dev 步骤对 `$RUNNER_TEMP` 显式做了 `cygpath -m` 转换（作者已证明知道此坑）。Windows runner 的 bash 下 `GITHUB_WORKSPACE` 为 `/d/a/...` 形态，原生 Bun 进程读取该路径若失败 → glob 0 个模板 → **Windows 发布版静默丢失全部 builtin 模板**（降级为两级 scope，无任何报错） | `.github/workflows/release-fork.yml:175` vs `:146-147` | 与 models.dev 步骤对齐，写 env 前对路径做 `cygpath -m` 转换（非 Windows 下幂等） |
| 2 | **MEDIUM** | `parseMeta` 假 async + 冗余 Promise 链包裹同步解析 | `Bun.YAML.parse` 是同步操作，却被 `Promise.resolve(text).then((value) => Bun.YAML.parse(value)).catch(() => undefined)` 包进 Promise 链（pre-PR 的 `.text().then(parse)` 形状遗留物）。违反 AGENTS.md「同步解析、校验应保持同步」精神，并强制 `builtinEntry`/`resolve`/`list` 无谓地携带 async/await。全 src 无此包裹同步解析的先例（`Promise.resolve` 在 src 中仅用于 sync-callback 桥接） | `packages/opencode/src/dag/workflows.ts:158-161` | parseMeta 改为同步函数（`Effect.try` 或 `Promise.resolve().then(...).catch(...)` 单链），builtinEntry 随之同步，调用点去掉 `await` |
| 3 | **MEDIUM** | `/dag-flow` 提示词停留在"两 scope"，与本次 PR 的核心新增（builtin 第三级）脱节 | dag-flow.txt 本次 PR 内被修改（11 行 diff），但 :13 仍写"installed in **two scopes**"；全局/项目顺序反列（L14-15 global 在前，实际解析 project 优先）；builtin 层完全缺失——而**全新安装（未跑 update）时 curated 模板恰恰只存在于 builtin 层**。:16 "pick by name or path" 也有误导：`list()` 对 builtin 项展示的 `builtin://name` 路径含 `/` → `isName` 为 false → 落入 path 分支报 "must be a .yaml or .yml file"（workflow.ts:416-418），路径回填必然失败 | `packages/core/src/plugin/command/dag-flow.txt:13-16` | 补第三级 scope 说明（builtin 编译进二进制）；路径选择措辞改为"按名选择"，删除对 builtin 路径回填的暗示 |
| 4 | **MEDIUM** | builtin 全新增面零测试覆盖，且唯一真实 spec 校验测试被删除 | `resolve` 的 builtin 兜底、`list` 的 builtin 合并去重、`isBuiltinPath`/`builtinName`、`readWorkflowSpec` builtin 分支、`searchedScopes` 提示——全部无测试。测试环境 `typeof` 守卫恒返回 `{}`，无任何注入钩子。被删的 "repository's own workflow library" 测试是唯一的 `depends_on`/`prompt_template.id` 完整性守卫，删除后 config repo 模板完全脱离本仓库 CI | `packages/opencode/test/dag/dag-workflows.test.ts`（删除段）；`workflows.ts:86-88,117-120` | 为 builtinTemplates 增加可注入的测试钩子（如通过 env/参数重载），补 resolve 兜底、list 遮蔽合并、searchedScopes 拼接的最小用例 |
| 5 | **LOW** | 过期注释：header 仍称"same two-level scope" | 本次 PR 把查找顺序改为三级（并更新了上方 bullet 列表），但 `Mirrors config.ts: same two-level scope` 未同步 | `packages/opencode/src/dag/workflows.ts:16-17` | 改为 three-level 或删除该句 |
| 6 | **LOW** | `Entry.content` 死字段 | `builtinEntry`（:135-137）设置 content，但 `readWorkflowSpec` 重新查询 `builtinTemplates()`（workflow.ts:361），全仓库无任何消费者；`list()` 输出也不含它 | `packages/opencode/src/dag/workflows.ts:43,135-137` | 要么让 readWorkflowSpec 消费 entry.content，要么删字段（或加注释明确为预留面） |
| 7 | **LOW** | README 死链/过时声明（PR 删文件未同步文档） | README.md:253、README.zh.md:227 指向已删除的 `.opencode/workflows/change-review.yaml`（404）；README.zh.md:27 "仓库已经附带三类强约束参考图" 已不成立；:66-67 scope 表缺 builtin 层 | `README.md:253`、`README.zh.md:27,66-67,227` | 更新为 config repo 引用 + 三级 scope 表；删除死链接 |
| 8 | **LOW** | 锁语义两个 prompt 级缺口 | ① `mkdir <config dir>/workflows/.dag-update.lock`：首次运行时父目录不存在 → ENOENT，提示词将其归因为"目录已存在=他人持锁"，agent 会误判；② 陈旧锁无恢复路径（崩溃后 `.dag-update.lock` 永久残留，无 age 检测/手工清除提示） | `packages/core/src/plugin/command/dag-template-update.txt:67-78,97` | 锁步骤前明确"先创建 workflows 目录"；补充陈旧锁的处理指引 |
| 9 | **LOW** | "pinned repository URL" 措辞不实 | 提示词称 URL 为 "pinned/fixed"，但 `codeload.../zip/refs/heads/main` 未 pin tag/commit（release 流水线同），可复现性弱 | `dag-template-update.txt:28-29`；`release-fork.yml:83` | 措辞改为"固定分支 URL"或真的 pin commit |
| 10 | **NIT** | `\.ya?ml$` 中的 `?` 是死代码 | glob 只匹配 `*.yaml`（generate.ts:51，release 打包、update prompt 亦只认 `.yaml`），正则暗示 `.yml` 支持并不存在——三层 `.yml` 漂移是既有事实 | `packages/opencode/script/generate.ts:52` | 去掉 `?` 或统一 `.yml` 支持 |
| 11 | **NIT** | 私有 helper 重复显式返回类型标注 | `describe` 与 `parseMeta` 各自标注相同的内联返回类型 `Promise<{ title?: string; nodes?: number }>`；repo 风格倾向依赖推断 | `workflows.ts:150,158` | 删除显式标注（或提取共享 type alias） |

**核查通过项**（非 finding）：
- 命名一致性：`builtinTemplates`/`builtinEntry`/`builtinName`/`isBuiltinPath`/`BUILTIN_PREFIX` 前缀统一 ✓；`DAG_TEMPLATE_UPDATE_PROMPT`/`DagTemplateUpdateDescription` 与 dag-flow 同构 ✓
- 导出模式：`export * as DagWorkflows`（workflows.ts:20）沿用既有 module shape；新 helper 全部 namespace-private 不导出 ✓
- 类型纪律：导出函数显式返回类型、私有函数推断，边界正确；无 `any` ✓
- 控制流：全部早退、无 else、const 优先 ✓；`searchedScopes` 对 `searchPaths()` 返回的新数组 push 安全 ✓
- Effect 纪律：builtin 分支的 `Effect.fail(new Error(...))` 与文件分支（workflow.ts:374,377,412）逐字同形，遵循文件内既有惯例 ✓
- `Array.fromAsync` 为仓库既有模式（5+ 处使用）✓；动态 import 无新增需求 ✓
- dag-template-update.txt 结构（`##` 分节 + 加粗术语 + 失败处理段）与 review.txt/initialize.txt 房风一致，比 dag-flow.txt 的数字列表更贴近主流结构 ✓
- 已修复项确认：typeof 守卫（workflows.ts:54）、seen 去重（:117-120）、空 glob 守卫（release-fork.yml:84-89）均修复正确；测试全部通过 ✓

### 2. unverified_claims

- **U1**：Bun@Windows 对 POSIX 形 `DAG_TEMPLATES_DIR`（`/d/a/...`）路径的解析行为——决定 finding #1 是否真致 Windows 版静默丢模板（本地无法验证 Windows runner，需 CI 实测或 Windows 环境确认）
- **U2**：release 产出的二进制实际包含 builtin 模板——define 注入链已静态验证与 `OPENCODE_MODELS_DEV` 同构（生产先例），但本 PR 产物未做 `--version`/运行时 smoke 验证
- **U3**：opencode-dag-config 仓库根目录只含 `*.yaml`（顶层）——若含 `.yml` 或子目录会被 glob/打包/提示词三层静默丢弃
- **U4**：`/dag-template-update` 的写入目录（prompt 描述）与运行时读取目录（workflows.ts:145 `Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config`）逐字一致——已对 flag.ts/global.ts 静态核对，但未实测 XDG_CONFIG_HOME 全路径矩阵
- **已消解**：explore 波声称的 `command/index.ts:51` Default 枚举缺 `DAG_TEMPLATE_UPDATE` 条目——该文件不存在（`packages/core/src/plugin/command/index.ts` IO error），`Default.DAG_FLOW` 全仓库零命中，此声明为误报，不构成 finding

### 3. summary

整体风格纪律良好：命名前缀统一、导出模式与模块形状合规、早退/const/推断类型纪律一致、Effect 错误处理与文件内既有惯例同构，dag-template-update.txt 的 `##` 分节结构与仓库 prompt 房风吻合；40 个 dag 测试全部通过。主要问题在**一致性**而非风格本身：dag-flow.txt 未同步 builtin 第三级（其 "two scopes" 描述在全新安装下直接误导 agent）、`parseMeta` 的假 async 是 pre-PR 形状的遗留物、README 死链未随模板删除更新。唯一 HIGH 是 release-fork.yml 的 Windows 路径转换遗漏——同一文件内已有 cygpath 先例，属可低成本修复的静默失败风险；builtin 零测试覆盖与 config repo 脱离 CI 校验是测试面最大缺口。