---
name: detailed-design
description: 当用户进入 DevFlow 详细设计阶段，或需要基于 PRD、已确认概要设计、知识库和真实代码，为一个或多个 Git 仓库生成可直接实施的详细设计时使用。该 Skill 是前后端详细设计的唯一入口，按仓库 kind 一仓生成一份 `design.md`；不用于概要设计、编码或测试执行。
---

# Detailed Design

把概要设计确定的跨仓边界落实为每个 Git 仓库可直接实施的技术 Spec。详细设计必须明确真实代码落点、完整最终契约、关键实现决策、异常与风险以及验证计划，但不修改业务代码。

## 阶段边界

- 输入是 PRD、已确认的概要设计、可选需求问题结论、流程状态、工程知识库和目标需求工作树。
- 输出固定为 `worktree/<需求名>/docs/detailed-design/<仓库名>/design.md`，一仓一份。
- 前后端使用同一个入口和同一种交付语义，仓库 `kind` 只决定专项模板、知识库和检查重点。
- 概要设计负责跨仓边界和变化契约；详细设计负责仓库内部实现和最终完整契约。
- 业务代码只在实施阶段修改。

## 输入与状态

完整流程必须读取：

1. `worktree/<需求名>/docs/prd.md`。
2. `worktree/<需求名>/docs/概要设计文档.md`。
3. 存在的 `worktree/<需求名>/docs/需求澄清问题列表.md`。
4. `worktree/<需求名>/docs/flow-state.json` 顶层 `repositories[]`。
5. 每个目标仓库的需求工作树。
6. `knowledge/architecture/` 和 `knowledge/engineering/testing.md`。

独立执行时可以没有状态文件，但用户必须明确提供 PRD、概要设计、目标仓库、仓库类型和代码基线。不要创建状态文件或猜测仓库类型。

完整流程只从顶层 `repositories[]` 读取 `name`、`kind`、`featureBranch`、`worktreePath`、`baselineBranch` 和 `baselineSha`。`kind` 只支持 `backend` 和 `frontend`。

## 仓库门禁

每个仓库开始设计前检查：

- 工作树存在且位于状态记录的 `worktreePath`。
- 当前分支等于 `featureBranch`，且不是 `main`、`master`、`develop` 或 `dev`。
- 概要设计的改动仓库表包含该仓库。
- 概要设计没有会阻断该仓库的未解决问题。
- 工作区中的已有改动可以识别来源，不覆盖用户改动。

条件不满足时只阻断受影响仓库。不要创建、切换、重置或删除分支和工作树。

## 资源路由

- 所有仓库读取 [契约展开规则](references/contract-expansion.md) 和 [验证与开发准入](references/testing-and-readiness.md)。
- 后端仓库读取 `knowledge/engineering/backend.md` 和 [后端详细设计规则](references/backend-design.md)；涉及 SQL 时再读取 `knowledge/engineering/sql.md`。
- 前端仓库读取 `knowledge/engineering/frontend.md` 和 [前端详细设计规则](references/frontend-design.md)。
- 需要具体结构时，按 `kind` 使用 [后端模板](assets/backend-design.md) 或 [前端模板](assets/frontend-design.md)。

知识库定义目标工程规范，真实代码定义当前事实。两者冲突时记录现状、目标规范和迁移决策，不得把规范中的理想结构写成当前事实。

## 统一设计深度

每份 `design.md` 必须让实施者无需重新决定：

1. 当前仓负责什么、不负责什么。
2. 修改哪些真实文件、目录、symbol、接口、页面、组件、表、任务或消息入口。
3. 当前代码如何工作，哪些能力复用，哪些内容新增或修改。
4. 完整最终契约是什么，以及它如何由现状和概要变化合并得到。
5. 权限、事务、幂等、并发、异常、降级、兼容和资源释放中的适用项如何处理。
6. 每个验收场景使用什么验证层级，实施完成的判定标准是什么。

不要规定与当前仓库不一致的固定框架、方法签名、ID 类型、目录布局或复杂度公式。项目已有约定优先；新结构按工程知识库和相邻代码收敛。

## 契约继承

概要设计中的仓库边界、责任方、变化内容和兼容策略不得被静默改写。

详细设计中的完整最终契约按以下方式形成：

`目标仓真实代码中的当前完整契约 + 概要设计确认的变化 = 本次实施后的完整契约`

现有代码无法提供完整契约、概要变化不足以补齐新增契约，或两者存在冲突时，标记阻断并回到概要设计或需求澄清收口。

## 设计流程

1. 读取状态、需求、问题结论和概要设计，确认目标仓库及依赖关系。
2. 逐仓核对工作树、Git 基线、工程知识库和真实代码。
3. 建立“需求/概要场景 → 当前代码事实 → 文件与 symbol → 最终契约 → 实现决策 → 验证方式”的追踪关系。
4. 按仓库类型生成或增量更新一仓一份 `design.md`。
5. 运行 `scripts/validate_detailed_design.py --kind <kind> <design.md>`；阶段完成前再加 `--require-ready`。
6. 做跨仓一致性收口，确认提供方与消费方对同一契约的最终定义一致。
7. 输出每仓开发准入结论和整个阶段结论，等待用户确认。

## 并行规则

- 概要契约已确定且仓库之间没有未决实现依赖时，各仓可以并行设计。
- 契约实现仍依赖提供方内部决策时，先完成提供方，再完成消费方。
- 每个执行单元只写自己仓库的 `design.md`，不得修改其他仓库设计。
- 并行结果必须由统一入口再次核对契约、发布依赖和验收场景。

## 开发准入

每份设计只能使用以下结论：

- `可实施`：范围、代码事实、最终契约、关键方案和验证计划完整。
- `部分可实施`：允许范围和阻断范围清楚，可用于讨论或继续补充，但不能完成详细设计阶段。
- `阻断`：关键输入、契约或代码事实不足，不能实施。

只有全部目标仓库均为 `可实施`、校验脚本通过且用户确认后，才能把 `stages.detailed-design` 标记为 `completed` 并将 `currentStage` 更新为 `implementation`。`部分可实施` 不得自动进入实施阶段。

## 状态更新

状态文件存在时，本阶段只更新：

- `stages.detailed-design.status`
- `stages.detailed-design.confirmed`
- `stages.detailed-design.outputs`
- `stages.detailed-design.blockedReason`
- `currentStage`

`outputs` 按 `repositories[]` 顺序记录每个 `docs/detailed-design/<仓库名>/design.md`。不得写入旧前后端阶段或仓库级阶段对象。

## 交付检查

- 一仓一份 `design.md`，仓库名、kind、分支和基线可追溯。
- 当前事实均有代码证据，新目标均有概要设计或需求依据。
- 文件落点、完整最终契约、实现决策和验证计划可以直接驱动实施。
- 前后端或上下游对相同契约的字段、语义、兼容和责任方一致。
- 文档没有本机绝对路径、旧 `frontend.md`/`backend.md` 产物约定或无依据的框架硬编码。
- 每份设计校验通过，且整个阶段没有 `部分可实施` 或 `阻断` 仓库。
