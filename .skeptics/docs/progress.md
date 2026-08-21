# 项目进度文档

## 进度总览
| 编号 | 标题 | 简述 | 目标 | 难度 | 进度 | 状态 |
|------|------|------|------|------|------|------|
| P001 | OpenCode-GraphAgent 源码安装（opencodeg） | 从源码构建 GraphAgent fork，产物命令名 opencodeg，配置隔离，与现有 opencode 共存 | opencodeg 可运行 | ⭐⭐⭐ | 100% | ✅ 已完成 |
| P003 | 自动更新体系 | 自动更新脚本：拉取→比对→编译/跳过，保留会话+日志 | opencodeg-update 可运行 | ⭐⭐⭐ | 100% | ✅ 已完成 |
| P004 | 版本号对齐上游（R10） | 修改 opencodeg-update：fetch --tags、rebase 前提取上游版本号、构建子 shell 双 env 钉死版本号 | 版本号对齐上游 v1.0.25（1.0.25-opencodeg） | ⭐⭐ | 100% | ✅ 已完成 |
| P005 | 修复 opencodeg 无模型 + 建同步机制（R11） | 建立 opencode→opencodeg 配置同步脚本（T301），修复无模型/无配置/dag skill 面板不可见，验证模型可用（T302/T303） | opencodeg 启动即有模型可用、配置与 opencode 一致、Skill 面板可见 dag skill | ⭐⭐⭐ | 100% | ✅ 已完成 |
| P007 | 增强 opencodeg-update：依赖自动解决 + DAG 配置智能同步（R13） | opencodeg-update 增强五项能力：①仓库自动拉取（已有）②数据不丢失（本地改动/会话DB/workflows自定义）③跟随发版版本号自动编译（已有+验证1.0.26）④依赖自动解决（bun.lock变化才install）⑤DAG配置智能同步（workflows转git checkout） | opencodeg-update 满足五项能力，可升级到 1.0.26-opencodeg | ⭐⭐⭐ | 100% | ✅ 已完成 |
| P006 | 补齐 opencodeg 的 DAG 流程化内容（R12） | 安装 16 个 DAG 模板到全局层（T401）、dag.jsonc 配 standard 模型（T402）、/dag-init 降级为记录失败+认证指引（T403）、/dag-flow 端到端验证（T404）、DAG 关键事实沉淀（T405）、/dag-init 平台握手（T406） | /dag-flow 可用（不依赖平台握手）；平台握手实质打通（can_push=false 已知限制） | ⭐⭐⭐ | 100% | ✅ 已完成 |
| P008 | 修复 opencodeg 命令名提示硬编码（R14） | 退出会话恢复提示 + 全部面向用户的命令名提示用 basename(process.execPath) 动态化（8 处 5 文件）；重建重装验证 | 恢复提示显示 opencodeg --mini -s ...；所有命令提示随产物名 | ⭐⭐ | 45% | 🔄 进行中 |

## 进度详情
### P001 - OpenCode-GraphAgent 源码安装（opencodeg）
- 实施时间：2026-08-17
- 结束时间：2026-08-17
- 结论简要：
  - 全链路完成：源码落地（git clone 镜像）→ bun 升级 1.3.14 → 命名改动 opencodeg → 构建（Linux bun shim）→ 安装 ~/.local/bin/opencodeg → 三层验收通过
  - 三重 Loop 发现并修复 3 个问题：T003 测试断言不同步（2 处 BLOCKER）、P1 隔离缺口（dag-prompts 硬编码 opencode 目录）
  - 最终产物：~/.local/bin/opencodeg，version 0.0.0-main-202608171045；opencode 1.17.18 共存无冲突
- 关联任务：T001, T002, T003, T003-FIX, T004, T005, T003-FIX2, T006

