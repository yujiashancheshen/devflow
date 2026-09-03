---
name: code-review
description: 当用户要求审查当前 DevFlow 需求实现，或 implementation 阶段需要执行 Review 质量门时使用。该 Skill 是 Code Review 唯一入口，不区分前端和后端；按仓库 kind 加载对应知识库和专项参考规则。
---

# Code Review

Code Review 是一个统一入口。它可以被 `implementation` 阶段调用，也可以在用户明确要求单独审查时独立执行。

主流程中，Review 属于实施阶段质量门。Review 通过并修复阻断问题后，实施阶段才能进入 E2E 联调。

## 输入

必须读取：

- 当前需求 PRD。
- `概要设计文档.md`。
- 每个目标仓库的 `docs/detailed-design/<仓库名>/design.md`。
- 每个目标仓库的 `docs/implementation/<仓库名>/plan.md` 和 `test-report.md`。
- 当前需求涉及的 Git 仓库和精确 diff 范围。
- `knowledge/architecture/`。
- `knowledge/engineering/testing.md`。

按需读取：

- 后端仓库读取 `knowledge/engineering/backend.md` 和 `knowledge/engineering/sql.md`。
- 前端仓库读取 `knowledge/engineering/frontend.md`。
- 后端 Review 读取 `references/backend-review.md`；当前改动涉及相应主题时再读取 `references/concurrency.md`、`references/database-and-messaging.md`、`references/errors-and-resources.md`。
- 前端 Review 读取 `references/frontend-review.md`。
- 输出 Finding 前读取 `references/false-positives.md` 控制误报。

专项文件只作为参考材料。最终审查仍由本 Skill 汇总和输出。

## 输出

实施阶段内调用时，每仓写入：

```text
worktree/<需求名>/docs/implementation/<仓库名>/review-report.md
```

独立审查多个仓库时，可以写入合并报告：

```text
worktree/<需求名>/docs/code-review-报告.md
```

审查阶段默认不修改业务代码。用户明确要求“修复 Review 问题”时，转回 `implementation` 执行修复、自测和复审。

## 审查范围

逐仓确定本次需求 diff：

- 优先使用用户明确给出的 commit、branch 或 diff 范围。
- 完整流程中结合 `flow-state.json` 的 `baselineSha`、`featureBranch`、当前 HEAD、staged、unstaged 和未跟踪文件确定范围。
- 不把整个长期分支或全仓历史默认当作本次需求范围。
- 无法可靠区分需求改动时，停止该仓审查，要求用户提供基线或 commit 范围。

不得只看 `git diff` 后漏掉已提交代码，也不得只看提交记录后漏掉工作区改动。

## 知识库加载规则

| 仓库类型 | 必读知识库 | 审查重点 |
|---|---|---|
| backend | `knowledge/engineering/backend.md`、`knowledge/engineering/testing.md` | 业务正确性、接口级 Mock 测试可信度及适用的并发、事务、SQL、消息风险 |
| frontend | `knowledge/engineering/frontend.md`、`knowledge/engineering/testing.md` | 页面行为、接口消费、异常态、权限、兼容性和页面级 Mock 测试可信度 |

所有仓库都要读取 `knowledge/architecture/`，用来确认模块边界、跨仓责任和依赖关系。

## 公共检查

所有仓库都检查：

- 改动是否属于当前需求范围。
- 实现是否符合 `design.md`。
- 跨仓接口、配置、路由、权限、数据结构和消息契约是否与概要设计一致。
- 错误路径是否会导致用户可见错误、数据损坏、安全问题或难以恢复的状态。
- 测试报告是否对应当前 HEAD 或工作区，关键验证是否实际执行。
- 测试是否遵守知识库定义的粒度和 Mock 边界；不以函数覆盖率或测试数量作为通过条件。
- 是否引入秘密、调试代码、生产路径 mock、无关格式化或生成物污染。
- 新增依赖、迁移、配置和发布步骤是否完整。

## 后端专项检查

后端仓库重点检查：

- goroutine、锁、channel、context 和超时是否安全。
- 事务边界、幂等键、重复消费、重试和补偿是否成立。
- SQL 是否存在深分页、索引缺失、范围错误、并发写冲突或兼容性问题。
- 错误处理、资源释放、日志和可观测性是否足够定位问题。
- 受影响的 HTTP、RPC、MQ、定时任务和一次性任务入口是否有对应验证。
- 接口测试是否保留真实内部业务链路，只 Mock 外部 IO 或进程边界。

## 前端专项检查

前端仓库重点检查：

- 页面入口、路由、组件拆分和复用是否符合详细设计。
- Loading、Empty、Error、Disabled、Permission 等状态是否完整。
- 接口入参、响应映射、错误展示、并发请求、取消和缓存是否正确。
- 表单、筛选、分页、URL 状态和返回恢复是否符合用户路径。
- UI 来源、视觉还原、响应式和容器约束是否存在明显回归。
- 页面测试是否从真实页面入口触发，并覆盖本需求涉及的主要状态和用户操作。

## Findings 规则

只输出有明确触发条件和影响的问题。不要输出纯风格建议。

| 级别 | 判定 |
|---|---|
| P0 | 会造成严重安全事故、不可逆数据或资金损失、核心服务不可用，必须立即阻断 |
| P1 | 在现实输入或流程下会产生错误结果、panic、数据不一致、权限绕过或主要功能不可用 |
| P2 | 边界场景下会产生可复现错误、恢复困难或明显运维风险，应在合入前处理 |

每条 Finding 必须包含：

- 标题和级别。
- 文件与行号。
- 触发条件。
- 实际影响。
- 修复方向。

如果没有 Finding，明确写“未发现阻塞问题”，并记录审查范围、已执行验证、审查缺口和剩余风险。

P0/P1 必须修复并复验。P2 必须标记为已修复、已接受或不适用，不得无结论遗留。修复后重新核对 `test-report.md`、最终 HEAD 和工作区指纹，避免报告引用修复前证据。

## 自检

完成前检查：

- 是否按仓库类型读取了对应知识库。
- 是否读取了 `design.md`、实施计划和测试报告。
- 是否覆盖了已提交、未提交和未跟踪的当前需求改动。
- Findings 是否按 P0/P1/P2 排序。
- 每条 Finding 是否有触发条件和实际影响。
- 是否避免把个人偏好写成审查结论。
