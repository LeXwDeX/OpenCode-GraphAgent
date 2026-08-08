# remote-config-lkg — OpenSpec apply-ready 镜像

- **基线：** `dev@4675435d94d462d2f9317d6688ddab2f0105c746`
- **change：** `remote-config-lkg`
- **local-only 原件：** `openspec/changes/remote-config-lkg/`
- **状态：** `4/4 artifacts complete`，apply-ready
- **校验：** `openspec validate --changes` → `1 passed, 0 failed`
- **严格校验：** `openspec validate remote-config-lkg --type change --strict --no-interactive` → `valid`
- **实施入口：** 按末尾 `tasks.md` 由票 07 以 TDD 执行；本镜像不包含生产代码。

以下四段在提交前按字节与 local-only 原件逐段核对。

<!-- BEGIN artifact: proposal.md -->
## Why

remote config 在 transport 或 body 读取失败时会告警并跳过来源；长期离线时，这会让最近一次已验证的在线配置不可用。需要一个持久化 last-known-good（LKG），同时严格避免缓存或日志泄露认证材料，并且不掩盖认证与 schema 错误。

## What Changes

- 为每个规范化 remote URL 保存最近一次完整通过解析与 schema 验证的远端响应；缓存保留 Environment 替换前的响应内容，不保存请求 header、token 或替换后的秘密。
- 仅在既有可降级错误类别上读取 LKG；401/403、HTML 登录/认证响应和 schema decode 错误继续硬失败。
- 使用同目录临时文件、原子 rename 和最终 `0600` 文件模式更新 LKG；写入失败不影响在线读取，也不破坏旧 LKG。
- 损坏或空 LKG 告警后按既有 warn + skip 行为继续；日志不包含缓存正文或凭据。
- LKG 不因年龄自动过期；记录 `writtenAt`，年龄只用于安全诊断，下一次合法在线成功原子覆盖旧值。
- 用目标测试锁定在线写入后离线回退、失败写入保留旧值、硬失败边界、损坏缓存、安全键与日志以及原子文件语义。

## Capabilities

### New Capabilities

- `remote-config-lkg`: 定义 remote config 已验证响应的持久化、回退边界、隐私约束、耐久写入和诊断行为。

### Modified Capabilities

无。

## Impact

- 主要影响 `packages/opencode/src/config/config.ts`、一个位于 `packages/opencode/src/config/` 的 LKG 持久化模块，以及 `packages/opencode/test/config/wellknown-offline.test.ts` 的集成场景。
- 在 OpenCode 的 XDG cache 根下新增用户私有的 remote-config LKG 文件；不改变 HTTP API、SDK、配置 schema 或依赖。
- 没有 breaking change；没有可配置 TTL，也不重写当前无可用来源时的 warn + skip 降级。
<!-- END artifact: proposal.md -->

<!-- BEGIN artifact: design.md -->
## Context

`Config.layer` 目前按以下顺序加载一个 well-known 认证来源：请求 `/.well-known/opencode`，解析并 decode `ConfigV1.WellKnown`，对 `remote_config.url` 与请求 headers 做 Environment 替换，可选请求第二跳 JSON，把内嵌与第二跳配置合并，最后由 `loadConfig` 执行 Environment 替换、JSONC 解析和 `ConfigV1.Info` schema 验证。transport、非认证 HTTP 不可用和 body 读取失败当前会 warn + skip；HTML 登录响应与 decode 失败会中止该配置加载。

LKG 必须接在这条流程上，而不能缓存最终的 `Info`。最终 `Info` 已经包含 Environment 替换结果，可能固化 token 或文件引用中的秘密。缓存还必须区分“在线 body 不是 JSON”与“JSON 可解析但不符合 schema”：前者属于允许降级的 body 失败，后者属于必须暴露的配置错误。

## Goals / Non-Goals

**Goals:**

- 在长期离线或远端暂时不可用时，复用同一 remote URL 最近一次完整验证成功的原始响应 body。
- 保持认证、HTML 登录和 schema 错误为硬失败，保证 LKG 不掩盖需要用户处理的问题。
- 让缓存更新具备用户私有权限和单文件原子替换语义；任何写入失败都不改变在线成功结果或旧 LKG。
- 保持没有可用 LKG 时现有 warn + skip 的结果与合并边界。

**Non-Goals:**