## 难题追踪
| 编号 | 难题标题 | 难度等级 | 影响范围 | 阻塞任务 | 当前状态 | 突破方案 | POC结果 |
|------|----------|----------|----------|----------|----------|----------|---------|
| P1-1 | 网络对 GitHub 不稳定 | 🔴 高 | 源码下载、依赖下载 | T001、T004 | ✅ 已解决 | git clone 走 ghfast.top 镜像（210.5MB 成功）；依赖走 npmmirror | 已验证 |
| P1-2 | 构建脚本版本检查 bun ^1.3.14 | 🟡 中 | 构建 | T004 | ✅ 已解决 | 升级系统 bun 1.3.6 → 1.3.14（npm 通道 + npmmirror） | 已验证 |
| P1-3 | 系统 bun 是 Windows shim 会构建 win32 目标 | 🔴 高 | 构建 | T004、T006 | ✅ 已解决 | 从 npmmirror 下载 Linux bun 1.3.14 到 /tmp/opencode/，PATH 前置 shim；tmux 会话防后台清理；MODELS_DEV_API_JSON 本地 fixture 绕过 models.dev 网络挂死 | 已验证 |
| P1-4 | bun.lock 被 npmmirror --registry 重写 | 🟡 中 | 可移植性 | T004 | ✅ 已解决 | 回滚 URL 重写，仅保留 bin 键一行；frozen-lockfile 离线验证通过 | 已验证 |
| P1-5 | dag-prompts 全局目录硬编码 opencode（P1 隔离缺口） | 🔴 高 | 配置隔离 | T006 | ✅ 已解决 | 改为 Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config 派生，与 workflows.ts 一致；重建重装验证 strings 无残留 | 已验证 |

### P003 - 自动更新体系
- 实施时间：2026-08-17
- 结束时间：2026-08-17
- 结论简要：
  - 全链路完成：产物 ~/.local/bin/opencodeg-update（bash 脚本 133 行，可执行），手动脚本触发（D5）
  - 功能：① git fetch（timeout 180）② 版本比对（rev-list --count feat/opencodeg-local..origin/main）③ 无变动跳过 exit 0 ④ 有变动 rebase+编译（timeout 1200）+ 原子安装 ⑤ 失败保留旧版+回滚 ⑥ 更新日志 updates.log 归档
  - 关键设计：D5 手动脚本 / D6 失败保留旧版 / D7 会话+日志保留；rebase 失败回滚（rollback）；构建超时保护；原子改名安装；curl/unzip 依赖检查；INT/TERM trap
  - 三重 Loop：Reviewer 首轮不通过（B1 编译失败不回滚、B2 构建无超时）→ T101-FIX 修复 → 复审通过；Tester 两轮 16/16 通过；Approval 终审通过 + 移交 4 项加固 → T101-HARDEN 落地 H1-H4
  - 验证：跳过路径实测 exit 0；会话数据 md5 不变；opencodeg/opencode 双二进制未覆盖；updates.log 正常追加
- 关联任务：T101, T101-FIX, T101-HARDEN, T102
- 首次真实更新（2026-08-18）：opencodeg-update 实跑通过，基线 e62a875a3 → 上游最新 v1.0.25（25a711b40，落后 14 提交）
  - 流程：fetch → 比对 14 提交 → rebase 零冲突 → 编译约 5 分钟 → 原子安装 → ✅ 更新完成
  - 本地改动保留：rebase 后本地 7 文件隔离改动完整保留在新 commit 5a51b8b8d；新版本号 0.0.0-feat/opencodeg-local-202608180142
  - 会话保留；opencode 1.17.18 共存未被覆盖
  - 关联任务：T103, T104

### P004 - 版本号对齐上游（R10）
- 实施时间：2026-08-18
- 结束时间：2026-08-18
- 结论简要：
  - 背景：T104 验证发现更新后版本号为 0.0.0-feat/opencodeg-local-202608180142（本地动态派生），未对齐上游 graphagent tag v1.0.25；本任务将构建版本号改为 `{上游 tag}-opencodeg`（如 1.0.25-opencodeg）
  - 实现（T201，改动仅 ~/.local/bin/opencodeg-update）：
    ① fetch 加 --tags（并入 `timeout 180 git fetch origin`，不另起无超时 fetch）
    ② rebase 前提取上游版本号 `UPSTREAM_VER`（git tag --sort=-v:refname --merged origin/main → grep 收紧 `^graphagent-v[0-9]+(\.[0-9]+){2}$` → head -1 → sed 去前缀；空则回退 `0.0.0-$(git branch --show-current)-$(date +%Y%m%d%H%M)`）；`--merged origin/main` 防 hotfix 高 tag 误报、`|| true` 防 set -e 下无匹配中止
    ③ 构建子 shell 双 env：`OPENCODE_CHANNEL=feat/opencodeg-local`（钉死保 DB 路径稳定 opencode-feat-opencodeg-local.db，勿改动态）+ `OPENCODE_VERSION=${UPSTREAM_VER}-opencodeg`
  - 其余逻辑（rebase/回滚/超时/安装/日志）不动
  - 已知限制（Q1）：上游"新 tag + 无新 commit"时脚本 exit 0 不重建，版本停留旧对齐值——release 必有新 commit，窗口罕见；T202 强制构建覆盖当前实例
