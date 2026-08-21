# 项目需求文档

## 项目信息
- 项目名称：OpenCode-GraphAgent 源码安装（opencodeg）
- 技术栈：TypeScript / Bun 1.3.14 / Node 24 / Git
- 项目目标：从 GitHub 源码安装 opencode fork（GraphAgent 版），编译产物命令命名为 opencodeg，避免覆盖现有 opencode
- 创建时间：2026-08-17
- 最后更新：2026-08-19
- 状态：🔄 进行中（R13 新增）

## 需求列表
| 编号 | 需求标题 | 需求描述 | 优先级 | 预估难度 | 状态 | 关联进度 | 备注 |
|------|----------|----------|--------|----------|------|----------|------|
| R1 | 源码获取 | 从 GitHub LeXwDeX/OpenCode-GraphAgent 下载 main 分支源码到本地工作目录 | P0 | ⭐ | ✅已完成 | P001 | git clone ghfast.top 镜像，HEAD=e62a875a |
| R2 | 源码构建 | 用 bun 执行 build.ts --single 编译当前平台独立二进制 | P0 | ⭐⭐ | ✅已完成 | P001 | bun 1.3.14，--skip-embed-web-ui |
| R3 | 产物命名 opencodeg | 编译产物可执行文件命名为 opencodeg，不得为 opencode | P0 | ⭐⭐ | ✅已完成 | P001 | 3 文件 4 处改动 + 测试同步 |
| R4 | 安装位置 | 产物安装到 ~/.local/bin/opencodeg（已在 PATH） | P0 | ⭐ | ✅已完成 | P001 | 与 opencode 1.17.18 并存 |
| R5 | 配置目录隔离 | global.ts app 名 opencodeg，数据/缓存/配置/状态目录完全隔离 | P1 | ⭐⭐ | ✅已完成 | P001 | 含 P1 缺口修复（dag-prompts） |
| R6 | 环境升级 | 升级 bun 到 ^1.3.14 满足构建脚本版本检查 | P0 | ⭐ | ✅已完成 | P001 | 1.3.6→1.3.14 |
| R7 | 功能验证 | opencodeg 可运行；opencode 不受影响；TUI 可启动 | P0 | ⭐⭐ | ✅已完成 | P001 | 三层验收 + TUI 冒烟通过 |
| R8 | 上游更新重编译 | 作者维护更新时，拉起最新仓库代码并重新编译 opencodeg，保留本地改动 | P1 | ⭐⭐⭐ | ✅已确认 | P002 | 触发式需求，SOP 见 learned.md，已固化本地分支 |
| R9 | 自动更新体系 | 设计自动更新脚本：拉取仓库→比对版本变动→有变动编译/无变动跳过，并保留历史会话与更新日志 | P1 | ⭐⭐⭐ | ✅已完成 | P003 | 手动脚本触发，D5/D6/D7 决策；产物 ~/.local/bin/opencodeg-update（133 行）2026-08-17 落地，三重 Loop 验收通过 |
| R10 | opencodeg 版本号与上游 release 对齐（自动跟踪） | opencodeg 当前版本号为 0.0.0-feat/opencodeg-local-<时间戳>（git 分支名+时间戳），无法对应上游 release。需求：版本号与上游 release 一致，带 opencodeg 标记，便于跟踪 | P1 | ⭐⭐ | ✅已完成 | P004 | D8 版本号格式=<上游版本>-opencodeg（如 1.0.25-opencodeg，合法 semver 预发布）；D9 自动从 git tag 提取（--merged origin/main，每次更新自动同步）；实现只改 opencodeg-update 脚本，零核心代码；双 env（OPENCODE_CHANNEL=feat/opencodeg-local 钉死保 DB 会话 + OPENCODE_VERSION）；Approval 三轮审视通过（阻断项：DB 路径切换会话消失→双 env 解决；回退死代码→\|\| true 解决）；2026-08-18 落地产物 1.0.25-opencodeg，三重 Loop（Reviewer / Tester 7/7 / Approval）验收通过 |
| R11 | 修复 opencodeg 无模型/无配置/dag skill 面板不可见 + 建立配置同步机制 | opencodeg 启动后看不到之前导入的 opencode 配置、没有模型可用、Skill 面板看不到 dag 系列内置 skill；建立 opencode→opencodeg 配置同步机制解决 | P0 | ⭐⭐⭐ | ✅已完成 | P005 | Approval 四轮审批通过（终版 2026-08-18）；T301 配置同步（P0）、T302 验证模型可用（P0）、T303 dag skill 面板验证（P1）；D10 永久隔离+同步脚本+完全对齐、D11 默认模型条件改写为 deepseek-v4-flash；红线：含 apiKey 配置/auth.json 禁止 commit 进 git、不触碰 opencode 1.17.18、同步严格单向；2026-08-18 全部完成：T301/T302/T303 全过，B1/B2/B3 闭环，Approval 终审通过 |
| R12 | 补齐 opencodeg 的 DAG 流程化内容 | 作者对 opencode 有重大改造（DAG 流程化内容）；opencodeg 需补齐：安装模板库、配置 dag.jsonc、/dag-flow 可用 | P0 | ⭐⭐⭐ | ✅已完成 | P006 | 完成杆=/dag-flow 可用（不依赖平台握手）；用户裁决：模板全局层 ~/.config/opencodeg/workflows/、仅配 standard 层=yc-proxy-gpt/deepseek-v4-flash、/dag-init 降级为"记录失败+交付认证指引"；2026-08-18 需求讨论 Approval 二轮 ✅ + 任务规划 Approval ✅ + 实施三重 Loop ✅（Reviewer✅ Tester 9/9✅ Approval 终审✅）；2026-08-19 T406 平台握手补充完成（can_push=false 已知限制，用户裁决接受现状） |
| R13 | 增强 opencodeg-update 更新程序：依赖自动解决 + DAG 配置智能同步 | opencodeg-update 需增强五项能力：①仓库自动拉取（已有保持）②现有数据不丢失（本地分支改动/会话 DB/workflows 自定义模板）③跟随原仓库发版版本号自动编译（已有保持+验证）④依赖自动解决（检测根 bun.lock 变化才完整 bun install，npmmirror）⑤DAG 配置集成（拉取 opencode-dag-config 智能同步到全局 workflows/，git 跟踪识别自定义保留） | P1 | ⭐⭐⭐ | ✅已完成 | P007 | 2026-08-19 需求讨论：现状探索+澄清（D20-D23）+Approval 审视修正（"纯补齐缺失"致命缺陷→git 跟踪智能同步）；R13.1 用户确认；任务规划 Approval ✅；实施 T501/T502/T503 全部完成（三重 Loop 全过 + 真实更新 1.0.25→1.0.26-opencodeg 回归验证全绿） |