- 不增加 TTL 配置、后台刷新、跨设备同步、缓存清理命令或多版本迁移框架。
- 不缓存请求 header、认证 token、Environment 替换后的正文、最终合并后的 `Info` 或 HTTP API 数据。
- 不改变 remote config 的优先级、插件解析、普通本地配置加载、HTTP API 或 SDK。
- 不借本变更重写现有 warn + skip 流程；只在允许降级的失败点插入 LKG 读取。

## Decisions

### 1. 每个 HTTP remote URL 保存一个原始响应 LKG

well-known 第一跳与可选 remote-config 第二跳各自以其请求 URL 标识缓存记录。记录格式固定为版本化 JSON envelope：

```json
{
  "version": 1,
  "writtenAt": "2026-08-09T00:00:00.000Z",
  "body": "{...the exact response text...}"
}
```

`body` 是 Environment 替换前的响应文本。envelope 不保存响应 headers/status，也不保存请求 URL、请求 headers、认证 token、Environment map 或 decode 后对象。读取 LKG 后，body 必须重新经过与在线 body 相同的 JSON 解析、请求级 schema decode、remote-config 对象检查、Environment 替换和最终 `ConfigV1.Info` 验证。

在线 body 先进入暂存结果，只有该 well-known 来源的完整下游流程通过解析与 schema 验证后才允许写入本次在线取得的记录。任一在线 auth、HTML、JSON shape、对象检查、Environment 替换或最终 `ConfigV1.Info` 失败时，不写本次来源暂存的任何 LKG。选择延迟提交而不是在 `fetchRemoteJson` decode 后立即写，是为了避免把“JSON 合法但最终配置无效”的响应提升为 LKG。

未选择缓存最终 `Info`，因为它已经过 Environment 替换；也未选择缓存 request/response headers，因为它们不是离线重放配置所需的数据，并可能携带凭据。

### 2. cache key 只有规范化 URL 的稳定摘要

URL 用 WHATWG `URL` 规范化：清除不会随 HTTP 请求发送的 fragment，依赖 URL 实现统一 scheme/host 大小写、默认端口与转义形式，并保留会改变资源身份的 path 与 query。缓存文件名是规范化 URL UTF-8 字节的 SHA-256 小写十六进制摘要加 `.json`；目录固定为 `Global.Path.cache/remote-config-lkg/`。

文件名和 envelope 都不拼接原始 URL、认证 header、token、Environment 变量值或配置正文。摘要是 key 中唯一由 URL 派生的值；headers、token、Environment map 与 body 不参与额外的 key 组成。remote-config 日志使用稳定摘要和 `well-known`/`remote-config` 角色标识，不记录请求 headers、token、Environment 值、缓存 body 或响应 body；错误原因先归类，不直接序列化可能回显请求的底层错误对象。

未选择可读 URL 文件名，因为 query/userinfo 可能携带凭据；未选择 header/token 分区，因为它会把认证材料引入持久身份并违反本票边界。

### 3. 明确在线失败分类，再决定是否读取 LKG

`fetchRemoteJson` 将在线结果表达为成功、允许降级失败或硬失败，而不是用一个捕获所有错误的分支：

- 允许降级并尝试 LKG：DNS/连接/timeout 等 transport 错误；除 401/403 外的现有不可用 HTTP 状态；body stream 读取失败；内容不是 HTML 登录页但 JSON 语法不可解析。
- 直接硬失败且不得读取 LKG：HTTP 401/403；content-type 或 body 特征识别出的 HTML/login/auth 响应；JSON 可解析但请求级 schema decode 失败；第二跳结果不是对象；Environment 替换、JSONC 解析或最终 `ConfigV1.Info` schema decode 失败。

在线 JSON 语法解析与 schema decode 必须分成两个可观察步骤，才能保持上述边界。401/403 在进入通用非 2xx 降级分支前转换为现有 `RemoteAuthError` 语义。已有 LKG 也不能改变硬失败结果，且硬失败不能覆盖旧 LKG。

第一跳允许降级失败且没有可用 LKG时，继续跳过整个 well-known 来源。第二跳同类失败且没有可用 LKG时，继续返回空的 fetched config，使 well-known 内嵌 config 按现状合并。这个分支只复用原行为，不重新定义 warn + skip。

### 4. 损坏、空或缺失缓存不成为新的硬错误