- 关联任务：T201, T202
- 并行分组：
  - 批7：T201（修改脚本）
  - 批8：T202（依赖 T201，构建 5-12 分钟）
- 不做什么：不改核心代码、不改发布逻辑、不触碰 opencode 1.17.18、不 commit、不 push
- 验证要点（T202）：手动强制构建（自然路径 NEW_COUNT=0 不触发）取 UPSTREAM_VER=1.0.25 → 双 env → timeout 1200 构建 → 原子安装；断言 `opencodeg --version` 含 1.0.25-opencodeg、会话 DB 仍为 opencode-feat-opencodeg-local.db、会话数据 md5 不变、opencode 1.17.18 不变、updates.log 记录新版本；scratch 验证无 tag 回退分支不中止
- 完成结论（2026-08-18）：
  - 产物版本 1.0.25-opencodeg 与上游 graphagent-v1.0.25 对齐；后续更新版本号自动随上游 tag 同步
  - 双 env 钉死 OPENCODE_CHANNEL=feat/opencodeg-local 保会话 DB 路径稳定（opencode-feat-opencodeg-local.db），会话数据不消失
  - fetch --tags + rebase 前版本提取（--merged origin/main + grep 3 段正则 + `|| true` 回退）落地，无 tag 时回退分支正常不中止
  - 三重 Loop 全过：Reviewer ✅ / Tester 7/7 ✅ / Approval ✅
  - T202 强制构建验证 7/7 断言全过（1.0.25-opencodeg / DB 不变 / md5 不变 / opencode 1.17.18 不变 / updates.log 记录新版本 / 回退分支 / 版本对齐）

### P005 - 修复 opencodeg 无模型 + 建同步机制（R11）
- 实施时间：2026-08-18（任务规划完成）
- 结束时间：2026-08-18（全部完成）
- 当前阶段：✅ 已完成（T301 ✅、T302 ✅、T303 ✅，Approval 终审通过）
- 进度：100%
- 结论简要：
  - 背景（用户报告）：opencodeg 启动后看不到之前导入的 opencode 配置（B1）、没有模型可用（B2）、Skill 面板看不到 dag 系列内置 skill（B3）
  - 根因（Phase1 实证）：配置目录隔离（~/.config/opencodeg/opencode.jsonc 仅 50B）；~/.local/share/opencodeg/ 无 auth.json；默认模型 glm-5.2 未声明 → 报错 "No configured text models for MEMORY"（无已配置的文本模型可供 MEMORY 使用）
  - 方案（Approval 四轮审批终版）：T301 配置同步（P0，脚本优先、幂等可重跑）、T302 验证模型可用（P0，断言①-⑧）、T303 dag skill 面板验证（P1，内置 skill 与 superpowers plugin 无关）
  - 实施（2026-08-18）：T301 ✅ 同步脚本落地（~/.local/bin/opencodeg-sync-config，幂等重跑 diff 验证通过）；T302 ✅ 验证通过，其中 T302-FIX 三项修复：① zod 本地拷贝 zod@4.1.8 / effect@4.0.0-beta.83（满足同步脚本 5b/5c 条件改写依赖升级后的 zod 校验）② 行为配置 default_agent=leader（opencodeg 无内置 main agent，D12）③ browser 适配 bunx（monorepo 慢盘 npx 首次超 30s 超时，D15）；项目目录 14/14 验证通过
  - T303 ✅ 完成（2026-08-18）：create-dag-workflow 面板可见三层实证全过——① 数据层：app.skills() 含 create-dag-workflow ② 展示层：opencodeg run "列出你可用的技能" 输出含 create-dag-workflow ③ 渲染层：TUI Skill 面板可见 create-dag-workflow；B3 闭环（与 superpowers plugin 无关，内置 skill 编译进二进制）
  - 已知限制（最终化，均验收接受）：
    | 编号 | 已知限制 | 实测 | 验收结论 |
    |------|----------|------|----------|
    | K1 | models.dev 冷启动阻塞 provider 注入 | ~23-24.8s TUI 空窗，无本地缓存 | 接受（D14），不建缓存不改源码不判失败 |
    | K2 | opencode 1.17.18 run 模式 default_agent=main 无效 | 报 `default agent "main" not found`（上游已改名 build，07-10 起持续） | 接受（D13），TUI 会话可用不受影响 |
    | K3 | 同步脚本 5c 正则结构敏感 fail-safe | 匹配不到预期结构则跳过改写，不误伤 | 接受，幂等重跑 diff 验证兜底 |
    | K4 | browser MCP 用 bunx 而非 npx | monorepo 慢盘 npx 首次超 30s 超时；bunx 5.8s | 接受（D15），playwright 包/浏览器已装 |
  - 突破计划：T301 ⭐⭐⭐ 调研已完成（Approval 四轮源码/文件系统/沙箱/代理实测），直接实施；脚本优先保证幂等可验证
  - 红线：含 apiKey 配置/auth.json 禁止 commit 进 git；不触碰 opencode 1.17.18；同步严格单向（opencode → opencodeg）