| R13 | 增强 opencodeg-update 更新程序：依赖自动解决 + DAG 配置智能同步 | opencodeg-update 需增强五项能力：仓库自动拉取（已有）、现有数据不丢失（本地分支改动/会话 DB/workflows 自定义模板）、跟随原仓库发版版本号自动编译（已有）、依赖自动解决（检测 bun.lock 变化才完整 bun install）、DAG 配置集成（拉取 opencode-dag-config 智能同步到全局 workflows/） | P1 | ⭐⭐⭐ | ✅已完成 | P007 | 2026-08-19 需求讨论：现状探索+澄清（D20-D23）+ Approval 审视修正（git 跟踪智能同步替代纯补齐缺失）；R13.1 用户确认；T501/T502/T503 已完成，真实更新回归全绿 |
| R14 | 修复 opencodeg 命令名提示硬编码：恢复会话 + 全部命令名提示 | 退出 opencodeg 会话后恢复提示显示 `opencode --mini -s <session_id>`（硬编码 opencode），应随产物名显示 `opencodeg`；全部面向用户的命令名提示统一用 `basename(process.execPath)` 动态化 | P0 | ⭐⭐ | 🔄 进行中 | P008 | 2026-08-19 需求讨论：定位 splash.ts:237 硬编码；冰山追问发现 error.ts/acp/service.ts/provider 等同类提示；用户决策：全部命令名提示一并修 + 执行重建重装验证；Approval 审视通过 |

