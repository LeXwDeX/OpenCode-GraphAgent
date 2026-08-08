# ADR-0001: escalation_pending 是裁决状态旗（Q1）

- 状态：已接受（批次 A grilling，2026-08-07，决策 (b)）
- 上游公理：设计公理 ①②④（CONTEXT.md）

## 背景

`escalation_pending` 曾是无契约的混合旗：escalate 置 true、NodeStarted/Restarted 清、updateNodeDeadline 清、终态不清。被三个消费者依赖（交付边界、summary escalatedNodes、re-time 门控）。D2（wake 被 extend 偷吃）与「终态永挂旗」陷阱同源于语义未定义——投递状态与裁决状态共用一旗。

## 决策

`escalation_pending` 的唯一语义：**该节点正在等待主 agent 裁决**。

清除时机（仅两种）：
1. **裁决写动作**：extend（NodeDeadlineExtended 投影）/ restart（NodeRestarted）/ cancel（NodeCancelled）
2. **终态**：NodeCompleted / NodeFailed 清旗——死掉的节点无裁决对象，其结果由交付边界终态臂 `(extensions>0 ∧ terminal)` 保证送达

投递（送达）是 `wake_reported` 的专职，两旗职责正交。

## 后果

- projector：NodeCompleted/NodeFailed handler 增补清旗（修复终态挂旗）
- NodeCancelled handler 清旗（cancel 即裁决）
- summary 谓词与边界谓词不变（语义对齐后自然正确）
- 测试：终态清旗回归测试 + cancel 清旗测试
