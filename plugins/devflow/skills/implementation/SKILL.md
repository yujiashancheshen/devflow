---
name: implementation
description: 当用户进入 DevFlow 实施阶段，或需要基于详细设计 spec 对一个或多个 Git 仓库完成编码、自测和 Code Review 修复时使用。该 Skill 是实施阶段唯一入口，不区分前端和后端；按仓库 kind 加载对应知识库和参考规则。
---

# Implementation

实施阶段负责把 `detailed-design` 产出的 `design.md` 变成可验证的代码改动。

本阶段包含编码、自测和 Review。Code Review 不再作为完整流程里的独立阶段存在，而是实施阶段的质量门。需要单独审查时仍可调用 `code-review` Skill，但主流程只通过 `implementation` 进入联调。

## 输入

必须读取：

- `worktree/<需求名>/docs/prd.md`。
- `worktree/<需求名>/docs/概要设计文档.md`。
- 每个目标仓库的 `worktree/<需求名>/docs/detailed-design/<仓库名>/design.md`。
- `worktree/<需求名>/docs/flow-state.json` 中的顶层 `repositories[]`。
- 目标仓库需求工作树 `worktree/<需求名>/<仓库名>/`。
- `knowledge/architecture/`。
- `knowledge/engineering/testing.md`。

按需读取：

- 后端仓库读取 `knowledge/engineering/backend.md` 和 `knowledge/engineering/sql.md`。
- 前端仓库读取 `knowledge/engineering/frontend.md`。
- 已有计划或报告、任务中断恢复、设计或代码变化时读取 `references/evidence-and-resume.md`。
- 前端范围包含 UI、页面状态或视觉来源时读取 `references/frontend-ui.md`。
- 复杂纯逻辑、算法、解析器、状态计算或缺陷回归需要 RED/GREEN 时读取 `references/tdd-workflow.md`。
- Review 时调用统一 `code-review`，由它按仓库类型加载专项参考。

## 输出

每个仓库输出：

```text
worktree/<需求名>/docs/implementation/<仓库名>/plan.md
worktree/<需求名>/docs/implementation/<仓库名>/test-report.md
worktree/<需求名>/docs/implementation/<仓库名>/review-report.md
```

前端如有视觉还原或截图检查，输出到：

```text
worktree/<需求名>/docs/implementation/<仓库名>/visual/<页面>/
```

业务代码只能修改 `worktree/<需求名>/<仓库名>/`。禁止修改 `codebase/`，禁止把流程产物写入业务仓库的 `docs/` 或 `.claude/docs/`。

## 实施前门禁

开始修改代码前必须确认：

- `ensure_baseline.py` 执行成功，需求分支包含冻结基线。
- 每个目标仓库当前分支等于 `featureBranch`。
- 当前分支不是 `main`、`master`、`develop`、`dev`。
- 每个目标仓库都有 `docs/detailed-design/<仓库名>/design.md`。
- `stages.detailed-design.status` 为 `completed` 且 `confirmed` 为 `true`。
- 详细设计校验通过且开发准入结论为 `可实施`。
- 工作区没有与当前需求无关的高风险改动。

任一条件不满足时停止，不进入编码。

## 知识库加载规则

| 仓库类型 | 必读知识库 | 实施重点 |
|---|---|---|
| backend | `knowledge/architecture/`、`knowledge/engineering/backend.md`、`knowledge/engineering/testing.md` | 按设计实现，并以接口或业务入口级 Mock 测试验证可观察行为 |
| frontend | `knowledge/architecture/`、`knowledge/engineering/frontend.md`、`knowledge/engineering/testing.md` | 按设计实现，并以页面级 Mock 测试验证用户可观察行为 |

真实代码是当前事实，知识库是目标工程规范，`design.md` 是本需求 Spec。代码变化导致设计失效时返回详细设计；设计与工程规范冲突时暂停并修订设计。实施阶段不得让任一方静默覆盖另外两方。

## 执行流程

### 1. 生成单仓实施计划

每个仓库先写 `plan.md`，计划只回答三件事：

