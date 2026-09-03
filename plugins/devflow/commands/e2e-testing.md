---
description: 执行 devflow 的 E2E 测试阶段入口
allowed-tools: Read, Write, Bash
---

你正在执行 devflow 的 `e2e-testing` 阶段入口。

按以下顺序执行：

1. 尝试读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`；文件不存在时，按当前 `e2e-testing` 阶段独立执行，不要求先启动完整流程。
2. 状态文件存在时检查 `currentStage`；如果不匹配，只提示记录的阶段与当前入口不同，不阻断当前阶段执行。
3. 按照 `plugins/devflow/skills/e2e-testing/SKILL.md` 执行。
4. 只有状态文件存在且用户确认阶段完成时，才把该阶段标记为 `completed`，并告知当前流程已完成。
