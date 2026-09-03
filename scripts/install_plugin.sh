#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "用法：$(basename "$0") [--dry-run]" >&2
}

case "$#" in
    0)
        dry_run=false
        ;;
    1)
        if [[ "$1" != "--dry-run" ]]; then
            usage
            exit 2
        fi
        dry_run=true
        ;;
    *)
        usage
        exit 2
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_SRC="$SCRIPT_DIR/../plugins/devflow"

if [[ ! -d "$PLUGIN_SRC" ]]; then
    echo "错误：插件源码目录不存在：$PLUGIN_SRC" >&2
    exit 1
fi

CLAUDE_DIR="${CLAUDE_PLUGIN_DIR:-$HOME/.claude/plugins/devflow}"
CODEX_DIR="${CODEX_PLUGIN_DIR:-$HOME/.codex/plugins/devflow}"

if [[ "$dry_run" == true ]]; then
    echo "干运行：将复制 $PLUGIN_SRC/. 到："
    echo "  Claude Code: $CLAUDE_DIR"
    echo "  Codex:       $CODEX_DIR"
    exit 0
fi

mkdir -p "$CLAUDE_DIR" "$CODEX_DIR"
cp -R "$PLUGIN_SRC"/. "$CLAUDE_DIR/"
cp -R "$PLUGIN_SRC"/. "$CODEX_DIR/"

echo "已安装到："
echo "  Claude Code: $CLAUDE_DIR"
echo "  Codex:       $CODEX_DIR"
echo
echo "重启 Claude Code 或 Codex 后，可使用 /devflow:start 启动流程。"
