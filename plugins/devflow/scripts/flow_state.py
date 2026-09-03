from __future__ import annotations

import json
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath
from typing import Any, Iterator, Mapping


STATE_FILENAME = "flow-state.json"
EVENTS_FILENAME = "flow-events.jsonl"
_SUPPORTED_VERSION = 1
_SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}\Z")
_RESERVED_WORKTREE_NAMES = frozenset({"docs", "codebase"})
_STATE_FIELDS = frozenset({"version", "currentStage", "repositories", "stages"})
_REPOSITORY_FIELDS = frozenset(
    {
        "name",
        "kind",
        "baselineBranch",
        "baselineSha",
        "featureBranch",
        "worktreePath",
        "mergedBaselineSha",
        "mergeCommitSha",
    }
)
_STAGE_FIELDS = frozenset({"status", "confirmed", "blockedReason", "output", "outputs"})
_STAGES = frozenset(
    {
        "requirement-clarification",
        "high-level-design",
        "detailed-design",
        "implementation",
        "e2e-testing",
    }
)
_STAGE_STATUSES = frozenset(
    {
        "pending",
        "in_progress",
        "blocked",
        "awaiting_confirmation",
        "completed",
        "not_applicable",
    }
)


class FlowStateError(ValueError):
    pass


def state_path(root: str | Path, requirement: str) -> Path:
    _validate_requirement_name(requirement)
    root_path = Path(root)
    return root_path / "worktree" / requirement / "docs" / STATE_FILENAME


def preflight_state_path(root: str | Path, requirement: str) -> Path:
    """无副作用地验证状态路径中已存在的组件均可安全访问。"""
    _validate_requirement_name(requirement)
    root_fd = _open_root_directory(root)
    opened_descriptors = [root_fd]
    try:
        parent_fd = root_fd
        for component in ("worktree", requirement, "docs"):
            try:
                child_fd = _open_directory_component(parent_fd, component, create=False)
            except FileNotFoundError:
                return state_path(root, requirement)
            opened_descriptors.append(child_fd)
            parent_fd = child_fd
        _reject_existing_state_symlink(parent_fd)
        return state_path(root, requirement)
    finally:
        for file_descriptor in reversed(opened_descriptors):
            os.close(file_descriptor)


def load_state(root: str | Path, requirement: str) -> dict[str, Any]:
    path = state_path(root, requirement)
    with _open_docs_directory(root, requirement, create=False) as docs_fd:
        state_fd = _open_state_file(docs_fd)
        try:
            with os.fdopen(state_fd, "r", encoding="utf-8") as state_file:
                state = json.load(state_file, object_pairs_hook=_json_object)
        except json.JSONDecodeError as error:
            raise FlowStateError(f"状态文件不是有效 JSON：{path}") from error
    validate_state(state)
    return state


def write_state(root: str | Path, requirement: str, state: dict[str, Any]) -> Path:
    validate_state(state)
    path = state_path(root, requirement)
    serialized = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    with _open_docs_directory(root, requirement, create=True) as docs_fd:
        _reject_existing_state_symlink(docs_fd)
        temporary_name: str | None = None
        try:
            temporary_name, temporary_fd = _create_temporary_state_file(docs_fd)
            with os.fdopen(temporary_fd, "w", encoding="utf-8") as temporary_file:
                temporary_file.write(serialized)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(
                temporary_name,
                STATE_FILENAME,
                src_dir_fd=docs_fd,
                dst_dir_fd=docs_fd,
            )
            temporary_name = None
            os.fsync(docs_fd)
        except OSError as error:
            cleanup_error: OSError | None = None
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name, dir_fd=docs_fd)
                except FileNotFoundError:
                    pass
                except OSError as unlink_error:
                    cleanup_error = unlink_error
            if cleanup_error is not None:
                raise FlowStateError(
                    f"无法安全写入状态文件：{error}；临时文件清理失败："
                    f"{temporary_name}：{cleanup_error}"
                ) from error
            raise FlowStateError(f"无法安全写入状态文件：{error}") from error
    return path


def append_event(
    root: str | Path,
    requirement: str,
    *,
    stage: str,
    event: str,
    details: Mapping[str, Any] | None = None,
) -> Path:
    """追加流程事件；状态快照继续只负责恢复，事件用于耗时和方差分析。"""
    _validate_requirement_name(requirement)
    if stage not in _STAGES:
        raise FlowStateError(f"不支持的流程阶段：{stage}")
    _require_text(event, "event")
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stage": stage,
        "event": event,
        "details": dict(details or {}),
    }
    path = state_path(root, requirement).with_name(EVENTS_FILENAME)
    with _open_docs_directory(root, requirement, create=True) as docs_fd:
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | _nofollow_flag()
        try:
            event_fd = os.open(EVENTS_FILENAME, flags, 0o600, dir_fd=docs_fd)
            with os.fdopen(event_fd, "a", encoding="utf-8") as event_file:
                event_file.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
                event_file.flush()
                os.fsync(event_file.fileno())
            os.fsync(docs_fd)
        except OSError as error:
            raise FlowStateError(f"无法追加流程事件：{error}") from error
    return path


