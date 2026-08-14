# AHE 提示词修订 — DAG Orchestration Router

## 1. 范围与职责

让父对话从实时模板库选择一个主参考和自治档位，再把必要的跨领域保障组合进同一个 YAML DAG。

## 2. 组件地图（修改前）

- 常驻 Router 决定是否使用 DAG 和积木顺序，但不知道配置仓库已经收敛为七个领域及 `full`/`lite`。
- 配置仓库 README 保存了档位规则，但 README 不在运行时模板发布包内。
- `guide(topic="patterns")` 仍提供 Deep Review、Large Engineering 等另一套路线名称。
- `workflow(action="list")` 只显示名称、标题和大小，隐藏了模板的目标。

## 3. 评估笔记

YAML 字段契约和文件式 authoring 已经明确；缺口在选择信息的所有权和可见性。修订不增加 Schema、积木种类或运行时状态，只删除平行路由语言并让现有模板目标进入选择面。

## 4. 失败模式类

### P1 — 路由权威分裂

- 证据：新模板目录只在配置 README 中，常驻 Router 和 patterns guide 使用两套旧分类。
- 根因：模板目录更新没有同步到模型真正常驻的工作流指导层。
- 组件层级：工作流指导。

### P2 — 参考库被新建路径绕过

- 证据：`/dag-flow` 明示优先 fresh blocks；用户反馈表现为模型猜测 YAML 和路线。
- 根因：命令入口没有先读取实时模板目录。
- 组件层级：命令工作流指导。

### P3 — 候选信息不足

- 证据：`list` 输出缺少 `config.objective`，必须逐个 `read` 才能判断目标。
- 根因：工具输出契约没有携带模板已经声明的选择证据。
- 组件层级：工具输出契约。

### P4 — lite 子节点越权选路

- 证据：七个 lite 模板曾要求第一个子节点自行“升级 full”，但子节点既不拥有路由权，也不能阻止后续写入。
- 根因：档位前提只写成自然语言提示，没有连接到现有 verdict condition 与父会话 wake。
- 组件层级：配置模板拓扑、配置 CI 契约。

## 5. 变更清单

### chg-1 — 一个主参考加一条风险升级规则

- 失败证据：P1。
- 根因：常驻 Router 不认识领域交付物和档位边界。
- 针对性修复：按最终交付物选择一个主参考；仅在全部低风险条件成立时使用 `lite`，任一高风险信号选择 `full`。
- 预测影响：领域和档位选择稳定；风险是边界任务升级为 `full`，由模板裁剪抵消成本。
- 组件层级：工作流指导。

### chg-2 — patterns 只处理跨领域冲突

- 失败证据：P1。
- 根因：按需 guide 又定义了一套完整路线。
- 针对性修复：删除六个旧 playbook；只说明如何在一个主参考中加入最小 secondary assurance。
- 预测影响：同一目标不再拼接两套完整路线或启动多个 workflow。
- 组件层级：按需工作流指导。

### chg-3 — 库优先并显示 objective

- 失败证据：P2、P3。
- 根因：命令偏向从零生成，候选列表缺少目标。
- 针对性修复：常驻 Router 先 `list`、再 `read`；`/dag-flow` 只委托 Router；列表显示每个模板的 `objective`。
- 预测影响：已发布参考会先于自由生成被采用；无匹配参考时仍可使用 blocks 逃生口。
- 组件层级：命令工作流指导、工具输出契约。

### chg-4 — lite 前提失效时先阻断

- 失败证据：P4。
- 根因：子节点同时承担取证和重新选路，且没有结构化停止条件。
- 针对性修复：七个 lite 模板在取证后增加 reporting review gate；所有后续路径均受 gate 支配，非 `ACCEPT` 会唤醒父会话并跳过后续。子节点和按需 guide 只要求 verdict、证据及 required actions；父 Router 在 workflow 完成后决定是否用新节点 ID `extend`。
- 预测影响：运行中发现迁移、并发、安全或发布边界时不会继续写入，也不会由子节点猜测 full 路线。
- 组件层级：配置模板拓扑、配置 CI 契约。

### chg-5 — Router 单独拥有执行模式与控制选择

- 失败证据：按需 policy/interface guides 重复 direct、task、workflow 选择规则，并曾要求 child 输出 `next_action`。
- 根因：路由规则被放进三个组件，加载按需 guide 会覆盖 resident Router 的较新判断。
- 针对性修复：policy/interface 只引用 Router 并保留各自的 tier、YAML、checkpoint 与恢复契约；工具字段和示例只接受 `list` 返回的精确名称或 YAML 路径；catalog 拒绝 child 中的 route 名、`next_action` 和具体控制操作。
- 预测影响：加载任何 guide 不会改变已选择的执行模式；child 只能报告证据和 required actions。
- 组件层级：resident Router、按需 guides、配置 CI 契约。

## 6. 证伪计划

- 小型明确功能应选 development-lite；出现跨模块迁移时应翻转为 development-full。
- 可复现单点缺陷应选 debug-lite；未知根因或并发/持久化边界应翻转为 debug-full。
- 需要修改代码的安全问题应保持 development/debug 主参考并加入安全保障；只要安全报告时才以 security-audit 为主。
- 删除 gate→qualification 边、把 writer 放在 gate 前、绕过 gate 支配链或让 child 选择 full route 时，catalog 契约测试必须失败。
- 删除 `list` 的 objective 输出后，列表契约测试必须失败；删除 Router 的领域或风险规则后，提示词契约测试必须失败。
- 删除 lite gate 的 parent report、让后续节点绕过 gate，或重新加入子节点选路文本时，配置目录门禁必须失败。
- 若实测仍跳过模板库，先回滚并重写 chg-3 的入口约束，不在 Router 叠加更多同义规则。