仅在在线失败属于允许降级类别时读取 LKG。文件缺失表示没有 LKG，保留原在线失败告警并执行原 skip；空文件、JSON envelope 损坏、版本不支持、`writtenAt` 无效、空 body 或缓存 body 无法重新解析/decode 则额外记录不含正文与凭据的 warning，并把缓存视为不可用，随后执行同一 skip 分支。缓存自身的 schema 错误属于缓存损坏，不提升为在线 schema 硬失败。

未选择让损坏缓存中止启动，因为 LKG 是可丢弃的恢复材料，不能比当前无缓存流程更脆弱。

### 5. 同目录临时文件保证旧值不被失败更新破坏

实现放在新的 `packages/opencode/src/config/remote-lkg.ts` 自包含模块，公开一个窄的读取/写入接口给 `config.ts`。写入顺序为：确保专用目录存在；在目标同目录创建唯一临时文件并以 `0600` 写完整 envelope；关闭文件；原子 rename 到摘要目标；确认最终目标模式为 `0600`。成功 rename 前的任意失败只做安全 warning 和临时文件 best-effort 清理，旧目标保持不变。因为临时文件从创建起就是 `0600`，rename 后不会出现更宽权限窗口。

缓存写入是在线成功路径的 best-effort side effect。任一记录写失败只保留对应 URL 的旧文件并继续返回已验证在线配置；多条暂存记录独立提交，失败不会回滚配置加载。并发更新采用“最后一个完整 rename 获胜”，每个可见文件始终是完整 envelope，不增加锁服务。

未选择直接 truncate 目标文件，因为进程崩溃或磁盘错误会破坏旧 LKG；未选择跨目录临时文件，因为 rename 可能失去原子性。

### 6. LKG 永不过期，年龄只用于诊断

读取逻辑不以 `writtenAt` 或文件 mtime 拒绝 LKG。回退成功时可以记录 `writtenAt` 或计算后的非敏感年龄诊断，但年龄不改变控制流。下一次合法在线成功按上述原子写流程覆盖同 URL 的记录。

未选择固定或可配置 TTL：LKG 的目标是支持长期离线，自动过期会在最需要它时恢复到 warn + skip，并引入本票不需要的策略面。

### 7. TDD 边界

07 先扩展 `packages/opencode/test/config/wellknown-offline.test.ts`，用真实 `Config.layer` 锁定两跳在线写入后离线回退、预置 LKG 下的 auth/decode 硬失败、损坏/空缓存和日志无凭据。持久化细节放在 `packages/opencode/test/config/remote-lkg.test.ts`，用隔离 cache 根验证稳定摘要文件名、Environment 替换前 body、同目录 rename、写失败保留旧值和 POSIX `0600`。测试可为 rename 失败提供最窄的文件系统故障注入点，其余路径使用真实文件系统。

生产改动限定为 `packages/opencode/src/config/config.ts` 与新的 `packages/opencode/src/config/remote-lkg.ts`；不改 `packages/core`、schema、路由或生成物。

## Risks / Trade-offs

- [永不过期的 LKG 可能很旧] → 每次回退记录安全的 `writtenAt`/年龄诊断，并由下一次合法在线成功覆盖；不静默声称缓存新鲜。
- [只按 URL 分区会让同一用户下不同认证上下文共享该 URL 的 LKG] → 文件保持用户私有 `0600`，不把凭据加入 key；这是安全 key 约束与认证维度隔离之间的明确取舍。
- [磁盘写入、rename 或 chmod 失败] → 在线配置仍成功，旧 LKG 在 rename 前保持完整，日志只包含摘要与分类。
- [Windows 不提供等价的 POSIX mode 语义] → 创建与替换仍请求 `0600`；POSIX 测试断言精确 mode，Windows 保留原子替换与不扩宽应用请求的行为。
- [缓存 body 本身包含用户配置] → 只写入专用 cache 目录的 `0600` 文件，绝不写入 key 或日志，也不保存经过 Environment 替换的版本。

## Migration Plan

无需迁移：首次合法在线成功按需创建 version 1 文件；没有文件时行为与当前版本相同。回滚代码后这些 cache 文件无人读取，可安全保留；未来不兼容版本按损坏/不支持缓存的 warn + skip 语义处理。

## Open Questions

无。本票明确采用永不过期策略，不增加可配置 TTL 或后续扩展点。
<!-- END artifact: design.md -->

<!-- BEGIN artifact: specs/remote-config-lkg/spec.md -->
## ADDED Requirements