## 已确认决策
| 决策编号 | 决策内容 | 确认方式 |
|----------|----------|----------|
| D1 | 配置/数据目录完全隔离（~/.config/opencodeg 等） | 用户询问确认 |
| D2 | 产物安装到 ~/.local/bin/opencodeg | 用户询问确认 |
| D3 | 升级系统 bun 到 ^1.3.14 | 用户询问确认 |
| D4 | 本地改动保留策略：本地分支 feat/opencodeg-local + rebase | 用户询问确认（推荐方案） |
| D5 | 自动更新触发方式：手动脚本（~/.local/bin/opencodeg-update） | 用户询问确认（推荐方案） |
| D6 | 编译失败处理：保留旧版提示，不自动覆盖 | 用户询问确认（推荐方案） |
| D7 | 历史会话保留范围：用户会话数据 + 更新日志都保留 | 用户询问确认（推荐方案） |
| D8 | 版本号格式 = 上游版本-opencodeg（如 1.0.25-opencodeg，合法 semver 预发布） | Approval 三轮审视通过 |
| D9 | 版本号自动从 git tag 提取（--merged origin/main，每次更新自动同步） | Approval 三轮审视通过 |
| D10 | opencodeg 配置永久隔离 + 同步脚本 + 完全对齐 opencode 行为（R11） | 用户裁决 |
| D11 | 默认模型条件改写：坏默认 glm-5.2（未声明）→ yc-proxy-gpt/deepseek-v4-flash；非坏默认不覆盖用户偏好（R11） | 用户裁决 + Approval 四轮审批通过 |
| D12 | 行为配置 default_agent：opencodeg 侧改为 leader（Approval 实证 opencodeg 无内置 main agent，默认 main 报错） | 用户裁决 |
| D13 | opencode 1.17.18 不做任何改动（default_agent 保持 main）；其无内置 main agent 导致 run 模式报 `default agent "main" not found`（07-10 起持续）为已知限制，TUI 会话可用不受影响 | 用户裁决 |
| D14 | models.dev 冷启动阻塞 provider 注入实测 ~23-24.8s（TUI 空窗）接受为已知限制：不建缓存、不改源码、不判失败 | 用户裁决 |
| D15 | MCP/plugin 复刻沿用作者配置：browser 适配 bunx（monorepo 慢盘 npx 超 30s）、sequential-thinking/opencode-plugin/superpowers 保留 | 用户裁决 |
| D16 | 模板全局层路径：~/.config/opencodeg/workflows/（R12，opencodeg 侧对应 ~/.config/opencodeg 隔离） | 用户裁决 |
| D17 | dag.jsonc 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash，单 tier 即统一默认（R12） | 用户裁决 |
| D18 | /dag-init 降级为"记录失败 + 交付认证指引"（R12） | 用户裁决 |
| D19 | T406 平台握手 can_push=false（znewyear 对作者仓库只读）接受现状，/dag-auto 为增强项未来在有写权限项目重跑 /dag-init（R12） | 用户裁决 |
| D20 | DAG 配置集成方式：拉取 opencode-dag-config + 补齐缺失模板，不覆盖自定义（R13，后升级为 git 跟踪智能同步） | 用户裁决 |
| D21 | 数据保护范围：本地 feat/opencodeg-local 改动 + 会话历史 DB + workflows 自定义模板（R13） | 用户裁决 |
| D22 | 依赖解决：检测根 bun.lock hash 变化才完整 bun install（npmmirror 源）（R13） | 用户裁决 |
| D23 | 触发机制：保持手动运行 opencodeg-update（R13） | 用户裁决 |
| D24 | 命令名提示修复范围：全部面向用户的命令名提示统一用 basename(process.execPath) 动态化（R14，含恢复会话+错误提示）；不改 provider ID "opencode" | 用户裁决 |

## 技术约束
- 不改 packages/opencode/package.json 的 name 字段（packages/web 以 "opencode": "workspace:*" 引用）
- 不改 packages/core/package.json 的 bin（core 无独立产物）
- 不改 provider ID "opencode"（第三方服务识别与鉴权依赖）
- 不改 user-agent "opencode"（协议/canonical 身份）
- 不改 managed 配置目录 /etc/opencode（MDM/组织策略域，有意沿用）
- 网络对 GitHub 不稳定，下载须走镜像 ghfast.top / npmmirror

