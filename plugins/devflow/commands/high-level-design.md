---
description: 执行 devflow 的概要设计阶段入口
allowed-tools: Read, Write, Edit, Glob, Grep, WebFetch, AskUserQuestion, Bash
---

你正在执行 devflow 的 `high-level-design` 阶段入口。

按以下顺序执行：

1. 尝试读取需求集中状态文件 `worktree/<需求>/docs/flow-state.json`；文件不存在时，按当前 `high-level-design` 阶段独立执行，不要求先启动完整流程。
2. 状态文件存在时检查 `currentStage`；不匹配时提示记录与当前入口不同，但不阻断当前阶段执行。
3. 按照 `plugins/devflow/skills/high-level-design/SKILL.md` 执行；定稿前必须运行概要设计结构校验并通过。
4. 用户确认概要设计完成后，完整流程必须从概要设计的“改动模块”提取每个目标 Git 仓库的稳定 `name` 与唯一 `kind`（仅 `backend` 或 `frontend`）。同一仓库只保留一个 `name:kind`，不得从阶段对象、历史分支或目录结构补充仓库信息。
5. 对所有目标仓库执行一次真实准备命令，每个仓库传一个 `--repository`：

   ```bash
   python3 "$workspace/plugins/devflow/scripts/prepare_requirement.py" \
     --root "$workspace" \
     --requirement "$requirement" \
     --repository "$name:$kind"
   ```

   不得使用 `--dry-run` 代替准备。脚本失败时立即阻断，不创建、切换、删除、重建或 reset 分支和工作树；不得进入详细设计。
6. 准备命令成功后，重新读取 `docs/flow-state.json`，验证顶层 `repositories[]` 与目标 `name:kind` 一致，且每项的 `featureBranch`、`worktreePath`、`baselineBranch`、`baselineSha` 均存在。只有此时，才以 `status`、`confirmed`、`output` 或 `outputs` 更新 `stages.high-level-design` 为 `completed`。不适用轨道只标记 `status: not_applicable`，不得在任何阶段对象读写仓库元数据。
7. 调用已注册的统一详细设计入口 `detailed-design`。该入口仅根据顶层 `repositories[].kind` 按需加载前端或后端知识库；任一仓库阻断时停止，不得进入实施阶段。
