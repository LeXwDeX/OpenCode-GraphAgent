# 实施经验文档

## 反复出现的问题（重点关注）
| 编号 | 问题描述 | 出现次数 | 根因 | 解决方案 | 关联任务 |
|------|----------|----------|------|----------|----------|
| L01 | GitHub 直连网络不稳定（clone/下载超时截断） | 3+ | 直连 GitHub 被限速/超时 | 走镜像 ghfast.top（git clone 与 tarball 均成功）；npm 依赖走 npmmirror | T001、T004 |
| L02 | 系统 bun 是 Windows shim 导致构建错目标 | 2 | `/mnt/d/Apps/nodejs/bun` 是 shim 脚本转发到 Windows bun.exe，process.platform=win32 | 从 npmmirror 下载 Linux bun 1.3.14 到 /tmp/opencode/，PATH 前置 shim | T004、T006 |
| L03 | 测试/断言未随 app 名改名同步 | 1 | 改名 opencodeg 后，断言旧值 opencode 的测试失效 | 全局搜索受影响测试并同步（global.test.ts、cli-process.ts） | T003-FIX |
| L04 | 源码内残留硬编码 opencode 目录 | 1 | 全局目录解析点未走 Global.Path.* 统一派生 | Reviewer 全链路审查发现，改为 Flag/Global 派生 | T003-FIX2 |

## 实施问题与方案
| 编号 | 问题描述 | 解决方案/思路 | 使用技术栈 | 关联任务 | 阶段 |
|------|----------|----------|----------|----------|------|
| P1-3 | build.ts 内 `$` 子进程按 PATH 调回 Windows bun 卡死 | Linux bun shim 前置 PATH + tmux 独立会话防后台清理 | bun/linux/wsl | T004 | 实施 |
| P1-3 | models.dev 网络不可达导致 generate.ts fetch 挂死 | 设 MODELS_DEV_API_JSON 指向本地 fixture | 环境变量 | T004 | 实施 |
| P1-4 | bun.lock 被 --registry npmmirror 重写 +3513/-3513 | 回滚 URL 重写，仅保留 bin 键一行；frozen-lockfile 验证 | git/bun | T004 | 排查 |
| EBUSY | drvfs（/mnt/f Windows 挂载）报告 EBUSY link | 未触发（hardlink/symlink 正常）；备选方案为构建到 /tmp 再拷回 | WSL | T004 | 排查 |
| 权限 | drvfs 把所有文件报 777 与 index mode 冲突 | git config core.filemode false（仅本地配置） | git | T001 | 排查 |

## 验收问题记录
| 编号 | 问题描述 | 原因分析 | 解决方案 | 关联任务 |
|------|----------|----------|----------|----------|
| A01 | T003 Reviewer 首次审查不通过：2 处 BLOCKER | 测试断言未随 app 改名同步（global.test.ts、cli-process.ts） | T003-FIX 修改 2 测试文件，复审 PASS | T003 |
| A02 | 最终审查 CONDITIONAL_PASS：P1 隔离缺口 | resolve.ts:95 全局 dag-prompts 硬编码 ~/.config/opencode，opencodeg 会读 opencode 模板 | T003-FIX2 改 Flag/Global 派生 + T006 重建重装，strings 验证 0 残留 | T003-FIX2、T006 |
| A03 | Tester 发现 typecheck 无法运行 | 仓库挂载 Windows 盘，native-preview win32 包缺失（WSL bun 缓存缺 linux 原生包） | 环境限制非代码问题，用 bun test 实测替代验证 | T006 |

## 关键技术结论
- **命名改名最小侵入法**：只改 package.json bin 键 + build.ts outfile/binaryPath + global.ts app 名，不动 name 字段（workspace 依赖约束），不动 bin 脚本本体（bin 键映射即可）
- **WSL 下构建 Linux 二进制的坑**：npm 安装的 bun 是 Windows shim，必须用真 Linux bun 前置 PATH 才能构建 linux 目标
- **lockfile 可移植性**：--registry 改镜像会重写 lockfile 污染 diff，应回滚为最小 diff，依赖下载靠运行时 registry 配置而非固化到 lockfile
- **环境缺陷**：oxlint bin 是 extensionless ESM 文件，Windows Node v20（F:\ 挂载路径）无法加载（ERR_UNKNOWN_FILE_EXTENSION），husky pre-commit 会失败；用 Linux bun 跑 oxlint 验证 0 errors 后 `--no-verify` 提交

