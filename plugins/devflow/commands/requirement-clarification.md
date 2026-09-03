---
description: 执行 devflow 的需求澄清阶段入口
allowed-tools: Read, Write, Edit, Glob, Grep, WebFetch, AskUserQuestion, Bash
---

你正在执行 devflow 的 `requirement-clarification` 阶段入口。

按以下顺序执行：

1. 尝试读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`；文件不存在时，按当前 `requirement-clarification` 阶段独立执行，不要求先启动完整流程。
2. 状态文件存在时检查 `currentStage`；如果不匹配，只提示记录的阶段与当前入口不同，不阻断当前阶段执行。
3. 先在当前工作区及状态文件记录的路径中定位与 PRD 对应的真实代码。当前目录不是 Git 仓库时，将其视为可能包含多个代码模块的工作区；先盘点根目录中的真实目录和符号链接，对链接目标使用 `rg --follow`、`find -L` 或解析后的真实路径进行搜索。完成模块盘点和 PRD 关键词搜索后仍找不到或无法确认相关仓库时，才调用 `AskUserQuestion` 弹窗，请用户通过 `Other/自行输入` 提供一个或多个代码库路径，然后暂停；不得只用普通文本索要路径，也不得生成最终 `需求澄清问题列表.md`。
4. 按照 `plugins/devflow/skills/requirement-clarification/SKILL.md` 执行。
5. 只有状态文件存在且用户确认阶段完成时，才把该阶段标记为 `completed`，并把 `currentStage` 更新为 `high-level-design`。
6. 结束响应前确认已实际读取相关代码，并已生成和重新读取最终的 `需求澄清问题列表.md`；向用户说明 PRD 是否存在待确认问题、问题数量、检查范围和产物绝对路径。
