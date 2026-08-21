# 项目任务文档

## 任务列表
| 进度标题 | 任务标题 | 实现目标 | 分类 | 优先级 | 难度 | 开始时间 | 结束时间 | 状态 | 是否解决 | 简要 |
|----------|----------|----------|------|--------|------|----------|----------|------|----------|------|
| P001 | T001 源码落地 | GraphAgent main 分支源码入工作目录，保留 git HEAD | 配置 | P0 | ⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | git clone ghfast.top 镜像，HEAD=e62a875a，6198 文件 |
| P001 | T002 环境升级 bun | bun 升级到 ^1.3.14 | 配置 | P0 | ⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | 1.3.6→1.3.14，npm 通道 npmmirror |
| P001 | T003 源码命名改动 | 产物命令名 opencodeg（4 处） | 修改 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | package.json bin/build.ts outfile+path/global.ts app |
| P001 | T003-FIX 测试断言同步 | 修复 global.test.ts + cli-process.ts 断言 | 修改 | P0 | ⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | 2+7 pass |
| P001 | T004 构建独立二进制 | build.ts --single --skip-embed-web-ui 出 opencodeg | 新增 | P0 | ⭐⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | Linux bun shim 解决 win32 劫持，产物 144MB ELF |
| P001 | T005 安装与验证 | 安装 ~/.local/bin/opencodeg 三层验收 | 配置 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | 功能/命名隔离/配置隔离/TUI 全过 |
| P001 | T003-FIX2 dag-prompts 隔离修复 | resolve.ts 全局目录改 Flag/Global 派生 | 修改 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | P1 隔离缺口，17/17 测试过 |
| P001 | T006 重建重装再验证 | P1 修复后重建+重装+strings 验证 | 构建 | P0 | ⭐⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | version 1045，strings=0 残留，bun.lock 2 行 |
| P003 | T101 自动更新脚本实现 | ~/.local/bin/opencodeg-update：fetch→比对→编译/跳过，保留会话+日志 | 新增 | P0 | ⭐⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | 133 行 bash；D5/D6/D7；Reviewer 首轮❌→T101-FIX→复审✅ |
| P003 | T101-FIX Reviewer 阻断修复 | B1 编译失败不回滚、B2 构建无超时 | 修改 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | 失败分支统一回滚 OLD_HEAD；timeout 1200 包构建 |
| P003 | T101-HARDEN Approval 加固落地 | Approval 终审移交 4 项加固 H1-H4 | 修改 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | ensure_bun mkdir -p、curl/unzip 检查、trap INT/TERM、原子改名安装 |
| P003 | T102 自动更新验证 | 验证跳过路径/会话保留/日志正确 | 测试 | P0 | ⭐⭐ | 2026-08-17 | 2026-08-17 | ✅已完成 | ✅ | Tester 两轮 16/16；跳过 exit 0；会话 md5 不变；双二进制未覆盖 |
| P003 | T103 更新执行 | 运行 opencodeg-update 更新上游到 v1.0.25（25a711b40） | 更新 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | fetch→比对 14 提交→rebase 零冲突→编译约 5 分钟→原子安装→✅ 更新完成；本地 7 文件改动保留在 5a51b8b8d；unzip 缺失用 python3 包装解决 |
| P003 | T104 更新验证 | 验证更新后版本/会话保留/opencode 共存 | 测试 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 新版本 0.0.0-feat/opencodeg-local-202608180142；会话保留；opencode 1.17.18 共存未覆盖；bun.lock 还原干净 |
| P004 | T201 修改 opencodeg-update 脚本 | fetch --tags；rebase 前提取上游版本号；构建子 shell 双 env 钉死版本号 | 修改 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 改动仅 ~/.local/bin/opencodeg-update；UPSTREAM_VER=grep 收紧 3 段数字+--merged origin/main+`|| true`；OPENCODE_CHANNEL=feat/opencodeg-local（钉死保 DB 路径）+OPENCODE_VERSION=${UPSTREAM_VER}-opencodeg；其余 rebase/回滚/超时/安装/日志不动；Approval 捕获"仅设 OPENCODE_VERSION 致 CHANNEL 变 latest→DB 切换会话消失"阻断项→双 env 解决 |
| P004 | T202 验证 | 强制构建验证版本号对齐/会话保留/无 tag 回退 | 测试 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 手动强制构建（自然路径 NEW_COUNT=0 不触发）：UPSTREAM_VER=1.0.25→双 env→timeout 1200 build.ts--single--skip-embed-web-ui→原子安装；7/7 断言全过：1.0.25-opencodeg/DB 不变/md5 不变/opencode 1.17.18 不变/updates.log/回退分支/版本对齐；Tester 7/7 + Reviewer/Approval 全过 |
| P005 | T301 配置同步 + 同步脚本 | opencodeg 配置完全对齐 opencode 行为：幂等脚本 opencodeg-sync-config | 新增 | P0 | ⭐⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 脚本优先原则：pgrep 运行检测→备份→整体复制 opencode.jsonc→条件改写 model（5b/5c）→plugin 归一化→auth.json 600 重拷；不硬编码 key/不进 git/手动触发；Approval 修正已采纳；依赖链首节点 |
| P005 | T302 验证模型可用 | 重启后断言模型可用、无 MEMORY 报错 | 测试 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 依赖 T301；断言①-⑧（无 MEMORY 报错/provider 可见/默认模型发消息/auth 600/opencode 不受影响/models.dev 噪音/mcp 不阻断）；T302-FIX：zod 修复 + default_agent=leader + browser bunx 适配；项目目录 14/14 验证通过 |
| P005 | T303 验证 dag skill 面板可见 | Skill 面板/技能列表含 create-dag-workflow | 测试 | P1 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 依赖 T302，不依赖 T301 插件步骤（Approval 修正）；create-dag-workflow 是内置 skill 编译进二进制，与 superpowers plugin 无关；三层实证通过：数据层 app.skills() 含 → run 技能列表含 → TUI Skill 面板可见 |
| P006 | T401 模板库安装 | 16 YAML → ~/.config/opencodeg/workflows/ | 新增 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | ghfast.top 代理 clone → 仅复制 16 YAML 到全局层，目录干净；二进制无 builtin 模板（strings 0 命中）依赖全局层 |
| P006 | T402 dag.jsonc 配置 standard | 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash | 配置 | P0 | ⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 单 tier 即统一默认（config.ts 确认 critical→advanced 其余→standard）；模型格式 provider/model；不 pin model 到 saved workflow spec |
| P006 | T403 /dag-init 降级 | 预期失败记录 + 认证指引文档交付 | 文档 | P0 | ⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 交付 .skeptics/docs/dag-init-guidance.md；失败于 step1（ghfast.top unsupported platform）非 gh/auth；内置提示旧路径 ~/.config/opencode 已纠正为 opencodeg |
| P006 | T404 /dag-flow 端到端验证 | 16 模板之一 reference 路径跑通，返回 Workflow ID | 测试 | P0 | ⭐⭐⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | Workflow ID 返回 + 模型解析确认；headless 收尾 workflow control=cancel 防子会话残留 |
| P006 | T405 DAG 关键事实沉淀 | DAG 关键事实写入 learned.md | 文档 | P1 | ⭐ | 2026-08-18 | 2026-08-18 | ✅已完成 | ✅ | 8 条经验（现象→根因→方案→可复用性）追加 learned.md R12 章节 |
| P006 | T406 /dag-init 平台握手 | 用户认证后重跑 /dag-init 平台握手，记录权限结果 | 测试 | P0 | ⭐⭐ | 2026-08-19 | 2026-08-19 | ✅已完成 | ✅ | gh 2.45.0 已装 + znewyear ssh 认证；origin 改 ssh git@github.com；.opencode/dag-init.json 生成（platform=github, can_push=false, has_ci=true, has_rulesets=true, has_templates=true）；znewyear 对作者仓库只读→can_push=false 为已知限制，用户裁决接受现状 |
| P007 | T501 依赖自动解决 | opencodeg-update 增加：rebase 前记录根 bun.lock hash，rebase 后对比，变化才完整 bun install（npmmirror）；install 失败沿用 rollback | 修改 | P1 | ⭐⭐⭐ | 2026-08-19 | 2026-08-19 | ✅已完成 | ✅ | OLD_LOCK_SHA/NEW_LOCK_SHA（82/95 行）+变化才 install（105-110 行，npmmirror）；TDD 12/12 PASS；真实更新实测"bun.lock 无变化跳过"✅ |
| P007 | T502 DAG 智能同步独立脚本 | 新建 ~/.local/bin/opencodeg-sync-dag：拉取 opencode-dag-config（ghfast 镜像）→ workflows/ 转 git checkout（POC 已验证）→ git pull + 逐文件 git diff 识别自定义（保留+警告 / 自动更新）→ runtime-compat.json 校验（仅警告） | 新增 | P1 | ⭐⭐⭐ | 2026-08-19 | 2026-08-19 | ✅已完成 | ✅ | 最终方案=git 基线判定（git status --porcelain 识别 untracked/modified）+ cmp 幂等；经 FIX2-FIX7 共 6 轮修复（详见 R13 WBS）；E2E 10/10 + 边界 4/4 + dry-run 幂等全过 |
| P007 | T503 集成+回归验证 | opencodeg-update 主更新成功后调用 opencodeg-sync-dag（失败不阻断）；真实运行更新到 1.0.26-opencodeg；验证版本号/数据保留/模板同步/依赖处理 | 修改 | P1 | ⭐⭐ | 2026-08-19 | 2026-08-19 | ✅已完成 | ✅ | T503a 集成（⑥.5 ⑥.5 段 command -v + 失败不阻断）；T503b 真实更新 1.0.25→1.0.26-opencodeg ✅ rebase 1 提交→bun.lock 无变化跳过→构建 7 分钟→DAG 同步 15 一致+1 更新；bun.lock 构建污染已恢复，stash 已还原 |
| P008 | T601 命令名提示动态化 | 全部面向用户的命令名提示用 basename(process.execPath) 替换硬编码 opencode：splash.ts:237(恢复会话)/error.ts:67,105/acp/service.ts:94,102/provider/error.ts:61/provider.ts:786,872 | 修改 | P0 | ⭐⭐ | 2026-08-19 | 2026-08-19 | ✅已完成 | ✅ | 8 处 5 文件全改；新增 src/command-name.ts（module shape 合规）；新增/整合 5 个测试文件（15 用例/0 失败）；三重 Loop 通过（Reviewer PASS→Tester PASS→Approval 1 轮修正后 PASS）；红线零触碰（provider ID/uninstall/upgrade/注释）；typecheck REAL_EXIT=0 |
| P008 | T602 重建重装验证 | 重建 opencodeg（构建约7-12分钟）→ 重装 ~/.local/bin/opencodeg → 退出 TUI 验证恢复提示显示 opencodeg --mini -s ...；回归 models/基本命令；**含 pr.ts:83/104 功能性 spawn 改用 process.execPath 修复（Approval 批注强制项）** | 构建 | P0 | ⭐⭐ | 2026-08-19 | | ⬜未开始 | ❌ | 依赖 T601；会动真实二进制（用户已授权）；验证 provider.ts 硬编码 strings 扫描 + 手动触发 |