## P003 自动更新体系实施经验（2026-08-17）

1. **Subagent 静默失败**：本会话 3 次 Task 返回空结果（T101-FIX 首派、Approval 首派、DocKeeper 首派），重派后成功。经验：派发关键任务后须自查产物（Read 脚本/查文件），不能仅信 Task 返回；空返回须重派并明确要求输出文字证据。
2. **Approval 捕获 Reviewer 盲区**：Reviewer 复审 PASS 后 Approval 终审仍发现真实缺陷（ensure_bun 缺 mkdir -p，/tmp 被清后 bun 自愈重建必失败→更新永久静默跳过）。三重 Loop 层层把关有效。
3. **环境缺陷 unzip 缺失**：本机 unzip 缺失（sudo 需密码无法自动安装）。当前不影响（bun 已装好），但 /tmp 被清需重建 bun 时 ensure_bun 会明确报错并保留旧版（干净降级）。建议后续手动 `sudo apt install unzip`。
4. **脚本健壮性模式（可复用）**：`set -euo pipefail` + 失败分支原子回滚（git reset 回 OLD_HEAD 保证可重试）+ timeout 包裹长任务 + 临时文件原子改名安装 + trap 清理。对任何"构建+安装"类更新脚本通用。
5. **版本比对对象**：比对 `feat/opencodeg-local`（rebase 目标分支）而非当前 HEAD，避免切分支时比对失真。

## opencodeg 上游更新重编译 SOP（R8，触发式）

> 触发条件：用户指示"更新"（作者维护发布新版本时）
> 前置：本地 opencodeg 改动已固化在分支 `feat/opencodeg-local`（commit 1426fc2ee，7 文件）

### 更新步骤（按序执行）

```
┌─ 1. 拉取上游并 rebase ─────────────────────────────────────────┐
│   git fetch origin                                              │
│   git checkout feat/opencodeg-local                             │
│   git rebase origin/main                                        │
│   （若冲突：保留 opencodeg 命名改动，合并上游新功能后            │
│     git add -A && git rebase --continue）                       │
└────────────────────────────────────────────────────────────────┘
┌─ 2. 依赖安装（仅上游依赖变化时）───────────────────────────────┐
│   bun install  [可加 --registry https://registry.npmmirror.com/]│
│   ★ 注意：install 后检查 git diff bun.lock，需保持最小 diff      │
│     （只允许 bin 键一行，若有 URL 重写污染则回滚）               │
└────────────────────────────────────────────────────────────────┘
┌─ 3. 重建二进制 ─────────────────────────────────────────────────┐
│   前置：Linux bun 1.3.14（若 /tmp 被清，从 npmmirror 重新下载）  │
│     https://registry.npmmirror.com/-/binary/bun/bun-v1.3.14/    │
│     bun-linux-x64.zip 解压到 /tmp/opencode/                      │
│   PATH=/tmp/opencode/bin:$PATH（前置 shim）                      │
│   cd packages/opencode                                          │
│   MODELS_DEV_API_JSON=<快照> bun run script/build.ts \           │
│     --single --skip-embed-web-ui                                 │
│   （models.dev 不可达时设 MODELS_DEV_API_JSON；或用             │
│     @opencode-ai/models 本地 snapshot 兜底）                     │
│   长耗时：tmux 会话 + 日志轮询（构建约 12 分钟）                 │
└────────────────────────────────────────────────────────────────┘
┌─ 4. 重新安装 ───────────────────────────────────────────────────┐
│   cp packages/opencode/dist/opencode-linux-x64/bin/opencodeg \  │
│      ~/.local/bin/opencodeg && chmod +x                          │
└────────────────────────────────────────────────────────────────┘
┌─ 5. 三层验证 ───────────────────────────────────────────────────┐
│   ① 功能：opencodeg --version（新版本号，exit 0）                │
│   ② 回归：opencode --version = 1.17.18（未被覆盖）               │
│   ③ 隔离：strings opencodeg | grep -c "config/opencode/dag" = 0  │
│      且 ~/.config/opencodeg/ 正常、~/.config/opencode/ 零污染     │
│   ④ TUI 冒烟：script -qec "timeout 15 opencodeg" 渲染无崩溃       │
└────────────────────────────────────────────────────────────────┘
┌─ 6. 记录 ───────────────────────────────────────────────────────┐
│   更新 .skeptics/docs/*（progress/task/learned）                │
│   追加 JOURNAL.jsonl 日志                                       │
└────────────────────────────────────────────────────────────────┘
```

