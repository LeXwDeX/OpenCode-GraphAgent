# S09 最终脱敏验收报告

状态：**PASS**。原生上下文折叠已在零模型 host、性能门禁、本地候选制品和真实 Qwen 配对任务中通过验收。
这份报告只公开白名单聚合值与 SHA-256；prompt、回答、工具正文、endpoint、凭据和 session 标识仍只保存在权限为
`0700/0600` 的本机私有证据目录。

## 冻结对象

- 最终运行候选：`084f09946dfe4a52e96b6ae11c7cd1c5654b3a99`。
- 模型：`local-proxy-compatible/qwen3.8-max`。
- 模型身份 SHA-256：`3770a290a4c3c48c4b45023d8f39f61306fe82cce57b7bc0c6a8682a4ad8761f`。
- 模型配置 SHA-256：`6b96db2d731292e018238ffda2919aa4b7055220415bffdf09d3d701b1d483c8`。
- 窗口：context `81920`、output reserve `4096`、折叠目标 `54476`。
- 保护策略：最近 `4` steps、最近 `16000` estimated tokens、最小净节省 `512` estimated tokens；自动全文压缩保持开启。
- T3/T4 最终 freeze manifest SHA-256：
  `16d609198b6478fe2a5ddd5d2eae4334fc0f65c32e254829fd43f9ee9cb7818d`。

M0、T1、T2、T3/T4 之间的候选变化只涉及 S09 driver、判分、任务提示、测试、证据文档和 release notes；
生产折叠实现、模型身份、模型配置和窗口没有变化。

## 门禁证据

| 层级 | 结果 | 可核验结果 |
| --- | --- | --- |
| H0 raw HTTP host | PASS | 1 test / 56 assertions；enabled 折叠 3 个结果、disabled 折叠 0 个；3/3 witness 与 6 个 read settlement 完整 |
| V3 零模型 host 资格 | PASS | 1 test / 242 assertions；四任务、两臂、真实 builtin tool provenance 与生产投影均通过 |
| P0 正式性能 | PASS | 1 MiB：p95 `21.167 ms`、RSS delta `34.047 MiB`；7.5 MiB：p95 `105.906 ms`、RSS delta `96.75 MiB` |
| 本地候选制品 | PASS | DAG 2 + folding 2 + hold 2 + PTY 1，共 73 assertions；loopback provider，未调用外部模型 |
| 真实模型配对 | PASS | M0 与 T1-T4 共 5 组 enabled/disabled 配对，最终 10 个接受结果全部通过 |

P0 原始样本 SHA-256 为
`504c6ed029cf8decd0983b8a965bdec184729326483344fb21cd2e3b4fc10c8f`；样本数分别为 20 和 10。
RSS 是本次运行观测到的 fresh-process delta，不是严格的内存上界。

H0 脱敏 assessment SHA-256 为
`feceebf2b7def6eee4d0e9ee9ccfe8563a72b926ea9e46e7660e5a0056b8b81e`，对应 evidence SHA-256 为
`4aed2391888a67a2ef24c5898848bee983de8ba97d5641494b60e85563b98480`。

## 真实模型结果

provider usage 是各请求原样上报值的求和；cache read 单独列出，不与 input 相加。

| Run | 任务 | 臂 | 请求 | fold | compaction | input | output | reasoning | cache read | 结果 SHA-256 |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 14 | M0 | enabled | 1 | 1 | 0 | 54,816 | 55 | 44 | 0 | `27cdb29ae83d345cbe345c5979260f3149cfb7ea8c88636139250d8d3546db72` |
| 15 | M0 | disabled | 1 | 0 | 0 | 60,116 | 270 | 259 | 0 | `6a0c4bd3cffcb7c14047e996824f007641cf36f49a04502191fd6c3e69e4be2d` |
| 16 | T1 | disabled | 8 | 0 | 0 | 246,764 | 904 | 393 | 189,440 | `88c44da937590e3c8c0e58fd4b75cda4f9fe038ad15982767c48e9953a90954d` |
| 17 | T1 | enabled | 8 | 1 | 0 | 236,139 | 969 | 458 | 172,032 | `57ab0b5c39feaf571cc9ab2738cc8ee2211449c36a5302b317d5ae4ce13d4538` |
| 19 | T2 | disabled | 7 | 0 | 0 | 238,867 | 1,372 | 487 | 180,224 | `fa9c0871007cd5ba5fa2a8316f0db35dae46f408adbcbd88d2b7e3a374d2eea0` |
| 20 | T2 | enabled | 7 | 1 | 0 | 229,457 | 1,796 | 880 | 159,744 | `a5aa48898b4af1246917e143c2f62dfcc20b5b2ad24967c02471c041b6e817ef` |
| 25 | T3 | disabled | 8 | 0 | 0 | 280,955 | 1,443 | 661 | 223,232 | `a6d8d81ec9bf3093629737f54c366d873df095d6c1110cb4318b380c92038002` |
| 26 | T3 | enabled | 8 | 1 | 0 | 269,070 | 1,128 | 403 | 193,536 | `779abfd84802017e4f41808210f3b23eb3022a370c78bdc58041c74d51ea6c2f` |
| 27 | T4 | disabled | 6 | 0 | 0 | 207,359 | 1,019 | 382 | 152,576 | `0cba923251933eab092861a78f54d4e9075c5a83e5a67638c548989e98e3240f` |
| 28 | T4 | enabled | 6 | 1 | 0 | 196,862 | 1,113 | 413 | 121,856 | `b57cac8a65cf40dcf3853e54aff37c0c9e0e8813ab8bc770e93a7e38f0d15e3a` |

