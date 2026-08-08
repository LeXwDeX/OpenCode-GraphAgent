# 06 — O1：remote config LKG 小规格

**What to build:** 只为 remote config 的持久化 last-known-good 增量产出一份小规格；不修改生产代码。OpenSpec 原件在 local-only `/openspec/` 生成并校验，同时把可执行镜像写入 `.scratch/batch-b/config-lkg-spec.md`，再更新 07 的具体文件、验收与分支边界。

**Evidence:** `.scratch/batch-b/evidence.md#o1--remote-config-last-known-good`
**Branch:** `docs/config-lkg-spec`
**Blocked by:** 05（批次串行）
**Status:** closed

- [x] 定义缓存内容与写入时机：只缓存完整下游验证成功的原始响应 body，持久化发生在 Environment 替换前，envelope 不保存请求 header/token
- [x] 定义稳定 cache key、原子写、文件权限：规范化 URL 的 SHA-256 文件名、同目录临时文件 + rename、最终 `0600`，key/日志不含凭据或正文
- [x] 定义回退矩阵：transport、非 401/403 的不可用状态、body read 与非 HTML JSON 语法失败可回退；401/403、HTML/login/auth、schema/object/final decode 硬失败
- [x] 定义损坏/空缓存 warn + skip 与 LKG 永不过期策略；`writtenAt`/年龄只做安全诊断，下一次合法在线成功原子覆盖
- [x] OpenSpec 4/4 apply-ready，原件与镜像逐 artifact 字节一致，07 已获得 TDD 文件边界与可执行验收

## 交付记录

- **Change 原件（local-only）：** `openspec/changes/remote-config-lkg/`（`proposal.md`、`design.md`、`specs/remote-config-lkg/spec.md`、`tasks.md`）
- **Tracked 镜像：** `.scratch/batch-b/config-lkg-spec.md`
- **校验 1：** `openspec validate --changes` → `✓ change/remote-config-lkg`，`1 passed, 0 failed`
- **校验 2：** `openspec validate remote-config-lkg --type change --strict --no-interactive` → `Change 'remote-config-lkg' is valid`
- **基线/范围：** `dev@4675435d94d462d2f9317d6688ddab2f0105c746`；本票没有修改 `packages/**` 或生产代码