## 并行分组（执行记录）
| 批次 | 任务 | 说明 | 结果 |
|------|------|------|------|
| 批1 | T001 + T002 | 并行，无依赖 | ✅ 都 DONE |
| 批2 | T003 | 依赖 T001 | ✅ 三重Loop（Reviewer❌→FIX→复审✅） |
| 批3 | T004 | 依赖 T002+T003 | ✅ 构建成功 |
| 批4 | T005 | 依赖 T004 | ✅ 三层验收 |
| 追加 | T003-FIX2 + T006 | 最终审查发现 P1 | ✅ 重建重装验证 |
| 批5 | T101 | 依赖 P001 构建环境 | ✅ 三重Loop（Reviewer❌→T101-FIX✅→复审✅；Approval→T101-HARDEN✅） |
| 批6 | T102 | 依赖 T101 | ✅ Tester 独立新鲜验证 16/16 |
| 批7 | T201 | 修改脚本，无依赖 | ✅ 完成（Approval 捕获 DB 切换会话消失阻断项→双 env 解决） |
| 批8 | T202 | 依赖 T201 | ✅ 完成（强制构建 7/7 断言全过，构建 5-12 分钟） |
| 批9 | T401 + T402 + T403 | 并行，无依赖 | ✅ 全绿（T401/T402/T403 均已完成） |
| 批10 | T404 | 依赖 T401+T402 | ✅ 完成（/dag-flow 端到端返回 Workflow ID） |
| 批11 | T405 | 依赖全部 | ✅ 完成（learned.md R12 章节沉淀） |
| 批12 | T406 | 依赖用户 gh 认证 + 步骤 A（改 remote） | ✅ 完成（平台握手实质打通，can_push=false 已知限制，用户裁决接受现状） |

