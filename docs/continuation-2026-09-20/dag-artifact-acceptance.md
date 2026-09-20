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
SOURCE_ROOT=$(git rev-parse --show-toplevel)
test "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" = "$DEV_SHA"

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
shasum -a 256 "$ROOT/bin/opencode" > "$ROOT/installed-binary.sha256"

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

python3 - "$ROOT/commands.json" "$SOURCE_ROOT/packages/core/src/plugin/command/dag-auto.txt" <<'PY'
import hashlib, json, pathlib, sys
commands = json.load(open(sys.argv[1], encoding="utf-8"))
command = next(item for item in commands if item.get("name") == "dag-auto")
assert command.get("source") == "command"
assert command.get("description") == "Assess useful DAG orchestration for a request and adapt the graph to its evidence and dependencies"
expected = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
actual = command.get("template", "")
assert actual == expected
print("dag-auto artifact registry template: PASS", hashlib.sha256(actual.encode()).hexdigest())
PY

"$GLOBAL" --version | tee "$ROOT/global-version.after"
shasum -a 256 "$GLOBAL" > "$ROOT/global.sha256.after"
cmp "$ROOT/global-version.before" "$ROOT/global-version.after"
cmp "$ROOT/global.sha256.before" "$ROOT/global.sha256.after"
```

通过条件：release target、资产校验、版本/help、签名以及从精确 `DEV_SHA` checkout 读取的完整 `/dag-auto` 模板逐字节相等；`commands.json`、模板 SHA256、server 输出和命令退出码均保留。最后再次比较 `global-version.before` 和 `global.sha256.before`，证明 1.0.44 全局二进制未被替换。该步骤证明 command registry 从制品加载了模板；实际 `--command dag-auto` 分发与参数展开由下一节的 provider transcript 证明。

## 3. 提示词分发与 workflow guide 的制品验收

下面的两个用例使用真实支持的 `opencode run --command dag-auto <arguments>` 路径以及真实 `workflow(action="guide")` tool call。它们由 `TestLLMServer` 捕获最终制品发出的 provider request，不调用外部模型：

- `/dag-auto` 用例要求 request 包含当前 `DEV_SHA` 的完整 resident 模板，且 `$ARGUMENTS` 已替换为唯一 sentinel；
- workflow 用例要求模型侧 tool description 的 resident 前缀逐字节等于 `workflow-routing.md`，其后只允许产品按运行时配置追加的 worker catalog；用例再依次执行四个 guide，并要求每份真实 tool output 出现在后续 provider request；
- 两份 evidence 都记录 artifact realpath/SHA256、direct argv、stdout/stderr、退出码、完整 request transcript 及当前源码期望哈希。

源码模式仅用于准备 harness，不能计作制品验收：

```bash
cd packages/opencode
OPENCODE_TEST_DAG_PROMPTS_SOURCE=1 \
OPENCODE_TEST_DAG_PROMPTS_EVIDENCE_DIR="$ROOT/dag-prompts-source-evidence" \
bun test --timeout 240000 test/cli/run/dag-prompts-artifact.test.ts
```

最终制品阶段必须使用下载并隔离安装的绝对 binary：

```bash
mkdir -m 700 "$ROOT/dag-prompts-evidence"
cd packages/opencode
OPENCODE_TEST_ARTIFACT_EXECUTABLE="$ROOT/bin/opencode" \
OPENCODE_TEST_DAG_PROMPTS_EVIDENCE_DIR="$ROOT/dag-prompts-evidence" \
bun test --timeout 240000 test/cli/run/dag-prompts-artifact.test.ts \
  2>&1 | tee "$ROOT/dag-prompts-artifact.log"

test -s "$ROOT/dag-prompts-evidence/dag-auto-dispatch.json"
test -s "$ROOT/dag-prompts-evidence/workflow-guides.json"
python3 - "$ROOT/installed-binary.sha256" "$ROOT/dag-prompts-evidence" <<'PY'
import json, pathlib, sys
expected = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").split()[0]
evidence = pathlib.Path(sys.argv[2])
for name in ("dag-auto-dispatch.json", "workflow-guides.json"):
    data = json.loads((evidence / name).read_text(encoding="utf-8"))
    assert data["target"]["mode"] == "artifact", name
    assert data["target"]["sha256"] == expected, name
    assert data["result"]["exitCode"] == 0, name
    assert data["requests"], name