- 关联任务：T301, T302, T303
- 依赖链：T301 → T302 → T303（串行，全部完成）
- 并行分组：首轮仅 T301 无并行；T301→T302→T303 串行完成后全绿

### P006 - 补齐 opencodeg 的 DAG 流程化内容（R12）
- 实施时间：2026-08-18（任务规划完成）
- 结束时间：2026-08-19（T406 平台握手补充完成）
- 当前阶段：✅ 已完成（T401 ✅、T402 ✅、T403 ✅、T404 ✅、T405 ✅、T406 ✅，Reviewer ✅ + Tester 9/9 ✅ + 用户裁决 T406 ✅）
- 进度：100%
- 结论简要：
  - 背景（用户需求 R12）：作者对 opencode 有重大改造——DAG 流程化内容；opencodeg 需补齐
  - 需求确认（2026-08-18，Approval 二轮 ✅）：
    | 项 | 裁决 |
    |----|------|
    | 完成杆 | /dag-flow 可用（不依赖平台握手） |
    | 模板全局层 | ~/.config/opencodeg/workflows/（D16） |
    | dag.jsonc 模型 | 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash，单 tier 即统一默认（D17） |
    | /dag-init | 降级为"记录失败 + 交付认证指引"（D18） |
  - 关键前置实证：二进制无 builtin 模板（strings 验证），依赖全局 workflows 目录 → T401 是 /dag-flow 可用的强前置
  - 实施（2026-08-18）：
    - T401 ✅：ghfast.top 代理 clone opencode-dag-config → 仅复制 16 个 YAML 到 ~/.config/opencodeg/workflows/（目录干净）；模板全局层就绪
    - T402 ✅：dag.jsonc 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash；config.ts 确认 critical→advanced 其余→standard，单 tier 全兜底；模型格式 provider/model，不 pin 到 saved workflow spec
    - T403 ✅：交付 .skeptics/docs/dag-init-guidance.md 认证指引；失败实证于 step1（ghfast.top unsupported platform），非 gh/auth 步骤；内置提示旧路径 ~/.config/opencode/workflows 已纠正为 opencodeg
    - T404 ✅：/dag-flow 端到端验证通过——16 模板之一 reference 路径返回 Workflow ID + 模型解析确认；headless 收尾 workflow(control=cancel) 防子会话残留；遗留 draft 草稿清理
    - T405 ✅：DAG 关键事实 8 条经验沉淀 learned.md（R12 章节）
    - T406 ✅（2026-08-19）：/dag-init 平台握手——用户完成 gh 认证（gh 2.45.0 + znewyear ssh）并改 origin=ssh git@github.com 后重跑，全通过：平台检测✅ gh 认证✅ CI✅ rulesets✅ 模板✅；.opencode/dag-init.json 生成
  - 平台握手结果表（T406，2026-08-19）：
    | 项 | 结果 |
    |----|------|
    | 平台检测 | ✅ platform=github（origin=ssh git@github.com 通过 step1） |
    | gh 认证 | ✅ cli=gh，znewyear（ssh 协议） |
    | CI | ✅ has_ci=true |
    | Rulesets | ✅ has_rulesets=true |
    | 模板 | ✅ has_templates=true（全局层 16 模板，T401） |
    | 推送权限 | ❌ can_push=false——znewyear 对 LeXwDeX/OpenCode-GraphAgent 作者仓库只读 |
    | 用户裁决 | ✅ 接受现状，记录结果；/dag-auto 为增强项，未来在有写权限的项目使用 |
  - can_push 限制：can_push=false 意味着 /dag-auto（六积木超流，需写权限开 PR）在本仓库不可用；/dag-flow（常驻编排路由）不依赖平台握手，不受影响
  - 完成杆达成：/dag-flow 可用（不依赖平台握手）✅；平台握手实质打通（can_push 权限边界明确）✅
  - 关联任务：T401, T402, T403, T404, T405, T406
  - 依赖链：T401/T402/T403（并行）→ T404 → T405（串行，全部完成）→ T406（补充，依赖用户认证+步骤 A）
  - 并行分组：批9（T401+T402+T403，并行无依赖）→ 批10（T404，依赖 T401+T402）→ 批11（T405，依赖全部）→ 批12（T406，依赖用户认证）

