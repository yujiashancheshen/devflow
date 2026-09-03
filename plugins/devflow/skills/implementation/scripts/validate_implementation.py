#!/usr/bin/env python3
"""Validate DevFlow implementation artifacts against the final repository state."""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path


KINDS = {"backend", "frontend"}
TASK_STATUSES = {"未开始", "进行中", "完成", "不适用", "阻断"}
RESULTS = {"通过", "失败", "未执行", "不适用"}
FINDING_LEVELS = {"P0", "P1", "P2"}
FINDING_STATUSES = {"开放", "已修复", "已接受", "不适用"}
HEX_PATTERN = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")


class ValidationError(Exception):
    """Raised when implementation artifacts violate the delivery contract."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验 DevFlow 单仓实施产物")
    parser.add_argument("--kind", choices=sorted(KINDS), required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--design", type=Path, required=True)
    parser.add_argument("--require-ready", action="store_true")
    parser.add_argument("plan", type=Path)
    parser.add_argument("test_report", type=Path)
    parser.add_argument("review_report", type=Path)
    return parser.parse_args()


def read_file(path: Path, expected_name: str) -> tuple[Path, str]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValidationError(f"文件不存在：{resolved}")
    if resolved.name != expected_name:
        raise ValidationError(f"文件名必须为 {expected_name}：{resolved}")
    content = resolved.read_text(encoding="utf-8")
    if "<仓库名>" in content or "<featureBranch>" in content:
        raise ValidationError(f"文件仍包含模板占位符：{resolved}")
    return resolved, content


def metadata(content: str, label: str) -> str:
    match = re.search(
        rf"^>\s*{re.escape(label)}：\s*`?([^`\n]+)`?\s*$",
        content,
        re.MULTILINE,
    )
    if not match:
        raise ValidationError(f"缺少元数据：{label}")
    value = match.group(1).strip()
    if not value or "<" in value:
        raise ValidationError(f"元数据未填写：{label}")
    return value


def section(content: str, heading: str, next_heading: str | None) -> str:
    start = content.find(heading)
    if start < 0:
        raise ValidationError(f"缺少固定章节：{heading}")
    start += len(heading)
    end = len(content) if next_heading is None else content.find(next_heading, start)
    if end < 0:
        raise ValidationError(f"缺少固定章节：{next_heading}")
    return content[start:end]


def table_rows(content: str, header: str) -> list[list[str]]:
    lines = content.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != header:
            continue
        rows: list[list[str]] = []
        for row_line in lines[index + 2 :]:
            stripped = row_line.strip()
            if not stripped.startswith("|"):
                break
            rows.append([cell.strip() for cell in stripped.strip("|").split("|")])
        return rows
    raise ValidationError(f"缺少固定表头：{header}")


def git(repo: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments], cwd=repo, text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ValidationError(f"Git 命令失败：git {' '.join(arguments)}：{detail}")
    return completed.stdout.strip()


def actual_fingerprint(repo: Path) -> str:
    script = Path(__file__).with_name("worktree_fingerprint.sh")
    completed = subprocess.run(
        [str(script), str(repo)], text=True, capture_output=True, check=False
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ValidationError(f"无法计算工作区指纹：{detail}")
    return completed.stdout.strip()


def validate_common(
    contents: list[str], kind: str, design_hash: str
) -> tuple[str, str, int]:
    repositories = {metadata(content, "仓库") for content in contents}
    kinds = {metadata(content, "仓库类型") for content in contents}
    branches = {metadata(content, "分支") for content in contents}
    design_hashes = {metadata(content, "design 指纹") for content in contents}
    revisions = {metadata(content, "计划修订号") for content in contents}
    if len(repositories) != 1 or len(branches) != 1:
        raise ValidationError("三份产物的仓库或分支不一致")
    if kinds != {kind}:
        raise ValidationError(f"仓库类型与 --kind 不一致：{kinds}")
    if design_hashes != {design_hash}:
        raise ValidationError("design 指纹与当前详细设计不一致")
    if len(revisions) != 1 or not next(iter(revisions)).isdigit():
        raise ValidationError("计划修订号必须一致且为正整数")
    revision = int(next(iter(revisions)))
    if revision < 1:
        raise ValidationError("计划修订号必须大于 0")
    return next(iter(repositories)), next(iter(branches)), revision


def validate_plan(content: str, require_ready: bool) -> None:
    if metadata(content, "计划状态") not in {"执行中", "已完成", "阻断"}:
        raise ValidationError("非法计划状态")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", metadata(content, "计划 HEAD")):
        raise ValidationError("计划 HEAD 必须为 40 位 Git SHA")
    if not HEX_PATTERN.fullmatch(metadata(content, "计划工作区指纹")):
        raise ValidationError("计划工作区指纹格式错误")
    rows = table_rows(
        section(content, "## 2 实施任务", "## 3 验证计划"),
        "| TASK | 关联场景 | 目标文件 | 实施动作 | 验证入口 | 依赖 | 状态 |",
    )
    if not rows:
        raise ValidationError("实施任务表不能为空")
    for row in rows:
        if len(row) != 7 or row[6] not in TASK_STATUSES:
            raise ValidationError(f"实施任务行无效：{row}")
    scenario_rows = table_rows(
        section(content, "## 3 验证计划", "## 4 风险与确认"),
        "| 场景 ID | 测试层级 | 测试入口 | Mock 边界 | 预期结果 |",
    )
    if not scenario_rows:
        raise ValidationError("验证计划不能为空")
    if any(len(row) != 5 or not row[0] or not row[2] for row in scenario_rows):
        raise ValidationError("验证计划存在无效场景")
    if require_ready:
        if metadata(content, "计划状态") != "已完成":
            raise ValidationError("计划尚未完成")
        if any(row[6] not in {"完成", "不适用"} for row in rows):
            raise ValidationError("存在未完成的实施任务")


def validate_test_report(
    content: str, kind: str, head: str, fingerprint: str, require_ready: bool
) -> None:
    status = metadata(content, "验证状态")
    if status not in {"通过", "部分通过", "阻断"}:
        raise ValidationError("非法验证状态")
    if metadata(content, "最终 HEAD") != head:
        raise ValidationError("测试报告最终 HEAD 与当前仓库不一致")
    if metadata(content, "最终工作区指纹") != fingerprint:
        raise ValidationError("测试报告工作区指纹与当前仓库不一致")
    rows = table_rows(
        section(content, "## 2 验收场景", "## 3 执行记录"),
        "| 场景 ID | 测试入口 | Mock 边界 | 命令或操作 | 可观察结果 | 结果 |",
    )
    if not rows:
        raise ValidationError("验收场景表不能为空")
    for row in rows:
        if len(row) != 6 or row[5] not in RESULTS:
            raise ValidationError(f"验收场景行无效：{row}")
        if kind == "backend" and row[5] != "不适用" and not row[1]:
            raise ValidationError(f"后端场景缺少接口或业务入口：{row[0]}")
        if kind == "frontend" and row[5] != "不适用" and not row[1]:
            raise ValidationError(f"前端场景缺少页面入口：{row[0]}")
    commands = table_rows(
        section(content, "## 3 执行记录", "## 4 未覆盖与剩余风险"),
        "| 类型 | 命令 | 时间 | 结果 | 关键输出或证据 |",
    )
    if not commands:
        raise ValidationError("执行记录不能为空")
    for row in commands:
        if len(row) != 5 or row[3] not in RESULTS:
            raise ValidationError(f"执行记录行无效：{row}")
    if require_ready:
        if status != "通过":
            raise ValidationError("测试报告尚未通过")
        if any(row[5] not in {"通过", "不适用"} for row in rows):
            raise ValidationError("存在未通过的验收场景")
        if any(row[3] not in {"通过", "不适用"} for row in commands):
            raise ValidationError("存在未通过的执行记录")


def validate_review_report(
    content: str, head: str, fingerprint: str, require_ready: bool
) -> None:
    status = metadata(content, "审查状态")
    if status not in {"通过", "阻断"}:
        raise ValidationError("非法审查状态")
    if metadata(content, "最终 HEAD") != head:
        raise ValidationError("Review 报告最终 HEAD 与当前仓库不一致")
    if metadata(content, "最终工作区指纹") != fingerprint:
        raise ValidationError("Review 报告工作区指纹与当前仓库不一致")
    rows = table_rows(
        section(content, "## 2 Findings", "## 3 最终结论"),
        "| Finding | 级别 | 文件与行号 | 触发条件 | 实际影响 | 处理结论 | 状态 | 复验证据 |",
    )
    if not rows:
        raise ValidationError("Findings 表不能为空；无问题时填写一行“无”")
    for row in rows:
        if len(row) != 8:
            raise ValidationError(f"Finding 行无效：{row}")
        if row[0] == "无":
            continue
        if row[1] not in FINDING_LEVELS or row[6] not in FINDING_STATUSES:
            raise ValidationError(f"Finding 级别或状态无效：{row}")
        if require_ready and row[1] in {"P0", "P1"} and row[6] != "已修复":
            raise ValidationError(f"存在未修复的 {row[1]}：{row[0]}")
        if require_ready and row[1] == "P2" and row[6] not in {"已修复", "已接受", "不适用"}:
            raise ValidationError(f"P2 缺少处理结论：{row[0]}")
    if require_ready and status != "通过":
        raise ValidationError("Review 尚未通过")


def main() -> int:
    args = parse_args()
    try:
        repo = args.repo.expanduser().resolve()
        if git(repo, "rev-parse", "--show-toplevel") != str(repo):
            raise ValidationError("--repo 必须指向 Git 仓库根目录")
        design_path, design_content = read_file(args.design, "design.md")
        plan_path, plan = read_file(args.plan, "plan.md")
        test_path, test_report = read_file(args.test_report, "test-report.md")
        review_path, review_report = read_file(args.review_report, "review-report.md")
        design_hash = hashlib.sha256(design_content.encode("utf-8")).hexdigest()
        repository_name, branch, _revision = validate_common(
            [plan, test_report, review_report], args.kind, design_hash
        )
        if repository_name != repo.name:
            raise ValidationError(
                f"产物仓库名与 --repo 不一致：{repository_name} != {repo.name}"
            )
        actual_branch = git(repo, "branch", "--show-current")
        if branch != actual_branch:
            raise ValidationError(f"产物分支与当前分支不一致：{branch} != {actual_branch}")
        head = git(repo, "rev-parse", "HEAD")
        fingerprint = actual_fingerprint(repo)
        validate_plan(plan, args.require_ready)
        validate_test_report(test_report, args.kind, head, fingerprint, args.require_ready)
        validate_review_report(review_report, head, fingerprint, args.require_ready)
    except (OSError, ValidationError) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    print(
        f"校验通过：{plan_path.parent}（{args.kind}，design={design_path.name}，HEAD={head[:12]}）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