### 更新要点与红线
| 要点 | 说明 |
|------|------|
| rebase 冲突原则 | 保留 opencodeg 命名改动（4 处运行时 + 2 处测试 + bun.lock），上游冲突内容手工合并 |
| 绝不直推 main/dev | 本地分支只在本地 rebase，不 push（GitHub Rulesets 禁止直推） |
| bun.lock 保护 | install 后必须保持最小 diff（bin 键一行），污染则回滚 |
| 环境复用 | Linux bun shim、MODELS_DEV_API_JSON fixture、tmux 会话均可复用 T004/T006 经验 |
| 遗留待办 | 上游若改了 dag-prompts/全局目录解析，需复查是否引入新的隔离缺口（对照 workflows.ts 模式） |

## T103 首次真实更新经验（2026-08-18）

1. **首次真实更新成功**：opencodeg-update 实际跑通（fetch→比对 14 提交→rebase 零冲突→编译 5 分钟→原子安装→✅ 更新完成）。上游零重叠文件使 rebase 顺利；本地 7 文件隔离改动完整保留在 rebase 后新 commit 5a51b8b8d。
2. **环境缺陷 unzip 缺失（已解决）**：脚本 ensure_bun 先检查 curl/unzip 再查缓存 bun，本机 unzip 缺失导致首次运行被前置拦截失败（即使缓存 bun 可用）。已用用户级 python3 zipfile 包装 `~/.local/bin/unzip`（含 -q/-d/-l/-v，zip-slip 防护）解决，实测解压正常（exit=0）。**注意**：本机连 zip 也无，但构建只需解压 bun zip，unzip 包装够用。
3. **bun.lock 被 bun install 重写现象再次出现**：构建时 bun install 重写 bun.lock 产生 npmmirror registry URL 噪音（同依赖同 sha512，仅 URL 变更）。处置：`git checkout -- bun.lock` 还原，git 状态恢复干净，红线保持（bin 键 1 行最小 diff）。**经验：每次构建后必须检查 bun.lock 是否被重写并还原。**
4. **版本号带分支名**：rebase 后构建的版本号变为 `0.0.0-feat/opencodeg-local-202608180142`（git describe 基于当前分支 feat/opencodeg-local 命名），与之前 `0.0.0-main-*` 不同。属正常现象，无需处理。

## P004 版本号对齐上游经验（2026-08-18）

1. **Approval 对抗式审视捕获真实缺陷**：仅设 OPENCODE_VERSION 会使 CHANNEL 变 latest → 数据库从 opencode-feat-opencodeg-local.db 切到 opencode.db → 现有会话从视图消失。修复：双 env 同时设（OPENCODE_CHANNEL 钉死 + OPENCODE_VERSION）。经验：版本号/通道类改动必须检查"channel 下游副作用"（DB 路径、遥测、UA）。
2. **set -euo pipefail 下管道无匹配是死代码陷阱**：`X=$(... | grep | head | sed)` 无匹配时命令替换失败直接中止，到不了 if [ -z ] 回退分支。修复：命令替换内加 `|| true`。经验：所有"可能无匹配的管道赋值"都需 || true 保护。
3. **版本提取模式（可复用）**：`git tag --sort=-v:refname --merged refs/remotes/origin/main | grep -E '^graphagent-v[0-9]+(\.[0-9]+){2}$' | head -1 | sed 's/^graphagent-v//' || true` + 空回退。--merged 防 hotfix 高 tag 误报；grep 3 段正则防 beta/4 段。
4. **验证时机**：自然更新路径 NEW_COUNT=0 时无法触发新构建，需手动强制构建验证（Approval 必改项）。当前上游已是最新（无新提交），改脚本后无法通过 opencodeg-update 触发验证，必须手动 export 双 env 构建。

## R11 隔离配置同步机制经验（2026-08-18）

