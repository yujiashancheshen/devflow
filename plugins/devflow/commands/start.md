---
description: 扫描 devflow 真实需求并恢复到下一个可执行阶段
---

使用 `dev-flow` skill 扫描并恢复流程：

1. 定位工作区根目录（含 `workspace.toml`）。
2. 只扫描 `worktree/` 直接子目录；忽略 `worktree/_internal/`；仅识别含 `docs/prd.md` 或 `docs/flow-state.json` 的需求目录。
3. 对每个需求，读取集中产物和存在时的 `docs/flow-state.json`。仓库信息只能从顶层 `repositories[]` 读取，阶段对象只读取允许字段。
4. 以以下集中产物判定实际进度：`docs/需求澄清问题列表.md`、`docs/概要设计文档.md`、逐仓 `docs/detailed-design/<仓库>/design.md`、逐仓 `docs/implementation/<仓库>/plan.md`、`test-report.md` 和 `review-report.md`。
5. 只建议或调用第一个未完成、已具备前置条件且未阻断的已注册阶段：需求澄清加强、概要设计、详细设计、实施、E2E 联调。
6. 概要设计已确认但没有状态文件时，先执行 `prepare_requirement.py`。该命令成功创建工作树、冻结基线并生成顶层 `repositories[]` 后，才允许进入统一详细设计入口。
7. 报告每个真实需求的当前阶段、已验证产物、阻断原因和下一步；不得将临时目录或缺少 PRD/状态文件的目录报告为需求。