## 文件锁登记（已全部释放）
| 任务ID | 锁定文件 | 获取时间 | 释放时间 |
|--------|----------|----------|----------|
| T001 | 整个工作目录源码树 | 2026-08-17 | 已释放 |
| T002 | 系统 bun 二进制 | 2026-08-17 | 已释放 |
| T003 | package.json/build.ts/global.ts | 2026-08-17 | 已释放 |
| T004 | packages/opencode/dist/、node_modules/、bun.lock | 2026-08-17 | 已释放 |
| T005 | ~/.local/bin/opencodeg | 2026-08-17 | 已释放 |
| T003-FIX2 | resolve.ts | 2026-08-17 | 已释放 |
| T006 | dist/、~/.local/bin/opencodeg、bun.lock | 2026-08-17 | 已释放 |

## R11 任务分解（WBS）✅ 全部完成（2026-08-18，P005 100%）

```
R11 修复 opencodeg 无模型 + 建同步机制  ✅ 全部完成（T301/T302/T303 均 ✅，2026-08-18）
├── T301 [P0 ⭐⭐⭐] 配置同步 + 同步脚本 ✅ 已完成
│     目标：opencodeg 配置完全对齐 opencode 行为
│     涉及文件：~/.local/bin/opencodeg-sync-config(新建脚本)、~/.config/opencodeg/opencode.jsonc、~/.local/share/opencodeg/auth.json
│     技术方案（脚本优先原则，采纳 Approval 修正）：
│     ├─ 步骤1: 写幂等脚本 opencodeg-sync-config（核心逻辑全部进脚本，不手工执行）✅ 落地
│     │       ├─ pgrep opencodeg 运行中检测 → 警告/中止 ✅
│     │       ├─ 备份限定 opencode.jsonc 单文件（.bak 首次创建后不覆盖）✅
│     │       ├─ 整体复制 opencode.jsonc（provider/mcp/plugin/行为配置）✅
│     │       ├─ 条件改写 model/small_model: glm-5.2(未声明)→yc-proxy-gpt/deepseek-v4-flash ✅
│     │       ├─ plugin 归一化 ~/.config/opencode/node_modules/superpowers → /home/newyear/绝对路径 ✅
│     │       ├─ auth.json 复制(600,非软链,每次重拷) ✅
│     │       └─ 不硬编码任何 key；手动触发；不进 git ✅
│     ├─ 步骤2: 运行脚本完成首次同步 ✅
│     └─ 步骤3: 重跑第二遍验证幂等（diff 目标文件一致）✅
│     不做什么：不触碰 opencode 1.17.18 配置/数据；不动 DB ✅
│     验证标准：脚本可重跑幂等；opencodeg 启动无 MEMORY 报错 ✅
├── T302 [P0 ⭐⭐] 验证模型可用（依赖 T301）✅ 已完成（T302-FIX 3 项修复，项目目录 14/14 验证通过）
│     技术方案（采纳 Approval 可观测命令）：
│     ├─ 先停 opencodeg 再同步（已由 T301 脚本 pgrep 覆盖）✅
│     ├─ opencodeg models → 断言输出含 yc-proxy-gpt/deepseek-v4-flash ✅
│     ├─ opencodeg run "ping"（非交互）→ 断言正常返回无 "no model" 错误 ✅
│     ├─ grep ~/.local/share/opencodeg/log/opencode.log → 同步前签名 "No configured text models for MEMORY" 应消失（最硬前后对照）✅
│     ├─ 断言①-⑧（见 requirement.md R11 T302）：无 MEMORY 报错/provider 列表可见/默认模型发消息/auth 600 生效/opencode 不受影响/models.dev 噪音不判失败/行为配置 default_agent=leader(D12) permission=allow lsp enabled autoupdate=false（opencode 1.17.18 侧保持 main，D13）/mcp 失败不阻断 ✅
│     └─ 网络干扰处理：models.dev TimeoutError 间歇出现，区分"配置错误"与"网络不可达" ✅
│     T302-FIX（执行中发现 3 项修复，项目目录 14/14 验证通过）：
│     ├─ zod 修复：本地拷贝 zod@4.1.8 / effect@4.0.0-beta.83 到项目，满足同步脚本 5b/5c 条件改写依赖升级后的 zod 校验 ✅
│     ├─ default_agent=leader：opencodeg 无内置 main agent，行为配置由 main 改 leader（D12，用户裁决）✅
│     └─ browser 适配 bunx：MCP browser 由 npx 改 bunx，monorepo 慢盘下 npx 首次超 30s 超时（D15）✅
└── T303 [P1 ⭐⭐] 验证 dag skill 面板可见（依赖 T302，不依赖 T301 插件步骤——修正）✅ 已完成
     技术方案（采纳 Approval：create-dag-workflow 是内置 skill，编译进二进制，与 superpowers plugin 无关）：
     ├─ 可观测路径：opencodeg run "列出你可用的技能" → 断言输出含 create-dag-workflow ✅ 通过
     └─ 备选：TUI Skill 面板截图含 create-dag-workflow 为完成 artifact ✅ 通过（三层实证：数据层 app.skills() → 展示层技能列表 → 渲染层 TUI Skill 面板）
依赖链：T301 → T302 → T303（串行，全部完成）
```

