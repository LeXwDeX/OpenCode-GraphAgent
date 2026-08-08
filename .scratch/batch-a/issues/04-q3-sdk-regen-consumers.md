# 04 — Q3 派生：SDK 再生 + 消费者对齐

**What to build:** 03 落地后再生 JS SDK，使 NodeDeadlineExtended 进入生成的事件联合类型；对齐一切消费事件流/类型联合的消费者（TUI sync、httpapi-exercise 场景若涉及），保证 CI 生成物新鲜度门禁与 HttpAPI 契约门禁通过。

**Blocked by:** 03 — Q3：NodeDeadlineExtended durable 事件 + guard 前移命令层

**Status:** ready-for-agent

- [ ] SDK 再生脚本执行，生成物提交
- [ ] 事件联合类型包含 NodeDeadlineExtended，消费方编译绿
- [ ] `check:generated`（SDK + client）零 diff
- [ ] 涉及响应/事件形状的 httpapi-exercise 场景已更新（如有）
- [ ] 全量单元测试（含 httpapi 契约）绿
