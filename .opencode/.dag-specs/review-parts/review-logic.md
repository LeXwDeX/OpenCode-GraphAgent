审查完成。以下为逻辑正确性审查报告。

## 1. findings

### CRITICAL
无。

### HIGH

**H1. Windows 发布构建的 `DAG_TEMPLATES_DIR` 路径未做 cygpath 转换（与同文件 models 步骤不对称）**
- description: Extract Templates 把 `$GITHUB_WORKSPACE/dag-templates-src` 原样写入 GITHUB_ENV；而同一文件 15 行之上的 models 步骤对 `$RUNNER_TEMP` 路径显式做了 `cygpath -m` 转换——作者已知 Windows runner 的 bash 下路径形态陷阱，此处遗漏。若 bash 中 `GITHUB_WORKSPACE` 为 MSYS/POSIX 形（`/d/a/...`），原生 Bun 进程无法解析该 cwd：本地实测 `Bun.Glob.scan({cwd: 不存在目录})` 抛 ENOENT（fail-loud，build 失败）；若 scan 恰好返回空则 builtin 静默缺失。无法本地验证 Windows 侧行为（见 U1/U2）。
- evidence: `.github/workflows/release-fork.yml:175` vs `.github/workflows/release-fork.yml:145-147`
- recommendation: 与 models 步骤同构，写入 GITHUB_ENV 前 `cygpath -m`（cygpath 存在时）：`echo "DAG_TEMPLATES_DIR=$(cygpath -m "$GITHUB_WORKSPACE/dag-templates-src")" >> "$GITHUB_ENV"`。

**H2. builtin scope 零测试覆盖，且被删的仓库自检无替代**
- description: 新增面全部无测试：`builtinTemplates()` 守卫、resolve builtin 兜底（workflows.ts:86-88）、list builtin 合并（117-120）、`isBuiltinPath`/`builtinName`、`readWorkflowSpec` builtin 分支（workflow.ts:359-370）、`searchedScopes` 拼接。全仓 test 目录 `rg builtin` 零命中。删除的 "repository's own workflow library" 测试是唯一对真实 spec 做 `StartSpec` 解码 + prompt_template/depends_on 引用完整性校验的守卫；删除后 config repo 模板完全脱离本仓库任何 CI 校验（该仓库无 CI 挂钩）。删除本身必要（4 个模板已移出），但无替代校验。
- evidence: `packages/opencode/test/dag/dag-workflows.test.ts`（diff 删除 describe 块）；`packages/opencode/src/dag/workflows.ts:51-56,86-88,117-120`
- recommendation: 为 builtinTemplates/resolve/list 补单测（测试环境无法注入 define——可把 builtin map 改为可注入来源，或在测试内直接断言守卫分支 + 用 `Object.defineProperty(globalThis, ...)` 模拟注入）；同时考虑在 opencode-dag-config 仓库加模板解码 CI。

### MEDIUM

**M3. `list()` 展示的 `builtin://name` 路径不可回填为 spec_path（工具契约断裂）**
- description: project/global 条目展示的路径可直接回传；builtin 条目路径 `builtin://name`（无扩展名）回传时 `isName` 因含 `/` 为 false → 落入 path 分支 → `path.resolve` 折叠 `//`、extname 为空 → 报误导性错误 "must be a .yaml or .yml file"。结合 dag-flow.txt:16 的 "pick by name or path"，agent 按 list 输出回填必失败。
- evidence: `packages/opencode/src/dag/workflows.ts:136`（path 生成）；`packages/opencode/src/tool/workflow.ts:408`（isName 拒绝）、`415-418`（extname 检查）；`packages/core/src/plugin/command/dag-flow.txt:16`
- recommendation: 在 resolveSpecPath 的 path 分支前特判 `builtin://` 前缀直接走 builtin 解析；或在 list 输出中为 builtin 条目注明 "start by name only"。

**M4. dag-flow.txt 描述 "two scopes" 与运行时三级不符；4 个指名模板在 dev checkout 下不可解析**
- description: 运行时是 project → global → builtin 三级（workflows.ts:9-14），提示词只字未提 builtin——而对开箱即用用户，curated 模板恰恰只存在于 builtin 层，global 层为空。design-decision-loop / parallel-development-loop / deep-review-dag-module / change-review 四个名字对应本 PR 删除的模板（diff 872 行删除），dev checkout（无 builtin 注入、未跑 update）下全部解析失败。"run list first" 是兜底，但指名具体模板会误导。
- evidence: `packages/core/src/plugin/command/dag-flow.txt:13-19`；`packages/opencode/src/dag/workflows.ts:9-14,35`
- recommendation: 更新为三级描述；对 4 个模板名标注"需已安装（builtin/已跑 update）"。

**M5. /dag-template-update 锁语义两个缺口：父目录 ENOENT 歧义 + 陈旧锁无恢复**
- description: (a) `mkdir <config dir>/workflows/.dag-update.lock` 在 `<config dir>/workflows` 不存在时失败是 ENOENT 而非 EEXIST，而提示词的唯一诊断是"fails because the directory exists → another update is in progress"（L72-74），agent 可能误报并发；"create it before applying"（L97）位置在锁章节之后，且锁章节说 "before downloading or merging"（L70）与段落线性顺序（下载→干跑→合并→锁）矛盾。(b) agent 崩溃/被杀后锁目录永久残留，后续更新永远停在"already running"，无 mtime/age 检测、无强制清理或手工清除指引。
- evidence: `packages/core/src/plugin/command/dag-template-update.txt:67-78,97`
- recommendation: 明确"先 `mkdir -p <config dir>/workflows` 再取锁"；增加陈旧锁恢复路径（检测锁目录 mtime 超阈值视为陈旧，或提示用户手工 rmdir 后再试）。