最终接受结果合计 60 个 provider requests、input `2,020,405`、output `10,069`、reasoning `4,380`、
cache read `1,392,640`。五个 enabled 臂各折叠 1 个合格 source，五个 disabled 臂均折叠 0 个；所有接受结果的
自动全文压缩请求数均为 0。

十个接受结果全部满足以下条件：外部质量约束通过、工具轨迹通过、已有历史逐轮 hash 不变、source/witness 完整，
且 workspace 没有额外修改、文件、缺失项或特殊目录项。父级复核重新计算了 10 个 result SHA-256，并逐一验证
result 清单中的 304 个私有 artifact SHA-256，全部一致。

## 保留的失败与预算

失败证据没有删除、回收或改判：

- Run 10：旧 M0 enabled fixture 的真实 token 用量超过可用窗口；auto compaction 被单请求 guard 阻止。
- Run 12：旧 M0 disabled input `83688`，超过可用的 `77824`；auto compaction 被单请求 guard 阻止。
- Run 13：上游返回真实 `503`，未重试。
- Run 18：T2 回答语义正确但未满足旧的显式 count 格式；判定为 fixture/checker 缺陷后改正任务合同并重新配对。
- Run 22：T3 内容和 workspace 均正确，但模型在要求的 `cp` 后追加了 shell 子命令，严格轨迹判分失败；澄清合同后
  重新执行完整 T3 配对。

Run 21 本身通过，但因对应 enabled Run 22 失败而不进入最终配对证据；它与失败运行一样保留在账本中。

用户授权后的 100-request envelope 最终实际消耗 **83/100**，剩余 17。组成是 60 个最终接受请求、Run 18 的
7 个请求、被替代的 Run 21 的 8 个请求和失败 Run 22 的 8 个请求。最终 ledger SHA-256 为
`b95d4c588df85ce0f62fcf5460b1e75179aab343e8b3890d4789bd1f6469b865`。Run 10/12/13 属于更早的历史账本，
没有从本轮 100-request envelope 中重复扣减。

## 证据边界

- 首个最终文档 head `7777af3a1d` 的 Linux Unit Tests 暴露 8 个 fixture 失败：两份 28K read 正文都是
  单行，而生产 ReadTool 会把单行截到 2000 字符，使 read source 的估算净节省落在 512-token 门槛附近。
  Linux 的精确选择差异未能在 macOS 复现；修复把相同规模正文改为每行低于 2000 字符，并增加 read 未截断、
  三类 source 精确占位和 witness 逐字完整断言。产品实现和真实模型结果没有改动，也没有新增模型调用。
  原失败日志 SHA-256 为 `1e2154503758152b17ab6723ecb9ca08c0e88ae42dbbe91158cdb9bf042c415c`。
- 后续 head `55423042bf` 的 Linux Unit Tests 仍有相同 8 个折叠数失败，但新增的 read 长度和未截断断言已通过；
  原有总数断言先于逐工具断言失败，尚不能据此确认缺少的是 read、grep 还是 glob。测试现先逐项核对三类工具，并且
  只输出 source/witness 是否逐字相同以及各自长度和 SHA-256。glob 文件枚举顺序仍只是待该诊断证据验证的假设，
  没有因此修改产品排序或折叠门槛。该次失败日志 SHA-256 为
  `337949d236ff15c25c93fe0455a27e70a0e9f3c38cec9febe7c62064cc9ef5a4`。
- `requestPreparationDurationMs` 不可用：当前 host diagnostic 没有发出该字段。
- live-host RSS baseline/peak/delta 不可用：没有可靠的 live sampler；P0 RSS 没有冒充真实模型运行 RSS。
- provider cache-write 不可用；没有把缺失值写成 0。
- 原始 prompt、provider response、before/after history、outbound body 与凭据分阶段保存在本机私有目录
  `graphagent-final-ce9ca-qwen100-private`、`graphagent-final-be5bab-t2-recovery-private` 和
  `graphagent-final-084f099-t3-recovery-private`，没有提交。
- 本报告证明 S09 对冻结候选的验收通过；PR 合并、当前 head CI、三平台制品和正式发布仍由各自门禁决定。