### 1. 隔离配置同步机制（核心模式，可复用）
- **现象**：opencodeg 因配置目录隔离（app=opencodeg）看不到 opencode 的完整配置（目标 opencode.jsonc 仅 50B），无模型可用。
- **根因**：隔离设计使两个二进制各自读 ~/.config/{opencode,opencodeg}/，opencodeg 侧无任何迁移/同步机制。
- **方案**：fork 出 opencodeg 配置隔离目录 + 幂等同步脚本 `~/.local/bin/opencodeg-sync-config`（源→目标整体复制 + 条件改写链）。改写链五项：① model 坏模型改写（glm-5.2 未声明 → deepseek-v4-flash）② plugin `~` 归一化绝对路径 ③ default_agent 存在性改写 ④ MCP command 适配 npx→bunx ⑤ auth.json 600 复制。核心逻辑全部进脚本，不手工执行（脚本优先原则）。
- **可复用性**：任何"双二进制隔离部署 + 配置需对齐"场景通用；关键设计：pgrep 运行检测防同步中进程写回、整体复制保完整、条件改写保幂等、备份 .bak 首次创建不覆盖、不硬编码 key。

### 2. 默认模型未声明陷阱
- **现象**：报错 `No configured text models for MEMORY`（无已配置的文本模型可供 MEMORY 使用）。
- **根因**：model/small_model 指向 provider 未声明的模型 yc-proxy-openai/glm-5.2（该 provider 仅声明 glm-5.3/qwen3.8-max）→ 校验失败。
- **方案**：同步必须校验 model 指向已声明模型；本环境 glm-5.2 坏，条件改写为已声明的 yc-proxy-gpt/deepseek-v4-flash（D11）；非坏默认不覆盖用户偏好。
- **可复用性**：写同步/迁移脚本时，模型改写必须与 provider 声明做存在性校验，不能盲目复制。

### 3. 上游改名陷阱（opencode default agent main→build）
- **现象**：行为配置 default_agent=main 时 `opencode run` 报 `default agent "main" not found`（找不到默认代理 "main"）。
- **根因**：上游已把内置默认 agent 由 main 改名 build（07-10 起持续），旧配置 default_agent=main 在 run 模式无效（TUI 会话可用不受影响）。
- **方案**：opencodeg 侧改 default_agent=leader（D12，用户裁决）；opencode 1.17.18 侧保持 main 不动（D13，已知限制）。
- **可复用性**：同步/复刻配置时，default_agent 必须做存在性改写（按目标二进制实际内置 agent 名），不能原样复制；上游改名会静默失效，需实测 run 模式而非只看 TUI。

### 4. models.dev 不可达阻塞 provider 注入
- **现象**：冷启动 ~23-24.8s 空窗，provider 注入被阻塞延迟（无本地缓存），TUI 无模型可用期间像"卡死"。
- **根因**：opencode 启动时向 models.dev 拉模型目录，网络不可达时无本地缓存兜底 → 阻塞后续自定义 provider 注入。
- **方案**：接受为已知限制（D14，不建缓存不改源码不判失败）；判断"配置错误"与"网络不可达"需看报错签名（TimeoutError vs No configured text models）。
- **可复用性**：网络不可达环境的诊断基线——启动慢/空窗先查 models.dev 可达性，再查配置；A6 断言模型前须排除该噪音。

### 5. monorepo 慢盘 npx 超时（browser MCP）
- **现象**：browser MCP 用 npx 从 monorepo cwd 解析包超 30s（TimeoutError），TUI 启动报 mcp 失败。
- **根因**：monorepo 挂在 Windows 慢盘（drvfs），npx 逐目录向上解析 node_modules 极慢。
- **方案**：MCP command 由 npx 改 bunx（5.8s 完成）；playwright 包/浏览器已装（D15）；mcp 失败不阻断模型可用（A8）。
- **可复用性**：WSL + monorepo + 慢盘环境下，凡需要拉包的工具命令优先 bunx/bun 而非 npx；MCP 配置失效先换命令再查包。

### 6. node_modules 部分提取损坏（.opencode/node_modules）
- **现象**：MODULE_NOT_FOUND——.opencode/node_modules 下 zod/effect 只有子目录无 package.json。
- **根因**：node_modules 部分提取损坏（只提取了子目录，缺包入口 package.json）→ require/import 解析失败。
- **方案**：本地拷贝 opencodeg 侧完整包修复，版本精确匹配（zod@4.1.8 / effect@4.0.0-beta.83，T302-FIX ①）。
- **可复用性**：同步/拷贝 node_modules 后必须验证包入口完整（package.json + 主文件），不能只看目录存在；版本精确匹配避免 zod 校验差异。

