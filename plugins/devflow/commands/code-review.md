---
description: 独立执行 DevFlow Code Review，主流程中由 implementation 阶段调用
allowed-tools: Read, Write, Glob, Grep, Bash
---

你正在执行 DevFlow 的 `code-review` 独立审查入口。

主流程中 Code Review 属于 `implementation` 阶段，不单独推进 `currentStage`。用户明确要求单独审查时，按以下顺序执行：

1. 尝试读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`；文件不存在时，要求用户提供 PRD、概要设计、详细设计、目标仓库和 diff 范围。
2. 状态文件存在时，从顶层 `repositories[]` 读取仓库信息，不从阶段对象读取仓库元数据。
3. 检查每个目标仓库对应的 `docs/detailed-design/<仓库>/design.md`、`docs/implementation/<仓库>/plan.md` 和 `test-report.md`。
4. 按照 `plugins/devflow/skills/code-review/SKILL.md` 执行。该 Skill 会按 `kind` 加载知识库和统一专项参考，并输出 Review Findings。
5. 独立审查可以写入 `worktree/<需求>/docs/code-review-报告.md`。主流程调用时，结果应写入 `docs/implementation/<仓库>/review-report.md`。
6. 本入口不自动修改业务代码，不自动进入 E2E，也不更新 `currentStage`。需要修复时回到 `/devflow:implementation`。