**困难任务突破计划**：T301 ⭐⭐⭐ —— 调研已完成（Approval 四轮源码/文件系统/沙箱/代理实测），直接实施；脚本优先保证幂等可验证。

## R12 任务分解（WBS）✅ 全部完成（T401-T405 2026-08-18，T406 2026-08-19，P006 100%；Reviewer ✅ + Tester 9/9 ✅ + 用户裁决 T406 ✅）

```
R12 补齐 opencodeg 的 DAG 流程化内容（作者对 opencode 重大改造）✅ 全部完成（T401/T402/T403/T404/T405 2026-08-18 + T406 2026-08-19）
├── T401 [P0 ⭐⭐] 模板库安装（16 YAML → ~/.config/opencodeg/workflows/）✅ 已完成
│     目标：16 个 DAG 模板安装到全局层，供 /dag-flow 使用
│     技术方案：
│     ├─ clone 源必须用 ghfast.top 代理：https://ghfast.top/https://github.com/LeXwDeX/opencode-dag-config.git
│     │   （直连 github.com 超时，见 P1-1）
│     ├─ 目标目录 ~/.config/opencodeg/workflows/（用户裁决 D16：模板全局层）
│     └─ 强前置依据：二进制无 builtin 模板（strings 验证），依赖全局 workflows 目录 → T401 是 /dag-flow 可用的强前置
│     完成实证：ghfast.top 代理 clone → 仅复制 16 个 YAML 到全局层，目录干净 ✅
├── T402 [P0 ⭐] dag.jsonc 配置 standard=yc-proxy-gpt/deepseek-v4-flash ✅ 已完成
│     目标：单 tier 即统一默认模型
│     技术方案：
│     ├─ 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash（用户裁决 D17）
│     └─ 不 pin model 到 saved workflow spec（沿用 AGENTS.md 约束）
│     完成实证：config.ts 确认 critical→advanced 其余→standard，单 tier 全兜底；模型格式 provider/model ✅
├── T403 [P0 ⭐⭐] /dag-init 预期失败记录 + 认证指引文档交付 ✅ 已完成
│     目标：/dag-init 降级为"记录失败 + 交付认证指引"（用户裁决 D18）
│     技术方案：
│     ├─ 文档交付：.skeptics/docs/dag-init-guidance.md ✅ 交付
│     ├─ 注意：dag-init 内置提示写死 ~/.config/opencode/workflows 是旧路径，对 opencodeg 应为 ~/.config/opencodeg/workflows
│     └─ 失败点实证：dag-init 失败于 step1（ghfast.top unsupported platform），非 gh/auth 步骤
├── T404 [P0 ⭐⭐⭐] /dag-flow 端到端验证（依赖 T401+T402）✅ 已完成
│     目标：16 模板之一 reference 路径跑通，返回 Workflow ID
│     成功标准：返回 ID + 初始状态，无需跑完整 DAG
│     完成实证：Workflow ID 返回 + 模型解析确认；headless 收尾 workflow control=cancel 防子会话残留 ✅
└── T405 [P1 ⭐] DAG 关键事实沉淀 learned.md（依赖全部）✅ 已完成
      内容：DAG 关键事实（模板安装/配置/验证经验）写入 learned.md（R12 章节 8 条经验）✅
追加 T406 [P0 ⭐⭐] /dag-init 平台握手（2026-08-19，用户认证后补做）✅ 已完成
     目标：用户完成 gh 认证后重跑 /dag-init，验证平台握手链路
     前置（用户已执行）：gh 2.45.0 已装 + znewyear 已认证（ssh 协议）；步骤 A 已改 origin=ssh git@github.com（ghfast 镜像保留为独立 fetch remote）
     完成实证：opencodeg run "/dag-init" 全通过——平台检测✅ gh 认证✅ CI✅ rulesets✅ 模板✅；.opencode/dag-init.json 生成
     （platform=github, repo=LeXwDeX/OpenCode-GraphAgent, remote=origin, base_branch=main, cli=gh, can_push=false,
       has_ci=true, has_rulesets=true, has_templates=true, merge_policy=ordered, checked_at=2026-08-19T01:38:32Z）
     结果：can_push=false——znewyear 对 LeXwDeX/OpenCode-GraphAgent 作者仓库只读，无 push 权限
     用户裁决：接受现状，记录结果；/dag-auto 为增强项，未来在有写权限的项目使用

依赖链：T401/T402/T403（并行）→ T404 → T405（串行，全部完成）→ T406（补充，依赖用户认证+步骤 A）
并行分组：批9（T401+T402+T403）→ 批10（T404）→ 批11（T405）→ 批12（T406），全绿

关键事实（供后续引用）：
- 二进制无 builtin 模板（strings 验证），依赖全局 workflows 目录 → T401 是 /dag-flow 可用的强前置
- 平台握手（T406，2026-08-19）：origin 改 ssh 后 /dag-init 全通过，dag-init.json 生成；can_push=false（znewyear 对作者仓库只读），has_ci/has_rulesets/has_templates=true；用户裁决接受现状，/dag-auto 未来在有写权限项目使用
- runtime-compat.json 的 b48dce469 是本地 HEAD(5a51b8b8d) 祖先，模板兼容性高

## R13 任务分解（WBS）✅ 全部完成（T501/T502/T503 2026-08-19，P007 100%；三重 Loop 全过 + 真实更新回归验证）

```
R13 增强 opencodeg-update：依赖自动解决 + DAG 配置智能同步  ✅ 全部完成（T501/T502/T503 均 ✅，2026-08-19）
├── T501 [P1 ⭐⭐⭐] 依赖自动解决 ✅ 已完成
│     目标：rebase 后根 bun.lock 变化才完整 bun install（npmmirror），否则跳过
│     实现：opencodeg-update 82 行 OLD_LOCK_SHA + 95 行 NEW_LOCK_SHA（sha256sum bun.lock）
│           + 105-110 行 变化判断 → BUN_CONFIG_REGISTRY=npmmirror bun install（失败 rollback）
│     验证：TDD 12/12 PASS；bash -n；真实更新实测"bun.lock 无变化，跳过依赖安装"✅
│     副产品事实：build.ts 内置 3 次 bun install（@opentui/core/@parcel/watcher/@ff-labs/fff-bun）
│           会更新 bun.lock（URL 重写为 npmmirror）→ 构建后需 git checkout -- bun.lock 还原
├── T502 [P1 ⭐⭐⭐] DAG 智能同步独立脚本 ✅ 已完成（FIX2-FIX7 共 6 轮修复）
│     目标：新建 ~/.local/bin/opencodeg-sync-dag（-t 目标目录 / --dry-run）
│          拉取上游→git 基线判定自定义→保留/更新→幂等→runtime-compat 警告
│     六轮修复（Approval/Reviewer 驱动 + E2E 实证）：
│     ├─ FIX2 [BLOCKER] cmp 内容比对无法区分"旧上游版本"vs"用户自定义"→上游更新被丢弃
│     │        → 改 git diff --quiet HEAD 基线判定
│     ├─ FIX3 [BLOCKER] git add -A && commit 无条件提交把自定义污染进基线→git diff 恒空→覆盖
│     │        → 基线只提交 WRITTEN_FILES（本次上游写入的文件）
│     ├─ FIX4 [BLOCKER] 第 2 步每次运行都 git add -A && commit baseline→同上污染
│     │        → baseline 提交仅首次初始化（git init 同 if 块）执行
│     ├─ FIX5 [BLOCKER] git diff --quiet 忽略 untracked→用户新建自定义被当"未自定义"覆盖
│     │        → 改 git status --porcelain（能识别 untracked+modified）
│     ├─ FIX6 [幂等] 未自定义但内容=上游时仍报"更新"+重写→破坏幂等
│     │        → 未自定义分支内嵌套 cmp：一致→"ℹ️ 一致"；不一致→"🔄 更新"
│     └─ FIX7 [网络健壮性] clone/fetch 无 timeout→ghfast.top 挂起时阻塞（集成进 update 后阻塞整个流程）
│              → timeout 120 包裹 clone/fetch（与 update 其他网络调用一致）
│     最终逻辑：git status --porcelain 判定自定义（空=未自定义→cmp 决定更新/一致；非空=自定义→保留+警告）
│     验证：E2E 六场景 10/10 PASS（补齐16/上游更新/修改自定义保留/untracked自定义保留/幂等/dry-run幂等）
│          边界 4/4（未知参数 exit1/目录不存在自动创建/无上游 exit1/dry-run 无写入）
├── T503 [P1 ⭐⭐] 集成+回归验证 ✅ 已完成
│     ├─ T503a 集成：opencodeg-update ⑥.5 段（NEW_VER 验证后）command -v 探测 opencodeg-sync-dag
│     │        → 成功 log ✅ / 失败 log ⚠️（不阻断）/ 未安装 log ℹ️ 跳过
│     └─ T503b 真实更新回归（用户授权执行）：
│          预检：工作区有 .gitignore 修改+3 untracked → git stash push -u → 更新 → stash pop
│          流程：fetch 46 提交 → rebase 1 提交（5a51b8b8→31bd2d4eb）→ bun.lock 无变化跳过 install
│                → 构建 7 分钟（12:34:38-12:41:45）→ 原子安装 → 1.0.26-opencodeg
│                → DAG 同步：16 文件 15 一致 + code-review-lite 更新（未自定义→更新）
│          处理：构建后 bun.lock 被 build.ts 内置 install 污染（npmmirror URL 重写）→ git checkout 还原
│                stash pop 还原 .gitignore+3 untracked；仓库回到更新前状态
│     回归验证全绿：版本 1.0.26-opencodeg / models 正常 / DAG 16 文件无自定义丢失 / 日志完整
```

依赖链：T501（依赖构建环境）→ T502（独立，无依赖）→ T503a（依赖 T501+T502）→ T503b（依赖 T503a+用户授权）
并行分组：批13（T501+T502 串行后 T503），三重 Loop 全过

关键事实（供后续引用）：
- sync-dag 自定义判定最终方案：`git status --porcelain -- "$name"` 为空=未自定义（→cmp 决定更新/一致），非空=自定义（→保留+警告）；基线提交只含 WRITTEN_FILES
- `git diff --quiet HEAD` 忽略 untracked 文件（返回 0=未修改）→ 判定用户自定义必须用 git status --porcelain
- build.ts 内置 3 次 `bun install`（第 151-153 行）会重写 bun.lock 源 URL 为 npmmirror → 构建后需 `git checkout -- bun.lock` 还原（不可提交进仓库）
- 真实更新验证 bun.lock 无变化跳过 install 路径 ✅（T501 省时生效）
- 真实 workflows 目录 2026-08-19 已 git 初始化（baseline 840265f + sync update 81bfce6），16 模板与上游一致

## R14 任务分解（WBS）🔄 进行中（T601 已完成，T602 待做，2026-08-19，P008）

```
R14 修复命令名提示硬编码（恢复会话 + 全部命令名提示） 🔄 进行中（用户决策：全部一并修 + 重建重装验证）
├── T601 [P0 ⭐⭐] 命令名提示动态化 ✅ 已完成（2026-08-19）
│     目标：全部面向用户的命令名提示用 basename(process.execPath) 替换硬编码 opencode
│     结果：8 处 5 文件全改；新增 src/command-name.ts（自导出 module shape 合规）
│          新增/整合 5 测试文件（splash.test/command-name.test/cli.error/provider.error/acp.initialize）
│          三重 Loop：Reviewer PASS → Tester PASS(15/0) → Approval 1 轮修正（acp 测试 TS2741/TS2339）后 PASS
│          typecheck REAL_EXIT=0；红线零触碰
│     涉及文件（8 处 5 文件）：
│     ├─ packages/opencode/src/cli/cmd/run/splash.ts:238（恢复会话提示，用户报告核心）✅
│     ├─ packages/opencode/src/cli/error.ts:66,105 ✅
│     ├─ packages/opencode/src/acp/service.ts:95,103（含 terminal-auth command 字段）✅
│     ├─ packages/opencode/src/provider/error.ts:62 ✅
│     ├─ packages/opencode/src/provider/provider.ts:786,872 ✅
│     └─ 新增 packages/opencode/src/command-name.ts（helper）✅
│     不做什么（红线，已守住）：
│     ├─ 不改 provider ID "opencode"（models.ts/footer.command.tsx/demo.ts）
│     ├─ 不改 uninstall.ts/upgrade.ts 官方安装逻辑
│     ├─ 不改注释中的 `opencode --mini`
│     ├─ 不改 run.ts:963 $0（评估：零消费点，零用户影响，Reviewer 确认）
│     └─ 不改 providers.ts:307 describe（协议标识 .well-known/opencode，非命令名，Approval 认同）
│     验证：TDD 15 用例（含真实 TUI 渲染回归断言不含 `opencode --mini`）+ typecheck exit 0
└── T602 [P0 ⭐⭐] 重建重装验证 ⬜ 未开始（依赖 T601，用户已授权）
      目标：重建 opencodeg（bun run script/build.ts --single --skip-embed-web-ui，约7-12分钟）→ 原子重装 ~/.local/bin/opencodeg → 验证恢复提示
      强制内容（Approval 批注 4+1 项）：
      ├─ pr.ts:83/104 功能性 spawn 改用 process.execPath（opencodeg 下避免拉起错误二进制；不用 commandName() 因 spawn 需真实路径）
      ├─ provider.ts 硬编码验证：strings 扫描 `opencode auth cloudflare-ai-gateway` 应 0 命中 + 手动触发无 CLOUDFLARE_API_TOKEN 看提示
      ├─ 用户原场景强制验收：退出 TUI 恢复提示须显示 `opencodeg --mini -s <sid>`
      ├─ terminal-auth 真机确认：生产二进制下 ACP initialize 返回 command: "opencodeg"
      └─ [建议] 开工前先 commit T601 到 feat/opencodeg-local 避免 diff 混淆
      验证标准：退出 TUI 后恢复提示显示 `opencodeg --mini -s <session_id>`（非 opencode）；models/基本命令回归正常；构建后 git checkout -- bun.lock 还原
```

依赖链：T601（改源码+TDD）✅ → T602（重建重装 + pr.ts 修复，依赖 T601）
并行分组：串行（T602 必须等 T601 源码改动落定）

关键事实（供后续引用）：
- 命令名动态化正确模式：`basename(process.execPath)`（packages/opencode/src/cli/cmd/debug/agent.handler.ts:36 已有先例）
- 技术约束已明确"不改 provider ID 'opencode'"（requirement.md 技术约束第 4 条）——本次修复必须区分命令提示 vs provider 名
- 功能性 spawn 与命令提示不同：spawn 用 `process.execPath`（真实路径，dev 下避免 "bun"），提示字符串用 `commandName()`（basename）
- opencodeg 安装路径 ~/.local/bin/opencodeg → basename(process.execPath) 应返回 "opencodeg"
- WSL2 混合环境 typecheck 注意：`bun typecheck` 因 @typescript/native-preview-win32-x64 平台包缺失失败；等价 `bun run --bun tsgo --noEmit` 前需临时移开 git-ignored dist/ 目录（stale 产物会报 TS1484）
```
