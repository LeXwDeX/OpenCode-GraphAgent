#!/bin/bash
# 测试不同版本的 opencode 黑屏问题
# Usage: ./test-black-screen.sh [official|dev|fork-release]

set -e

VERSION=${1:-dev}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFICIAL_DIR="$SCRIPT_DIR/../opencode-official"

case "$VERSION" in
  official)
    echo "=== 测试官方版本 v1.17.11 ==="
    if [ ! -d "$OFFICIAL_DIR" ]; then
      echo "官方克隆不存在,正在克隆..."
      cd "$SCRIPT_DIR/.."
      git clone https://github.com/anomalyco/opencode.git opencode-official
      cd opencode-official
      git checkout v1.17.11
      bun install
    fi
    cd "$OFFICIAL_DIR"
    echo "构建官方版本..."
    cd packages/opencode
    bun run build
    echo ""
    echo "✅ 构建完成,请在新 Windows Terminal 窗口测试:"
    echo "  cd $OFFICIAL_DIR/packages/opencode"
    echo "  ./dist/opencode-linux-x64/bin/opencode"
    ;;

  dev)
    echo "=== 测试本地 DEV 版本 ==="
    cd "$SCRIPT_DIR"
    echo "构建本地 DEV 版本..."
    cd packages/opencode
    bun run build
    echo ""
    echo "✅ 构建完成,请在新 Windows Terminal 窗口测试:"
    echo "  cd $SCRIPT_DIR/packages/opencode"
    echo "  ./dist/opencode-linux-x64/bin/opencode"
    ;;

  fork-release)
    echo "=== 测试 GitHub FORK-RELEASE 版本 ==="
    echo "请从 GitHub Actions 下载最新的 release binary:"
    echo "  https://github.com/LeXwDeX/OpenCode-GraphAgent/actions/runs/28419729354"
    echo ""
    echo "下载后解压测试:"
    echo "  tar -xzf opencode-linux-x64.tar.gz"
    echo "  ./opencode-linux-x64/bin/opencode"
    ;;

  *)
    echo "Usage: $0 [official|dev|fork-release]"
    echo ""
    echo "  official      - 官方 v1.17.11 (从上游克隆)"
    echo "  dev           - 本地 DEV 版本 (当前 fork)"
    echo "  fork-release  - GitHub FORK-RELEASE (从 Actions 下载)"
    exit 1
    ;;
esac