### P007 - 增强 opencodeg-update：依赖自动解决 + DAG 配置智能同步（R13）
- 实施时间：2026-08-19（需求讨论+任务规划+实施+回归）
- 结束时间：2026-08-19（全部完成，真实更新回归验证通过）
- 当前阶段：✅ 已完成（T501 ✅、T502 ✅、T503 ✅，三重 Loop 全过）
- 进度：100%
- 结论简要：
  - 背景（用户需求 R13）：opencodeg-update 需增强五项能力：①仓库自动拉取（已有）②数据不丢失（本地改动/会话 DB/workflows 自定义模板）③跟随发版版本号自动编译（已有+验证）④依赖自动解决（bun.lock 变化才完整 install）⑤DAG 配置智能同步
  - 需求确认（2026-08-19，Approval 审视修正）：
    | 决策 | 内容 |
    |------|------|
    | D20 | DAG 配置集成方式：拉取 opencode-dag-config 智能同步（git 跟踪识别自定义保留，替代"纯补齐缺失"——后者在用户 workflows 已齐全时会永不更新） |
    | D21 | 数据保护范围：本地 feat/opencodeg-local 改动 + 会话历史 DB + workflows 自定义模板 |
    | D22 | 依赖解决：检测根 bun.lock hash 变化才完整 bun install（npmmirror 源） |
    | D23 | 触发机制：保持手动运行 opencodeg-update |
  - 实施（2026-08-19）：
    - T501 ✅ 依赖自动解决：opencodeg-update 加 OLD_LOCK_SHA/NEW_LOCK_SHA + 变化才 install（npmmirror，失败 rollback）；TDD 12/12 PASS
    - T502 ✅ DAG 智能同步脚本（~/.local/bin/opencodeg-sync-dag）：经 FIX2-FIX7 共 6 轮修复（cmp 误判→git 基线判定→基线污染→untracked 识别→幂等细化→网络 timeout），最终方案 = git status --porcelain 判定自定义 + cmp 幂等；E2E 10/10 + 边界 4/4
    - T503 ✅ 集成+真实回归：opencodeg-update ⑥.5 段集成（失败不阻断）；真实更新 1.0.25→1.0.26-opencodeg 全链路验证通过
  - 真实更新回归（T503b，用户授权）：
    - 预检：工作区有 .gitignore 修改+3 untracked → git stash push -u → 更新 → stash pop 还原
    - 流程：fetch 46 提交 → rebase 1 提交 → bun.lock 无变化跳过 install（T501 省时生效）→ 构建 7 分钟 → 原子安装 1.0.26-opencodeg → DAG 同步（15 一致 + code-review-lite 更新）
    - 处理：构建后 bun.lock 被 build.ts 内置 install 污染（npmmirror URL）→ git checkout 还原；stash 还原 .gitignore+3 untracked
    - 回归验证全绿：版本 1.0.26-opencodeg / models 正常 / workflows 16 文件无自定义丢失 / git baseline+sync 两提交
  - 已知副作用（验收接受）：build.ts 内置 3 次 `bun install`（第 151-153 行）每次构建会重写 bun.lock 源 URL 为 npmmirror → 构建后需 `git checkout -- bun.lock` 还原，不可提交
  - 关联任务：T501, T502, T503（T503a 集成 + T503b 真实回归）
  - 依赖链：T501 → T502（独立）→ T503a（依赖 T501+T502）→ T503b（依赖 T503a+用户授权）