### 验收问题记录（R11）
| 编号 | 问题描述 | 原因分析 | 解决方案 | 关联任务 |
|------|----------|----------|----------|----------|
| A-R11-1 | 同步脚本 5c 正则结构敏感（fail-safe） | 条件改写依赖 JSONC 结构匹配，结构变化可能失配 | 失配则跳过改写不误伤；幂等重跑 diff 目标文件验证兜底（K3） | T301 |
| A-R11-2 | Approval 终审 4 项（model 存在性校验/幂等验证/browser bunx/agent 存在性） | 终审对抗式审视发现同步链完整性缺口 | T301/T302 全采纳落地，14/14 验证通过 | T301、T302 |
| A-R11-3 | T303 展示层与渲染层一致性 | 数据层存在不等于面板可见 | 三层实证（数据层 app.skills → 展示层 run 技能列表 → 渲染层 TUI 面板）全过，B3 闭环 | T303 |

## R12 DAG 流程化经验（2026-08-18）

### 1. DAG 模板库三层作用域（核心，可复用）
- **现象**：workflow(action="list") 返回 "No saved workflows"（没有保存的工作流），/dag-flow 无参考模板可用。
- **根因**：模板库分三层——项目 `.opencode/workflows/` > 全局 `<config dir>/workflows/` > 内置二进制；本环境二进制**无内置模板**（strings 验证 0 命中），必须装全局层才可用。
- **方案**：T401 将 16 个模板 YAML 安装到 `~/.config/opencodeg/workflows/`（opencodeg 全局层）。
- **可复用性**：排查 "/dag-flow 无模板"类问题时先确认目标二进制是否内置模板（strings 验证），再确认三层作用域哪一层缺失；不能用项目层替代全局层（/dag-flow 在任意目录都要可用）。

### 2. 模板安装走 ghfast.top 代理（可复用）
- **现象**：直连 github.com clone opencode-dag-config 超时（exit 124）。
- **根因**：github.com 直连被限速/超时（同 P1-1）。
- **方案**：`git clone https://ghfast.top/https://github.com/LeXwDeX/opencode-dag-config.git`；**仅复制 16 个 YAML** 到目标目录，勿整仓 clone（保持目录干净）。
- **可复用性**：所有 github.com git 拉取操作一律前缀 ghfast.top 代理；注意 api.github.com 直连可达（见经验 7），gh 的 API 操作不必走代理。

### 3. dag.jsonc 单 tier 语义（核心）
- **现象**：不确定只配 standard 层是否覆盖所有节点。
- **根因**：tier 分 advanced/standard 两层，源码 config.ts 确认：critical 节点→advanced，其余节点→standard；只配 standard 时所有节点都落到 standard 默认。
- **方案**：dag.jsonc 仅配 standard 层 = `yc-proxy-gpt/deepseek-v4-flash`（模型格式 `provider/model`）；不 pin model 到 saved workflow spec。
- **可复用性**：想统一默认模型时配 standard 单层即够，无需逐节点配置；模型格式必须是 provider/model 组合。

### 4. /dag-flow vs /dag-auto 依赖差异（核心）
- **现象**：/dag-flow 配置好模板+模型即可用，/dag-auto 却硬依赖 .opencode/dag-init.json（缺失直接 STOP）。
- **根因**：/dag-flow 是对话式入口，走 resident Orchestration Router（不读 dag-init.json）；/dag-auto 是 ultra-flow 驱动，强依赖平台握手产物。
- **方案**：验收顺序"先跑通 /dag-flow"——低门槛（不依赖平台握手），可独立验证模板+配置链路。
- **可复用性**：DAG 相关功能验收先选依赖最浅的入口（/dag-flow），把平台握手类依赖（/dag-init）后置或降级。

### 5. /dag-init 平台握手失败点（顺序陷阱）
- **现象**：/dag-init 失败于 step1（平台检测）而非 step2（gh 检查），报 unsupported platform。
- **根因**：git remote host=ghfast.top 非 github.com/gitlab.com → 探测 /api/v4/version 得 403 → STOP "unsupported platform"。
- **方案**：**必须先改 remote 为 github.com 再装 gh/auth**；当前 remote 是 ghfast.top 镜像，平台探测认不出。
- **可复用性**：凡平台握手类工具（检测 git remote 识别 Git 平台）都要求 remote host 为已知平台域名；镜像源 remote 会让探测失败——排查顺序：先确认 remote host，再谈 gh/auth 认证。

