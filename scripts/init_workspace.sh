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
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

if [[ "$dry_run" == true ]]; then
    python3 "$SCRIPT_DIR/init_workspace.py" --root "$ROOT" --dry-run
    "$SCRIPT_DIR/install_plugin.sh" --dry-run
else
    python3 "$SCRIPT_DIR/init_workspace.py" --root "$ROOT"
    "$SCRIPT_DIR/install_plugin.sh"
fi