### Requirement: 只持久化完整验证成功的原始远端响应
系统 MUST 以版本、`writtenAt` 和原始响应 body 组成 LKG；MUST 在对应 well-known 来源的请求级解析、schema decode、第二跳对象检查、Environment 替换和最终 `ConfigV1.Info` schema 验证全部成功后，才持久化本次在线取得的响应。系统 MUST 保存 Environment 替换前的 body，且 MUST NOT 把请求 headers、认证 token、Environment map、替换后的正文或最终合并 `Info` 作为缓存字段。

#### Scenario: 在线成功后写入并可离线复用
- **WHEN** well-known 与第二跳 remote-config 在线响应均成功，完整配置通过最终 schema 验证，随后同一 URL 的 transport 请求失败
- **THEN** 系统写入各 URL 的原始响应 LKG，并在后续离线加载中重新验证和应用 LKG，得到与上一次合法在线读取相同的配置语义

#### Scenario: Environment 秘密不被固化
- **WHEN** 原始远端 body 包含 Environment 占位符，在线加载用当前 Environment 值完成替换并通过验证
- **THEN** LKG body 保留占位符形式，缓存 envelope 不包含替换后的 Environment 值、请求 header 或 token，回退时使用当次 Environment 重新执行替换

#### Scenario: 下游验证失败不产生新 LKG
- **WHEN** 在线 body 可解析，但第二跳不是对象、Environment 替换失败或最终 `ConfigV1.Info` schema decode 失败
- **THEN** 系统硬失败，MUST NOT 写入本次暂存响应，也 MUST NOT 覆盖已有 LKG

### Requirement: 缓存身份与诊断不得泄露凭据
系统 MUST 用规范化 remote URL 的 SHA-256 小写十六进制摘要作为唯一文件标识。规范化 MUST 清除 fragment，并统一 WHATWG URL 定义的 scheme/host 大小写、默认端口与转义形式，同时保留改变资源身份的 path 与 query。key、文件名和日志 MUST NOT 拼接原始 URL、认证 headers、token、Environment 变量值、缓存正文或配置正文；remote-config 诊断 MUST 只使用摘要、端点角色、失败分类和非敏感年龄信息。

#### Scenario: 等价 URL 使用同一稳定文件名
- **WHEN** 两个 remote URL 仅在 host 大小写、默认 HTTPS 端口或 fragment 上不同
- **THEN** 系统规范化后生成相同的 64 位十六进制摘要文件名

#### Scenario: 凭据与正文不出现在 key 或日志
- **WHEN** remote config 请求包含认证 header、token、Environment 替换值和可识别的配置正文标记，并发生在线成功、缓存写入、离线回退及缓存错误诊断
- **THEN** 缓存文件名、key 和捕获到的日志均不包含这些 header、token、Environment 值或正文标记，缓存 envelope 也不包含请求认证元数据

### Requirement: LKG 更新必须原子且用户私有
系统 MUST 在目标文件同目录创建唯一临时文件，以 `0600` 写入完整 envelope，关闭后通过原子 rename 替换目标，并保证最终文件模式为 `0600`。缓存写入 MUST 是在线成功路径的 best-effort side effect；写入失败 MUST NOT 使已验证在线配置失败，也 MUST NOT 修改或删除旧 LKG。

#### Scenario: 同目录原子替换并设置文件模式
- **WHEN** 系统首次写入或覆盖一个 LKG
- **THEN** 完整内容先写入目标同目录的临时文件，再由 rename 发布，最终目标是完整 envelope 且权限模式为 `0600`

#### Scenario: rename 前写入失败保留旧 LKG
- **WHEN** 已存在可用旧 LKG，而新在线响应验证成功但临时写入、关闭或 rename 失败
- **THEN** 系统记录不含正文和凭据的 warning，仍返回新在线配置，并保留旧 LKG 原封不动供后续允许降级的失败使用

#### Scenario: 并发写入不暴露部分文件
- **WHEN** 同一 URL 的两个合法在线加载并发更新 LKG
- **THEN** 最终读者只能观察到某一个完整 envelope，不能观察到截断或混合内容

### Requirement: 只有允许降级的在线失败可以回退
系统 MUST 先按现有 remote-config 错误语义分类在线失败。transport 错误、除 401/403 外的非认证不可用 HTTP 状态、body stream 读取失败以及非 HTML 的 JSON 语法不可解析 body MUST 尝试读取 LKG。HTTP 401/403、HTML/login/auth 响应、JSON 可解析后的请求级 schema decode 错误、第二跳非对象、Environment 替换错误和最终配置 schema decode 错误 MUST 硬失败，且 MUST NOT 读取 LKG 掩盖错误。

