---
description: 执行 DevFlow 的详细设计阶段入口
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, WebFetch, AskUserQuestion
---

你正在执行 DevFlow 的 `detailed-design` 阶段入口。

按以下顺序执行：

1. 尝试读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`；完整流程中该文件必须存在，独立执行时由用户明确提供 PRD、概要设计、目标仓库和仓库类型。
2. 状态文件存在时检查 `currentStage`；如果不匹配，只提示记录的阶段与当前入口不同，不阻断当前阶段执行。
3. 从顶层 `repositories[]` 读取目标仓库，不从阶段对象、目录名或历史分支猜测仓库信息。
4. 逐仓校验 `featureBranch`、`worktreePath`、`baselineBranch`、`baselineSha` 和当前分支，当前分支不得为 `main`、`master`、`develop`、`dev`。
5. 按照 `plugins/devflow/skills/detailed-design/SKILL.md` 执行。该 Skill 会按 `kind` 加载前端或后端知识库，并为每个仓库生成：

   ```text
   worktree/<需求>/docs/detailed-design/<仓库>/design.md
   ```

6. 逐仓运行 `validate_detailed_design.py --kind <kind> --require-ready <design.md>`。只有状态文件存在、全部目标仓库校验通过且结论均为“可实施”、跨仓契约一致并经用户确认时，才以 `status`、`confirmed` 和 `outputs` 更新 `stages.detailed-design`，并将 `currentStage` 更新为 `implementation`。
7. 阻断时仅使用 `status: blocked` 与 `blockedReason`，不得写入仓库级阶段对象。
