"""验证需求 worktree 已包含冻结基线。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import flow_state


class EnsureBaselineError(RuntimeError):
    """冻结基线验证失败。"""


def ensure_baseline(root: Path, requirement: str) -> dict[str, Any]:
    """验证每个需求 worktree 已包含状态文件中冻结的基线。

    基线 SHA 仅来自 ``flow-state.json``。此函数不会修改仓库、创建提交、
    执行合并或写回状态文件。
    """
    root = Path(root).absolute()
    try:
        state = flow_state.load_state(root, requirement)
    except (FileNotFoundError, flow_state.FlowStateError) as error:
        raise EnsureBaselineError(f"无法读取流程状态：{error}") from error

    for repository in state["repositories"]:
        name = repository["name"]
        baseline_sha = repository["baselineSha"]
        worktree = root / "worktree" / requirement / repository["worktreePath"]
        _validate_worktree(worktree, name)

        if _is_ancestor(worktree, baseline_sha):
            continue
        raise EnsureBaselineError(
            f"worktree {name} 的当前 HEAD 不包含冻结基线 {baseline_sha}；"
            "请先明确处理分支关系，再重新进入实施阶段"
        )
    return state


def _validate_worktree(worktree: Path, name: str) -> None:
    if worktree.is_symlink() or not worktree.is_dir():
        raise EnsureBaselineError(f"worktree {name} 不存在或不是安全目录：{worktree}")
    if not (worktree / ".git").exists():
        raise EnsureBaselineError(f"worktree {name} 不是 Git 仓库：{worktree}")
    if _git(worktree, "rev-parse", "--show-toplevel") != str(worktree.resolve()):
        raise EnsureBaselineError(f"worktree {name} 不是 Git 仓库根目录：{worktree}")


def _is_ancestor(worktree: Path, baseline_sha: str) -> bool:
    completed = _run_git(worktree, "merge-base", "--is-ancestor", baseline_sha, "HEAD")
    if completed.returncode in {0, 1}:
        return completed.returncode == 0
    detail = completed.stderr.strip() or completed.stdout.strip()
    raise EnsureBaselineError(
        f"无法检查冻结基线是否为祖先：{detail or baseline_sha}"
    )


def _run_git(worktree: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *arguments],
            cwd=worktree,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise EnsureBaselineError(f"无法执行 Git 命令：git {' '.join(arguments)}") from error


def _git(worktree: Path, *arguments: str) -> str:
    completed = _run_git(worktree, *arguments)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise EnsureBaselineError(
            f"Git 命令失败：git {' '.join(arguments)}" + (f"：{detail}" if detail else "")
        )
    return completed.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="验证需求 worktree 已包含冻结基线")
    parser.add_argument("--root", type=Path, required=True, help="工作区根目录")
    parser.add_argument("--requirement", required=True, help="需求名称")
    args = parser.parse_args(argv)

    try:
        state = ensure_baseline(args.root, args.requirement)
    except EnsureBaselineError as error:
        print(f"冻结基线验证失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