#### Scenario: transport 或非认证不可用状态回退
- **WHEN** 已有可用 LKG，在线请求发生 DNS、连接、timeout 或除 401/403 外的既有不可用 HTTP 状态
- **THEN** 系统告警该在线失败，重新验证 LKG，并用其继续 remote config 加载

#### Scenario: body 读取或 JSON 语法失败回退
- **WHEN** 已有可用 LKG，在线 response body stream 读取失败，或 body 不是 HTML/login 响应但不是可解析 JSON
- **THEN** 系统把失败归入允许降级 body 类别并使用 LKG

#### Scenario: 401 或 403 不回退
- **WHEN** 已有可用 LKG，但在线 remote endpoint 返回 401 或 403
- **THEN** 系统保持认证硬失败语义，不读取 LKG，也不覆盖旧 LKG

#### Scenario: HTML 登录页不回退
- **WHEN** 已有可用 LKG，但在线响应由 content-type 或 body 特征识别为 HTML/login/auth 页面
- **THEN** 系统产生现有 `RemoteAuthError` 语义，不读取 LKG，也不覆盖旧 LKG

#### Scenario: schema decode 错误不回退
- **WHEN** 已有可用 LKG，但在线 body 是合法 JSON，随后在 well-known schema、第二跳对象检查或最终 `ConfigV1.Info` schema decode 中失败
- **THEN** 系统暴露硬失败，不读取 LKG，也不覆盖旧 LKG

### Requirement: 不可用缓存保留原 warn + skip 语义
系统 MUST 把缺失 LKG 视为没有恢复材料；MUST 把空文件、损坏 envelope、不支持版本、无效 `writtenAt`、空 body 或无法重新解析/decode 的缓存视为不可用。损坏或空缓存 MUST 产生不含正文与凭据的 warning，随后 MUST 执行原有允许降级分支，而不是崩溃或改变在线错误类别。

#### Scenario: 第一跳损坏或空缓存告警后跳过来源
- **WHEN** well-known 在线失败允许降级，但对应 LKG 为空或损坏
- **THEN** 系统告警缓存不可用并跳过整个 well-known 来源，本地配置继续按现有行为加载

#### Scenario: 第二跳损坏或空缓存保留内嵌配置
- **WHEN** 第二跳 remote-config 在线失败允许降级，但对应 LKG 为空或损坏
- **THEN** 系统告警缓存不可用并按现有空 fetched-config 分支继续，well-known 内嵌配置仍可合并

#### Scenario: 缓存告警不回显缓存内容
- **WHEN** 损坏缓存包含可识别的凭据或配置正文标记
- **THEN** warning 只包含安全摘要、端点角色和损坏分类，不包含文件正文、底层解析输入或凭据标记

### Requirement: LKG 不因年龄自动过期
系统 MUST 保存合法 RFC 3339 `writtenAt`，但 MUST NOT 以 `writtenAt`、文件 mtime 或任何固定/可配置 TTL 拒绝 LKG。年龄 MUST 只用于安全诊断；下一次同 URL 的合法在线成功 MUST 通过原子更新覆盖旧记录。系统 MUST NOT 为本能力增加可配置 TTL 扩展点。

#### Scenario: 很旧的 LKG 仍支持长期离线
- **WHEN** 在线失败允许降级且可用 LKG 的 `writtenAt` 已经过任意长时间
- **THEN** 系统仍重新验证并使用该 LKG，同时可记录不含凭据的年龄诊断，不因年龄执行 warn + skip

#### Scenario: 合法在线成功覆盖旧记录
- **WHEN** 使用旧 LKG 后，同一规范化 URL 再次获得并完整验证合法在线响应
- **THEN** 系统原子覆盖旧 LKG，更新 `writtenAt`，且不创建或读取 TTL 配置
<!-- END artifact: specs/remote-config-lkg/spec.md -->

<!-- BEGIN artifact: tasks.md -->
## 1. 红灯：锁定外部行为