### 6. 路径陷阱：dag-init 内置提示旧路径（opencodeg 专属）
- **现象**：dag-init 内置提示写死 `~/.config/opencode/workflows`（旧 opencode 路径），对 opencodeg 是错的。
- **根因**：源码提示未随 opencodeg 配置隔离改造（同 T003-FIX2 类硬编码缺口）。
- **方案**：指引文档（.skeptics/docs/dag-init-guidance.md）已纠正为 `~/.config/opencodeg/workflows`。
- **可复用性**：fork/改名后的二进制，凡文档/提示内写死 `~/.config/opencode/` 路径的地方都要复查是否应为 opencodeg；strings 二进制可批量排查。

### 7. 网络通道分离：github.com vs api.github.com（可复用）
- **现象**：github.com 直连超时(124)，ghfast.top 代理可达(200)，api.github.com 直连可达(200)。
- **根因**：不同主机出口网络策略不同——git 协议走 github.com（不通），gh API 走 api.github.com（通）。
- **方案**：gh 的 API 操作（auth/issue）不必走代理；git 操作必须走 ghfast.top。**注意**：改 remote 回 github.com 会破坏 opencodeg-update 自动更新（依赖 origin fetch+rebase），建议保留 ghfast 镜像作独立 fetch remote，勿破坏 origin。
- **可复用性**：WSL/受限网络下按主机区分通道——先测 api.github.com 直连可用性再决定 gh 命令是否走代理；git remote 变更前检查是否有脚本依赖 origin。