## 非功能性需求
- 命名隔离：产物命令名 opencodeg，与现有 opencode 互不覆盖 ✅
- 数据隔离：配置/数据/缓存/状态目录与现有 opencode 零共享 ✅
- 验证新鲜：测试/审查结果含 git HEAD + 时间戳 ✅
- bun.lock 可移植性：保持最小 diff（不固化第三方镜像 URL）✅

## R11 需求详情：修复 opencodeg 无模型/无配置/dag skill 面板不可见 + 建立配置同步机制

> 需求状态：✅ 已完成（2026-08-18，P005 100%；Approval 终审通过）
> 优先级：T301（P0）、T302（P0）、T303（P1）
> 关联进度：P005

### 背景 / 用户报告
opencodeg（1.0.25-opencodeg）启动后：
| 编号 | 现象 |
|------|------|
| B1 | 看不到之前导入的 opencode 配置 |
| B2 | 没有模型可用 |
| B3 | Skill 面板看不到 dag 系列内置 skill |

### 根因分析（Phase1 实证）
| 编号 | 实证发现 | 说明 |
|------|----------|------|
| G1 | 配置目录隔离 | opencodeg 因 packages/core/src/global.ts 本地改动 app="opencodeg" → 配置目录 = ~/.config/opencodeg/（隔离设计，用户确认永久） |
| G2 | 目标配置为空 | ~/.config/opencodeg/opencode.jsonc 仅 50B（只有 $schema），无任何 provider/model |
| G3 | 完整配置在源 | 完整配置在 ~/.config/opencode/opencode.jsonc（4621B）；~/.local/share/opencodeg/ 无 auth.json |
| G4 | 默认模型未声明 | 默认模型 model/small_model = yc-proxy-openai/glm-5.2，但该模型在 provider 从未声明（yc-proxy-openai 仅 glm-5.3/qwen3.8-max）→ 报错 "No configured text models for MEMORY"（无已配置的文本模型可供 MEMORY 使用） |
| G5 | 代理实测 | 192.168.33.110:8000 仅暴露 qwen3.8-max（glm-5.2/5.3 均拒）；192.168.34.144:8000 的 deepseek-v4-flash 正常；opencode 默认模型 glm-5.2 本来就是坏的 |
| G6 | dag skill 数据层存在 | create-dag-workflow 数据层存在（debug skill + GET /skill 共 14 个含它），面板数据源 app.skills() 包含；用户看不到疑与初始化异常同根，待模型修复后复核 |

### 需求条目

#### T301 配置同步（P0）
opencodeg 配置完全对齐 opencode 行为（用户裁决：永久隔离 + 同步脚本 + 完全对齐）。
| 项 | 内容 |
|----|------|
| 源 → 目标 | ~/.config/opencode/opencode.jsonc → ~/.config/opencodeg/opencode.jsonc（整体复制） |
| auth 同步 | ~/.local/share/opencode/auth.json → ~/.local/share/opencodeg/auth.json（复制非软链，权限 600，每次重拷） |
| plugin 归一化 | ~/.config/opencode/node_modules/superpowers → /home/newyear/.config/opencode/node_modules/superpowers（isPathPluginSpec 不认 ~ 路径） |
| provider 保留 | 现有声明不变（glm-5.3 / qwen3.8-max / deepseek-v4-flash / gpt-5.6 等），不补声明 glm-5.2 |
| 默认模型条件改写 | model/small_model 当前指向 glm-5.2（未声明）→ 改写为 yc-proxy-gpt/deepseek-v4-flash（用户裁决）；非坏默认不覆盖用户偏好 |
| key 策略 | "不落 key" = 脚本不硬编码 key；明文 apiKey 随整体复制合法进入目标 |
| 脚本要求 | 产物 ~/.local/bin/opencodeg-sync-config：幂等可重跑、条件改写、plugin 归一化、首次无目标跳过 .bak、有目标时备份、权限校验、手动触发、不硬编码 key、不进 git |

