# /dag-init 平台握手认证指引（T403 / T406）

> 本文档由 T403（P006/R12-4/D18）交付：记录 `/dag-init` 在当前 opencodeg 环境的失败过程，并给出**给用户的平台握手认证指引**。T406（2026-08-19）用户已实际执行认证并完成平台握手，本文档更新为**已完成**状态，步骤说明保留作为**未来在有写权限项目使用 `/dag-auto` 的参考**。

---

## 0. 当前状态：✅ 平台握手已完成（2026-08-19，T406）

用户已实际执行本指引第 2 节步骤并重跑 `/dag-init`，平台握手**实质打通**。结果见第 5 节「当前仓库 can_push=false 结论」。

---

## 1. 历史背景：为什么 /dag-init 之前跑不了（2026-08-18）

> 本节记录 T403 阶段（用户认证前）的失败状态，作为过程留痕；当前仓库已完成握手，不再处于该状态。

### 1.1 实际运行失败输出（2026-08-18，opencodeg 环境实测）

在 `/mnt/f/projects/AI/OpenCode-GraphAgent` 运行 `opencodeg run "/dag-init"`：

```
$ git remote get-url origin
https://ghfast.top/https://github.com/LeXwDeX/OpenCode-GraphAgent.git
（host = ghfast.top，不属于 github.com / gitlab.com → 进入 self-hosted GitLab 探测）

$ curl -sS -o /tmp/daginit_probe.json -w "HTTP_CODE:%{http_code}\n" \
    --connect-timeout 10 --max-time 15 "https://ghfast.top/api/v4/version"
HTTP_CODE:403
---BODY---
Invalid input.

→ 403 + "Invalid input." 非 GitLab 形状响应（GitLab 自托管应返回 401/GitLab JSON）
→ 按 dag-init 命令 step1 规则：STOP "unsupported platform: only GitHub and GitLab
   (self-hosted included) are supported."

$ which gh
gh: command not found

→ 结果：.opencode/dag-init.json 未被写入（命令在 step1 即 STOP，早于写配置）
```

### 1.2 失败根因（两条叠加，R2 为主因）

| 编号 | 根因 | 实证 |
|------|------|------|
| **R2（主因）** | git remote host = `ghfast.top`，非 github.com/gitlab.com。dag-init step1 平台检测仅认 GitHub/GitLab；ghfast.top 不在其中 → 探测 `/api/v4/version` 得 **HTTP 403 + "Invalid input."**（非 GitLab 形状）→ **STOP "unsupported platform"**。失败发生在 **step1（平台检测）**，早于 step2 的 gh 检查 | `git remote get-url origin` + curl 实测 403 |
| **R1（次因）** | gh CLI 未安装（`gh: command not found`），且无 `GH_TOKEN` / git credential helper / `~/.config/gh` | `which gh`、`env`、`ls ~/.config/gh` 实测 |

### 1.3 网络事实（决定步骤顺序）

| 目标 | 结果 |
|------|------|
| `github.com` 直连 | ❌ 超时不可达（curl timeout 124） |
| `ghfast.top` 代理 | ✅ HTTP 200 可达 |
| `api.github.com` 直连 | ✅ HTTP 200 可达（**gh 的 API 走 api.github.com，通**；git 操作走 github.com，不通） |

⚠️ **结论**：即使装了 gh 并登录，**不改 git remote 也过不了 step1**——所以**步骤 A（改 remote）必须先做**。

### 1.4 ⚠️ 路径陷阱（务必注意）

dag-init 内置提示（`packages/core/src/plugin/command/dag-init.txt` step4）写死的安装建议是：

```
git clone git@github.com:LeXwDeX/opencode-dag-config.git ~/.config/opencode/workflows
```

这是**旧 opencode 路径**，对 opencodeg 是**错的**！opencodeg 的正确全局路径是 **`~/.config/opencodeg/workflows`**（实测该目录已存在，装好了 16 个 DAG 模板，见 T401）。**本指引不得照抄 dag-init 内置提示**，模板安装/检查一律用 opencodeg 路径。

---

## 2. 解决方案步骤（顺序重要，勿跳步）——本仓库已执行完成（2026-08-19），留作未来参考

> 用户已实际完成步骤 A–D 并跑通 T406。以下步骤保留，供**未来在有写权限的项目**重新走平台握手时参考。

### 步骤 A：改 git remote（必须先做）

失败发生在 step1 平台检测，host 必须是 github.com 才能通过。改 origin 为 github.com 地址。

> **T406 已执行的实际结果（2026-08-19）**：origin 改为 **ssh 形式** `git@github.com:LeXwDeX/OpenCode-GraphAgent.git`（gh 认证为 ssh 协议，见 learned.md 经验 9），并保留 `ghfast` 镜像为独立 fetch remote（供 opencodeg-update 自动更新，实测 ssh 可达且不破坏 opencodeg-update）。当前 remote 状态：

```
origin  git@github.com:LeXwDeX/OpenCode-GraphAgent.git (fetch/push)
ghfast  https://ghfast.top/https://github.com/LeXwDeX/OpenCode-GraphAgent.git (fetch/push)
```

下列原始命令为 **https 形式**（若未来项目 gh 认证为 https 协议则用此形式）：

```bash
git -C /mnt/f/projects/AI/OpenCode-GraphAgent remote set-url origin https://github.com/LeXwDeX/OpenCode-GraphAgent.git
```

验证：

