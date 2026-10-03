# Dependency review — 2026-10-03

Reviewed all 38 JavaScript package manifests and all four Bun lockfiles. 169 package names change their selected version, 6 additional names become exact pins without a version change. All changed versions whose publish timestamps are available in the official npm registry satisfy the repository minimum release age of 259200 seconds. Existing prerelease/commit pins and local patches are retained for compatibility; peer dependency ranges remain compatibility declarations.

Bun remains `1.4.2`; the separate toolchain review pins Node `24.21.0` and Go `1.27.1`. All root workspaces share the catalog and main `bun.lock`. GitHub is now a root workspace; its stale lock and the already-workspace console resource stale lock are removed. VS Code remains independent with a refreshed exact-pin manifest and lock. VS Code uses Node 20 types to match its extension host, and VS Code 1.94 types to match its declared minimum supported editor; its build runs on the same Node/Bun toolchain.

Compatibility decisions:

| Group                                                                         | Selected version / decision                           | Evidence and reason                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Effect v4 family                                                              | `4.0.0-beta.83` retained together                     | [Official registry](https://registry.npmjs.org/effect): GA `4.0.0` published Oct 1, younger than the three-day policy; beta-to-GA migration affects unstable APIs.                                                                                                                         |
| Drizzle ORM / Kit                                                             | `1.0.0-rc.2` retained together                        | Vendored `packages/effect-drizzle-sqlite` copies RC2 internals and explicitly requires RC2 comparisons; later RC migration needs dedicated adapter/persistence tests.                                                                                                                      |
| OpenTUI family                                                                | `0.5.12` retained together                            | [Registry](https://registry.npmjs.org/@opentui%2Fcore): 0.5.13 and 0.5.14 were published Sep 30 and are younger than three days.                                                                                                                                                           |
| Native Node PTY family                                                        | `1.2.0-beta.12` retained together                     | Wrapper and platform binaries must match; independent numeric selection of platform stable artifacts would mismatch the wrapper.                                                                                                                                                           |
| Patched Google / xAI / TanStack / Pierre Trees / npm / GCP / photon / bun-pty | Existing exact patched versions retained              | Fresh resolution is constrained with exact overrides so dependency refresh cannot bypass local patches. No patch file is removed.                                                                                                                                                          |
| fff-bun                                                                       | `0.9.4` → `0.9.6`, patch carried forward              | The previous 0.9.3 patch was inactive against 0.9.4. Updated patch supports literal embedded native assets, retains development path resolution, and accepts Bun 1.4 bigint pointer results without runtime narrowing. Development and compiled native loading probes pass on macOS arm64. |
| Pierre diffs                                                                  | `1.2.10` retained                                     | Attempted 1.5.1 requires a new Caret generic at 17 consumer sites. Reverted dependency change instead of silently changing renderer contracts.                                                                                                                                             |
| Clack                                                                         | `1.0.0-alpha.1` retained                              | Attempted 1.8.1 changes select cancellation to symbol unions and cancel/log argument contracts, producing actual CLI type regressions.                                                                                                                                                     |
| Stripe server SDK                                                             | `18.0.0` retained                                     | Attempted 18.5.0 changes the typed default API from `2025-03-31.basil` to `2025-08-27.basil`. Billing intentionally keeps its existing remote API behavior.                                                                                                                                |
| oxlint / tsgolint                                                             | `1.60.0` / `0.21.0` retained                          | 1.86.0 requires tsgolint >=7.0.2003; matched upgraded pair runs but produces 5828 warnings, exceeding existing cap 4850. Original pair passes at 4839 warnings, zero errors. No rule is disabled and cap is not raised.                                                                    |
| TypeScript                                                                    | `5.9.3`; native preview `7.0.0-dev.20260707.2`        | Workspaces and independent VS Code compiler versions are unified. TS 6/7 stable migration is deferred because existing TypeScript ESLint peer support is <6.1; native preview remains the existing tsgo checker and is tested separately.                                                  |
| ESLint (VS Code only)                                                         | `9.x` → `10.11.0`                                     | The entire 9.x branch is marked unsupported in the registry. Existing flat config and typescript-eslint 8.71 support 10.x; editor typecheck/lint/package checks pass. 10.12 is younger than three days.                                                                                    |
| Markdown                                                                      | Desktop 15.x → shared `17.0.6`                        | Desktop already uses the token-object renderer contract; shared version passes desktop typechecking.                                                                                                                                                                                       |
| React / React DOM                                                             | `18.3.1`                                              | Matching renderer versions resolve Pierre React peers; legacy JSX-email packages remain pending a dedicated package/API migration.                                                                                                                                                         |
| OpenAuth / Nitro / Solid Start / Sury / Git ghostty                           | Existing prerelease or immutable commit pins retained | Replacing these pins is a framework/API migration, not a patch-level update.                                                                                                                                                                                                               |

Lockfile review restored old tarball URLs only when package identity/version and integrity were unchanged. Real version changes, dependency metadata, new entries and removals are retained. Frozen installs succeed at the root, GitHub workspace, console resource workspace, and independent VS Code project.

Verification completed:

- Root and VS Code install with the private temporary cache and ignored install scripts. Frozen reinstallation passes, with no peer warnings after React DOM, Valibot and matching Electron builder peer declarations.
- Function regressions: 13 pass, 51 assertions; share wire contract, ownership, repository-scoped installation token, and Feishu authentication covered with local mocks.
- Web sanitizer: SSR fail-closed passes; real browser test remains skipped locally because the host sandbox prevents browser startup.
- VS Code: typecheck, lint (48 existing semicolon warnings, zero errors), and production bundling pass.
- Native fff-bun: development path resolution and loading pass; compiled executable embeds and loads the current macOS arm64 native binary. Other platform branches need release CI.
- Fresh root typecheck: all 31 tasks pass, including Web at zero errors and zero warnings. Final root lint passes at 4839 warnings and zero errors, within the unchanged cap 4850. Bun 1.4 declares mock.module as asynchronous; awaiting 27 test setup calls removed the additional warnings. The generated outputs did not cause the warning increase. Final all-package tests remain owned by the parent.

Selected-version changes (official npm publish times are UTC):

| Package                                                                                               | Before                      | After                  | Published              |
| ----------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------- | ---------------------- |
| [@actions/artifact](https://registry.npmjs.org/@actions%2Fartifact)                                   | `4.0.0`, `5.0.1`            | `5.0.3`                | 2026-01-27             |
| [@agentclientprotocol/sdk](https://registry.npmjs.org/@agentclientprotocol%2Fsdk)                     | `0.21.0`                    | `0.21.1`               | 2026-05-14             |
| [@ai-sdk/alibaba](https://registry.npmjs.org/@ai-sdk%2Falibaba)                                       | `1.0.57`                    | `1.0.61`               | 2026-09-28             |
| [@ai-sdk/amazon-bedrock](https://registry.npmjs.org/@ai-sdk%2Famazon-bedrock)                         | `4.0.180`                   | `4.0.186`              | 2026-09-28             |
| [@ai-sdk/anthropic](https://registry.npmjs.org/@ai-sdk%2Fanthropic)                                   | `3.0.120`                   | `3.0.125`              | 2026-09-28             |
| [@ai-sdk/azure](https://registry.npmjs.org/@ai-sdk%2Fazure)                                           | `3.0.123`                   | `3.0.128`              | 2026-09-28             |
| [@ai-sdk/cerebras](https://registry.npmjs.org/@ai-sdk%2Fcerebras)                                     | `2.0.82`                    | `2.0.86`               | 2026-09-28             |
| [@ai-sdk/cohere](https://registry.npmjs.org/@ai-sdk%2Fcohere)                                         | `3.0.62`                    | `3.0.66`               | 2026-09-28             |
| [@ai-sdk/deepinfra](https://registry.npmjs.org/@ai-sdk%2Fdeepinfra)                                   | `2.0.80`                    | `2.0.84`               | 2026-09-28             |
| [@ai-sdk/gateway](https://registry.npmjs.org/@ai-sdk%2Fgateway)                                       | `3.0.198`                   | `3.0.205`              | 2026-09-28             |
| [@ai-sdk/google-vertex](https://registry.npmjs.org/@ai-sdk%2Fgoogle-vertex)                           | `4.0.203`                   | `4.0.208`              | 2026-09-28             |
| [@ai-sdk/groq](https://registry.npmjs.org/@ai-sdk%2Fgroq)                                             | `3.0.67`                    | `3.0.71`               | 2026-09-28             |
| [@ai-sdk/mistral](https://registry.npmjs.org/@ai-sdk%2Fmistral)                                       | `3.0.65`                    | `3.0.69`               | 2026-09-28             |
| [@ai-sdk/openai](https://registry.npmjs.org/@ai-sdk%2Fopenai)                                         | `3.0.115`                   | `3.0.120`              | 2026-09-28             |
| [@ai-sdk/openai-compatible](https://registry.npmjs.org/@ai-sdk%2Fopenai-compatible)                   | `2.0.76`, `2.0.78`          | `2.0.80`               | 2026-09-28             |
| [@ai-sdk/perplexity](https://registry.npmjs.org/@ai-sdk%2Fperplexity)                                 | `3.0.61`                    | `3.1.1`                | 2026-09-28             |
| [@ai-sdk/provider](https://registry.npmjs.org/@ai-sdk%2Fprovider)                                     | `3.0.16`                    | `3.0.18`               | 2026-09-27             |
| [@ai-sdk/provider-utils](https://registry.npmjs.org/@ai-sdk%2Fprovider-utils)                         | `4.0.52`                    | `4.0.56`               | 2026-09-28             |
| [@ai-sdk/togetherai](https://registry.npmjs.org/@ai-sdk%2Ftogetherai)                                 | `2.0.82`                    | `2.0.86`               | 2026-09-28             |
| [@ai-sdk/vercel](https://registry.npmjs.org/@ai-sdk%2Fvercel)                                         | `2.0.78`                    | `2.0.82`               | 2026-09-28             |
| [@astrojs/check](https://registry.npmjs.org/@astrojs%2Fcheck)                                         | `0.9.6`                     | `0.9.10`               | 2026-07-27             |
| [@astrojs/cloudflare](https://registry.npmjs.org/@astrojs%2Fcloudflare)                               | `14.1.7`                    | `14.3.3`               | 2026-09-22             |
| [@astrojs/markdown-remark](https://registry.npmjs.org/@astrojs%2Fmarkdown-remark)                     | `7.2.4`                     | `7.3.1`                | 2026-09-08             |
| [@astrojs/solid-js](https://registry.npmjs.org/@astrojs%2Fsolid-js)                                   | `5.1.0`                     | `5.1.3`                | 2025-11-06             |
| [@astrojs/starlight](https://registry.npmjs.org/@astrojs%2Fstarlight)                                 | `0.41.7`                    | `0.41.11`              | 2026-09-01             |
| [@aws-sdk/client-athena](https://registry.npmjs.org/@aws-sdk%2Fclient-athena)                         | `3.933.0`                   | `3.1143.0`             | 2026-09-29             |
| [@aws-sdk/client-firehose](https://registry.npmjs.org/@aws-sdk%2Fclient-firehose)                     | `3.933.0`                   | `3.1143.0`             | 2026-09-29             |
| [@aws-sdk/client-s3](https://registry.npmjs.org/@aws-sdk%2Fclient-s3)                                 | `3.933.0`                   | `3.1143.0`             | 2026-09-29             |
| [@aws-sdk/client-sts](https://registry.npmjs.org/@aws-sdk%2Fclient-sts)                               | `3.782.0`                   | `3.1143.0`             | 2026-09-29             |
| [@aws-sdk/credential-providers](https://registry.npmjs.org/@aws-sdk%2Fcredential-providers)           | `3.1057.0`                  | `3.1143.0`             | 2026-09-29             |
| [@babel/core](https://registry.npmjs.org/@babel%2Fcore)                                               | `7.29.6`                    | `7.29.7`               | 2026-05-25             |
| [@cloudflare/vite-plugin](https://registry.npmjs.org/@cloudflare%2Fvite-plugin)                       | `1.15.2`                    | `1.62.2`               | 2026-09-29             |
| [@cloudflare/workers-types](https://registry.npmjs.org/@cloudflare%2Fworkers-types)                   | `4.20251008.0`              | `4.20260702.1`         | 2026-07-02             |
| [@ff-labs/fff-bun](https://registry.npmjs.org/@ff-labs%2Ffff-bun)                                     | `0.9.4`                     | `0.9.6`                | 2026-06-21             |
| [@fontsource/ibm-plex-mono](https://registry.npmjs.org/@fontsource%2Fibm-plex-mono)                   | `5.2.5`                     | `5.3.0`                | 2026-07-19             |
| [@happy-dom/global-registrator](https://registry.npmjs.org/@happy-dom%2Fglobal-registrator)           | `20.0.11`                   | `20.14.5`              | 2026-09-12             |
| [@hono/standard-validator](https://registry.npmjs.org/@hono%2Fstandard-validator)                     | `0.2.0`                     | `0.2.3`                | 2026-06-30             |
| [@hono/zod-validator](https://registry.npmjs.org/@hono%2Fzod-validator)                               | `0.4.2`                     | `0.4.3`                | 2025-02-15             |
| [@kobalte/core](https://registry.npmjs.org/@kobalte%2Fcore)                                           | `0.13.11`                   | `0.13.14`              | 2026-09-07             |
| [@modelcontextprotocol/client](https://registry.npmjs.org/@modelcontextprotocol%2Fclient)             | `2.0.0`                     | `2.2.0`                | 2026-09-28             |
| [@modelcontextprotocol/core](https://registry.npmjs.org/@modelcontextprotocol%2Fcore)                 | `2.0.0`                     | `2.2.0`                | 2026-09-28             |
| [@modelcontextprotocol/server](https://registry.npmjs.org/@modelcontextprotocol%2Fserver)             | `2.0.0`                     | `2.2.0`                | 2026-09-28             |
| [@octokit/auth-app](https://registry.npmjs.org/@octokit%2Fauth-app)                                   | `8.0.1`                     | `8.3.1`                | 2026-09-01             |
| [@octokit/graphql](https://registry.npmjs.org/@octokit%2Fgraphql)                                     | `9.0.1`, `9.0.2`            | `9.0.5`                | 2026-08-30             |
| [@octokit/rest](https://registry.npmjs.org/@octokit%2Frest)                                           | `22.0.0`                    | `22.0.1`               | 2025-10-31             |
| [@openrouter/ai-sdk-provider](https://registry.npmjs.org/@openrouter%2Fai-sdk-provider)               | `2.9.0`                     | `2.10.0`               | 2026-06-26             |
| [@opentelemetry/api](https://registry.npmjs.org/@opentelemetry%2Fapi)                                 | `1.9.0`                     | `1.9.1`                | 2026-03-25             |
| [@opentelemetry/context-async-hooks](https://registry.npmjs.org/@opentelemetry%2Fcontext-async-hooks) | `2.6.1`                     | `2.11.0`               | 2026-08-31             |
| [@opentelemetry/sdk-trace-base](https://registry.npmjs.org/@opentelemetry%2Fsdk-trace-base)           | `2.6.1`                     | `2.11.0`               | 2026-08-31             |
| [@opentelemetry/sdk-trace-node](https://registry.npmjs.org/@opentelemetry%2Fsdk-trace-node)           | `2.6.1`                     | `2.11.0`               | 2026-08-31             |
| [@parcel/watcher](https://registry.npmjs.org/@parcel%2Fwatcher)                                       | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-darwin-arm64](https://registry.npmjs.org/@parcel%2Fwatcher-darwin-arm64)             | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-darwin-x64](https://registry.npmjs.org/@parcel%2Fwatcher-darwin-x64)                 | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-linux-arm64-glibc](https://registry.npmjs.org/@parcel%2Fwatcher-linux-arm64-glibc)   | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-linux-arm64-musl](https://registry.npmjs.org/@parcel%2Fwatcher-linux-arm64-musl)     | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-linux-x64-glibc](https://registry.npmjs.org/@parcel%2Fwatcher-linux-x64-glibc)       | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-linux-x64-musl](https://registry.npmjs.org/@parcel%2Fwatcher-linux-x64-musl)         | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-win32-arm64](https://registry.npmjs.org/@parcel%2Fwatcher-win32-arm64)               | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@parcel/watcher-win32-x64](https://registry.npmjs.org/@parcel%2Fwatcher-win32-x64)                   | `2.5.1`                     | `2.6.0`                | 2026-07-20             |
| [@planetscale/database](https://registry.npmjs.org/@planetscale%2Fdatabase)                           | `1.19.0`                    | `1.20.2`               | 2026-09-23             |
| [@playwright/test](https://registry.npmjs.org/@playwright%2Ftest)                                     | `1.59.1`                    | `1.63.0`               | 2026-09-04             |
| [@sentry/solid](https://registry.npmjs.org/@sentry%2Fsolid)                                           | `10.36.0`                   | `10.75.3`              | 2026-09-23             |
| [@sentry/vite-plugin](https://registry.npmjs.org/@sentry%2Fvite-plugin)                               | `4.6.0`                     | `4.9.1`                | 2026-02-10             |
| [@shikijs/stream](https://registry.npmjs.org/@shikijs%2Fstream)                                       | `4.2.0`                     | `4.4.3`                | 2026-08-10             |
| [@shikijs/transformers](https://registry.npmjs.org/@shikijs%2Ftransformers)                           | `3.20.0`, `3.9.2`           | `3.23.0`               | 2026-02-25             |
| [@slack/bolt](https://registry.npmjs.org/@slack%2Fbolt)                                               | `^3.17.1`                   | `3.22.0`               | 2024-09-27             |
| [@smithy/eventstream-codec](https://registry.npmjs.org/@smithy%2Feventstream-codec)                   | `4.2.14`, `4.2.7`           | `4.5.2`                | 2026-08-15             |
| [@smithy/util-utf8](https://registry.npmjs.org/@smithy%2Futil-utf8)                                   | `4.2.0`, `4.2.2`            | `4.5.2`                | 2026-08-15             |
| [@solid-primitives/active-element](https://registry.npmjs.org/@solid-primitives%2Factive-element)     | `2.1.3`                     | `2.1.6`                | 2026-07-04             |
| [@solid-primitives/audio](https://registry.npmjs.org/@solid-primitives%2Faudio)                       | `1.4.2`                     | `1.4.5`                | 2026-07-04             |
| [@solid-primitives/bounds](https://registry.npmjs.org/@solid-primitives%2Fbounds)                     | `0.1.3`                     | `0.1.7`                | 2026-07-05             |
| [@solid-primitives/event-bus](https://registry.npmjs.org/@solid-primitives%2Fevent-bus)               | `1.1.2`                     | `1.1.4`                | 2026-07-04             |
| [@solid-primitives/event-listener](https://registry.npmjs.org/@solid-primitives%2Fevent-listener)     | `2.4.5`                     | `2.4.6`                | 2026-07-04             |
| [@solid-primitives/media](https://registry.npmjs.org/@solid-primitives%2Fmedia)                       | `2.3.3`                     | `2.3.6`                | 2026-07-04             |
| [@solid-primitives/resize-observer](https://registry.npmjs.org/@solid-primitives%2Fresize-observer)   | `2.1.3`, `2.1.5`            | `2.2.0`                | 2026-07-05             |
| [@solid-primitives/scheduled](https://registry.npmjs.org/@solid-primitives%2Fscheduled)               | `1.5.2`, `1.5.3`            | `1.5.3`                | 2026-02-21             |
| [@solid-primitives/scroll](https://registry.npmjs.org/@solid-primitives%2Fscroll)                     | `2.1.3`                     | `2.1.6`                | 2026-07-04             |
| [@solid-primitives/storage](https://registry.npmjs.org/@solid-primitives%2Fstorage)                   | `4.3.3`                     | `4.4.0`                | 2026-07-11             |
| [@solid-primitives/websocket](https://registry.npmjs.org/@solid-primitives%2Fwebsocket)               | `1.3.1`                     | `1.4.0`                | 2026-06-04             |
| [@standard-schema/spec](https://registry.npmjs.org/@standard-schema%2Fspec)                           | `1.0.0`                     | `1.1.0`                | 2025-12-15             |
| [@storybook/addon-a11y](https://registry.npmjs.org/@storybook%2Faddon-a11y)                           | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [@storybook/addon-docs](https://registry.npmjs.org/@storybook%2Faddon-docs)                           | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [@storybook/addon-links](https://registry.npmjs.org/@storybook%2Faddon-links)                         | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [@storybook/addon-onboarding](https://registry.npmjs.org/@storybook%2Faddon-onboarding)               | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [@storybook/addon-vitest](https://registry.npmjs.org/@storybook%2Faddon-vitest)                       | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [@stripe/stripe-js](https://registry.npmjs.org/@stripe%2Fstripe-js)                                   | `8.6.1`                     | `8.11.0`               | 2026-03-18             |
| [@tailwindcss/vite](https://registry.npmjs.org/@tailwindcss%2Fvite)                                   | `4.1.11`                    | `4.3.3`                | 2026-07-16             |
| [@tanstack/solid-query](https://registry.npmjs.org/@tanstack%2Fsolid-query)                           | `5.91.4`                    | `5.104.0`              | 2026-09-26             |
| [@tsconfig/bun](https://registry.npmjs.org/@tsconfig%2Fbun)                                           | `1.0.9`                     | `1.0.11`               | 2026-08-15             |
| [@tsconfig/node22](https://registry.npmjs.org/@tsconfig%2Fnode22)                                     | `22.0.2`                    | `22.0.6`               | 2026-08-15             |
| [@types/bun](https://registry.npmjs.org/@types%2Fbun)                                                 | `1.3.13`                    | `1.4.2`                | 2026-09-08             |
| [@types/d3-geo](https://registry.npmjs.org/@types%2Fd3-geo)                                           | `3.1.0`                     | `3.1.1`                | 2026-07-31             |
| [@types/escape-html](https://registry.npmjs.org/@types%2Fescape-html)                                 | `1.0.3`                     | `1.0.4`                | 2023-11-07             |
| [@types/katex](https://registry.npmjs.org/@types%2Fkatex)                                             | `0.16.7`                    | `0.16.8`               | 2026-01-10             |
| [@types/luxon](https://registry.npmjs.org/@types%2Fluxon)                                             | `3.7.1`                     | `3.7.6`                | 2026-09-29             |
| [@types/node](https://registry.npmjs.org/@types%2Fnode)                                               | `20.x`, `24.12.2`           | `20.19.43`, `24.19.0`  | 2026-06-10, 2026-09-25 |
| [@types/react](https://registry.npmjs.org/@types%2Freact)                                             | `18.0.25`                   | `18.3.31`              | 2026-06-05             |
| [@types/semver](https://registry.npmjs.org/@types%2Fsemver)                                           | `7.7.1`, `^7.5.8`           | `7.8.0`                | 2026-08-02             |
| [@types/turndown](https://registry.npmjs.org/@types%2Fturndown)                                       | `5.0.5`                     | `5.0.6`                | 2025-10-26             |
| [@types/ws](https://registry.npmjs.org/@types%2Fws)                                                   | `8.18.1`                    | `8.18.2`               | 2026-09-29             |
| [@types/yargs](https://registry.npmjs.org/@types%2Fyargs)                                             | `17.0.33`                   | `17.0.35`              | 2025-11-14             |
| [@typescript-eslint/eslint-plugin](https://registry.npmjs.org/@typescript-eslint%2Feslint-plugin)     | `^8.31.1`                   | `8.71.0`               | 2026-09-28             |
| [@typescript-eslint/parser](https://registry.npmjs.org/@typescript-eslint%2Fparser)                   | `^8.31.1`                   | `8.71.0`               | 2026-09-28             |
| [@typescript/native-preview](https://registry.npmjs.org/@typescript%2Fnative-preview)                 | `7.0.0-dev.20251207.1`      | `7.0.0-dev.20260707.2` | 2026-07-07             |
| [@upstash/redis](https://registry.npmjs.org/@upstash%2Fredis)                                         | `1.38.0`                    | `1.39.0`               | 2026-09-21             |
| [@valibot/to-json-schema](https://registry.npmjs.org/@valibot%2Fto-json-schema)                       | `1.6.0`                     | `1.8.0`                | 2026-09-11             |
| [@vscode/test-cli](https://registry.npmjs.org/@vscode%2Ftest-cli)                                     | `^0.0.11`                   | `0.0.15`               | 2026-06-22             |
| [@webgpu/types](https://registry.npmjs.org/@webgpu%2Ftypes)                                           | `0.1.54`                    | `0.1.74`               | 2026-09-19             |
| [@zip.js/zip.js](https://registry.npmjs.org/@zip.js%2Fzip.js)                                         | `2.7.62`                    | `2.18.2`               | 2026-09-24             |
| [ai](https://registry.npmjs.org/ai)                                                                   | `6.0.290`                   | `6.0.296`              | 2026-09-28             |
| [ai-gateway-provider](https://registry.npmjs.org/ai-gateway-provider)                                 | `3.1.2`                     | `3.2.0`                | 2026-06-29             |
| [astro](https://registry.npmjs.org/astro)                                                             | `7.1.0`                     | `7.3.5`                | 2026-09-24             |
| [bonjour-service](https://registry.npmjs.org/bonjour-service)                                         | `1.3.0`                     | `1.4.4`                | 2026-07-28             |
| [decimal.js](https://registry.npmjs.org/decimal.js)                                                   | `10.5.0`                    | `10.6.0`               | 2025-07-06             |
| [diff](https://registry.npmjs.org/diff)                                                               | `8.0.2`                     | `8.0.4`                | 2026-03-23             |
| [dompurify](https://registry.npmjs.org/dompurify)                                                     | `3.4.13`                    | `3.4.16`               | 2026-09-23             |
| [electron](https://registry.npmjs.org/electron)                                                       | `42.3.3`                    | `42.11.9`              | 2026-09-29             |
| [electron-builder](https://registry.npmjs.org/electron-builder)                                       | `26.15.2`                   | `26.15.3`              | 2026-06-09             |
| [electron-log](https://registry.npmjs.org/electron-log)                                               | `^5`                        | `5.4.4`                | 2026-05-14             |
| [electron-vite](https://registry.npmjs.org/electron-vite)                                             | `^5`                        | `5.0.0`                | 2025-12-07             |
| [esbuild](https://registry.npmjs.org/esbuild)                                                         | `^0.25.3`                   | `0.25.12`              | 2025-11-01             |
| [eslint](https://registry.npmjs.org/eslint)                                                           | `^9.25.1`                   | `10.11.0`              | 2026-09-18             |
| [gitlab-ai-provider](https://registry.npmjs.org/gitlab-ai-provider)                                   | `6.9.3`                     | `6.18.0`               | 2026-09-23             |
| [glob](https://registry.npmjs.org/glob)                                                               | `13.0.5`                    | `13.0.6`               | 2026-02-19             |
| [hono](https://registry.npmjs.org/hono)                                                               | `4.10.7`                    | `4.13.11`              | 2026-09-29             |
| [ignore](https://registry.npmjs.org/ignore)                                                           | `7.0.5`                     | `7.0.10`               | 2026-09-22             |
| [immer](https://registry.npmjs.org/immer)                                                             | `11.1.4`                    | `11.1.18`              | 2026-08-19             |
| [jose](https://registry.npmjs.org/jose)                                                               | `6.0.11`                    | `6.2.12`               | 2026-09-05             |
| [js-base64](https://registry.npmjs.org/js-base64)                                                     | `3.7.7`                     | `3.9.4`                | 2026-09-19             |
| [katex](https://registry.npmjs.org/katex)                                                             | `0.16.27`                   | `0.16.47`              | 2026-05-16             |
| [luxon](https://registry.npmjs.org/luxon)                                                             | `3.6.1`                     | `3.7.2`                | 2025-09-05             |
| [marked](https://registry.npmjs.org/marked)                                                           | `17.0.1`, `^15`             | `17.0.6`               | 2026-04-05             |
| [marked-katex-extension](https://registry.npmjs.org/marked-katex-extension)                           | `5.1.6`                     | `5.1.13`               | 2026-09-16             |
| [minimatch](https://registry.npmjs.org/minimatch)                                                     | `10.2.3`                    | `10.2.6`               | 2026-07-27             |
| [motion](https://registry.npmjs.org/motion)                                                           | `12.34.5`                   | `12.43.0`              | 2026-07-28             |
| [motion-dom](https://registry.npmjs.org/motion-dom)                                                   | `12.34.3`                   | `12.43.0`              | 2026-07-28             |
| [motion-utils](https://registry.npmjs.org/motion-utils)                                               | `12.29.2`                   | `12.39.0`              | 2026-05-18             |
| [mysql2](https://registry.npmjs.org/mysql2)                                                           | `3.22.0`                    | `3.24.5`               | 2026-09-29             |
| [open](https://registry.npmjs.org/open)                                                               | `10.1.2`                    | `10.2.0`               | 2025-07-14             |
| [openai](https://registry.npmjs.org/openai)                                                           | `5.11.0`                    | `5.23.2`               | 2025-09-30             |
| [opencode-poe-auth](https://registry.npmjs.org/opencode-poe-auth)                                     | `0.0.1`                     | `0.0.4`                | 2026-05-08             |
| [postgres](https://registry.npmjs.org/postgres)                                                       | `3.4.7`                     | `3.4.9`                | 2026-04-05             |
| [prettier](https://registry.npmjs.org/prettier)                                                       | `3.6.2`                     | `3.9.9`                | 2026-09-23             |
| [react](https://registry.npmjs.org/react)                                                             | `18.2.0`                    | `18.3.1`               | 2024-04-26             |
| [remeda](https://registry.npmjs.org/remeda)                                                           | `2.26.0`                    | `2.50.0`               | 2026-09-14             |
| [remend](https://registry.npmjs.org/remend)                                                           | `1.3.0`                     | `1.3.1`                | 2026-08-24             |
| [semver](https://registry.npmjs.org/semver)                                                           | `7.7.4`, `^7.6.0`, `^7.6.3` | `7.8.5`                | 2026-06-19             |
| [shiki](https://registry.npmjs.org/shiki)                                                             | `4.2.0`                     | `4.4.3`                | 2026-08-10             |
| [solid-js](https://registry.npmjs.org/solid-js)                                                       | `1.9.12`                    | `1.9.15`               | 2026-08-17             |
| [sst](https://registry.npmjs.org/sst)                                                                 | `4.13.1`                    | `4.17.1`               | 2026-07-12             |
| [storybook](https://registry.npmjs.org/storybook)                                                     | `^10.2.13`                  | `10.6.1`               | 2026-09-29             |
| [storybook-solidjs-vite](https://registry.npmjs.org/storybook-solidjs-vite)                           | `^10.0.9`                   | `10.7.2`               | 2026-09-08             |
| [strip-ansi](https://registry.npmjs.org/strip-ansi)                                                   | `7.1.2`                     | `7.2.0`                | 2026-02-26             |
| [tailwindcss](https://registry.npmjs.org/tailwindcss)                                                 | `4.1.11`                    | `4.3.3`                | 2026-07-16             |
| [tree-sitter-bash](https://registry.npmjs.org/tree-sitter-bash)                                       | `0.25.0`                    | `0.25.1`               | 2025-12-02             |
| [turbo](https://registry.npmjs.org/turbo)                                                             | `2.9.14`                    | `2.11.5`               | 2026-09-28             |
| [turndown](https://registry.npmjs.org/turndown)                                                       | `7.2.0`                     | `7.2.4`                | 2026-04-03             |
| [typescript](https://registry.npmjs.org/typescript)                                                   | `5.8.2`, `^5.8.3`, `~5.6.2` | `5.9.3`                | 2025-09-30             |
| [ulid](https://registry.npmjs.org/ulid)                                                               | `3.0.1`                     | `3.0.2`                | 2025-11-30             |
| [venice-ai-sdk-provider](https://registry.npmjs.org/venice-ai-sdk-provider)                           | `2.0.2`                     | `2.1.1`                | 2026-06-25             |
| [vite](https://registry.npmjs.org/vite)                                                               | `7.1.4`                     | `7.3.6`                | 2026-06-25             |
| [vite-plugin-icons-spritesheet](https://registry.npmjs.org/vite-plugin-icons-spritesheet)             | `3.0.1`                     | `3.1.0`                | 2026-06-01             |
| [vite-plugin-solid](https://registry.npmjs.org/vite-plugin-solid)                                     | `2.11.10`                   | `2.11.14`              | 2026-07-27             |
| [vscode-languageserver-types](https://registry.npmjs.org/vscode-languageserver-types)                 | `3.17.5`                    | `3.18.4`               | 2026-09-25             |
| [wrangler](https://registry.npmjs.org/wrangler)                                                       | `4.59.1`                    | `4.144.0`              | 2026-09-29             |
| [ws](https://registry.npmjs.org/ws)                                                                   | `8.21.0`                    | `8.22.0`               | 2026-09-26             |
| [yaml](https://registry.npmjs.org/yaml)                                                               | `2.9.0`                     | `2.9.1`                | 2026-09-11             |
| [yargs](https://registry.npmjs.org/yargs)                                                             | `18.0.0`                    | `18.2.0`               | 2026-09-20             |
| [zod](https://registry.npmjs.org/zod)                                                                 | `^4.2.0`                    | `4.6.5`                | 2026-09-13             |

Exact-pin-only normalization: `@hey-api/openapi-ts`, `@types/mocha`, `@types/vscode`, `@vscode/test-electron`, `aws4fetch`, `electron-window-state`.

New consistency declarations: `@types/hast`, `electron-builder-squirrel-windows`, `react-dom`, `valibot`. Removed unused desktop `@actions/artifact` duplicate (root keeps it) and unused script-package `semver` / `@types/semver` after the shared toolchain checker replaces their use.

Audit limits: package metadata and locally exercised code provide compatibility evidence, not proof that every transitive dependency is secure. External vulnerability scanners and DayBreak were not used. The source audit remains bounded by the parent's recorded file coverage; this dependency report does not imply exhaustive review of third-party code. Existing framework prereleases and deprecated JSX-email packages are explicitly retained rather than represented as current stable APIs.

New consistency declaration publish dates (UTC):

| Package                             | Pin       | Published  |
| ----------------------------------- | --------- | ---------- |
| `@types/hast`                       | `3.0.5`   | 2026-07-09 |
| `electron-builder-squirrel-windows` | `26.15.3` | 2026-06-09 |
| `react-dom`                         | `18.3.1`  | 2024-04-26 |
| `valibot`                           | `1.5.0`   | 2026-09-09 |

Public registry reproducibility: 520 package/version/integrity identities were checked against the official npm version metadata. All 566 company-mirror tarball entries (464 main lock, 102 VS Code lock) matched the official integrity and now use the official `dist.tarball`; no company-mirror URL remains in either tracked Bun lock. Root and independent frozen installs leave both lockfiles byte-identical. Existing Git / `pkg.pr.new` immutable snapshots still depend on their original hosts being reachable.

The two ignored runtime cache trees `.opencode` and `packages/opencode/.opencode` currently contain their own generated package manifests and npm locks (plugin 1.0.5 and 1.18.15 respectively). They are excluded by their local `.gitignore` files, are outside the tracked workspace dependency graph, and were left untouched. They are not characterized as orphan locks.

The VS Code manifest now pins the same Bun 1.4.2 metadata and runs the repository central validator before typechecking, lint and tests. Production packaging was rerun with the checksum-verified Node 24.21.0 archive selected through a temporary PATH and passed (48 existing semicolon warnings, zero errors). The host default Node 26.9.0 was left unchanged; the central validator rejects it until the pinned Node is selected. These development scripts run in the source repository; the VS Code extension runtime does not execute them.

Final tracked lock SHA-256:

- `bun.lock`: `1876b82eec8fd47e16984a69410034f3bd234013f08ffd6a3c398beaee603433`
- `sdks/vscode/bun.lock`: `40f4a579ad9c1288f00443a7e1c000c847d73a1e75d6fa6d18bc8b8c2da43d33`

CI test discovery follow-up:

- Turbo's generic test task now discovers existing package scripts; previously only five explicitly registered package tasks ran. The parent owns that task configuration and the final combined run.
- Added real test scripts to schema (18 pass), protocol (1 pass), console core (20 pass), console app (34 pass), CLI (3 pass, existing OpenTUI preload retained), stats core (7 pass), and enterprise. No scripts were added to packages without tests.
- Enterprise's existing storage/share tests previously required live S3/R2 credentials. Its new test-only preload overrides all storage inputs with synthetic credentials and substitutes an in-memory fetch transport; unknown endpoints and operations throw, with no network fallback. The real signing library and production storage adapter remain in use. The 17 existing tests pass offline.
- That offline harness reproduced an existing share revocation defect: snapshot/compaction files were written as `<id>.json` but deletion searched `<id>/`; the public data handler could still return the snapshot. Three regression tests failed before the fix and pass afterward, including neighboring-share isolation, orphan snapshots from an already-started sync, and legacy compaction reconstruction. Enterprise now has 20 passing tests, typechecking passes, and the new preload/regression files have zero lint warnings. Exact object deletion plus the existing-share guard fix new reads; this does not claim distributed synchronization, complete orphan garbage collection, or invalidation of previously cached CDN responses.

Independent delivery review:

- The 38 manifests contain no unresolved catalog references or floating direct dependency specifications. Shared registry dependencies use the catalog; the two `ghostty-web` declarations retain the same immutable Git commit. Independent VS Code declarations remain exact pins.
- The shared validator passes with Bun 1.4.2, Node 24.21.0 and Go 1.27.1. Its eight Node tests pass. CI verification and browser jobs install the central Node pin before repository scripts; release jobs use the shared Bun action, which also installs and validates Node. Container build arguments read the same version sources.
- [Official adapter metadata](https://registry.npmjs.org/marked-shiki/1.2.1) permits `marked-shiki` 1.2.1 with Shiki 4.4.3. A rendering probe passes through Marked 17 and that adapter, and Shiki 4.4.3 successfully executes the 3.23.0 notation diff, highlight and focus transformers. The version-number difference alone does not demonstrate a rendering regression; this probe does not claim complete transformer or browser coverage.
- Stats Docker previously deleted its pruned lock and resolved dependencies again. The installer now retains Turbo's lock after workspace-glob normalization. An isolated Turbo 2.11.5 prune followed by the actual Bun 1.4.2 frozen production install succeeds (111 packages installed); its lock stays byte-identical, and all 549 pruned package records match records in the committed lock, including version, metadata, URL and integrity. Container build scripts do not contain a similar lock re-resolution step. Docker itself was unavailable, so this verifies dependency preparation rather than a completed container build.

Astro peer graph follow-up:

- Native Dependabot inspection found two Astro advisories whose ranges also matched an obsolete `toolbeam-docs-theme/astro@5.7.13` lock record and its Sharp 0.33.5 closure. The web host already pins Astro 7.3.5 and Starlight 0.41.11. A clean Bun 1.4.2 frozen install of the aggregate source resolves the theme to those host versions and installs no Astro 5; no exploitable old image-decoder or routing path was established. This is a peer-lock consistency repair, not a claim of a confirmed deployed vulnerability.
- `toolbeam-docs-theme` 0.4.8 remains the latest published release and declares older peer ranges. Two ordinary exact root overrides now bind its peers to the already selected host versions. [Bun's documented override contract](https://bun.sh/docs/pm/overrides) applies root overrides to peers; ordinary rules preserve lock format version 1. Existing version, metadata, integrity and URL records are retained unchanged; Bun removes 167 obsolete package records and adds none. No release-age exception or validation gate is changed.
- In isolated copies, both the original frozen graph (2,166 packages installed) and the repaired frozen graph (2,165 packages installed) complete the actual web package build with Node 24.21.0 and Bun 1.4.2. Each produces 649 HTML files, the Pagefind search index, sitemap and both configuration schemas. All 649 route/title/header/footer structures match, and both generated schema artifacts are byte-identical. The repaired lock remains byte-identical after a frozen recheck.
- Wrangler logs and its local registry use private `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH` for these builds; the first attempt using default macOS preferences was blocked by the filesystem sandbox before prerendering. The successful runs keep the actual Cloudflare adapter and passthrough image configuration. Existing component-override, markdown-deprecation and chunk-size warnings remain; this proof does not certify every theme option, browser interaction or deployed artifact.

Embedded desktop runtime and build resources:

- Standalone Node builds and checks use exact Node 24.21.0. Electron 42.11.9 owns its embedded Node 24.19.0 runtime; it is not replaced by a PATH installation. A real Electron run inside app.asar verifies the portable schema worker with normal/null output, JSON-string repair, review fingerprints, a 250 ms deadline, cancellation and same-schema registry re-registration. This explicit vendor-runtime boundary is separate from the VS Code extension-host boundary above.
- ARM64 Darwin native verification reproduced a V8 heap failure near 1,970 MiB during desktop backend bundling. The canonical desktop build entrypoint validates central toolchain pins, resolves the installed electron-vite CLI, and invokes Node with a build-only 4,096 MiB old-space budget. Unrelated NODE_OPTIONS remain inherited; caller heap flags yield to this explicit build argument. Nix and CI use the same entrypoint. Electron runtime flags and source maps are preserved.
- The actual local main/preload/renderer build passes with the 4,096 MiB budget (21.33 seconds, about 4.79 GiB peak child RSS). Later manifest-shape guards preserve that invocation and pass direct correct/wrong-version, inherited-option, missing-bin and exit-status probes with zero lint warnings. Final native builds remain necessary to verify platform resource limits.