#### T302 验证模型可用（P0）
重启 ~/.local/bin/opencodeg 后断言：
| 编号 | 断言 |
|------|------|
| A1 | 无 "No configured text models" 报错 |
| A2 | 自定义 provider 列表可见（yc-proxy-openai / yc-proxy-gpt） |
| A3 | 默认模型 deepseek-v4-flash 实际发消息 |
| A4 | auth.json 权限 600 生效 |
| A5 | opencode 1.17.18 不受影响 |
| A6 | models.dev 报错 = 噪音（以自定义 provider 为准）；实测阻塞 provider 注入 ~23-24.8s（冷启动 TUI 空窗），非单纯噪音，已接受为已知限制（D14），不判失败 |
| A7 | 行为配置：opencodeg 侧 default_agent=leader（D12，用户裁决，Approval 实证 opencodeg 无 main）、permission=allow、lsp enabled、autoupdate=false；opencode 1.17.18 侧保持 main 不动（D13，用户裁决） |
| A8 | mcp 加载失败不阻断 A1 / A3 |

> 补充实证（2026-08-18）：opencode 1.17.18 无内置 main agent（上游已改名 build），其 `opencode run` 模式同样报 `default agent "main" not found`（找不到默认代理 "main"，07-10 起持续）——run 模式限制为已知限制（D13），TUI 会话可用不受影响。

#### T303 dag skill 面板验证（P1）
| 项 | 内容 |
|----|------|
| 验证方式 | 数据层已实测存在；模型修复重启后，Skill 面板确认 create-dag-workflow 展示层可见；若仍不可见，则分离数据层 / 渲染层定位 |

### 红线
| 编号 | 红线 |
|------|------|
| R1 | 含 apiKey 的配置 / auth.json 禁止 commit 进 git |
| R2 | 不触碰 opencode 1.17.18 的配置/数据；DB 路径由 CHANNEL 编译期决定，与配置目录无关 |
| R3 | 同步严格单向：opencode → opencodeg |

### 验收标准（用户视角）
opencodeg 启动即有模型可用、配置与 opencode 一致、Skill 面板能看到 dag skill。

### 验收结论（2026-08-18，R11 全部完成）
| 项 | 结果 |
|----|------|
| T301 配置同步 | ✅ 通过：同步脚本 ~/.local/bin/opencodeg-sync-config 落地，幂等重跑 diff 目标文件一致；同步后 opencodeg 启动无 MEMORY 报错 |
| T302 验证模型可用 | ✅ 通过：断言①-⑧ 全过（无 MEMORY 报错/provider 可见/默认模型发消息/auth 600/opencode 不受影响/models.dev 噪音不判失败/行为配置 leader/mcp 不阻断）；项目目录 14/14 验证通过 |
| T303 dag skill 面板可见 | ✅ 通过：create-dag-workflow 三层实证（数据层 app.skills() → 展示层 run 技能列表 → 渲染层 TUI Skill 面板）全过，B3 闭环 |
| B1/B2/B3 闭环 | ✅ 全闭环：B1 配置可见（T301）、B2 模型可用（T302）、B3 dag skill 面板可见（T303） |
| 三重 Loop | ✅ Reviewer / Tester / Approval 全过，Approval 终审通过 |
| 已知限制（已接受） | K1 models.dev 冷启动 ~23-24.8s 空窗（D14）、K2 opencode run 模式 main 无效（D13）、K3 5c 正则结构敏感 fail-safe、K4 browser 用 bunx（D15） |

## R12 需求详情：补齐 opencodeg 的 DAG 流程化内容

> 需求状态：✅ 已完成（T401-T405 2026-08-18 + T406 平台握手 2026-08-19；需求讨论 Approval 二轮 ✅ + 任务规划 Approval ✅ + 实施三重 Loop ✅ + 用户裁决 T406 ✅）
> 优先级：P0（难度 ⭐⭐⭐）
> 关联进度：P006（✅ 已完成，100%）
> 任务分解：T401、T402、T403、T404、T405、T406（全部 ✅）

### 背景
作者对 opencode 有重大改造——DAG 流程化内容（/dag-flow 编排、模板库、dag.jsonc 节点模型配置）。opencodeg（fork 产物）需补齐该能力。

