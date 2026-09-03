---
name: dev-flow
description: 当需要在 DevFlow 工作区启动、恢复、查看或自动推进真实需求流程时使用。流程阶段固定为需求澄清加强、概要设计、详细设计、实施和 E2E 联调。
---

# Dev Flow

`dev-flow` 是完整流程的编排入口。流程产物集中在 `worktree/<需求>/docs/`；业务代码仅能修改冻结基线后创建的 `worktree/<需求>/<仓库>/`。`codebase/` 永远是只读基线。

## 阶段

DevFlow 只有五个主阶段：

| 阶段 | 状态名 | 入口 |
|---|---|---|
| 需求澄清加强 | `requirement-clarification` | `/devflow:requirement-clarification` |
| 概要设计 | `high-level-design` | `/devflow:high-level-design` |
| 详细设计 | `detailed-design` | `/devflow:detailed-design` |
| 实施，包含编码、自测和 Review | `implementation` | `/devflow:implementation` |
| 联调，E2E | `e2e-testing` | `/devflow:e2e-testing` |

Code Review 是实施阶段的质量门。`/devflow:code-review` 只作为独立审查入口，不参与主流程阶段流转。

## 需求识别与扫描

只扫描 `worktree/` 的直接子目录。必须忽略 `worktree/_internal/`，且仅将同时满足以下任一条件的目录识别为需求：

- 存在 `docs/prd.md`。
- 存在 `docs/flow-state.json`。

不得因目录名、临时文档、业务 worktree 或 `_internal` 下的测试材料推断需求或阶段。

## 状态边界

完整流程在概要设计确认后由 `prepare_requirement.py` 创建 `docs/flow-state.json`。此后：

- 仓库事实只读写顶层 `repositories[]`。每项只使用 `name`、`kind`、`featureBranch`、`worktreePath`、`baselineBranch`、`baselineSha`，以及准备和基线脚本维护的基线合入字段。
- `stages.<阶段>` 只允许使用 `status`、`confirmed`、`output`、`outputs`、`blockedReason`。
- `repositories[].kind` 只接受 `backend` 或 `frontend`，用于详细设计、实施和 Review 按需加载知识库。

状态文件用于记录确认和阻断；扫描到的集中产物用于判定阶段实际完成度。状态不得宣称已完成而对应产物缺失。

每次阶段开始、等待确认、完成、阻断、恢复和退回时，通过 `flow_state.append_event` 追加到 `docs/flow-events.jsonl`。

## 集中产物判据

| 阶段 | 必需集中产物 |
|---|---|
| 需求澄清加强 | `docs/需求澄清问题列表.md` |
| 概要设计 | `docs/概要设计文档.md` |
| 详细设计 | 每个目标仓库均有 `docs/detailed-design/<name>/design.md` |
| 实施 | 每个目标仓库均有 `docs/implementation/<name>/plan.md`、`test-report.md`、`review-report.md` |
| E2E 联调 | `docs/e2e-test-report.md` 或 E2E Skill 明确产出的测试报告 |

详细设计和实施的“全部完成”均需同时满足逐仓产物判据、相应阶段的 `status: completed` 与 `confirmed: true`。

## 默认完整编排

1. 创建需求目录并写入 `docs/prd.md`，执行 `requirement-clarification`；用户确认后进入 `high-level-design`。
2. 概要设计通过结构校验且用户确认后，从“改动模块”提取唯一的 `name:kind` 列表。必须执行真实准备命令，不得手工创建需求分支、worktree 或状态文件：

   ```bash
   python3 "$workspace/plugins/devflow/scripts/prepare_requirement.py" \
     --root "$workspace" \
     --requirement "$requirement" \
     --repository "$name:$kind"
   ```

   每个目标仓库各传一个 `--repository`。命令会同步基线、创建 Git worktree、冻结 `baselineSha` 并写入顶层 `repositories[]`。
3. 准备命令成功后，调用 `detailed-design`。它会按 `repositories[].kind` 逐仓加载前端或后端知识库，并生成一仓一份 `design.md`；只有全部仓库校验通过且为“可实施”才完成该阶段。
4. 全部详细设计产物确认后，调用 `implementation`。实施入口必须先通过 `ensure_baseline.py` 的只读基线验证，再逐仓完成编码、自测和 Review。
5. 全部实施产物确认后，调用 `e2e-testing`，进入联调和端到端验证。

任一步被阻断时，只在当前阶段记录 `status: blocked` 与 `blockedReason`，并停止自动流转。恢复时重新读取顶层 `repositories[]`、集中产物和阶段允许字段，不从历史目录结构猜测仓库信息。

## 分派顺序

| 条件 | 调用入口 |
|---|---|
| 需求澄清未完成 | `requirement-clarification` |
| 概要设计未完成 | `high-level-design` |
| 详细设计未完成 | `detailed-design` |
| 实施产物未完成 | `implementation` |
| 实施已确认完成 | `e2e-testing` |

同一阶段内默认逐仓串行。一个仓库阻断、缺少状态顶层字段、需求分支不匹配或处于保护分支时，不得跳过该仓库，也不得进入下一阶段。

## 启动与恢复

- 使用 `start-flow` 从本地 PRD 创建并启动完整流程。
- 使用 `start` 扫描已识别需求，按以上产物判据和状态恢复到第一个未完成且未阻断的阶段。
- 用户确认当前阶段完成前，始终停留在当前阶段；确认后只能按照默认完整编排推进。

不得在业务仓库的 `docs/`、`.claude/docs/` 写入流程产物。
