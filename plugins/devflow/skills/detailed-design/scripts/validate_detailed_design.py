#!/usr/bin/env python3
"""Validate a DevFlow per-repository detailed design."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


KINDS = {"backend", "frontend"}
READINESS_VALUES = {"可实施", "部分可实施", "阻断"}
COMMON_HEADINGS = [
    "## 1 输入与基线",
    "## 2 当前代码事实",
    "## 3 本仓变更范围",
    "## 4 详细方案",
    "## 5 跨仓契约与依赖",
    "## 6 验收与验证计划",
    "## 7 风险、阻断与开发准入",
]
KIND_HEADINGS = {
    "backend": [
        "### 4.1 数据与领域",
        "### 4.2 HTTP 与 RPC",
        "### 4.3 MQ 与任务",
        "### 4.4 事务、幂等与异常",
    ],
    "frontend": [
        "### 4.1 页面、路由与组件",
        "### 4.2 状态与数据流",
        "### 4.3 接口消费与字段映射",
        "### 4.4 UI 与视觉",
    ],
}
EVIDENCE_HEADER = "| 对象 | 当前职责或行为 | 代码证据 | 核对状态 |"
CHANGE_HEADER = "| 文件/目录 | 修改类型 | 当前事实 | 目标变化 | 依据 |"
CONTRACT_HEADER = "| 契约 | 角色 | 当前定义 | 目标变化 | 兼容策略 | 责任方 |"
SCENARIO_HEADER = "| 场景 ID | 来源 | 场景 | 验证方式 | 可观察结果 | 优先级 |"
CHANGE_TYPES = {"新增", "修改", "删除", "复用"}
VERIFICATION_METHODS = {
    "api-entry",
    "page-mock",
    "unit",
    "integration-e2e",
    "manual",
}
CODE_EVIDENCE_PATTERN = re.compile(r"`[^`\n]+/[^`\n]+:[^`\n]+`")
SCENARIO_ID_PATTERN = re.compile(r"[A-Z]{2,5}-\d+\Z")
WINDOWS_ABS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:\\")
LEGACY_OUTPUT_PATTERN = re.compile(
    r"docs/detailed-design/[^\s)]+/(frontend|backend)\.md"
)


class ValidationError(Exception):
    """Raised when a detailed design violates the delivery contract."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验 DevFlow 单仓详细设计")
    parser.add_argument("--kind", choices=sorted(KINDS), required=True)
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="要求开发准入结论为可实施",
    )
    parser.add_argument("document", type=Path)
    return parser.parse_args()


def read_document(path: Path) -> tuple[Path, str]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValidationError(f"文档不存在：{resolved}")
    if resolved.name != "design.md":
        raise ValidationError("详细设计文件名必须为 design.md")
    try:
        return resolved, resolved.read_text(encoding="utf-8")
    except OSError as error:
        raise ValidationError(f"读取文档失败：{error}") from error


def metadata_value(content: str, label: str) -> str:
    pattern = re.compile(
        rf"^>\s*{re.escape(label)}：\s*`?([^`\n]+)`?\s*$",
        re.MULTILINE,
    )
    match = pattern.search(content)
    if not match:
        raise ValidationError(f"缺少元数据：{label}")
    value = match.group(1).strip()
    if not value or "<" in value:
        raise ValidationError(f"元数据未填写：{label}")
    return value


def validate_metadata(content: str, kind: str, require_ready: bool) -> str:
    repository = metadata_value(content, "仓库")
    actual_kind = metadata_value(content, "仓库类型")
    branch = metadata_value(content, "分支")
    baseline = metadata_value(content, "基线")
    readiness = metadata_value(content, "开发准入")

    if actual_kind != kind:
        raise ValidationError(f"仓库类型与 --kind 不一致：{actual_kind} != {kind}")
    if actual_kind not in KINDS:
        raise ValidationError(f"不支持的仓库类型：{actual_kind}")
    if readiness not in READINESS_VALUES:
        raise ValidationError(f"非法开发准入结论：{readiness}")
    if require_ready and readiness != "可实施":
        raise ValidationError(f"当前开发准入不是可实施：{readiness}")
    if branch in {"main", "master", "develop", "dev"}:
        raise ValidationError(f"详细设计不能基于受保护分支：{branch}")
    if not re.fullmatch(r"[^@\s]+@[0-9a-fA-F]{40}", baseline):
        raise ValidationError("基线必须使用 <baselineBranch>@<baselineSha>")
    if "/" in repository or "\\" in repository:
        raise ValidationError("仓库名必须是单层目录名")
    return readiness


def validate_headings(content: str, kind: str) -> None:
    cursor = -1
    for heading in COMMON_HEADINGS:
        index = content.find(heading)
        if index < 0:
            raise ValidationError(f"缺少固定章节：{heading}")
        if index <= cursor:
            raise ValidationError(f"固定章节顺序错误：{heading}")
        cursor = index

    detail_section = find_section(
        content, "## 4 详细方案", "## 5 跨仓契约与依赖"
    )
    kind_cursor = -1
    for heading in KIND_HEADINGS[kind]:
        index = detail_section.find(heading)
        if index < 0:
            raise ValidationError(f"缺少 {kind} 专项章节：{heading}")
        if index <= kind_cursor:
            raise ValidationError(f"{kind} 专项章节顺序错误：{heading}")
        kind_cursor = index