### 需求条目
| 编号 | 项 | 内容 |
|------|----|------|
| R12-1 | 完成杆 | /dag-flow 可用（不依赖平台握手） |
| R12-2 | 模板库安装 | 16 YAML → 模板全局层 ~/.config/opencodeg/workflows/（D16）；clone 源必须用 ghfast.top 代理（https://ghfast.top/https://github.com/LeXwDeX/opencode-dag-config.git，直连 github.com 超时） |
| R12-3 | dag.jsonc 配置 | 仅配 standard 层 = yc-proxy-gpt/deepseek-v4-flash，单 tier 即统一默认（D17）；不 pin model 到 saved workflow spec |
| R12-4 | /dag-init 降级 | 预期失败记录 + 交付认证指引文档 .skeptics/docs/dag-init-guidance.md（D18）；注意 dag-init 内置提示写死 ~/.config/opencode/workflows 是旧路径，对 opencodeg 应为 ~/.config/opencodeg/workflows |
| R12-5 | /dag-flow 验证 | 16 模板之一 reference 路径跑通，返回 Workflow ID；成功标准=返回 ID + 初始状态，无需跑完整 DAG |
| R12-6 | 关键事实沉淀 | DAG 关键事实写入 learned.md（T405） |
| R12-7 | /dag-init 平台握手（补充） | 用户完成 gh 认证（gh 2.45.0 + znewyear ssh）并改 origin=ssh git@github.com（步骤 A）后重跑 /dag-init，验证平台握手链路并记录权限结果（T406，2026-08-19）；can_push=false 为已知限制，用户裁决接受现状 |

### 关键事实（规划阶段实证，供 T401-T405 引用）
| 编号 | 事实 | 影响 |
|------|------|------|
| F1 | 二进制无 builtin 模板（strings 验证），依赖全局 workflows 目录 | T401 是 /dag-flow 可用的强前置 |
| F2 | dag-init 失败于 step1（ghfast.top unsupported platform），非 gh/auth 步骤 | T403 记录失败点，交付认证指引 |
| F3 | runtime-compat.json 的 b48dce469 是本地 HEAD(5a51b8b8d) 祖先 | 模板兼容性高 |

### 依赖链与并行分组
- T401/T402/T403（并行，无依赖）→ T404（依赖 T401+T402）→ T405（依赖全部）

### 验收标准（用户视角）
`/dag-flow` 可用（返回 Workflow ID + 初始状态），不依赖平台握手。

### 验收结论（2026-08-18，R11 式总结）
| 任务 | 结论 | 关键证据 |
|------|------|---------|
| T401 模板库安装 | ✅ | 16 模板装入 `~/.config/opencodeg/workflows/`；`workflow(action="list")` 枚举 16 个 `[global]` |
| T402 dag.jsonc 配置 | ✅ | standard=`yc-proxy-gpt/deepseek-v4-flash`；DAG 子会话实测解析 `model.id=deepseek-v4-flash / providerID=yc-proxy-gpt` |
| T403 /dag-init 降级 | ✅ | 预期失败记录（step1 unsupported platform）+ 认证指引 `dag-init-guidance.md` 交付（步骤 A-D + 路径陷阱警告） |
| T404 /dag-flow 验证 | ✅ | list→read→draft→validate→start 全通；Workflow ID=`dag_fe5febc3b2fc29ClonywRfb3tA` state=running；cancel 收尾干净（DB 无残留） |
| T405 文档沉淀 | ✅ | learned.md R12 章节 8 条经验 + task.md/progress.md 全绿 |
| T406 /dag-init 平台握手 | ✅ | 平台检测✅ gh 认证✅ CI✅ rulesets✅ 模板✅；.opencode/dag-init.json 生成（platform=github, can_push=false, has_ci/rulesets/templates=true）；can_push=false（znewyear 对作者仓库只读）用户裁决接受现状 |
| **三重 Loop** | ✅ | Reviewer ✅ 通过（7 维度无 BLOCKER）+ Tester 9/9 ✅ + Approval 终审 ✅ 通过 + 用户裁决 T406 ✅ |
| **完成杆** | ✅ | `/dag-flow` 可用达成；B 类缺失（模板/模型/文档）全补齐；平台握手实质打通（can_push 权限边界明确） |