**M6. README 死链与过时声明（模板删除的连带损伤）**
- description: README.md:227 链接已删除的 `./.opencode/workflows/change-review.yaml`（404）；README.md:30 / README.zh.md:27 "仓库附带三类参考图"已不成立；README.zh.md:66-67 两级 scope 表缺 builtin 层。
- evidence: `README.md:227,30`；`README.zh.md:27,66-67`
- recommendation: 随本 PR 同步更新（本 PR 未触碰 README，属遗漏）。

### LOW

**L7. `.ya?ml$` 的 `?` 是死代码；`.yml` 被三层一致丢弃**
- description: glob 只匹配 `*.yaml`，正则中 `?` 永不生效；运行时 EXTENSIONS 含 `.yml`（workflows.ts:33），但 generate.ts glob、release 打包（release-fork.yml:83）、update 提示三层都只认 `.yaml`——config repo 若放 `.yml` 模板会被静默丢弃。
- evidence: `packages/opencode/script/generate.ts:51-52`；`.github/workflows/release-fork.yml:83`
- recommendation: 要么统一支持 `.yml`，要么去掉 `?` 并把"仅 .yaml"写成显式约束。

**L8. 空库消息的 builtin 提及是不可达死代码**
- description: builtinTemplates 非空 → list() 必有 ≥1 条目 → `entries.length === 0` 分支不可能执行；map 空 → searchedScopes 不追加 builtin 文案。两条件互斥，builtin 文案永不出现于空库消息。not-found 消息中的 builtin 提及（map 非空但该名缺失）可达且正确。
- evidence: `packages/opencode/src/tool/workflow.ts:145` vs `395-399`；`packages/opencode/src/dag/workflows.ts:117-120`
- recommendation: 无害，但应移除或重构消息构造，避免维护者误读。

**L9. `Entry.content` 死字段**
- description: builtinEntry 写入 content（workflows.ts:135-137），但 readWorkflowSpec 重新查 `builtinTemplates()`（workflow.ts:360-364），全仓无 `.content` 消费者。
- evidence: `packages/opencode/src/dag/workflows.ts:42-43,135-137`；全仓 grep 无消费者
- recommendation: 为 TUI/预览预留可保留，建议加注释说明意图。

**L10. builtin 内容绕过 1MB size 检查**
- description: size 检查仅文件分支（workflow.ts:376），builtin 分支（359-370）跳过——内容为构建期策展，风险可接受，属隐式信任面。
- evidence: `packages/opencode/src/tool/workflow.ts:376` vs `359-370`
- recommendation: 可接受，建议注释注明设计意图。

**L11. opencode-dag-config 未 pin tag/commit**
- description: update 命令下载 `refs/heads/main`（L31）、release clone 同取 HEAD（release-fork.yml:74-77）——同一 URL 两处 HEAD，可复现性弱，模板变更不可追踪。
- evidence: `packages/core/src/plugin/command/dag-template-update.txt:31`；`.github/workflows/release-fork.yml:74-77`
- recommendation: 考虑 pin 到 tag；属设计权衡。

## 2. unverified_claims

- U1: windows-latest runner 的 bash 中 `$GITHUB_WORKSPACE` 的实际形态（POSIX `/d/a/...` 还是原生 `D:\a\...`）——决定 H1 是否触发，本地不可验证
- U2: Bun@Windows 对 MSYS/POSIX 形 cwd 的 `Glob.scan` 行为（本地仅在 macOS 实测：缺失 cwd 抛 ENOENT）
- U3: release 流水线端到端产物实际包含 builtin 模板（package-templates → build-cli → 二进制）——仅静态分析，config repo 私有/无法本地跑通
- U4: opencode-dag-config 仓库根目录仅含 `*.yaml`（若含 `.yml`/子目录会被 glob 与打包三层一致静默丢弃，见 L7）
- U5: Windows 上 xdg-basedir 对 `Global.Path.config` 的实际回退（提示词仅声明 macOS/Linux 行为，运行时代码静态一致但 Windows 分支未验证）

## 3. summary

核心逻辑正确：resolve 三级回退嵌套（scope 外循环 × extension 内循环）、list 去重/排序与 resolve 优先级严格一致、readWorkflowSpec builtin 分支（缺失报错/坏 YAML → `workflowSpecParseError`）与文件分支同形、typeof 守卫在 dev/release 双环境语义正确、generate.ts 路径拼接与 JSON.stringify 无注入面、release-fork.yml 的 nullglob 守卫与 needs 链（push 触发不中断）均确认无误；40 项相关测试与 typecheck 全绿，无 CRITICAL。已修复项（ReferenceError 守卫、Entry 去重、M4 空 glob、重复下载删除）确认修复正确无回退，且探索波声称的 `command/index.ts` Default 枚举缺口经查该文件不存在，已证伪。主要风险集中在 H1（Windows 路径形态，同文件有 cygpath 先例）、H2（builtin 零测试 + 被删自检无替代）与 M3/M4/M5（builtin 路径不可回填、提示词两级表述、锁的 ENOENT/陈旧锁缺口）；建议合并前至少处理 H1、H2 与 M3，其余为文档与打磨项。