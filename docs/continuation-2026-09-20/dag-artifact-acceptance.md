# DAG 提示词与 CLI hold：dev 制品验收清单

## 证据基线

- PR [#611](https://github.com/LeXwDeX/OpenCode-GraphAgent/pull/611) 已合并为 `545713c67c6f7be87a99325de7397bc1e2656805`，PR head 为 `11b6321e2f471d95ca455e198d317ff3004443db`。
- PR 正文归档的真实模型回放为 5/5；显式 DAG 案例在该 head 的最后 stdout 为 `replay=7;lines=12`、退出码 0、无 status/result 轮询，no-DAG 对照未受影响。记录同时披露预算 13/12（+1）以及 #614 裁决指纹 `b54a8804b7552569ea3b0f8567bce075d14dcbf46d39d050493d47b83635139a`。
- 上述 5/5 是 PR 自述的**历史源码运行时模型回放**。本轮没有逐案复跑，也没有把临时逐案原始文件重新归档；它不能证明后续 dev 制品已经包含或加载相同提示词。
- 当前全局 `/usr/local/bin/opencode` 是 1.0.44。未来验收只运行临时目录中的 dev 二进制，不替换全局安装、不读取全局配置、不再调用外部模型。

## 1. 固定制品来源并隔离安装（当前 macOS arm64）

先记录 release tag 和触发 release 的精确 dev SHA。`release-fork.yml` 应以该 SHA 为 target，产出 `opencode-darwin-arm64.zip` 和 `SHA256SUMS`；不能用“工作流成功”代替 SHA 对齐。

```bash
set -euo pipefail
REPO=LeXwDeX/OpenCode-GraphAgent
TAG=graphagent-vX.Y.Z-dev.N
DEV_SHA=<dispatch-and-required-checks-sha>
ASSET=opencode-darwin-arm64.zip
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dag-artifact-accept.XXXXXX")
mkdir -p "$ROOT/download" "$ROOT/unpack" "$ROOT/bin" "$ROOT/project" "$ROOT/home"

GLOBAL=/usr/local/bin/opencode
"$GLOBAL" --version | tee "$ROOT/global-version.before"
shasum -a 256 "$GLOBAL" > "$ROOT/global.sha256.before"

gh api "repos/$REPO/releases/tags/$TAG" > "$ROOT/release.json"
python3 - "$ROOT/release.json" "$DEV_SHA" <<'PY'
import json, sys
release = json.load(open(sys.argv[1], encoding="utf-8"))
assert release["prerelease"] is True
assert release["target_commitish"] == sys.argv[2], (release["target_commitish"], sys.argv[2])
print(release["html_url"], release["target_commitish"])
PY

gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --pattern SHA256SUMS --dir "$ROOT/download"
awk -v asset="$ASSET" '$2 == asset { print }' "$ROOT/download/SHA256SUMS" > "$ROOT/download/asset.sha256"
test -s "$ROOT/download/asset.sha256"
(cd "$ROOT/download" && shasum -a 256 -c asset.sha256)

unzip -q "$ROOT/download/$ASSET" -d "$ROOT/unpack"
install -m 755 "$ROOT/unpack/opencode" "$ROOT/bin/opencode"
xattr -cr "$ROOT/bin/opencode"
codesign -fs - "$ROOT/bin/opencode"
codesign --verify --strict "$ROOT/bin/opencode"

EXPECT_VERSION=${TAG#graphagent-v}
test "$("$ROOT/bin/opencode" --version)" = "$EXPECT_VERSION"
"$ROOT/bin/opencode" --help > "$ROOT/help.txt"
```

Linux/Windows 换成同一 release 的对应资产和解包命令；仍需保留 release JSON、资产、`SHA256SUMS`、校验输出、版本与 help 输出。macOS 安装后的二进制会被 ad-hoc codesign 改写，验收边界是解包前资产 SHA 加安装后签名有效和可执行，不比较安装后二进制与压缩包内文件的字节哈希。

## 2. 零模型验证 `/dag-auto` 确实从制品加载

使用空项目、空 HOME/XDG 和已知的本地测试密码启动**制品二进制**。`GET /command` 是现有 command.list 产品接口，不会发起模型请求。

```bash
env \
  HOME="$ROOT/home" \
  XDG_CONFIG_HOME="$ROOT/home/.config" \
  XDG_DATA_HOME="$ROOT/home/.local/share" \
  XDG_STATE_HOME="$ROOT/home/.local/state" \
  XDG_CACHE_HOME="$ROOT/home/.cache" \
  OPENCODE_CONFIG_DIR="$ROOT/home/.config/opencode" \
  OPENCODE_CONFIG_CONTENT='{}' \
  OPENCODE_AUTH_CONTENT='{}' \
  OPENCODE_DISABLE_PROJECT_CONFIG=1 \
  OPENCODE_DISABLE_AUTOUPDATE=1 \
  OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_PURE=1 \
  OPENCODE_SERVER_PASSWORD=acceptance-local \
  "$ROOT/bin/opencode" serve --hostname 127.0.0.1 --port 0 > "$ROOT/server.out" 2> "$ROOT/server.err" &
SERVER_PID=$!
cleanup_server() { kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; }
trap cleanup_server EXIT
for _ in $(seq 1 150); do
  BASE=$(sed -n 's/^opencode server listening on //p' "$ROOT/server.out" | tail -1)
  test -n "$BASE" && break
  sleep 0.1
done
test -n "${BASE:-}"
curl -fsS -u opencode:acceptance-local -H "x-opencode-directory: $ROOT/project" "$BASE/command" > "$ROOT/commands.json"
cleanup_server
trap - EXIT

python3 - "$ROOT/commands.json" <<'PY'
import json, sys
commands = json.load(open(sys.argv[1], encoding="utf-8"))
command = next(item for item in commands if item.get("name") == "dag-auto")
assert command.get("source") == "command"
assert command.get("description") == "Assess useful DAG orchestration for a request and adapt the graph to its evidence and dependencies"
template = command.get("template", "")
for marker in (
    "$ARGUMENTS",
    "explicit request for direct work or no DAG takes precedence",
    "not the default",
    "A review request does not authorize repairs or a release phase.",
    "Platform delivery is outside this command",
):
    assert marker in template, marker
print("dag-auto artifact prompt: PASS")
PY

"$GLOBAL" --version | tee "$ROOT/global-version.after"
shasum -a 256 "$GLOBAL" > "$ROOT/global.sha256.after"
cmp "$ROOT/global-version.before" "$ROOT/global-version.after"
cmp "$ROOT/global.sha256.before" "$ROOT/global.sha256.after"
```

通过条件：release target、资产校验、版本/help、签名以及五个提示词标记全部通过；`commands.json`、server 输出和命令退出码均保留。最后再次比较 `global-version.before` 和 `global.sha256.before`，证明 1.0.44 全局二进制未被替换。

## 3. CLI hold 的验收与限制

实现位于 `packages/opencode/src/cli/cmd/run/dag-hold.ts`，由 `packages/opencode/src/cli/cmd/run.ts` 的非 attach `run` 循环调用。其契约是：`pending`/`running` 或本轮已观察到活跃工作会 hold；首次出现的 workflow ID 至少 hold 一次以等待 wake；已知且静止的 completed/failed/cancelled/archived/paused/stepping 不继续 hold；idle 轮询失败按旧行为退出；attach 模式不启用该 hold。

现有源码测试入口（本清单编写时不重复运行）：

```bash
cd packages/core
bun test test/plugin/command.test.ts

cd ../opencode
bun test --timeout 30000 test/command/command.test.ts test/dag/workflow-tool.test.ts
bun test --timeout 30000 test/cli/run/dag-hold.test.ts test/cli/run/run-dag-hold-process.test.ts
bun test --timeout 30000 test/dag/release-packaging-smoke.test.ts test/dag/dag-templates-generation.test.ts
```

`packages/opencode/test/lib/cli-process.ts` 现在支持两个显式 target：默认 `source` 仍执行 `bun run --conditions=browser .../src/index.ts`；`artifact` 只接受绝对可执行文件路径，解析 symlink 后校验普通文件和可执行位，并在每次 spawn 前复核 realpath 与 SHA256。artifact 通过 direct argv 启动，不接受 shell command 或拼接字符串。测试日志记录 `mode=artifact`、解析后的路径和实际安装后二进制 SHA256。

制品验收只运行现有两个最小对照：no-DAG 单轮精确回复并退出 0；显式 DAG 的最终 wake 是 stdout 最后一行并退出 0。`TestLLMServer` 是本轮批准使用的 deterministic loopback regression provider；它不构成真实模型证据，也不得把该结果冒称为历史 5/5 真实模型回放。下面的私有 evidence 目录会保存两案实际 request transcript、stdout/stderr、退出码和 target 身份：

```bash
mkdir -m 700 "$ROOT/cli-hold-evidence"
shasum -a 256 "$ROOT/bin/opencode" > "$ROOT/installed-binary.sha256"

cd packages/opencode
OPENCODE_TEST_ARTIFACT_EXECUTABLE="$ROOT/bin/opencode" \
OPENCODE_TEST_ARTIFACT_EVIDENCE_DIR="$ROOT/cli-hold-evidence" \
bun test --timeout 30000 test/cli/run/run-dag-hold-process.test.ts \
  --test-name-pattern '(no-DAG single-turn prompt exits with the exact reply|holds through a running workflow and prints the final wake reply last)' \
  2>&1 | tee "$ROOT/cli-hold-artifact.log"

test -s "$ROOT/cli-hold-evidence/no-dag.json"
test -s "$ROOT/cli-hold-evidence/dag-hold.json"
python3 - "$ROOT/installed-binary.sha256" "$ROOT/cli-hold-evidence" <<'PY'
import json, pathlib, sys
expected = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").split()[0]
evidence = pathlib.Path(sys.argv[2])
for name in ("no-dag.json", "dag-hold.json"):
    data = json.loads((evidence / name).read_text(encoding="utf-8"))
    assert data["target"]["mode"] == "artifact", name
    assert data["target"]["sha256"] == expected, name
    assert data["result"]["exitCode"] == 0, name
    assert data["requests"], name
print("CLI hold artifact target and transcripts: PASS")
PY
```

该入口只证明下载并隔离安装的 binary 能通过这两个 DAG/no-DAG hold 回归。它不覆盖其余三个源码 subprocess 案例、历史 5/5 真实模型回放、外部 provider、TUI 交互或其他平台资产；这些边界必须在最终记录中保留。TestLLMServer 只监听随机 loopback 端口，harness 同时为每案建立独立 `OPENCODE_TEST_HOME`、HOME 和 XDG 子进程环境，并禁用外部插件、自动更新与模型目录抓取。

## 4. 接线与最终记录

- 提示词来源：`packages/core/src/plugin/command/{workflow-routing.md,workflow.md,workflow-blocks.md,orchestration-policy.md,orchestration-domains.md,dag-auto.txt}`；`packages/core/src/plugin/command.ts` 导出内容，`packages/opencode/src/command/index.ts` 注册 `/dag-auto`，`packages/opencode/src/tool/workflow.ts` 注入 workflow tool description/guide。
- 发布接线：`.github/workflows/release-fork.yml` 将经校验的配置仓库模板通过 `DAG_TEMPLATES_DIR` 交给 `packages/opencode/script/generate.ts`，再构建、打包、校验版本与 macOS 安装。该模板快照与 PR 611 的 resident heuristic prompt 是两个边界，不能用“模板已打包”替代 `/dag-auto` 加载验证。
- 既有断言：`packages/core/test/plugin/command.test.ts`、`packages/opencode/test/command/command.test.ts`、`packages/opencode/test/dag/workflow-tool.test.ts`；hold 单元/子进程入口见上节。
- 最终验收记录至少写入：`TAG`、`DEV_SHA`、release URL/target、平台资产名和 SHA256、安装后二进制版本、签名/help、`commands.json` 标记结果、同 SHA required checks、全局 1.0.44 前后版本/哈希、CLI target 模式/realpath/安装后二进制 SHA256、两案结果和私有 request transcript 路径。未运行上述两案时，CLI hold 仍是制品缺口，不能宣称完成。

图证据使用主项目 generation `2026-09-20T01:11:31Z`、Tier 2。上述路径 coverage 均为 `no_recorded_issue`/`metadata_match`，唯 `dag-auto.txt` 的 freshness 为 `not_tracked`，已直接读取当前源码；coverage 仅是 best-effort 信号。