**残留建议（非阻断）**：T403 §1.1 "实际运行失败输出" 实为按 step1 逻辑的等效复现，事实已独立验证零失真；后续若用户执行认证指引，可将实际输出回填文档。

## R13 需求详情：增强 opencodeg-update 更新程序（依赖自动解决 + DAG 配置智能同步）

> 需求状态：🔄 进行中（2026-08-19 需求讨论完成，进入任务规划）
> 优先级：P1（难度 ⭐⭐⭐）
> 关联进度：P007（待建）
> 决策记录：D20-D23

### 背景
opencodeg-update（~/.local/bin/opencodeg-update）当前已具备：①仓库自动拉取（git fetch origin --tags，ssh 认证已通）②本地分支改动保留（rebase）③会话 DB 保留（OPENCODE_CHANNEL=feat/opencodeg-local 钉死）④跟随原仓库发版版本号（提取 graphagent-vX.Y.Z → ${VER}-opencodeg，当前可升级 1.0.25→1.0.26）。
**缺失两项能力**：⑤依赖自动解决（当前仅 ensure_bun 二进制，node_modules 损坏/上游改依赖时编译失败）⑥DAG 配置集成（当前不拉取 opencode-dag-config，全局 workflows/ 模板不同步）。

### 需求条目
| 编号 | 项 | 内容 |
|------|----|------|
| R13-1 | 仓库自动拉取 | 已有（ssh+180s 超时），保持 |
| R13-2 | 数据不丢失 | 本地分支改动（rebase，已有）+ 会话 DB（CHANNEL 钉死，已有）+ workflows 自定义模板（新增：git 识别保留） |
| R13-3 | 跟随发版版本号自动编译 | 已有（graphagent-vX.Y.Z → ${VER}-opencodeg），保持 + 验证 1.0.26 可升级 |
| R13-4 | 依赖自动解决 | 检测根 bun.lock hash，rebase 前后变化才完整 bun install（npmmirror registry）；否则跳过 |
| R13-5 | DAG 配置智能同步 | 拉取 opencode-dag-config → ~/.config/opencodeg/workflows/ 转 git checkout → git pull + 逐文件检测本地是否偏离上游（git diff）：偏离=用户自定义→保留+警告；未偏离→自动更新；同步后校验 runtime-compat.json（不匹配仅警告） |
| R13-6 | DAG 同步时机 | 主更新（编译+安装）成功后执行；DAG 同步失败不阻断主流程（降级警告） |

### 关键事实（需求讨论阶段实证）
| 编号 | 事实 | 影响 |
|------|------|------|
| F1 | 根目录唯一 lockfile = bun.lock（974KB，bun 1.3.14），packages 无独立 lockfile | R13-4 检测对象锁定根 bun.lock |
| F2 | 用户全局 workflows/ 已有全部 16 个模板，与上游一致（16/16 diff 相同，零缺失零自定义） | 纯"补齐缺失"策略会永不更新（已否决）→ git 跟踪智能同步 |
| F3 | runtime-compat.json 的 runtime_commit=b48dce469，当前 main=31bd2d4eb（不一致） | R13-5 需校验并警告，不阻断 |
| F4 | opencode 读取 global workflows 只 glob *.yaml（按文件名），.git 目录不影响读取 | workflows/ 转 git checkout 可行 |
| F5 | opencode-dag-config 仓库可访问（https 直连 + ghfast.top 镜像均通），main 分支 | R13-5 拉取通道可行 |
| F6 | build.ts 有 --skip-install 标志；默认会 partial install 3 个 native 包（@opentui/core、@parcel/watcher、@ff-labs/fff-bun） | R13-4 完整 bun install 与之兼容 |

### 验收标准（用户视角）
1. 运行 opencodeg-update 正常升级到 1.0.26（或更高），版本号 = graphagent tag-opencodeg
2. 升级后本地分支改动、会话历史、workflows 自定义模板均保留
3. 上游模板更新时（用户未自定义）自动同步到全局 workflows/
4. 上游模板被用户自定义过时保留用户版本 + 日志警告
5. 依赖变化时自动 bun install 成功，编译不因依赖缺失失败
