# S7 — recovery INVENTED 推断诊断

- **Status:** closed-no-fix
- **基线:** `dev@18273554f4f2c18cab1370922eb1ec004ba5bad9`
- **分支:** `test/recovery-diagnosis`
- **日期:** 2026-08-09

## 反馈回路

从 `packages/opencode` 运行：

```bash
bun test test/dag/dag-recovery-transcript-diagnosis.test.ts
```

诊断期间使用的 throwaway 测试已删除。它走过以下真实持久化链路：

1. `Session.layer` 通过 `Session.updateMessage` 发布 durable transcript 事件，`SessionProjector` 写入数据库；测试再用 `Session.messages` 读回并断言完成边界。
2. `DagLoop.init` 扫描 durable running workflow，进入 `recoverWorkflow`。
3. `makeSessionStatusChecker` 通过真实 `Session.get/messages` 读取 child transcript，`reconcileWorkflow` 作出 settlement。
4. `Dag.nodeCompleted/nodeFailed` 发布事件，`DagProjector` 投影到真实 `DagStore`；测试直接读取 node/workflow 持久化结果。

观测断言：

| 输入 | transcript 证据 | 实际持久化结果 | workflow 结果 |
|---|---|---|---|
| 语义完成 | 最后一条 assistant 为 `finish: "stop"`，并带 `time.completed` | node `completed`，`errorClass: null` | `completed` |
| red-capable 对照 | 最后一条 assistant 为 `finish: "tool-calls"` | node `failed`，`errorClass: "exec_failed"` | `paused` |

## 运行结果

最终 `DagLoop.init` seam 连续运行三次，均为 `2 pass / 0 fail`：

| 次数 | 结果 | 耗时 |
|---|---|---|
| 1 | `2 pass / 0 fail` | `1.129s` |
| 2 | `2 pass / 0 fail` | `1.131s` |
| 3 | `2 pass / 0 fail` | `1.133s` |

首次运行因工作区尚未安装 `@opentui/solid/preload`，在加载测试前退出；执行 `bun install --no-save` 后依赖就绪，未修改 lockfile。随后先在真实 `Session → reconcileWorkflow → DagStore` seam 连续跑绿三次，再收紧到上述 `DagLoop.init` seam 并连续跑绿三次。

## 语义边界核对

- `packages/opencode/src/session/prompt.ts` 的真实 loop 只有在最后 assistant 已有 finish、finish 不是 `tool-calls`、没有待处理 tool call 且 assistant 位于最后 user 之后时才走完成退出。
- 同一 loop 将 `tool-calls` 与 `unknown` 明确视为需要 continuation；因此这两类 transcript 不能作为“系统语义已经完成”的证据。
- 测试没有使用自定义完成布尔值。完成态由真实持久化 transcript 中的 `finish: "stop"` 与 `time.completed` 证明，并经生产 `Session.messages` 读回。
- `tool-calls` 对照确实经过 recovery 写入 `exec_failed`，随后触发现有 `ownershipLost → workflow pause` 缓解；该行为用于证明反馈回路可红，不作为新缺陷上报。

## 结论

精确症状“已语义完成的 durable transcript 被 recovery 判为 active/ownershipLost，并实际持久化 `exec_failed`”未复现。完成态 transcript 在真实 recovery/loop 调用链中稳定投影为 node/workflow `completed`；会写 `exec_failed` 的对照 transcript 按现有 Session loop 语义仍需 continuation。

本票不修改生产代码，不保留诊断测试，不创建猜测性修复票，也不创建票 09。
