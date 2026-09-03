"""生成 devflow 工作区。"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

DEFAULT_BRANCH = "master"
SKELETON = ("codebase", "worktree")


class ConfigError(Exception):
    """workspace.toml 内容不合法。"""


@dataclass(frozen=True)
class Repository:
    name: str
    url: str
    branch: str


@dataclass(frozen=True)
class WorkspaceConfig:
    name: str
    repositories: tuple[Repository, ...]


def _ensure_safe_repository_name(context: str, name: str) -> None:
    """确认仓库 name 可以安全地当作 codebase/ 下的单层目录名。"""
    if "/" in name or "\\" in name:
        raise ConfigError(
            f'{context} name 不能包含路径分隔符，只写仓库目录名即可'
            f'（当前值 {name!r}，正确写法如 name = "svc-a"）'
        )
    if name in {".", ".."}:
        raise ConfigError(f"{context} name 不能是 . 或 ..（当前值 {name!r}）")


def load_config(path: Path) -> WorkspaceConfig:
    """读取 path 指向的 workspace.toml，返回校验通过的 WorkspaceConfig。

    文件读不到、TOML 语法有误或清单内容不合法时，统一抛出 ConfigError。
    """
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except FileNotFoundError as error:
        raise ConfigError(
            f"找不到 {path}。请在工作区根目录提供 workspace.toml"
        ) from error
    except OSError as error:
        raise ConfigError(f"无法读取 {path}：{error.strerror or error}") from error
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"{path} TOML 语法错误：{error}") from error

    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ConfigError("workspace.toml 缺少 name")

    defaults = data["defaults"] if "defaults" in data else {}
    if not isinstance(defaults, dict):
        raise ConfigError(
            'workspace.toml 的 [defaults] 必须写成表，'
            '例如 [defaults] 段内 branch = "master"'
        )
    default_branch = str(defaults.get("branch") or DEFAULT_BRANCH).strip()

    entries = data["repositories"] if "repositories" in data else []
    if not isinstance(entries, list):
        raise ConfigError("workspace.toml 的 repositories 必须是 [[repositories]] 表")

    repositories: list[Repository] = []
    seen: dict[str, int] = {}
    for index, entry in enumerate(entries):
        context = f"repositories[{index}]"
        if not isinstance(entry, dict):
            raise ConfigError(
                f"{context} 必须写成 [[repositories]] 表，"
                f"在其中分别填写 name 与 url（当前值 {entry!r}）"
            )
        if "path" in entry:
            continue

        repo_name = entry.get("name")
        url = entry.get("url")
        if not isinstance(repo_name, str) or not repo_name.strip():
            raise ConfigError(f"{context} 缺少 name")
        if not isinstance(url, str) or not url.strip():
            raise ConfigError(f"{context} 缺少 url")
        repo_name = repo_name.strip()
        _ensure_safe_repository_name(context, repo_name)
        if repo_name in seen:
            raise ConfigError(
                f"{context} name 与 repositories[{seen[repo_name]}] 重复：{repo_name}"
            )
        seen[repo_name] = index
        branch = str(entry.get("branch") or default_branch).strip()
        repositories.append(Repository(repo_name, url.strip(), branch))

    return WorkspaceConfig(name.strip(), tuple(repositories))


def validate_skeleton(root: Path) -> None:
    """严格校验既有工作区骨架路径，不创建或修改任何文件。"""
    if root.exists() and not root.is_dir():
        raise ConfigError(f"工作区根目录已被普通文件占用：{root}")

    for relative in SKELETON:
        target = root / relative
        if target.is_symlink():
            raise ConfigError(f"工作区目录不能是符号链接：{target}")
        if target.exists() and not target.is_dir():
            raise ConfigError(f"工作区目录已被普通文件占用：{target}")


def create_directories(root: Path) -> list[str]:
    """在 root 下建出工作区骨架目录，返回本次新建的相对路径列表。"""
    validate_skeleton(root)
    created = []
    for relative in SKELETON:
        target = root / relative
        if target.is_dir():
            continue
        target.mkdir(parents=True)
        created.append(relative)
    return created


def bootstrap_knowledge(root: Path) -> list[str]:
    """建立知识库目录骨架；实际内容由 init-knowledge 基于代码生成。"""
    knowledge = root / "knowledge"
    if knowledge.is_symlink():
        raise ConfigError(f"知识库目录不能是符号链接：{knowledge}")
    if knowledge.exists() and not knowledge.is_dir():
        raise ConfigError(f"知识库目录已被普通文件占用：{knowledge}")
    knowledge.mkdir(parents=True, exist_ok=True)

    created = []
    for relative in ("business", "architecture", "engineering"):
        target = knowledge / relative
        if target.is_symlink():
            raise ConfigError(f"知识库目录不能是符号链接：{target}")
        if target.exists() and not target.is_dir():
            raise ConfigError(f"知识库目录已被普通文件占用：{target}")
        if not target.exists():
            target.mkdir()
            created.append(relative)
    return created


@dataclass
class CloneResult:
    cloned: list[str]
    skipped: list[str]


def _default_runner(command: list[str], cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def clone_repositories(
    config: WorkspaceConfig,
    root: Path,
    runner: Callable[[list[str], Path], None] = _default_runner,
    dry_run: bool = False,
) -> CloneResult:
    """把代码仓库克隆到 root/codebase，已有 Git 元数据的目标直接跳过。"""
    codebase = root / "codebase"
    if codebase.is_symlink():
        raise ConfigError(f"代码仓库目录不能是符号链接：{codebase}")
    if codebase.exists() and not codebase.is_dir():
        raise ConfigError(f"代码仓库目录已被普通文件占用：{codebase}")
    if not dry_run:
        codebase.mkdir(parents=True, exist_ok=True)

    cloned: list[str] = []
    skipped: list[str] = []
    for repository in config.repositories:
        target = codebase / repository.name
        if target.is_symlink():
            raise ConfigError(f"代码仓库目标不能是符号链接：{target}")
        git_metadata = target / ".git"
        if git_metadata.is_file() or git_metadata.is_dir():
            skipped.append(repository.name)
            continue
        if target.exists() and (not target.is_dir() or any(target.iterdir())):
            raise ConfigError(f"代码仓库目标已存在其他内容：{target}")

        command = [
            "git",
            "clone",
            "--branch",
            repository.branch,
            repository.url,
            str(target),
        ]
        if not dry_run:
            runner(command, codebase)
        cloned.append(repository.name)

    return CloneResult(cloned=cloned, skipped=skipped)


def _ensure_root_has_no_symbolic_links(root: Path) -> None:
    """拒绝 root 及其既有父路径中的符号链接。"""
    current = Path(root.anchor)
    for part in root.parts[1:]:
        current /= part
        if current.is_symlink():
            raise ConfigError(f"工作区根目录或其父级不能是符号链接：{current}")
        if not current.exists():
            break


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="初始化 devflow 工作区")
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="工作区根目录")
    parser.add_argument("--dry-run", action="store_true", help="不写入且不执行克隆，只打印计划")
    args = parser.parse_args(argv)

    root = Path(os.path.abspath(args.root))
    try:
        _ensure_root_has_no_symbolic_links(root)
        validate_skeleton(root)
        config = load_config(root / "workspace.toml")

        if not args.dry_run:
            created = create_directories(root)
            knowledge_directories = bootstrap_knowledge(root)
            print(f"新建工作目录 {len(created)} 个，补齐知识库目录 {len(knowledge_directories)} 个")

        print(f"工作区：{root}")
        result = clone_repositories(config, root, dry_run=args.dry_run)
    except ConfigError as error:
        print(f"工作区初始化错误（{error}）")
        return 1

    action = "待克隆" if args.dry_run else "已克隆"
    print(f"{action} {len(result.cloned)} 个：{', '.join(result.cloned) or '无'}")
    print(f"已存在跳过 {len(result.skipped)} 个：{', '.join(result.skipped) or '无'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
