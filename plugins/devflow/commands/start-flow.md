---
description: 从本地 PRD 启动 devflow 完整开发流程
allowed-tools: Read, Write, Edit, Glob, Grep, WebFetch, AskUserQuestion, Bash
---

你正在执行 devflow 的完整流程入口。

按以下顺序执行：

1. 从用户输入提取本地 PRD 路径；缺失时追问。读取并确认它是本地文件，不接受 URL。
2. 定位工作区根目录（含 `workspace.toml`），创建或复用 `worktree/<需求>/docs/`，将 PRD 写入 `worktree/<需求>/docs/prd.md`。需求名必须安全且是单层目录名。
3. 仅当该需求目录含 `docs/prd.md` 或 `docs/flow-state.json` 时将其纳入流程扫描；始终忽略 `worktree/_internal/`。
4. 调用 `dev-flow` skill 的完整编排，直接执行 `requirement-clarification`。用户确认需求澄清产物后进入 `high-level-design`。
5. 概要设计通过校验并获得用户确认后，按概要设计的改动仓库得到 `name:kind` 列表，执行：

   ```bash
   python3 "$workspace/plugins/devflow/scripts/prepare_requirement.py" \
     --root "$workspace" \
     --requirement "$requirement" \
     --repository "$name:$kind"
   ```

   每个目标仓库必须传入一个 `--repository`。不得手工创建工作树、需求分支或状态文件。
6. 只有准备命令成功、`docs/flow-state.json` 已生成且顶层 `repositories[]` 的每项工作树均可用时，才调用已注册的 `detailed-design`。详细设计入口会按 `repositories[].kind` 加载前端或后端知识库，并为每个仓库生成一份 `design.md`。
7. 全部目标仓库的详细设计确认并具备集中产物后，调用已注册的 `implementation`。实施入口会先执行 `ensure_baseline.py` 做只读基线验证，通过后再逐仓完成编码、自测和 Review。

状态文件中仓库元数据只位于顶层 `repositories[]`；阶段对象只写 `status`、`confirmed`、`output`、`outputs`、`blockedReason`。任一命令失败或产物缺失时停止，不得绕过门禁。