def _absolute_root(root: str | Path) -> Path:
    root_path = Path(root)
    if root_path.is_absolute():
        return root_path
    return Path.cwd() / root_path


@contextmanager
def _open_docs_directory(
    root: str | Path, requirement: str, *, create: bool
) -> Iterator[int]:
    _validate_requirement_name(requirement)
    root_fd = _open_root_directory(root)
    worktree_fd: int | None = None
    requirement_fd: int | None = None
    docs_fd: int | None = None
    try:
        worktree_fd = _open_directory_component(root_fd, "worktree", create=create)
        requirement_fd = _open_directory_component(worktree_fd, requirement, create=create)
        docs_fd = _open_directory_component(requirement_fd, "docs", create=create)
        yield docs_fd
    finally:
        for file_descriptor in (docs_fd, requirement_fd, worktree_fd, root_fd):
            if file_descriptor is not None:
                os.close(file_descriptor)


def _open_root_directory(root: str | Path) -> int:
    root_path = _absolute_root(root)
    flags = _directory_open_flags()
    try:
        root_fd = os.open(root_path.anchor, flags)
    except OSError as error:
        raise FlowStateError(f"无法安全打开工作区根目录：{root_path}") from error
    try:
        for component in root_path.parts[1:]:
            child_fd = _open_directory_component(root_fd, component, create=False)
            os.close(root_fd)
            root_fd = child_fd
    except BaseException:
        os.close(root_fd)
        raise
    return root_fd


