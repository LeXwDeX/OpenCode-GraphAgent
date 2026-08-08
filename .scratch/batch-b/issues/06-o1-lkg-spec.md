# 06 — O1：remote config LKG 小规格

**What to build:** 只为 remote config 的持久化 last-known-good 增量产出一份小规格；不修改生产代码。OpenSpec 原件在 local-only `/openspec/` 生成并校验，同时把可执行镜像写入 `.scratch/batch-b/config-lkg-spec.md`，再更新 07 的具体文件、验收与分支边界。

**Evidence:** `.scratch/batch-b/evidence.md#o1--remote-config-last-known-good`
**Branch:** `docs/config-lkg-spec`
**Blocked by:** 05（批次串行）
**Status:** blocked

- [ ] 定义缓存内容与写入时机：只缓存已验证结构，明确环境替换前后边界
- [ ] 定义稳定 cache key、原子写、文件权限；key/内容不得泄露 header/token
- [ ] 仅 transport/body 失败允许回退；auth/HTML login/schema decode 不得被 LKG 掩盖
- [ ] 定义损坏缓存、空缓存与 TTL/不过期策略
- [ ] `openspec validate --changes` 通过，已追踪镜像与原件一致，07 获得可执行验收标准
