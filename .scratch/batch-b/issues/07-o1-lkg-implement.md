# 07 — O1：实现 remote config last-known-good 缓存

**What to build:** 按 06 产出的已校验 OpenSpec 实现 LKG，并扩展现有 `packages/opencode/test/config/wellknown-offline.test.ts`；不得重新实现已存在的 warn + skip 离线降级。

**Evidence:** `.scratch/batch-b/evidence.md#o1--remote-config-last-known-good`
**Branch:** `feat/config-lkg`
**Blocked by:** 06 规格通过校验并补齐本票验收
**Status:** blocked

- [ ] 本票开工前把 06 的 OpenSpec requirement/scenarios 链接写入此处
- [ ] 在线成功后产生可复用 LKG，随后 transport/body 失败按规格回退
- [ ] auth/HTML login/decode 失败仍保持硬失败
- [ ] 损坏缓存不崩溃、不覆盖错误类别，且日志不含凭据
- [ ] 在 `packages/opencode` 运行目标测试与 `bun typecheck`