def _open_directory_component(parent_fd: int, name: str, *, create: bool) -> int:
    try:
        return os.open(name, _directory_open_flags(), dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise
        try:
            os.mkdir(name, dir_fd=parent_fd)
        except FileExistsError:
            pass
        except OSError as error:
            raise FlowStateError(f"无法安全创建状态目录：{name}") from error
        try:
            return os.open(name, _directory_open_flags(), dir_fd=parent_fd)
        except OSError as error:
            raise FlowStateError(f"无法安全打开状态目录：{name}") from error
    except OSError as error:
        raise FlowStateError(f"状态路径不能是符号链接或非目录：{name}") from error


def _open_state_file(docs_fd: int) -> int:
    try:
        state_fd = os.open(
            STATE_FILENAME,
            os.O_RDONLY | os.O_NONBLOCK | _nofollow_flag(),
            dir_fd=docs_fd,
        )
    except FileNotFoundError:
        raise
    except OSError as error:
        raise FlowStateError("状态文件不能是符号链接") from error
    if not stat.S_ISREG(os.fstat(state_fd).st_mode):
        os.close(state_fd)
        raise FlowStateError("状态文件必须是普通文件")
    return state_fd


def _reject_existing_state_symlink(docs_fd: int) -> None:
    try:
        state_info = os.stat(STATE_FILENAME, dir_fd=docs_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    except OSError as error:
        raise FlowStateError("无法安全检查状态文件") from error
    if stat.S_ISLNK(state_info.st_mode):
        raise FlowStateError("状态文件不能是符号链接")


def _create_temporary_state_file(docs_fd: int) -> tuple[str, int]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | _nofollow_flag()
    for _ in range(100):
        temporary_name = f".flow-state.{secrets.token_hex(16)}.tmp"
        try:
            return temporary_name, os.open(
                temporary_name,
                flags,
                0o600,
                dir_fd=docs_fd,
            )
        except FileExistsError:
            continue
        except OSError as error:
            raise FlowStateError("无法安全创建状态临时文件") from error
    raise FlowStateError("无法创建唯一的状态临时文件")


def _directory_open_flags() -> int:
    try:
        return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    except AttributeError as error:
        raise FlowStateError("当前平台不支持安全目录描述符访问") from error


def _nofollow_flag() -> int:
    try:
        return os.O_NOFOLLOW
    except AttributeError as error:
        raise FlowStateError("当前平台不支持安全文件描述符访问") from error


def validate_state(state: Any) -> None:
    _require_mapping(state, "状态")
    _require_exact_fields(state, _STATE_FIELDS, "状态")
    version = state["version"]
    if not isinstance(version, int) or isinstance(version, bool) or version != _SUPPORTED_VERSION:
        raise FlowStateError("状态 version 必须为 1")
    _validate_stage_name(state["currentStage"], "currentStage")

    repositories = state["repositories"]
    if not isinstance(repositories, list):
        raise FlowStateError("repositories 必须是数组")
    names: set[str] = set()
    for index, repository in enumerate(repositories):
        _validate_repository(repository, index, names)

    stages = state["stages"]
    _require_mapping(stages, "stages")
    for name, stage in stages.items():
        _validate_stage_name(name, "阶段名称")
        _validate_stage(stage, name)


def _validate_repository(repository: Any, index: int, names: set[str]) -> None:
    label = f"repositories[{index}]"
    _require_mapping(repository, label)
    _require_exact_fields(repository, _REPOSITORY_FIELDS, label)

    name = repository["name"]
    _validate_repository_name(name)
    if name in names:
        raise FlowStateError(f"repositories 中存在重复仓库：{name}")
    names.add(name)

    if repository["kind"] not in {"backend", "frontend"}:
        raise FlowStateError(f"{label}.kind 必须为 backend 或 frontend")
    _require_text(repository["baselineBranch"], f"{label}.baselineBranch")
    _validate_sha(repository["baselineSha"], f"{label}.baselineSha")
    _require_text(repository["featureBranch"], f"{label}.featureBranch")
    _validate_worktree_path(repository["worktreePath"], name, label)
    _validate_optional_sha(repository["mergedBaselineSha"], f"{label}.mergedBaselineSha")
    _validate_optional_sha(repository["mergeCommitSha"], f"{label}.mergeCommitSha")


def _validate_stage_name(value: Any, label: str) -> None:
    _require_text(value, label)
    if value not in _STAGES:
        raise FlowStateError(f"{label} 不是支持的阶段")


def _validate_stage(stage: Any, name: str) -> None:
    label = f"stages.{name}"
    _require_mapping(stage, label)
    _require_allowed_fields(stage, _STAGE_FIELDS, label)
    if "status" not in stage:
        raise FlowStateError(f"{label} 缺少字段：status")
    _require_text(stage["status"], f"{label}.status")
    if stage["status"] not in _STAGE_STATUSES:
        raise FlowStateError(f"{label}.status 不是支持的状态")
    if "confirmed" in stage and not isinstance(stage["confirmed"], bool):
        raise FlowStateError(f"{label}.confirmed 必须是布尔值")
    if "blockedReason" in stage:
        _require_text(stage["blockedReason"], f"{label}.blockedReason")
    if stage["status"] == "blocked" and "blockedReason" not in stage:
        raise FlowStateError(f"{label}.blockedReason 在 blocked 状态下不能为空")
    if "output" in stage:
        _validate_docs_relative_path(stage["output"], f"{label}.output")
    if "outputs" in stage:
        outputs = stage["outputs"]
        if not isinstance(outputs, list):
            raise FlowStateError(f"{label}.outputs 必须是字符串数组")
        for index, output in enumerate(outputs):
            _validate_docs_relative_path(output, f"{label}.outputs[{index}]")


def _validate_requirement_name(requirement: Any) -> None:
    if not isinstance(requirement, str) or not _is_safe_single_name(requirement):
        raise FlowStateError("requirement 必须是安全的单层目录名")


def _validate_repository_name(name: Any) -> None:
    if not isinstance(name, str) or not _is_safe_single_name(name):
        raise FlowStateError("仓库 name 必须是安全的单层目录名")
    if name in _RESERVED_WORKTREE_NAMES:
        raise FlowStateError("仓库 name 不能为 docs 或 codebase")


def _validate_worktree_path(value: Any, repository_name: str, label: str) -> None:
    if not isinstance(value, str) or value != repository_name:
        raise FlowStateError(f"{label}.worktreePath 必须精确等于仓库名")


def _validate_docs_relative_path(value: Any, label: str) -> None:
    _require_text(value, label)
    path = Path(value)
    windows_path = PureWindowsPath(value)
    if (
        path.is_absolute()
        or windows_path.is_absolute()
        or windows_path.drive
        or "\\" in value
        or ".." in path.parts
    ):
        raise FlowStateError(f"{label} 必须是安全的相对 docs 路径")


def _validate_sha(value: Any, label: str) -> None:
    if not isinstance(value, str) or _SHA_PATTERN.fullmatch(value) is None:
        raise FlowStateError(f"{label} 必须是 40 位十六进制 SHA")


def _validate_optional_sha(value: Any, label: str) -> None:
    if value is not None:
        _validate_sha(value, label)


def _require_text(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise FlowStateError(f"{label} 必须是非空字符串")


def _require_mapping(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise FlowStateError(f"{label} 必须是对象")


def _require_exact_fields(value: Mapping[str, Any], fields: frozenset[str], label: str) -> None:
    _require_allowed_fields(value, fields, label)
    missing = fields - value.keys()
    if missing:
        raise FlowStateError(f"{label} 缺少字段：{', '.join(sorted(missing))}")


def _require_allowed_fields(value: Mapping[str, Any], fields: frozenset[str], label: str) -> None:
    unknown = value.keys() - fields
    if unknown:
        raise FlowStateError(f"{label} 包含未知字段：{', '.join(sorted(unknown))}")


def _is_safe_single_name(value: str) -> bool:
    return (
        value not in {"", ".", ".."}
        and "/" not in value
        and "\\" not in value
        and not Path(value).is_absolute()
        and "\x00" not in value
    )


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise FlowStateError(f"JSON 对象包含重复字段：{key}")
        result[key] = value
    return result