- 改哪些生产代码文件。
- 按什么顺序实现。
- 每个任务如何通过验收场景和 Review 验证。

使用 `assets/plan.md` 作为结构模板。

按可独立验证的行为和依赖关系拆分任务，避免过大或过碎。同一行为的测试和生产实现放在同一个任务里，不把“最后补测试”作为独立任务。

计划默认是可审计执行产物，生成后可继续实施。只有计划改变详细设计范围或契约、引入高风险操作、改变关键实施顺序，或需要新的产品与技术选择时才暂停并请用户确认。

### 2. 按计划编码和自测

逐任务实现。每个任务都要留下 fresh 验证证据。

后端按 `knowledge/engineering/testing.md` 从接口或业务入口验证，保留真实内部链路，只 Mock 外部边界。不要为简单函数和已被入口测试覆盖的内部实现重复补测试。

前端按 `knowledge/engineering/testing.md` 从真实页面入口使用 fixture/API Mock 验证页面行为。不要为已被页面测试覆盖的组件、hooks 和工具函数重复补测试。涉及 UI 来源时先完成静态或 Mock 视觉还原，再接入业务逻辑。

如果实施中发现详细设计与代码事实冲突，暂停受影响任务，回到详细设计更新 `design.md`，不得静默改变接口契约、页面边界、数据归属或核心业务规则。

### 3. 生成 test-report.md

使用 `assets/test-report.md` 作为结构模板。

`test-report.md` 必须记录：

- 当前仓库、分支、最终 HEAD、详细设计路径和内容指纹。
- 计划修订号和最终工作区指纹。
- 每个计划任务的完成状态。
- 每条验收场景的测试入口、Mock 边界、命令、结果和时间。
- 未覆盖场景、失败原因和剩余风险。
- 人工验证或联调验证的范围和证据。

没有执行的测试不能写成通过。无法自动化的验证必须写清人工验证方式。

### 4. 执行 Code Review

实施阶段必须对当前需求 diff 做 Review。

Review 范围包括：

- 代码是否按 `design.md` 实现。
- 是否违反对应工程知识库。
- 是否引入权限、数据一致性、并发、兼容性、异常态或用户体验问题。
- 测试报告是否可信。
- 是否有调试代码、秘密、无关格式化、生成物污染或生产路径 mock。

Review 使用 `assets/review-report.md` 作为结构模板。发现 P0/P1 时必须修复并重新验证；P2 必须标记为已修复、已接受或不适用。

每轮修复后必须重新计算最终 HEAD 和工作区指纹，重跑受影响测试，更新 `test-report.md`，重新 Review，并在 `review-report.md` 记录 Finding 的处理与复验结果。最终报告不得引用修复前的验证状态。

### 5. 汇总阶段结果

所有目标仓库完成后，输出实施阶段总结：

- 已改仓库。
- 每仓 plan、test-report、review-report 路径。
- 测试结果。
- Review Findings 和修复状态。
- 仍需联调关注的问题。

逐仓执行 `scripts/validate_implementation.py --require-ready`。只有全部仓库校验通过且用户确认实施完成后，状态文件存在时才将 `currentStage` 更新为 `e2e-testing`。

## 状态更新

状态文件存在时，实施阶段只更新：

- `stages.implementation.status`
- `stages.implementation.confirmed`
- `stages.implementation.outputs`
- `stages.implementation.blockedReason`
- `currentStage`

不得写入 `coding` 或 `code-review` 阶段对象。

## 自检

完成前检查：

- 是否按仓库类型读取了对应知识库。
- 是否先读取并遵守 `docs/detailed-design/<仓库名>/design.md`。
- 是否每仓生成 `plan.md`、`test-report.md` 和 `review-report.md`。
- 是否执行了 fresh 自测，而不是复用旧结果。
- 是否完成 Review，并处理 P0/P1。
- 是否所有 P2 都有明确处理结论。
- 是否测试与 Review 报告对应最终 HEAD 和工作区指纹。
- 是否通过实施产物校验器。
- 是否没有修改 `codebase/` 或把流程产物写入业务仓库。
