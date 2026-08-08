# 07 — O1：实现 remote config last-known-good 缓存

**What to build:** 按 06 产出的已校验 OpenSpec 实现 LKG，并扩展现有 `packages/opencode/test/config/wellknown-offline.test.ts`；不得重新实现已存在的 warn + skip 离线降级。

**Evidence:** `.scratch/batch-b/evidence.md#o1--remote-config-last-known-good`
**Branch:** `feat/config-lkg`
**Blocked by:** 无（06 已关闭；OpenSpec `remote-config-lkg` 为 apply-ready）
**Status:** ready-for-agent

- [x] 06 的 OpenSpec requirements/scenarios 已写入下方“规格入口”；实施以 tracked 镜像为稳定入口，以 local-only change 为 OpenSpec 原件
- [ ] 在线成功后产生可复用 LKG，随后 transport/body 失败按规格回退
- [ ] auth/HTML login/decode 失败仍保持硬失败
- [ ] 损坏缓存不崩溃、不覆盖错误类别，且日志不含凭据
- [ ] 在 `packages/opencode` 运行目标测试与 `bun typecheck`

## 规格入口

- [只持久化完整验证成功的原始远端响应](../config-lkg-spec.md#requirement-只持久化完整验证成功的原始远端响应)：[在线写入→离线复用](../config-lkg-spec.md#scenario-在线成功后写入并可离线复用)、[Environment 秘密不固化](../config-lkg-spec.md#scenario-environment-秘密不被固化)、[验证失败不写入](../config-lkg-spec.md#scenario-下游验证失败不产生新-lkg)
- [缓存身份与诊断不得泄露凭据](../config-lkg-spec.md#requirement-缓存身份与诊断不得泄露凭据)：[规范化 URL 稳定摘要](../config-lkg-spec.md#scenario-等价-url-使用同一稳定文件名)、[key/log 无凭据正文](../config-lkg-spec.md#scenario-凭据与正文不出现在-key-或日志)
- [LKG 更新必须原子且用户私有](../config-lkg-spec.md#requirement-lkg-更新必须原子且用户私有)：[同目录 rename + `0600`](../config-lkg-spec.md#scenario-同目录原子替换并设置文件模式)、[失败更新保留旧 LKG](../config-lkg-spec.md#scenario-rename-前写入失败保留旧-lkg)
- [只有允许降级的在线失败可以回退](../config-lkg-spec.md#requirement-只有允许降级的在线失败可以回退)：[transport/body 回退](../config-lkg-spec.md#scenario-transport-或非认证不可用状态回退)、[401/403 不回退](../config-lkg-spec.md#scenario-401-或-403-不回退)、[HTML 不回退](../config-lkg-spec.md#scenario-html-登录页不回退)、[decode 不回退](../config-lkg-spec.md#scenario-schema-decode-错误不回退)
- [不可用缓存保留原 warn + skip](../config-lkg-spec.md#requirement-不可用缓存保留原-warn--skip-语义)与[LKG 不因年龄自动过期](../config-lkg-spec.md#requirement-lkg-不因年龄自动过期)：[第一/第二跳损坏缓存边界](../config-lkg-spec.md#scenario-第一跳损坏或空缓存告警后跳过来源)、[长期离线继续使用](../config-lkg-spec.md#scenario-很旧的-lkg-仍支持长期离线)

## 实现边界

- **生产文件：** 仅修改 `packages/opencode/src/config/config.ts`，新增 `packages/opencode/src/config/remote-lkg.ts`
- **测试文件：** 扩展 `packages/opencode/test/config/wellknown-offline.test.ts`，新增 `packages/opencode/test/config/remote-lkg.test.ts`
- **禁止扩张：** 不修改 `packages/core`、HTTP routes、SDK/生成物、依赖或配置 schema；不重写当前第一跳 skip / 第二跳空 fetched-config 的 warn + skip 结果
- **方法：** 严格按镜像末尾 `tasks.md` 红-绿顺序实施；rename 失败只允许最窄文件系统故障注入，其余路径使用真实实现

## 可执行验收

1. `cd packages/opencode && bun test test/config/remote-lkg.test.ts test/config/wellknown-offline.test.ts`
2. `cd packages/opencode && bun typecheck`
3. 核对目标测试覆盖在线→离线、失败写入后旧 LKG、401/403/HTML/decode 硬失败、损坏/空缓存、key/log 无凭据、永久 LKG、`0600` 与同目录原子 rename
4. 核对实现 diff 只包含上述四个主要文件；任何最小 fixture 例外必须在提交说明中单列
