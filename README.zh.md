<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md"><b>简体中文</b></a>
</p>

# GraphAgent

> 一个把任务拆成子智能体依赖图、并驱动它跑完的编码智能体。状态持久化，崩溃能恢复，整张图在终端里就能看、能控。

GraphAgent 是本项目对外的产品名；仓库以 **OpenCode-GraphAgent** 发布，是 MIT 许可的
[opencode](https://github.com/anomalyco/opencode) 终端 AI 智能体的 fork，在其之上加了 DAG 工作流引擎。**与 OpenCode 团队无任何隶属或背书关系。**

---

## 「Graph Engineering」这个名字出现前，GraphAgent 已经在跑

在 GraphAgent 里，graph 是一份**可执行、可持久化、可观测、可控制的契约**。节点干活，边传产物，运行时负责调度和恢复。公开 Git 历史显示，第一版完整 DAG 引擎在 **2026-07-02** 已经提交；论文 [*What makes prompts a graph: necessary and sufficient conditions for prompt graph engineering*](https://arxiv.org/abs/2607.27578) 到 **2026-07-30** 才把显式结构、prompt/拓扑分离、可执行语义和 graph 一等制品化归纳出来。术语晚了四周，工具没有等它。

这套东西落到了五条运行规则里：

1. **每条边都要有用。** 如果下游不读上游产物，这条依赖就该删。真正独立的工作直接并行。
2. **模板是参考拓扑，不是固定脚本。** 主 Agent 可以按任务扩展或剪枝，但每次剪枝都必须写明理由和替代覆盖证据。
3. **推演、复审、裁决分开做。** `reasoner` 模拟潜在执行路径，fresh-context reviewer 复审前一个局部波次，最后由唯一 arbiter 给出裁决；这些门禁不可剪掉。
4. **迭代是有界的局部改图。** `PASS` 才能定稿，`LOOP` 通过 pause → replan → resume 增加新的修正与复审波次，`BLOCKED` 带证据停止；终态节点不会被伪装成环。
5. **代码和测试说了算。** 状态变更写入事件，崩溃恢复只认持久化证据。到了代价高的边界，人可以 pause、step、cancel 或 replan。

仓库已经附带三类强约束参考图：设计决策深挖、并行项目落地、已完成子系统深度 Review。`/dag-flow` 会先按需求选择最接近的中高规模样板，注入本次任务，再派生实际 DAG；可以扩展和剪枝，但不能绕过 fail-closed 门禁。入口见 [Graph Engineering 工作流目录](./.opencode/workflows/GRAPH-ENGINEERING.md)。

## 为什么是 DAG

任务一旦涉及分阶段依赖、可并行的独立工作，或者中间需要一道质量门禁，单智能体循环就不太够用了。这个引擎的设计基于四个判断：

1. **决策和跑量分开。** 必须做对的事（任务分解、门禁、仲裁、最终综合）交给 advanced 模型层；量大的事（探索、实现、分角度分析）在 standard 层扇出。standard 层靠冗余换精度：横向是独立并行的切片汇入一个仲裁节点，纵向是结论跨波次对照代码和测试重新验证。
2. **先把需求问清楚，再建图。** 复杂任务（`deep` 模式）建图前要过一轮有界问答（1、3 或 5 轮），产出带版本号和指纹的 Requirement Brief，裁定只有 `READY`、`NOT_READY`、`WAIVED` 三种。轮数用完还有阻塞问题，结果就是 `NOT_READY`，不会悄悄放行。
3. **门禁结论必须有下文。** 检查点返回 `REVISE` / `REJECT` / `BLOCKED` 时，父智能体要在同一个唤醒回合里处置它：extend、replan、开新工作流，或者说明理由后停下。只复述结论就结束回合，按契约算编排失败。
4. **恢复靠证据，不靠猜。** 所有状态变更都是持久化事件，状态转换要过声明式状态机的守卫，终态不可逆（只有一个写进规范的例外），读模型是 CQRS 投影。崩溃后只依据持久化证据和解现场，不会凭空重放模型调用。

## 工作流怎么用

不配置也能直接试：给它一件有阶段、有可并行部分、或者中间需要一道审查门禁的活，智能体自己会建图并跑起来。想把它变成你自己的一套固定流程，有三件事：

### 1. 选定模型分层 —— `.opencode/dag.jsonc`

节点从不指定自己的模型。图只声明*哪些节点是关键的*，由配置决定*用什么跑*：

```jsonc
{
  // 关键节点：required: true，以及审查/仲裁类 worker。
  "model": {
    "advanced": "anthropic/claude-sonnet-4-5",
    "standard": "anthropic/claude-haiku-4-5"
  },
  // DAG 子会话的推理深度变体，仅当模型定义了同名变体时生效。
  "thinking_depth": "medium"
}
```

项目的 `.opencode/dag.jsonc` 优先于 opencode 配置目录下的全局文件；首次使用时会在全局目录生成一份带注释的默认文件。只配一层时，它就是统一默认值。每个节点的解析顺序是：分层 → worker agent 模型 → 父会话模型；三者都给不出模型时，工作流不会被创建，而是回来问你去配一个。

### 2. 把要复用的工作流存起来 —— `.opencode/workflows/`

工作流 spec 就是一个描述图的 YAML 文件。把它放进工作流目录，它就有了**名字**：

| 作用域 | 路径 | 可用范围 |
|---|---|---|
| 项目级 | `.opencode/workflows/<name>.yaml` | 本仓库，随仓库提交 —— 团队拿到的是同一套流程 |
| 全局级 | `<opencode 配置目录>/workflows/<name>.yaml` | 本机所有项目 |

文件名（去掉扩展名）就是名字，同名时项目级遮蔽全局级。一个最小的 spec：

```yaml
title: Dependency audit
config:
  name: dependency-audit
  nodes:
    - id: inventory
      name: inventory
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: config-explore
        input:
          target: "package.json files and lockfiles"

    - id: report
      name: report
      worker_type: general
      depends_on: [inventory]
      report_to_parent: true
      prompt_template:
        inline: "Flag outdated or duplicated dependencies in {{inventory}} and propose an upgrade order."
```

之后直接说「跑 dependency-audit 工作流」就行 —— 智能体按名字启动，不需要路径。临时 spec 的用法完全不变：看起来像路径的 `spec_path`（含路径分隔符，或带 `.yaml`/`.yml` 扩展名）仍按会话目录相对解析，不走工作流库。

### 3. 让智能体替你写

内置的 **`create-dag-workflow`** skill 覆盖 spec 编写：两个作用域、文件结构、存盘 spec 必须守的规矩（不能钉死模型、`worker_type` 必须存在、模板必需变量必须给全），以及怎么验证。说一句「把这个存成可复用的工作流」，智能体会先跟你确认阶段和门禁，把文件写进你选的作用域，再真跑一次证明它能用。

节点 prompt 来自 `.opencode/dag-prompts/*.md` —— 随仓库附带 12 个，通过 `prompt_template.id` 引用。往那儿加一个 `.md` 就多一个模板；全局工作流建议用 `inline` prompt，否则会依赖某个仓库本地的模板。

## DAG 工作流引擎

引擎位于 [`packages/core/src/dag`](./packages/core/src/dag)（状态机、依赖图、调度、事件投影、SQLite 读模型）和 [`packages/opencode/src/dag`](./packages/opencode/src/dag)（工作流服务、执行循环、节点生成、准入、审查生命周期、崩溃恢复、模板）。智能体通过单个 `workflow` 工具驱动它；人通过 TUI 或 HTTP API 观察和控制它。

### 图定义

每个节点可声明：

| 字段 | 用途 |
|---|---|
| `depends_on` | 依赖边；创建时做环检测和悬空引用校验 |
| `worker_type` | 执行节点的智能体（`explore`、`build`、`general` 或任意已配置 agent） |
| `prompt_template` | 通过 `id` 引用模板（`.opencode/dag-prompts/`，随仓库附带 12 个）或 `inline` 内联，支持 `{{var}}` 插值 |
| `input_mapping` | 把上游节点输出映射为模板变量（`"count": "node-b.output.count"`） |
| `condition` | 基于上游输出的表达式；为假则跳过节点，纯依赖它的下游级联跳过 |
| `output_schema` | JSON Schema；子智能体必须调用 `submit_result` 提交匹配的结构化结果 |
| `required` | 必需节点失败会使整个工作流失败 |
| `report_to_parent` | 节点到达终态时唤醒父智能体 |
| `review` | `design` 或 `diff` 审查阶段，带实现指纹契约（见下） |

工作流级参数：`max_concurrency`（默认 5）、`max_node_replan_attempts`（5）、`max_total_nodes`（100）、节点级 `timeout_ms`（默认 10 分钟，排队等待计入预算）。

### 调度与执行

- 节点通过与 `task` 工具相同的代码路径生成真实子会话，按依赖顺序逐波执行，由并发信号量约束。节点在准入时持久化为 `queued`，子会话拿到并发许可后才创建，所以 100 个节点的扇出不会一次拉起 100 个会话。
- **动态重规划**，暂停优先：`pause` 立即冻结调度，`replan` 将片段（添加 / 替换 / 取消 / 重启节点）原子性合并进运行中的图，`resume` 继续。终态节点不可变，想重试失败的节点，就换个新 id 加一个替代节点。`extend` 追加节点，也允许重新打开一个自然完成的工作流（终态不可逆的唯一例外，写进了规范）。
- **单步模式**逐节点执行，便于调试。
- **父智能体不轮询。** `report_to_parent` 节点或工作流到达终态时，引擎用合成消息唤醒父智能体。检查点节点输出规范化裁定（`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`），下一步走向由处置契约约束。迭代是一轮轮有界的、由裁定触发的重规划，图里不存在环形边。

### 状态机与持久化

- 工作流和节点状态各有声明式转换表；所有变更先过守卫，非法转换和终态违规是类型化错误（HTTP 返回 409 而非 500）。
- 所有变更以持久化 `dag.*` 事件发布；投影器在发布事务*内部*写入 SQLite 读模型。历史来自事件回放，没有日志表。另有一个漂移测试盯着投影器守卫和声明的转换表，改了一边没改另一边，测试会挂。
- **崩溃恢复**是惰性的、按工作流、基于证据：残留 `running` 的节点对照其子会话的持久化状态和解。子会话已经跑完的，回填捕获输出；执行权确实丢了的，工作流转入暂停，交给父智能体决定处置（replan / resume / cancel）。恢复过程不会自行接管或重启模型调用。

### deep 模式：准入与审查

- 准入问答覆盖六个维度（目标、范围、约束与假设、验收标准、证据、风险），策略有界：`LIGHT`（1 轮）、`STANDARD`（3 轮）、`GRILL`（5 轮，对抗式）。产出的 Requirement Brief 计算指纹（规范化形式的 SHA-256）；实质性变更使指纹失效并回到问答。消费后的准入记录随工作流持久化，恢复时不重放问答。
- 审查节点必须如实声明阶段：`design` 审查实现前的产物；`diff` 审查实际实现，要求声明实现节点、通过验证的验证节点，并回显实现指纹。实现一变指纹就变，旧的 `ACCEPT` 过不了门禁。

### 观察与控制

- **TUI DAG 检查器**（命令面板 → `dag.open`）：工作流列表、按波次排序的节点视图（实时状态）、节点详情（依赖、错误、输出预览、截止倒计时），`p`/`r`/`s`/`x` 对应暂停/恢复/单步/取消，`enter` 进入节点的子会话。
- **侧边栏面板**：按会话展示工作流进度（完成/运行/失败/排队），可展开节点列表，由瞬态摘要事件驱动，打开时再拉一次兜底，不做轮询。
- **HTTP API**（与工具入口共用同一代码路径）：

  ```
  GET  /dag                              列出工作流
  POST /dag                              创建工作流
  GET  /dag/session/:sessionID           按会话列出工作流
  GET  /dag/session/:sessionID/summary   进度摘要
  GET  /dag/:dagID                       工作流详情
  GET  /dag/:dagID/nodes                 节点列表
  GET  /dag/:dagID/nodes/:nodeID         节点详情
  POST /dag/:dagID/control               pause/resume/cancel/replan/extend/step/complete
  ```

### 项目配置文件

DAG 相关的东西都放在 `.opencode/` 下，在 opencode 配置目录（`OPENCODE_CONFIG_DIR`，否则 `~/.config/opencode`）里有对应的全局版本。其余全部继承 opencode 主配置。

| 路径 | 用途 | 全局对应 |
|---|---|---|
| `.opencode/dag.jsonc` | 模型分层（`advanced` / `standard`）与子会话 `thinking_depth` | `<配置目录>/dag.jsonc`，首次使用时生成带注释的默认文件 |
| `.opencode/workflows/*.yaml` | 存盘的工作流 spec，可按名字启动 | `<配置目录>/workflows/*.yaml` |
| `.opencode/dag-prompts/*.md` | 由 `prompt_template.id` 引用的节点 prompt 模板 | ——（仅项目级） |

`dag.jsonc` 和工作流库都是惰性读取，改完下一次启动工作流就生效，不用重启。

---

## 本 fork 的其他改动

- **Hooks API**：兼容 Claude Code hooks 协议，26 个 hook 事件（`PreToolUse`、`PostToolUse`、`SessionStart`、`PermissionRequest`、`WorktreeCreate` 等）× 5 种执行类型（`command`、`mcp`、`http`、`prompt`、`agent`），从全局/项目/worktree 的 `hooks.json` 链加载，也可以经 HTTP 按会话注册，支持可选的工作区信任门控。详见 [hooks 参考](./packages/core/src/plugin/skill/configure-hooks.md)。
- **工具健壮性**：修复 LLM 输出里损坏的多字节 Unicode 转义（JSON 修复），校验错误带字段级提示，工具文档扩充，子进程管道修复。
- **CJK 与 IME 修复**：终端 UI 里中日韩文输入的修正（IME 组字刷新、全角文本处理），另有 [`patches/`](./patches) 下的韩文 IME 修复脚本。
- **Worktree 隔离**：按工作流的 `git worktree` 隔离，附实验性的 sandbox-worktree HTTP 端点。
- **配置助手**：[`config_assistant`](./config_assistant) 下提供独立 Go TUI，用于定位、校验和编辑 opencode 配置（`cd config_assistant && go run ./cmd/ocfg`）。
- 早期的「Goal 自动循环」和 `/goal`、`/subgoal`、`/workflow` 斜杠命令已经移除，自主执行统一走 `workflow` 工具和它的唤醒机制。

上游全部能力（多 Provider、内置 LSP、客户端/服务器架构、TUI/桌面/Web 客户端）均完整保留。

---

## 安装

预构建 CLI 二进制（Linux / macOS / Windows，附 SHA256SUMS）发布在 [releases 页面](https://github.com/LeXwDeX/OpenCode-GraphAgent/releases)。从 `main` 构建的是正式版；从 `dev` 构建的是预发布版。

从源码构建（需要 [Bun](https://bun.sh) 1.3+）：

```bash
bun install
bun dev              # TUI
bun dev serve        # headless API 服务（端口 4096）

# 独立二进制
./packages/opencode/script/build.ts --single
```

> 本 fork 未发布到 npm/brew/scoop。上游的 `opencode-ai` 包安装的是上游 opencode，不是本 fork。

---

## 质量门禁

- **CI**：每个 PR 跑 typecheck；`main` 门禁额外运行 Bun/Turbo 单元测试与配置助手 Go 测试（Linux）、Playwright e2e（Linux + Windows）、HTTP API 契约测试器、以及生成 SDK 的新鲜度校验。
- **DAG 专项测试**：核心调度单元测试、投影器/状态机漂移测试、工作流生命周期集成测试、每条 DAG 路由的 HTTP API 演练场景。

## 许可证

混合许可证模型：

| 内容 | 许可证 | 文本 |
|---------|---------|------|
| 上游 opencode 代码（绝大多数） | MIT | [`LICENSE`](./LICENSE) |
| DAG 工作流引擎（fork 自研） | AGPL-3.0-or-later | [`packages/core/src/dag/LICENSE`](./packages/core/src/dag/LICENSE)、[`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

精确的文件边界列在 [`NOTICE`](./NOTICE) 中。AGPL 覆盖 DAG 引擎及其衍生品，包括网络服务部署；不碰 DAG 引擎的话，仓库其余部分按 MIT 用就行。

## 文档

- [存盘工作流编写指南](./packages/core/src/plugin/skill/create-dag-workflow.md) —— `create-dag-workflow` skill 正文
- [Graph Engineering 工作流目录](./.opencode/workflows/GRAPH-ENGINEERING.md) —— 参考拓扑与自适应协议
- [`.opencode/workflows/change-review.yaml`](./.opencode/workflows/change-review.yaml) —— 轻量变更审查图，按 `change-review` 启动
- [`.opencode/dag-prompts`](./.opencode/dag-prompts) —— 内置节点 prompt 模板
- [`AGENTS.md`](./AGENTS.md) —— 贡献与开发指南

## 链接

- [GitHub](https://github.com/LeXwDeX/OpenCode-GraphAgent) · [Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues)
- [上游 opencode](https://opencode.ai)
