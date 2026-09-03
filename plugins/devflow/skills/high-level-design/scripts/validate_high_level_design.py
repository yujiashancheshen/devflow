#!/usr/bin/env python3
"""Validate the DevFlow five-chapter high-level design structure."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REPO_TYPE_VALUES = {"前端", "后端"}
REQUIRED_HEADINGS = [
    "## 一 需求概述",
    "### 1.1 目标与范围",
    "### 1.2 核心规则与边界",
    "## 二 核心方案",
    "## 三 仓库协作与契约变化",
    "## 四 影响与风险",
    "## 五 发布与验证",
    "### 5.1 发布顺序与回滚",
    "### 5.2 准入与验收场景",
]
CHANGE_HEADER = "| Git 仓库 | 模块类型 | 本次职责边界 | 变更范围 | 依据 |"
DEPENDENCY_HEADER = (
    "| 改动 Git 仓库 | 依赖 Git 仓库 | 依赖模块类型 | 依赖能力 | "
    "依赖方式 | 依赖仓库是否改动 | 依据 |"
)
CONTRACT_HEADER = "| 调用方 | 提供方 | 协作方式 | 变化内容 | 兼容策略 | 责任方 |"
SCENARIO_HEADER = "| 场景 ID | 类型 | 场景 | 前置条件 | 操作 | 可观察结果 | 验证层级 |"
WINDOWS_ABS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:\\")
LEGACY_MAJOR_HEADING_PATTERN = re.compile(
    r"^##\s+(六|七|八|五\s+接口文档)\b", re.MULTILINE
)


class ValidationError(Exception):
    """Raised when a high-level design violates the required structure."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="校验 DevFlow 概要设计文档结构")
    parser.add_argument("document", type=Path, help="概要设计文档路径")
    return parser.parse_args()


def read_document(path: Path) -> tuple[Path, str]:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise ValidationError(f"文档不存在：{resolved}")
    try:
        return resolved, resolved.read_text(encoding="utf-8")
    except OSError as error:
        raise ValidationError(f"读取文档失败：{error}") from error


def validate_headings(content: str) -> None:
    cursor = -1
    for heading in REQUIRED_HEADINGS:
        index = content.find(heading)
        if index < 0:
            raise ValidationError(f"缺少固定章节：{heading}")
        if index <= cursor:
            raise ValidationError(f"固定章节顺序错误：{heading}")
        cursor = index
    match = LEGACY_MAJOR_HEADING_PATTERN.search(content)
    if match:
        raise ValidationError(f"发现旧版八章结构标题：{match.group(0)}")


def find_section(content: str, heading: str, next_heading: str | None) -> str:
    start = content.find(heading)
    if start < 0:
        return ""
    start += len(heading)
    end = len(content) if next_heading is None else content.find(next_heading, start)
    if end < 0:
        end = len(content)
    return content[start:end]


def validate_core_sections(content: str) -> None:
    section_pairs = [
        ("## 二 核心方案", "## 三 仓库协作与契约变化"),
        ("## 三 仓库协作与契约变化", "## 四 影响与风险"),
        ("## 四 影响与风险", "## 五 发布与验证"),
        ("### 5.1 发布顺序与回滚", "### 5.2 准入与验收场景"),
    ]
    for heading, next_heading in section_pairs:
        body = find_section(content, heading, next_heading).strip()
        if not body or body in {"无", "不适用"}:
            raise ValidationError(f"章节缺少有效结论：{heading}")


def validate_no_absolute_paths(content: str) -> None:
    if "/Users/" in content:
        raise ValidationError("文档中包含本机绝对路径 /Users/")
    if WINDOWS_ABS_PATH_PATTERN.search(content):
        raise ValidationError("文档中包含 Windows 绝对路径")


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
            rows.append([cell.strip() for cell in stripped.strip("|").split("|")])
        return rows
    raise ValidationError(f"缺少固定表头：{header}")


def is_empty_row(row: list[str]) -> bool:
    return not any(cell.strip() for cell in row)


