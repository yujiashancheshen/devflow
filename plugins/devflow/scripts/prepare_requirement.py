"""为单个需求冻结基线并创建 Git worktree。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import flow_state


DEFAULT_BRANCH = "master"
_ALLOWED_KINDS = frozenset({"backend", "frontend"})
_RESERVED_REPOSITORY_NAMES = frozenset({"docs", "codebase"})


class PrepareRequirementError(RuntimeError):
    """需求工作树准备失败。"""


@dataclass(frozen=True)
class ConfiguredRepository:
    name: str
    url: str
    branch: str
    kind: str


def prepare_requirement(
    root: Path,
    requirement: str,
    repositories: list[dict[str, str]],
    dry_run: bool = False,
) -> dict[str, Any]:
    """冻结目标仓库基线，并为需求创建对应的 feature worktree。

    所有仓库完成不修改的预检后才会抓取远端；所有同步完成后才会创建
    worktree；仅在全部 worktree 可用时写入流程状态。该顺序避免半成品
    状态文件，以及预检失败时的任何网络或文件系统副作用。
    """
    root = Path(root).absolute()
    _validate_requirement(requirement)
    requested = _validate_requested_repositories(repositories)
    configured = _select_configured_repositories(root, requested)
    worktree_root = root / "worktree"
    requirement_root = worktree_root / requirement

    _preflight_state_path(root, requirement)
    existing_state = _load_existing_state(root, requirement)
    _preflight_workspace_paths(root, worktree_root, requirement_root)
    existing_worktrees = _preflight_repositories(root, requirement_root, configured)
    if existing_state is not None:
        _validate_existing_state(root, requirement, configured, existing_state)

    if dry_run:
        return _plan(root, requirement, configured, existing_worktrees)
    if existing_state is not None:
        return existing_state

    baseline_shas = _synchronize_repositories(root, configured)
    _verify_existing_worktrees(
        root, requirement_root, configured, existing_worktrees, baseline_shas
    )
    _create_missing_worktrees(
        root, requirement_root, configured, existing_worktrees
    )

    state = _state(requirement, configured, baseline_shas)
    flow_state.write_state(root, requirement, state)
    return state


def _validate_requirement(requirement: str) -> None:
    try:
        # 使用 flow_state 的同一套目录名约束，避免状态路径和 worktree 路径分歧。
        flow_state.state_path(Path("/"), requirement)
    except flow_state.FlowStateError as error:
        raise PrepareRequirementError(str(error)) from error


def _preflight_state_path(root: Path, requirement: str) -> None:
    try:
        flow_state.preflight_state_path(root, requirement)
    except flow_state.FlowStateError as error:
        raise PrepareRequirementError(f"状态路径不安全：{error}") from error


def _load_existing_state(root: Path, requirement: str) -> dict[str, Any] | None:
    try:
        return flow_state.load_state(root, requirement)
    except FileNotFoundError:
        return None
    except flow_state.FlowStateError as error:
        raise PrepareRequirementError(f"无法读取已有状态：{error}") from error


def _validate_existing_state(
    root: Path,
    requirement: str,
    repositories: Iterable[ConfiguredRepository],
    state: dict[str, Any],
) -> None:
    saved_repositories = state["repositories"]
    configured_repositories = list(repositories)
    if len(saved_repositories) != len(configured_repositories):
        raise PrepareRequirementError("已有状态与本次仓库请求不兼容：仓库数量不同")

    for index, (saved, configured) in enumerate(
        zip(saved_repositories, configured_repositories, strict=True)
    ):
        expected = {
            "name": configured.name,
            "kind": configured.kind,
            "baselineBranch": configured.branch,
            "featureBranch": f"feature/{requirement}",
            "worktreePath": configured.name,
        }
        for field, value in expected.items():
            if saved[field] != value:
                raise PrepareRequirementError(
                    f"已有状态与本次仓库请求不兼容：repositories[{index}].{field}"
                )
        baseline_sha = _git(root / "codebase" / configured.name, "rev-parse", "HEAD")
        if saved["baselineSha"] != baseline_sha:
            raise PrepareRequirementError(
                f"已有状态与本次仓库基线不兼容：repositories[{index}].baselineSha"
            )


def _validate_requested_repositories(
    repositories: list[dict[str, str]],
) -> list[tuple[str, str]]:
    if not isinstance(repositories, list) or not repositories:
        raise PrepareRequirementError("repositories 必须是非空数组")

    result: list[tuple[str, str]] = []
    names: set[str] = set()
    for index, repository in enumerate(repositories):
        label = f"repositories[{index}]"
        if not isinstance(repository, dict):
            raise PrepareRequirementError(f"{label} 必须是对象")
        if set(repository) != {"name", "kind"}:
            raise PrepareRequirementError(f"{label} 必须且只能包含 name 与 kind")
        name = repository.get("name")
        kind = repository.get("kind")
        if not isinstance(name, str) or not _safe_name(name):
            raise PrepareRequirementError(f"{label}.name 必须是安全的单层目录名")
        if name in _RESERVED_REPOSITORY_NAMES:
            raise PrepareRequirementError(f"{label}.name 不能为 docs 或 codebase")
        if not isinstance(kind, str) or kind not in _ALLOWED_KINDS:
            raise PrepareRequirementError(f"{label}.kind 必须为 backend 或 frontend")
        if name in names:
            raise PrepareRequirementError(f"repositories 中存在重复仓库：{name}")
        names.add(name)
        result.append((name, kind))
    return result


def _safe_name(value: str) -> bool:
    return (
        value not in {"", ".", ".."}
        and "/" not in value
        and "\\" not in value
        and "\x00" not in value
        and not Path(value).is_absolute()
    )


def _select_configured_repositories(
    root: Path, requested: Iterable[tuple[str, str]]
) -> list[ConfiguredRepository]:
    config_path = root / "workspace.toml"
    try:
        with config_path.open("rb") as handle:
            data = tomllib.load(handle)
    except FileNotFoundError as error:
        raise PrepareRequirementError(f"找不到工作区配置：{config_path}") from error
    except tomllib.TOMLDecodeError as error:
        raise PrepareRequirementError(f"工作区配置 TOML 语法错误：{error}") from error
    except OSError as error:
        raise PrepareRequirementError(f"无法读取工作区配置：{error}") from error

    if not isinstance(data, dict):
        raise PrepareRequirementError("workspace.toml 根节点必须是对象")
    defaults = data.get("defaults", {})
    if not isinstance(defaults, dict):
        raise PrepareRequirementError("workspace.toml 的 [defaults] 必须是表")
    default_branch = _config_branch(defaults.get("branch", DEFAULT_BRANCH), "defaults.branch")

    entries = data.get("repositories", [])
    if not isinstance(entries, list):
        raise PrepareRequirementError("workspace.toml 的 repositories 必须是数组")

    available: dict[str, tuple[str, str]] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise PrepareRequirementError(f"repositories[{index}] 必须是表")
        # 有 path 的条目由工作区其他机制管理，不参与 codebase/<name> worktree。
        if "path" in entry:
            continue
        name = entry.get("name")
        url = entry.get("url")
        if not isinstance(name, str) or not _safe_name(name):
            raise PrepareRequirementError(
                f"workspace.toml repositories[{index}].name 必须是安全的单层目录名"
            )
        if not isinstance(url, str) or not url.strip():
            raise PrepareRequirementError(
                f"workspace.toml repositories[{index}].url 必须是非空字符串"
            )
        if name in available:
            raise PrepareRequirementError(f"workspace.toml 存在重复仓库：{name}")
        branch = _config_branch(entry.get("branch", default_branch), f"repositories[{index}].branch")
        available[name] = (url.strip(), branch)

    selected: list[ConfiguredRepository] = []
    for name, kind in requested:
        config = available.get(name)
        if config is None:
            raise PrepareRequirementError(f"仓库未配置或配置了 path：{name}")
        url, branch = config
        selected.append(ConfiguredRepository(name, url, branch, kind))
    return selected


def _config_branch(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PrepareRequirementError(f"{label} 必须是非空字符串")
    branch = value.strip()
    if branch.startswith("-") or "\x00" in branch or any(char.isspace() for char in branch):
        raise PrepareRequirementError(f"{label} 不是安全的 Git 分支名")
    return branch


def _preflight_workspace_paths(root: Path, worktree_root: Path, requirement_root: Path) -> None:
    if not root.is_dir():
        raise PrepareRequirementError(f"工作区根目录不存在或不是目录：{root}")
    for path in (worktree_root, requirement_root):
        if path.is_symlink():
            raise PrepareRequirementError(f"工作树目录不能是符号链接：{path}")
        if path.exists() and not path.is_dir():
            raise PrepareRequirementError(f"工作树目录已被普通文件占用：{path}")


def _preflight_repositories(
    root: Path,
    requirement_root: Path,
    repositories: Iterable[ConfiguredRepository],
) -> dict[str, bool]:
    existing_worktrees: dict[str, bool] = {}
    for repository in repositories:
        source = root / "codebase" / repository.name
        _check_source_repository(source, repository)
        target = requirement_root / repository.name
        existing_worktrees[repository.name] = _check_existing_worktree(
            target, repository.name
        )
    return existing_worktrees


def _check_source_repository(source: Path, repository: ConfiguredRepository) -> None:
    if not source.is_dir() or source.is_symlink():
        raise PrepareRequirementError(f"codebase/{repository.name} 不存在或不是 Git 仓库")
    try:
        inside = _git(source, "rev-parse", "--is-inside-work-tree")
        top_level = Path(_git(source, "rev-parse", "--show-toplevel")).resolve()
    except PrepareRequirementError as error:
        raise PrepareRequirementError(f"codebase/{repository.name} 不是 Git 仓库") from error
    if inside != "true" or top_level != source.resolve():
        raise PrepareRequirementError(f"codebase/{repository.name} 不是 Git 仓库根目录")

    if _git(source, "status", "--porcelain"):
        raise PrepareRequirementError(f"codebase/{repository.name} 存在未提交改动")
    origin = _git(source, "config", "--get", "remote.origin.url")
    if origin != repository.url:
        raise PrepareRequirementError(f"codebase/{repository.name} 的 origin URL 与配置不一致")
    branch = _git(source, "branch", "--show-current")
    if branch != repository.branch:
        raise PrepareRequirementError(
            f"codebase/{repository.name} 当前分支为 {branch or 'detached'}，应为 {repository.branch}"
        )


def _check_existing_worktree(target: Path, name: str) -> bool:
    if not target.exists():
        return False
    if target.is_symlink() or not target.is_dir() or not (target / ".git").exists():
        raise PrepareRequirementError(f"已有 worktree 不完整：{target}")
    try:
        top_level = Path(_git(target, "rev-parse", "--show-toplevel")).resolve()
        branch = _git(target, "branch", "--show-current")
    except PrepareRequirementError as error:
        raise PrepareRequirementError(f"已有 worktree 不是 Git 仓库：{target}") from error
    if top_level != target.resolve():
        raise PrepareRequirementError(f"已有 worktree 根目录不匹配：{target}")
    expected_branch = f"feature/{target.parent.name}"
    if branch != expected_branch:
        raise PrepareRequirementError(
            f"已有 worktree {name} 当前分支为 {branch or 'detached'}，应为 {expected_branch}"
        )
    return True


def _synchronize_repositories(
    root: Path, repositories: Iterable[ConfiguredRepository]
) -> dict[str, str]:
    baseline_shas: dict[str, str] = {}
    for repository in repositories:
        source = root / "codebase" / repository.name
        _git(source, "fetch", "origin", repository.branch)
        _git(source, "merge", "--ff-only", f"origin/{repository.branch}")
        sha = _git(source, "rev-parse", "HEAD")
        if len(sha) != 40:
            raise PrepareRequirementError(f"codebase/{repository.name} 未得到有效的基线 SHA")
        baseline_shas[repository.name] = sha
    return baseline_shas


def _verify_existing_worktrees(
    root: Path,
    requirement_root: Path,
    repositories: Iterable[ConfiguredRepository],
    existing_worktrees: dict[str, bool],
    baseline_shas: dict[str, str],
) -> None:
    for repository in repositories:
        if not existing_worktrees[repository.name]:
            continue
        target = requirement_root / repository.name
        # 已有 feature 分支必须以本次冻结基线为祖先，绝不通过 reset 改写它。
        completed = subprocess.run(
            ["git", "merge-base", "--is-ancestor", baseline_shas[repository.name], "HEAD"],
            cwd=target,
            text=True,
            capture_output=True,
        )
        if completed.returncode != 0:
            raise PrepareRequirementError(
                f"已有 worktree {repository.name} 未以冻结基线为祖先，不会 reset 或删除"
            )


def _create_missing_worktrees(
    root: Path,
    requirement_root: Path,
    repositories: Iterable[ConfiguredRepository],
    existing_worktrees: dict[str, bool],
) -> None:
    for repository in repositories:
        if existing_worktrees[repository.name]:
            continue
        target = requirement_root / repository.name
        target.parent.mkdir(parents=True, exist_ok=True)
        source = root / "codebase" / repository.name
        _git(source, "worktree", "add", "-b", f"feature/{requirement_root.name}", str(target))


def _state(
    requirement: str,
    repositories: Iterable[ConfiguredRepository],
    baseline_shas: dict[str, str],
) -> dict[str, Any]:
    repository_list = list(repositories)
    return {
        "version": 1,
        "currentStage": _initial_stage(repository_list),
        "repositories": [
            {
                "name": repository.name,
                "kind": repository.kind,
                "baselineBranch": repository.branch,
                "baselineSha": baseline_shas[repository.name],
                "featureBranch": f"feature/{requirement}",
                "worktreePath": repository.name,
                "mergedBaselineSha": None,
                "mergeCommitSha": None,
            }
            for repository in repository_list
        ],
        "stages": {},
    }


def _initial_stage(repositories: Iterable[ConfiguredRepository]) -> str:
    return "detailed-design"


def _plan(
    root: Path,
    requirement: str,
    repositories: Iterable[ConfiguredRepository],
    existing_worktrees: dict[str, bool],
) -> dict[str, Any]:
    return {
        "dryRun": True,
        "requirement": requirement,
        "repositories": [
            {
                "name": repository.name,
                "kind": repository.kind,
                "baselineBranch": repository.branch,
                "featureBranch": f"feature/{requirement}",
                "codebasePath": str(root / "codebase" / repository.name),
                "worktreePath": str(root / "worktree" / requirement / repository.name),
                "existingWorktree": existing_worktrees[repository.name],
                "actions": [
                    f"git fetch origin {repository.branch}",
                    f"git merge --ff-only origin/{repository.branch}",
                    "验证或创建 feature worktree",
                ],
            }
            for repository in repositories
        ],
        "writeState": str(root / "worktree" / requirement / "docs" / "flow-state.json"),
    }


def _git(cwd: Path, *arguments: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=cwd,
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = ""
        if isinstance(error, subprocess.CalledProcessError):
            detail = error.stderr.strip() or error.stdout.strip()
        raise PrepareRequirementError(
            f"Git 命令失败：git {' '.join(arguments)}" + (f"：{detail}" if detail else "")
        ) from error
    return completed.stdout.strip()


def _parse_repository_argument(value: str) -> dict[str, str]:
    name, separator, kind = value.partition(":")
    if not separator or not name or not kind or ":" in kind:
        raise argparse.ArgumentTypeError("--repository 必须为 name:kind")
    return {"name": name, "kind": kind}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="准备需求 Git worktree")
    parser.add_argument("--root", type=Path, required=True, help="工作区根目录")
    parser.add_argument("--requirement", required=True, help="需求名称")
    parser.add_argument(
        "--repository",
        type=_parse_repository_argument,
        action="append",
        required=True,
        help="目标仓库，格式为 name:kind，可重复指定",
    )
    parser.add_argument("--dry-run", action="store_true", help="只输出计划，不执行修改")
    args = parser.parse_args(argv)

    try:
        result = prepare_requirement(
            args.root, args.requirement, args.repository, dry_run=args.dry_run
        )
    except PrepareRequirementError as error:
        print(f"需求准备失败：{error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
