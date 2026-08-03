# DAG 编排与深度准入

OpenCode-DAG 提供两种兼容的工作流入口：

- `standard`：默认模式。适合边界清楚的普通 DAG，不要求准入问答；启动时省略
  顶层 `mode` 参数，行为不变。
- `deep`：面向复杂、研究密集、需要多阶段拆解和交叉校验的任务。启动前必须在
  主会话完成准入，并提供有效的 `READY` 或知情 `WAIVED` 记录。

除非用户明确要求 `deep`，仅当任务至少具有两个复杂度信号时才建议使用：
独立工作流、跨领域不确定性、高影响范围、冲突约束、证据收集、多视角验证。
简单或已经充分限定的任务应继续使用 `standard`、单个 `task`，或直接执行。

## 主会话 QA

准入问答发生在创建 DAG 之前，并复用主会话的用户提问能力。不要把 QA
建模成子节点或子工作流，因为问答结果用于定义图本身。

QA 覆盖六个维度：目标、范围、约束与假设、验收标准、证据与审查、风险与失败
模式。系统支持三种有界策略，且只要已经满足准入条件就提前结束：

| 模式 | 最大轮数 | 用途 |
| --- | ---: | --- |
| `LIGHT` | 1 | 需求基本完整，只需确认关键缺口 |
| `STANDARD` | 3 | `deep` 的默认准入策略 |
| `GRILL` | 5 | 用户提出 `GRILL-ME` 等对抗式核查要求 |

轮数耗尽但仍有阻塞问题时，结果必须是 `NOT_READY`，不能静默降级为
`READY`。`GRILL` 会额外寻找矛盾、隐藏假设、薄弱证据、失败模式和可证伪条件；
它是同一准入协议的策略，不是独立人格或命令。

## Requirement Brief

每次准入都生成带版本和确定性指纹的结构化 Brief：

```json
{
  "goal": "要实现的结果",
  "scope": {
    "in": ["包含内容"],
    "out": ["明确排除"]
  },
  "constraints": ["约束"],
  "assumptions": ["假设"],
  "acceptance_criteria": ["验收标准"],
  "evidence_required": ["所需证据"],
  "risks": ["风险"],
  "review_plan": ["核对与审查计划"],
  "open_questions": ["非阻塞问题"],
  "blocking_questions": ["阻塞问题"]
}
```

YAML 准入输入只包含 `brief_revision`、`qa_mode`、`verdict`、`brief`，以及
WAIVED 所需的审计字段。不要在输入中提供 `protocol_version`、`state` 或
`fingerprint`：工作流边界会设置协议版本，从 verdict 初始化状态，规范化 Brief
后计算小写十六进制 SHA-256 指纹；只有成功启动后才把持久化状态转为
`CONSUMED`。

启动、扩展和 replan 的图配置都先写入 `.yaml` 或 `.yml` 文件，工具调用只传
`action`、`spec_path` 和该动作所需的少量标识字段。启动文件中，`mode`、
`admission` 与 `config` 同级。校验失败时保留并修改同一文件后重试，不要重新
生成整段 tool-call 参数。

目标、范围、约束、假设或验收标准发生实质变化时，应增加 Brief 修订号，
使旧指纹失效并重新问答；新指纹仍由工作流边界生成。

## Verdict 与恢复路径

- `READY`：目标、范围边界、验收标准、证据要求和审查计划均完整，且
  `blocking_questions` 为空。
- `NOT_READY`：仍有阻塞问题。用户可以继续回答、缩小范围、切换为
  `standard`，或进行知情豁免；此时不能创建深度工作流。
- `WAIVED`：用户明确接受未解决风险。必须同时记录非空的 `waiver_reason` 和
  `acknowledged_risks`。

成功启动后，最终记录作为 `CONSUMED` 与工作流配置一起持久化。恢复时读取该
记录，不重放 QA。状态查询只投影 verdict、模式、修订、指纹和豁免审计信息；
完整 Brief 保留在持久配置中，原始问答聊天不会复制到每个子节点。

## Review 生命周期

实现前的审查并非反模式，错误在于把它包装成已经审查代码差异：

- `review.phase: design` 审查需求、设计、架构、威胁模型或测试策略。它可以位于
  explore/design 之后、implementation 之前，但不能声称验证了实现正确性、
  实际 diff 或测试执行结果。
- `review.phase: diff` 审查实际实现。生产拓扑必须遵循
  `implementation → verification(PASS) → diff review → final gate/audit`。

深度 diff review 必须声明 `implementation_node_id` 和
`verification_node_id`，映射实现产生的 diff（或 changed-files 证据）、
实现指纹和验证结果，并以验证 verdict 为 `PASS` 作为执行条件。审查结果返回
`ACCEPT` 或 `REJECT`，同时回显被审实现指纹。

如果返回 `REJECT`，修正路径是：

```text
REJECT
  → corrected implementation
  → verification(PASS)
  → new diff review
```

实现变化会产生新指纹，旧 `ACCEPT` 不能满足最终门禁。验证不是 `PASS`、diff
为空、占位符未解析或结果指纹过期时，diff review 在创建子会话前或完成节点前
被阻断。

压测 DAG 可以为了构造扇出、扇入而在较早阶段安排审查，但必须标记为
`design`，并明确它不提供实现差异保证。真实质量门禁不能用这种压测拓扑替代。

## 兼容性与公共接口

严格准入和 review 拓扑校验仅用于 `deep`。现有 `standard` 图可以继续省略
准入和 review 元数据；若显式声明了不完整的 diff review 元数据，引擎只产生
非阻塞诊断。

本能力扩展的是模型可调用的 `workflow` 工具文件输入。现有 HTTP DAG
查询仍返回持久化工作流行和字符串化 `config`，HTTP 请求/响应 schema、
SDK 的 DAG summary 类型以及 TUI re-export 均未改变，因此不需要重新生成
JavaScript SDK。