def validate_module_tables(content: str) -> None:
    section = find_section(content, "### 1.1 目标与范围", "### 1.2 核心规则与边界")
    change_rows = [
        row for row in extract_table_rows(section, CHANGE_HEADER) if not is_empty_row(row)
    ]
    if not change_rows:
        raise ValidationError("改动模块表缺少结论行")

    repository_names: list[str] = []
    for row in change_rows:
        if len(row) != 5:
            raise ValidationError("改动模块表存在列数错误")
        if row[0] == "无":
            continue
        repository_names.append(row[0])
        if row[1] not in REPO_TYPE_VALUES:
            raise ValidationError(f"改动模块表存在非法模块类型：{row[1]}")
    duplicates = sorted(
        {name for name in repository_names if repository_names.count(name) > 1}
    )
    if duplicates:
        raise ValidationError(f"改动模块表存在重复 Git 仓库：{', '.join(duplicates)}")

    dependency_rows = [
        row
        for row in extract_table_rows(section, DEPENDENCY_HEADER)
        if not is_empty_row(row)
    ]
    if not dependency_rows:
        raise ValidationError("依赖模块表缺少结论行")
    for row in dependency_rows:
        if len(row) != 7:
            raise ValidationError("依赖模块表存在列数错误")
        if row[0] == "无":
            continue
        if row[2] not in REPO_TYPE_VALUES:
            raise ValidationError(f"依赖模块表存在非法模块类型：{row[2]}")
        if row[5] not in {"是", "否"}:
            raise ValidationError(
                f"依赖模块表“依赖仓库是否改动”只能为 是/否：{row[5]}"
            )


def validate_contract_table(content: str) -> None:
    section = find_section(
        content, "## 三 仓库协作与契约变化", "## 四 影响与风险"
    )
    rows = [
        row for row in extract_table_rows(section, CONTRACT_HEADER) if not is_empty_row(row)
    ]
    if not rows:
        raise ValidationError("仓库协作与契约变化表缺少结论行")
    for row in rows:
        if len(row) != 6:
            raise ValidationError("仓库协作与契约变化表存在列数错误")
        if row[0] == "无":
            continue
        if not row[3] or not row[4] or not row[5]:
            raise ValidationError("契约变化必须填写变化内容、兼容策略和责任方")


def validate_scenarios(content: str) -> None:
    section = find_section(content, "### 5.2 准入与验收场景", None)
    rows = [
        row for row in extract_table_rows(section, SCENARIO_HEADER) if not is_empty_row(row)
    ]
    if not rows:
        raise ValidationError("准入与验收场景表缺少场景")

    seen_ac = False
    seen_vc = False
    for row in rows:
        if len(row) != 7:
            raise ValidationError("准入与验收场景表存在列数错误")
        scenario_id, scenario_type = row[0], row[1]
        if scenario_id.startswith("AC-"):
            seen_ac = True
            if scenario_type != "准入":
                raise ValidationError(f"{scenario_id} 的类型必须为“准入”")
        elif scenario_id.startswith("VC-"):
            seen_vc = True
            if scenario_type != "验收":
                raise ValidationError(f"{scenario_id} 的类型必须为“验收”")
        else:
            raise ValidationError(f"场景 ID 必须使用 AC-* 或 VC-*：{scenario_id}")
        if not row[5]:
            raise ValidationError(f"{scenario_id} 缺少可观察结果")

    if not seen_ac:
        raise ValidationError("缺少 AC-* 准入场景")
    if not seen_vc:
        raise ValidationError("缺少 VC-* 验收场景")


def validate_document(path: Path) -> Path:
    resolved, content = read_document(path)
    validate_headings(content)
    validate_core_sections(content)
    validate_no_absolute_paths(content)
    validate_module_tables(content)
    validate_contract_table(content)
    validate_scenarios(content)
    return resolved


def main() -> int:
    args = parse_args()
    try:
        resolved = validate_document(args.document)
    except ValidationError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    print(f"校验通过：{resolved}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