```bash
git -C /mnt/f/projects/AI/OpenCode-GraphAgent remote get-url origin
# 期望输出：https://github.com/LeXwDeX/OpenCode-GraphAgent.git
```

**⚠️ 副作用警告（改前必读）**：`opencodeg-update` 自动更新依赖 origin 的 `fetch` + `rebase`。改回直连后，github.com 直连 git 超时不可达，**可能破坏自动更新**。两种安全做法，任选其一：

1. **保留镜像为独立 fetch remote**（推荐，一劳永逸）：
   ```bash
   git -C /mnt/f/projects/AI/OpenCode-GraphAgent remote add ghfast https://ghfast.top/https://github.com/LeXwDeX/OpenCode-GraphAgent.git
   ```
   之后 origin = 直连（供 /dag-init 识别平台），ghfast = 镜像（供自动更新/手动拉取）。
2. **临时改回，跑完 /dag-init 再还原**：
   ```bash
   # 改直连 → 跑 /dag-init → 跑完还原回 ghfast 镜像
   git -C /mnt/f/projects/AI/OpenCode-GraphAgent remote set-url origin https://ghfast.top/https://github.com/LeXwDeX/OpenCode-GraphAgent.git
   ```
   （若 opencodeg-update 逻辑硬绑 origin，做法 2 是最小侵入。）

### 步骤 B：安装 gh CLI

> **T406 已执行的实际结果（2026-08-19）**：gh **2.45.0** 已装（Ubuntu 官方仓库 2.45.0-1ubuntu0.3）。

Linux Debian/Ubuntu 一条命令（官方仓库安装）：

```bash
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) && sudo mkdir -p -m 755 /etc/apt/keyrings && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && sudo apt update && sudo apt install gh -y
```

验证：

```bash
gh --version
```

> 其他发行版见官方文档 https://cli.github.com 。（opencodeg 侧不负责安装 gh，本步骤由用户手动执行。）

### 步骤 C：gh auth login（交互式，用户手动执行）

> **T406 已执行的实际结果（2026-08-19）**：已认证为 **znewyear**，Git operations 协议 **ssh**（`gh auth status` 确认，Token 为 fine-grained PAT）。

```bash
gh auth login
```

按提示依次选择：

1. **GitHub.com**
2. **HTTPS**
3. **Login with a web browser**（浏览器授权）
4. 浏览器中确认授权 → 回到终端完成

验证：

```bash
gh auth status
# 期望输出：Logged in to github.com as <你的账号>
```

> 说明：gh 的 API 请求走 `api.github.com`（实测直连 200 通），所以登录和后续 API 探测不受 github.com 直连超时影响。git clone/push 走 github.com 的操作仍可能超时，那是另一个问题（用 ghfast 镜像 / 做法 1 规避）。

### 步骤 D：重跑 /dag-init

> **T406 已执行的实际结果（2026-08-19）**：重跑全通过——平台检测✅ gh 认证✅ CI✅ rulesets✅ 模板✅；`.opencode/dag-init.json` 已生成（见第 3 节实际产物）。

在项目目录（TUI 或 run 模式）运行：

```bash
opencodeg run "/dag-init"
```

（或直接在 TUI 里输入 `/dag-init`。）

若步骤 A–C 都通过，命令会跑完 step1–step4 并写入配置（见第 3 节）。

---

## 3. 成功产物与实际产物（T406）

成功后写入 `.opencode/dag-init.json`（这是 `/dag-*` 家族唯一的本地连接状态，可提交）。

**T406 实际产物（2026-08-19 实测，`checked_at=2026-08-19T01:38:32Z`）**：

```json
{
  "platform": "github",
  "repo": "LeXwDeX/OpenCode-GraphAgent",
  "remote": "origin",
  "base_branch": "main",
  "cli": "gh",
  "can_push": false,
  "has_ci": true,
  "has_rulesets": true,
  "has_templates": true,
  "merge_policy": "ordered",
  "checked_at": "2026-08-19T01:38:32Z"
}
```

与「预期产物」唯一的差异是 **`can_push: false`**（见第 5 节结论）。其余字段全部达成：`has_templates` 检查项目 `.opencode/workflows/` → 全局 `~/.config/opencodeg/workflows/` → 内置模板三层；当前全局层已有模板（T401），实测为 true。

## 4. 后续

- **`/dag-auto`（六积木超流）**：依赖 `dag-init.json` 且需要**写权限**（can_push=true，需开 PR）。本仓库 `can_push=false`，**/dag-auto 不可用**。想用 /dag-auto 必须在**有写权限的项目**里完成第 2 节步骤 A–D 后重跑 `/dag-init`。
- **`/dag-flow`（常驻编排路由）**：**不依赖** `dag-init.json`，现在就能用，不受平台握手结果影响。

## 5. 当前仓库 can_push=false 结论

| 项 | 内容 |
|----|------|
| 账号 | znewyear（gh 2.45.0，ssh 协议） |
| 仓库 | LeXwDeX/OpenCode-GraphAgent（**作者仓库**，非用户自有仓库） |
| 权限 | znewyear 对作者仓库**只读**（collaborator 权限不足，无 push 权限）→ `can_push=false` |
| 影响 | `/dag-auto`（六积木超流，需写权限开 PR）在本仓库不可用；`/dag-flow` 不受影响 |
| 用户裁决 | ✅ **接受现状，记录结果**；/dag-auto 为增强项，**未来在有写权限的项目**里重跑 `/dag-init` 即可（此时 can_push 会自动变为 true） |