print("DAG resident prompt artifact transcripts: PASS")
PY
```

这些 deterministic loopback 结果证明最终制品加载并分发了当前 checkout 的 resident 文本；它们不等同于 PR #611 的历史真实模型 5/5，也不证明模型会作出相同的启发式决策。

## 4. CLI hold 的验收与限制

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

该入口只证明下载并隔离安装的 binary 能通过这两个 DAG/no-DAG hold 回归。它不覆盖其余三个源码 subprocess 案例、历史 5/5 真实模型回放、外部 provider 或其他平台资产；这些边界必须在最终记录中保留。TestLLMServer 只监听随机 loopback 端口，harness 同时为每案建立独立 `OPENCODE_TEST_HOME`、HOME 和 XDG 子进程环境，并禁用外部插件、自动更新与模型目录抓取。

真实 TUI 的排队消息编辑/冲突/删除使用独立的后台 PTY 用例。harness 通过仓库已有 `bun-pty` 驱动进程、用 `ghostty-web` 解析固定尺寸屏幕、按屏幕文字定位并发送 SGR 鼠标事件，不占用用户焦点或指针。用例验证 Q1 编辑后保留原附件 ID 和顺序、Q2 弹窗打开后外部文字与附件变化触发冲突且不被覆盖、Q3 删除后 API 返回 404；首个 provider 请求在这些操作期间保持阻塞，释放后下一请求包含 Q1/Q2 的最终文字且不含 Q3。附件身份由持久 API 读回和实际屏幕证明；provider 转换不保证保留文件名。

源码模式只用于准备和回归 harness，不能计作制品验收：

```bash
cd packages/opencode
OPENCODE_TEST_TUI_SOURCE=1 \
OPENCODE_TEST_TUI_EVIDENCE_DIR="$ROOT/tui-source-evidence" \
bun test --timeout 120000 test/cli/tui/queued-message-artifact.test.ts
```

最终制品阶段必须将同一用例指向下载并隔离安装的绝对 binary 路径：

```bash
mkdir -m 700 "$ROOT/tui-queue-evidence"
cd packages/opencode
OPENCODE_TEST_ARTIFACT_EXECUTABLE="$ROOT/bin/opencode" \
OPENCODE_TEST_TUI_EVIDENCE_DIR="$ROOT/tui-queue-evidence" \
bun test --timeout 120000 test/cli/tui/queued-message-artifact.test.ts \
  2>&1 | tee "$ROOT/tui-queue-artifact.log"

test -s "$ROOT/tui-queue-evidence/raw.ansi"
test -s "$ROOT/tui-queue-evidence/frames.json"
test -s "$ROOT/tui-queue-evidence/inputs.json"
test -s "$ROOT/tui-queue-evidence/provider-requests.json"
test -s "$ROOT/tui-queue-evidence/result.json"
```

`result.json` 记录 target 模式、artifact realpath/SHA256、direct argv、终端尺寸、实际退出状态与已完成断言；`raw.ansi`、`frames.json`、`inputs.json` 和 `provider-requests.json` 分别保留原始终端输出、解析屏幕帧、输入字节和 loopback provider 请求。只有 `mode=artifact` 且 target SHA256 与本轮安装后二进制一致的成功运行，才补上真实 TUI 的制品证据。

## 5. 接线与最终记录

- 提示词来源：`packages/core/src/plugin/command/{workflow-routing.md,workflow.md,workflow-blocks.md,orchestration-policy.md,orchestration-domains.md,dag-auto.txt}`；`packages/core/src/plugin/command.ts` 导出内容，`packages/opencode/src/command/index.ts` 注册 `/dag-auto`，`packages/opencode/src/tool/workflow.ts` 注入 workflow tool description/guide。
- 发布接线：`.github/workflows/release-fork.yml` 将经校验的配置仓库模板通过 `DAG_TEMPLATES_DIR` 交给 `packages/opencode/script/generate.ts`，再构建、打包、校验版本与 macOS 安装。该模板快照与 PR 611 的 resident heuristic prompt 是两个边界，不能用“模板已打包”替代 `/dag-auto` 加载验证。
- 既有断言：`packages/core/test/plugin/command.test.ts`、`packages/opencode/test/command/command.test.ts`、`packages/opencode/test/dag/workflow-tool.test.ts`；hold 单元/子进程入口见上节。
- 最终验收记录至少写入：`TAG`、`DEV_SHA`、release URL/target、平台资产名和 SHA256、安装后二进制版本、签名/help、`commands.json` 的完整模板哈希/精确相等结果、同 SHA required checks、全局 1.0.44 前后版本/哈希、DAG prompt 两案和 CLI hold 两案各自的 target 模式/realpath/安装后二进制 SHA256、结果和私有 request transcript 路径、TUI 的 raw ANSI/frames/inputs/provider transcript/result 路径。未运行 DAG prompt、CLI hold 或 TUI 用例时，对应制品缺口仍然存在，不能宣称完成。

图证据使用主项目 generation `2026-09-20T01:11:31Z`、Tier 2。上述路径 coverage 均为 `no_recorded_issue`/`metadata_match`，唯 `dag-auto.txt` 的 freshness 为 `not_tracked`，已直接读取当前源码；coverage 仅是 best-effort 信号。