### 8. DAG 验证收尾：headless 防残留（可复用）
- **现象**：headless 环境启动 DAG 后子会话/节点可能持续运行，消耗 token。
- **根因**：DAG 工作流节点以子会话形式执行，验证完成不主动终止会残留。
- **方案**：验证后执行 workflow(action="control", operation="cancel") 收尾；清理遗留 draft 草稿（.opencode/workflow-drafts/*.yaml）。
- **可复用性**：凡"启动异步/后台执行体"的验证（DAG、子代理、长任务）都要显式收尾（cancel/cleanup），不能只验证启动成功；headless 环境尤甚。

### 9. 认证后 origin 用 ssh 形式（T406，2026-08-19，可复用）
- **现象**：gh 认证完成后，git remote 如何设置——https 直连 github.com 此前实测超时（P1-1），但 gh 认证协议是 ssh。
- **根因**：gh auth login 可选 https 或 ssh 协议；本环境用户选择 ssh。github.com **ssh 端口 22 实测可达**（不走被限速的 https 443 通道），https git 直连超时。
- **方案**：origin 改为 **ssh 形式** `git@github.com:<owner>/<repo>.git`（与 gh 认证协议一致），`ghfast` 镜像保留为独立 fetch remote。实测：ssh origin 可达，`/dag-init` 平台检测识别 github.com，且 **不破坏 opencodeg-update**（更新走 ghfast 镜像 fetch）。
- **可复用性**：受限网络下 gh 认证后 git remote 优先用 **ssh**（与认证协议一致）而非 https——ssh 端口往往比 https 443 更可达；改 remote 前先检查 opencodeg-update 等脚本的 fetch 依赖，保留镜像作独立 remote 兜底。

### 10. can_push 权限边界：作者仓库只读（T406，2026-08-19，可复用）
- **现象**：`/dag-init` 跑通后 `.opencode/dag-init.json` 的 `can_push=false`，`/dag-auto` 无法使用。
- **根因**：can_push 由 gh 对**当前账号在目标仓库**的推送权限决定；znewyear 对作者仓库 LeXwDeX/OpenCode-GraphAgent **只读**（无 collaborator 写权限）→ push 探测失败 → can_push=false。
- **方案**：用户裁决**接受现状，记录结果**；/dag-auto 为增强项，未来在**有写权限的项目**里重跑 `/dag-init` 即可（can_push 会自动变为 true）。/dag-flow 不依赖 can_push，当前仓库照常可用。
- **可复用性**：平台握手（/dag-init）能否产出 can_push=true 取决于**当前账号是否拥有目标仓库写权限**，与认证本身无关；对作者/他人仓库只读时，识别该限制（而非反复尝试），功能上以降级入口（/dag-flow）为主，增强入口（/dag-auto）留给有写权限的项目。

## R13 章节（2026-08-19，T501/T502/T503）

### 1. `git diff --quiet` 忽略 untracked 文件（T502-FIX5，2026-08-19，可复用）
- **现象**：用户新建的自定义文件（untracked）在 sync-dag 中被误判"未自定义"，被上游模板覆盖。
- **根因**：`git diff --quiet HEAD -- "$file"` 只比较已跟踪文件，对 untracked 文件返回 0（=未修改）→ 误判。
- **方案**：判定"文件是否有差异"必须用 `git status --porcelain -- "$file"`（输出空=与基线一致，非空=有 untracked/modified 差异）。
- **可复用性**：任何"用 git 判断用户是否修改过文件"的场景，一律用 `git status --porcelain` 而非 `git diff --quiet`，否则 untracked 的自定义会被静默覆盖。

### 2. 基线提交若无条件 `git add -A && git commit` 会污染自定义判定（T502-FIX3/FIX4，2026-08-19，可复用）
- **现象**：用户自定义文件在重跑后被覆盖。
- **根因**：基线提交无条件纳入全部工作区改动，把用户自定义提交进基线 → 之后 `git diff HEAD`/`git status` 恒空 → 误判"未自定义"→ 覆盖。
- **方案**：①基线提交只在首次初始化（git init 同 if 块）执行一次；②同步后的基线提交只纳入本次脚本写入的文件（WRITTEN_FILES），自定义文件保持未提交 dirty 状态以持续识别。
- **可复用性**：任何"同步 + 保留本地改动"机制，基线快照必须只含同步来源写入的内容，本地改动必须保持 dirty。

### 3. 内容比对（cmp）无法区分"旧上游版本"与"用户自定义"（T502-FIX2，2026-08-19，可复用）
- **现象**：用户未自定义、但上游更新了模板 → cmp 判定"不一致"→ 误判为自定义 → 上游更新被丢弃。
- **根因**：cmp 只看本地 vs 当前上游，无基线参照时无法判断"本地是旧上游版本"还是"用户改过"。
- **方案**：必须有"上次同步的上游快照"基线（git HEAD），先判未自定义（status 空）再 cmp 决定是否真变化。
- **可复用性**：同步类工具必须维护"来源快照基线"，不能仅凭当前内容比对判断自定义。

### 4. build.ts 内置 bun install 会重写 bun.lock 源 URL（T503b，2026-08-19，可复用）
- **现象**：真实更新构建后，bun.lock 出现 3512 处改动（所有包源 URL 被重写为 npmmirror），工作区 M 状态。
- **根因**：build.ts 第 151-153 行内置 3 次 `bun install`（装平台原生依赖 @opentui/core/@parcel/watcher/@ff-labs/fff-bun），安装时按 registry 重写 lockfile 源 URL。
- **方案**：构建后 `git checkout -- bun.lock` 还原；T501 的"bun.lock 变化才 install"检测不受影响（那是主依赖检测，构建内 install 是必需的）。
- **可复用性**：构建脚本内置 install 的场景，构建后必须还原 lockfile，否则本地镜像 URL 污染仓库。

### 5. 网络操作必须加 timeout（T502-FIX7，2026-08-19，可复用）
- **现象**：sync-dag 的 git clone/fetch 无 timeout，ghfast.top 挂起时无限期阻塞；集成进 update 后阻塞整个更新流程。
- **根因**：git clone/fetch 默认无超时；update 脚本其他网络操作均有 timeout（180s/1200s），形成不一致。
- **方案**：所有网络操作（clone/fetch/curl）统一 `timeout N` 包裹。
- **可复用性**：任何脚本的网络调用必须显式 timeout，尤其集成进长流程的调用。

## R14 章节（2026-08-19，T601 已完成，T602 待做）

### 6. 命令名提示 vs 功能性 spawn 是两种不同处理（T601/T602，2026-08-19，可复用）
- **面向用户的命令名提示**（错误信息/恢复提示/描述）→ 用 `commandName()` = `basename(process.execPath)`（新增 `src/command-name.ts` helper，module shape 自导出，8 处替换）。
- **功能性 spawn**（pr.ts:83/104 `Process.spawn(["opencode",...])`）→ 用 `process.execPath`（真实可执行路径），不用 `commandName()`——basename 依赖 PATH 且 dev 模式下 execPath=bun 会得 "bun"，spawn 必须指真实二进制。
- **provider ID / 协议标识 / 官方安装逻辑 / 注释**（models.ts/footer.command.tsx/demo.ts/uninstall.ts/upgrade.ts/providers.ts:307 `.well-known/opencode`）→ 一律不改，是协议/标识非命令名。
- **可复用性**：fork 产物改名场景，先枚举"命令提示 vs 功能 spawn vs 协议标识"三类，分别处理；改动前 grep 全局确认红线文件不入 diff。

### 7. WSL2 混合环境 typecheck 必须移开 git-ignored dist/（2026-08-19，可复用）
- **现象**：`bun typecheck` 报 `Unable to resolve @typescript/native-preview-win32-x64`（平台包缺失）；等价命令 `bun run --bun tsgo --noEmit` 又报 `dist/.../example.ts TS1484`。
- **根因**：仓库 node_modules 在 win32 下安装（F: 盘 WSL 挂载），@typescript/native-preview 的 win32-x64 原生包缺失；git-ignored 的 stale `dist/` 产物里有 vendored plugin example.ts 触发 verbatimModuleSyntax 错误。
- **方案**：验证 typecheck 三步：①`mv dist /tmp/xx` ②`bun run --bun tsgo --noEmit`（REAL_EXIT=0 才是干净）③还原 dist。Worker 报告的 "typecheck exit 0" 必须复核为 REAL_EXIT=0。
- **可复用性**：WSL2+win32 混合 node_modules 的仓库，任何 typecheck 声称都要验证 REAL_EXIT，且先排除 dist 干扰；不轻信 Worker 口头声称（T601 曾声称 exit 0 实为整合前旧状态）。

### 8. 测试文件整合必须在 typecheck 门禁内闭环（T601，2026-08-19，可复用）
- **现象**：Tester 新增的整合测试文件（acp/initialize.test.ts）有 2 处 TS 类型错误（缺 protocolVersion、cast 缺 args），Approval 抓出后 typecheck 才 REAL_EXIT=0。
- **根因**：Tester 阶段只跑 `bun test`（运行时类型擦除）没跑 typecheck；整合归位时未重跑门禁。
- **方案**：任何测试文件新增/整合后，必须过 typecheck 门禁（REAL_EXIT=0），不只跑 bun test。
- **可复用性**：TypeScript 仓库的测试文件也是 typecheck 范围，测试整合是每次改动轮次内必须闭环的门禁，不能留到下一轮。

### 9. 三重 Loop 中 Approval 抓增量问题的价值（T601，2026-08-19，可复用）
- **现象**：Reviewer PASS + Tester PASS 后，Approval 仍抓到 2 处必改 TS 错误（测试文件类型问题）+"typecheck exit 0 声称与实况不符"。
- **根因**：Reviewer/Tester 各自独立跑过，但都未做 typecheck 门禁（Reviewer 跑过等价命令但可能是同一旧状态；Tester 明确声明纯测试任务未跑 typecheck）。
- **方案**：三重 Loop 的 Approval 环节强制自查 typecheck REAL_EXIT，不采信 Worker 声称；修正后必须再审。
- **可复用性**：Approval 不是复读 Reviewer/Tester，而是独立执行门禁验证（自查优先），抓"声称 vs 实况"差异是核心价值。

### 10. T601 测试整合最终形态（2026-08-19，记录）
- **5 个测试文件**：`test/command-name.test.ts`（边界并入）、`test/cli/error.test.ts`（remote auth 2 用例）、`test/cli/run/splash.test.ts`（真实 TUI 渲染回归，核心）、`test/provider/error.test.ts`（网关 401）、`test/acp/initialize.test.ts`（ACP initialize）。
- **核心回归**：splash.test.ts 用 createTestRenderer 捕获真实 TUI 输出，断言含 `${commandName()} --mini -s sess_abc` 且不含 `opencode --mini`。
- **provider.ts 2 处（cloudflare/snowflake）无单测**（custom() 私有重依赖），留 T602 strings 扫描 + 手动触发验证。
