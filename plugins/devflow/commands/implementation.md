---
description: 执行 DevFlow 的实施阶段入口，包含编码、自测和 Review
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

你正在执行 DevFlow 的 `implementation` 阶段入口。

按以下顺序执行：

1. 读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`。完整流程缺少该文件时立即阻断；独立执行时必须由用户明确提供 PRD、详细设计、目标仓库和 diff 范围。
2. 状态文件存在时检查 `currentStage`；如果不匹配，只提示记录的阶段与当前入口不同，但在完成门禁前不得修改代码。
3. 编码前必须实际执行只读基线校验：

   ```bash
   python3 "$workspace/plugins/devflow/scripts/ensure_baseline.py" \
     --root "$workspace" \
     --requirement "$requirement"
   ```

4. 重新读取状态文件。逐仓只从顶层 `repositories[]` 读取 `name`、`kind`、`featureBranch`、`worktreePath`、`baselineBranch`、`baselineSha`；校验需求工作树当前分支与 `featureBranch` 一致，且不处于 `main`、`master`、`develop`、`dev`。
5. 检查集中详细设计产物：每个目标仓库必须有 `docs/detailed-design/<name>/design.md`，`stages.detailed-design` 必须为 `completed` 且 `confirmed: true`，并使用详细设计校验器确认开发准入为 `可实施`。缺少任一条件时停止。
6. 按照 `plugins/devflow/skills/implementation/SKILL.md` 执行。该 Skill 会按 `kind` 加载前端或后端知识库，并为每个仓库完成编码、自测和 Review，输出：

   ```text
   worktree/<需求>/docs/implementation/<仓库>/plan.md
   worktree/<需求>/docs/implementation/<仓库>/test-report.md
   worktree/<需求>/docs/implementation/<仓库>/review-report.md
   ```

7. 逐仓运行实施产物校验器：

   ```bash
   python3 "$workspace/plugins/devflow/skills/implementation/scripts/validate_implementation.py" \
     --kind "$kind" \
     --repo "$workspace/worktree/$requirement/$worktreePath" \
     --design "$workspace/worktree/$requirement/docs/detailed-design/$name/design.md" \
     --require-ready \
     "$workspace/worktree/$requirement/docs/implementation/$name/plan.md" \
     "$workspace/worktree/$requirement/docs/implementation/$name/test-report.md" \
     "$workspace/worktree/$requirement/docs/implementation/$name/review-report.md"
   ```

8. 只有全部产物校验通过且用户确认实施完成时，才以 `status`、`confirmed` 和 `outputs` 更新 `stages.implementation` 为 `completed`，并将 `currentStage` 更新为 `e2e-testing`。
9. 阻断时仅使用 `status: blocked` 与 `blockedReason`，不得写入 `coding` 或 `code-review` 阶段对象。