def find_section(content: str, heading: str, next_heading: str | None) -> str:
    start = content.find(heading)
    if start < 0:
        return ""
    start += len(heading)
    end = len(content) if next_heading is None else content.find(next_heading, start)
    if end < 0:
        end = len(content)
    return content[start:end]


def extract_table_rows(section: str, header: str) -> list[list[str]]:
    lines = section.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != header:
            continue
        rows: list[list[str]] = []
        for row_line in lines[index + 2 :]:
            stripped = row_line.strip()
            if not stripped.startswith("|"):
                break
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if any(cells):
                rows.append(cells)
        return rows
    raise ValidationError(f"缺少固定表头：{header}")


def validate_evidence(content: str) -> None:
    section = find_section(content, "## 2 当前代码事实", "## 3 本仓变更范围")
    rows = extract_table_rows(section, EVIDENCE_HEADER)
    if not rows:
        raise ValidationError("当前代码事实表缺少证据行")
    for row in rows:
        if len(row) != 4:
            raise ValidationError("当前代码事实表存在列数错误")
        if not CODE_EVIDENCE_PATTERN.search(row[2]):
            raise ValidationError(f"代码证据格式错误：{row[2]}")


def validate_changes(content: str) -> None:
    section = find_section(content, "## 3 本仓变更范围", "## 4 详细方案")
    rows = extract_table_rows(section, CHANGE_HEADER)
    if not rows:
        raise ValidationError("本仓变更范围表缺少文件或目录")
    for row in rows:
        if len(row) != 5:
            raise ValidationError("本仓变更范围表存在列数错误")
        if row[1] not in CHANGE_TYPES:
            raise ValidationError(f"非法修改类型：{row[1]}")
        if not row[0] or not row[3] or not row[4]:
            raise ValidationError("变更范围必须填写文件、目标变化和依据")


def validate_contracts(content: str) -> None:
    section = find_section(
        content, "## 5 跨仓契约与依赖", "## 6 验收与验证计划"
    )
    rows = extract_table_rows(section, CONTRACT_HEADER)
    if not rows:
        raise ValidationError("跨仓契约表缺少结论行")
    for row in rows:
        if len(row) != 6:
            raise ValidationError("跨仓契约表存在列数错误")
        if row[0] == "无":
            continue
        if not row[3] or not row[4] or not row[5]:
            raise ValidationError("契约必须填写目标变化、兼容策略和责任方")


def validate_scenarios(content: str) -> None:
    section = find_section(
        content, "## 6 验收与验证计划", "## 7 风险、阻断与开发准入"
    )
    rows = extract_table_rows(section, SCENARIO_HEADER)
    if not rows:
        raise ValidationError("验收与验证计划缺少场景")
    for row in rows:
        if len(row) != 6:
            raise ValidationError("验收与验证计划表存在列数错误")
        if not SCENARIO_ID_PATTERN.fullmatch(row[0]):
            raise ValidationError(f"场景 ID 格式错误：{row[0]}")
        if row[3] not in VERIFICATION_METHODS:
            raise ValidationError(f"非法验证方式：{row[3]}")
        if not row[1] or not row[4]:
            raise ValidationError(f"{row[0]} 缺少来源或可观察结果")


def validate_readiness_consistency(content: str, readiness: str) -> None:
    section = find_section(content, "## 7 风险、阻断与开发准入", None)
    match = re.search(r"^-\s*结论：\s*`?([^`\n]+)`?\s*$", section, re.MULTILINE)
    if not match:
        raise ValidationError("风险章节缺少“- 结论：”")
    section_readiness = match.group(1).strip()
    if section_readiness != readiness:
        raise ValidationError(
            f"顶部与风险章节的开发准入结论不一致：{readiness} != {section_readiness}"
        )


def validate_no_legacy_or_absolute_paths(content: str) -> None:
    if "/Users/" in content or WINDOWS_ABS_PATH_PATTERN.search(content):
        raise ValidationError("文档中包含本机绝对路径")
    match = LEGACY_OUTPUT_PATTERN.search(content)
    if match:
        raise ValidationError(f"文档中包含旧详细设计产物名：{match.group(0)}")


def validate_document(path: Path, kind: str, require_ready: bool) -> tuple[Path, str]:
    resolved, content = read_document(path)
    readiness = validate_metadata(content, kind, require_ready)
    validate_headings(content, kind)
    validate_no_legacy_or_absolute_paths(content)
    validate_evidence(content)
    validate_changes(content)
    validate_contracts(content)
    validate_scenarios(content)
    validate_readiness_consistency(content, readiness)
    return resolved, readiness


def main() -> int:
    args = parse_args()
    try:
        resolved, readiness = validate_document(
            args.document, args.kind, args.require_ready
        )
    except ValidationError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    print(f"校验通过：{resolved}（{args.kind}，{readiness}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