- [x] 1.1 在 `packages/opencode/test/config/wellknown-offline.test.ts` 增加两跳在线成功写入、换实例后第一跳/第二跳 transport 与非认证 body 失败使用 LKG 的场景，并先运行目标文件确认新断言因 LKG 尚未实现而失败；对应[在线成功后写入并可离线复用](specs/remote-config-lkg/spec.md#scenario-在线成功后写入并可离线复用)与[允许降级回退](specs/remote-config-lkg/spec.md#scenario-transport-或非认证不可用状态回退)。
- [x] 1.2 在同一集成测试预置可用 LKG，再覆盖 401、403、HTML login、合法 JSON 的 well-known schema 错误、第二跳非对象和最终 `ConfigV1.Info` decode 错误；逐项断言硬失败、未使用/未覆盖 LKG，对应[401/403](specs/remote-config-lkg/spec.md#scenario-401-或-403-不回退)、[HTML](specs/remote-config-lkg/spec.md#scenario-html-登录页不回退)与[schema decode](specs/remote-config-lkg/spec.md#scenario-schema-decode-错误不回退)。
- [x] 1.3 在同一集成测试加入缺失、空、损坏和超旧缓存；断言第一跳保持 warn + skip、本地配置可用，第二跳保持内嵌 config 合并，超旧记录仍使用且只给安全年龄诊断；不得改写现有降级分支的结果。
- [x] 1.4 新建 `packages/opencode/test/config/remote-lkg.test.ts`，用隔离 cache 根和真实文件系统锁定 URL 规范化摘要、原始 Environment 占位符、同目录 rename、完整 envelope、POSIX `0600`、并发完整性，并用最窄 rename 故障注入锁定失败更新后旧 LKG 仍可读。
- [x] 1.5 在两份目标测试放置独特的 header/token/Environment/正文标记，断言文件名、key 和所有 remote-config/cache 日志不含标记，envelope 不含请求认证元数据；确认新增安全断言先红。

## 2. 绿灯：实现私有原子 LKG 模块

- [x] 2.1 新建 `packages/opencode/src/config/remote-lkg.ts` 并按 `src/config` 自导出规范提供窄接口：WHATWG URL 去 fragment、SHA-256 文件名、version 1 envelope decode，以及从 `Global.Path.cache/remote-config-lkg/` 读取原始 body；损坏、空和不支持版本返回可分类的不可用结果，不抛出正文。
- [x] 2.2 在该模块实现 best-effort 写入：目标同目录唯一临时文件以 `0600` 写完整 envelope，关闭后原子 rename，最终模式 `0600`；失败时安全告警、best-effort 清理临时文件且不触碰旧目标。
- [x] 2.3 保持 `writtenAt` 为合法 RFC 3339 诊断字段；读取不检查 TTL/mtime，不增加配置项、清理器、后台刷新或 TTL 扩展接口。

## 3. 绿灯：接入当前 remote config 流程

- [x] 3.1 仅在 `packages/opencode/src/config/config.ts` 调整 `fetchRemoteJson` 附近：把 JSON 语法解析与 schema decode 分开，并将结果分类为在线成功、允许降级失败和硬失败；401/403 与 HTML/login/auth 继续使用硬认证错误，合法 JSON 的 schema/object/final-config 错误继续硬失败。
- [x] 3.2 well-known 与第二跳在线响应只暂存 Environment 替换前 body；完整来源通过 `loadConfig` 最终 schema 验证后才调用 LKG 写入。仅允许降级失败读取并重验 LKG；无可用 LKG 时分别复用现有“第一跳 skip 来源”和“第二跳空 fetched config”分支。
- [x] 3.3 把触及的 remote-config/cache 诊断限定为摘要、端点角色、失败分类和非敏感年龄；不得序列化原始 URL、底层可能回显请求的错误对象、headers、token、Environment 值或 body。

## 4. 验收与范围门禁

- [x] 4.1 从 `packages/opencode` 运行 `bun test test/config/remote-lkg.test.ts test/config/wellknown-offline.test.ts`，确认在线→离线、旧 LKG、auth/decode、损坏/空缓存、永不过期、key/log 安全及原子/权限场景全绿。
- [x] 4.2 从 `packages/opencode` 运行 `bun typecheck`；不得用 `bun run build` 代替类型门禁。
- [x] 4.3 检查实现 diff 只涉及 `packages/opencode/src/config/config.ts`、`packages/opencode/src/config/remote-lkg.ts` 和上述两份 config 测试；如确需测试 fixture 的最小改动须在提交说明中列出，`packages/core`、HTTP routes、SDK 生成物、依赖与既有 warn + skip 语义保持零改动。
<!-- END artifact: tasks.md -->
