# DevFlow

[AI Coding 如何真正提升团队交付效率](https://mp.weixin.qq.com/s/16MiKWd9zEAlp797GUbIbg)

AI 驱动的标准化开发工作区。

DevFlow 不是一个单独的代码生成 Prompt，也不是一个只会串命令的脚本。它的目标是把团队真实开发中的需求澄清加强、概要设计、详细设计、实施和 E2E 联调组织成一套可复制的流程，让不同研发在同一个工作区里，用同一套标准推进需求。

## 想解决的问题

团队开始使用 AI Coding 以后，单个人的写代码速度通常会明显提升，但团队交付效率不一定同步提高。原因往往不在模型能力，而在流程没有统一。

- 效率不稳定。个人体感变快了，但需求仍然会卡在理解、设计、联调、返工和 Review 上。
- 使用标准不一致。有人完整使用 Skill，有人只用一两个阶段，同一个需求会跑出不同过程。
- 交付标准不一致。团队只能看到最后代码，很难 Review 需求澄清、设计、自测和 E2E 是否真的发生过。
- 新人上手成本高。只有一堆 Prompt 和口头经验时，新人很难开箱即用。
- 知识缺口明显。缺少业务知识、架构边界和工程规范时，AI 会反复追问，或者直接按局部上下文设计，最后导致返工。

DevFlow 的设计目标，是把这些隐形经验落成标准目录、阶段产物、团队知识库、可恢复状态和 AI Skill。

整套方案除了五阶段 Skill，还依赖三项工程基础。

- 统一工作区，让代码、需求、知识库和阶段产物都有固定位置。
- 有效的知识库，向 AI 补充代码中无法完整推导的业务、架构和工程背景。
- 持续的数据反馈，记录各阶段耗时和结果，用来调整 Skill、知识库和交付策略。

## 设计目标

**让每个需求都有过程**

DevFlow 要求每个阶段留下产物。需求澄清有问题列表和增强 PRD，概要设计有系统边界和验收 Case，详细设计有代码级实现方案，编码有自测报告，Code Review 有 Findings，E2E 有测试流和报告。

**让流程可以中断后恢复**

真实开发会被会议、环境、联调和需求变更打断。DevFlow 会在 `worktree/<需求名>/docs/` 下记录流程状态和阶段产物，后续可以从已有结果继续推进。

**让知识库成为 AI 的长期上下文**

业务知识、架构边界和工程规范分别放在 `knowledge/` 下。稳定内容进入知识库，易变实现回到真实代码中确认，避免维护两套事实。

**让脚本只处理确定性动作**

初始化、代码基线、worktree 创建、流程状态和 E2E 执行由脚本处理。需求理解、方案判断、代码修改和 Review 仍然交给 AI Skill 与研发共同完成。

**让流程可以持续调整**

DevFlow 记录各阶段的耗时和执行结果。团队可以根据真实数据判断哪个阶段仍在反复确认或重复推演，再有针对性地修改流程和 Skill。

**让公开模板和公司配置分开**

公开仓库只包含通用流程、Skill、脚本、知识库示例和工程规范。公司内部的业务代码、真实知识库、PRD、MCP 和上线配置不提交到公开仓库。

## 整体流程

| 阶段 | 依赖物 | 输出物 | 参与人 | 目标 |
|---|---|---|---|---|
| 需求澄清加强 | 原始 PRD、业务知识库、相关代码 | 增强后的 PRD、需求澄清问题列表 | PM、主 R、AI | 提前暴露模糊口径、缺失字段、历史约束和待确认问题 |
| 概要设计 | 增强后的 PRD、模块边界、业务流程 | 概要设计文档 | 主 R、前后端、Leader、PM | 确认用户旅程、仓库边界、跨模块契约、上线方案和验收 Case |
| 详细设计 | 概要设计、真实代码、工程规范 | 每个仓库一份 `design.md` | 具体研发、AI | 把方案落到接口、表、函数、页面、组件、状态、权限、事务和测试入口 |
| 实施 | 详细设计、代码基线、工程规范 | 代码、实施计划、自测报告、Review 报告 | 具体研发、Review 人、AI | 按设计实现，通过自测和 Review 证明核心路径可用 |
| E2E 测试和联调 | 概要设计验收 Case、测试环境、测试账号 | Playwright 脚本、result.json、HTML 报告、检查点 | 主 R、测试、前后端、AI | 从 Case 生成 Playwright 脚本，浏览器执行，输出可视化报告 |

详细设计、实施和 Code Review 都只有一个入口 Skill。入口会根据仓库 `kind` 按需加载前端或后端知识库，不再要求用户选择前端阶段或后端阶段。

对从零开始、边界独立的功能，一份行为和验收场景清晰的 Spec 通常已经可以驱动实现。接入存量业务系统时，还需要核对现有字段、接口、历史逻辑和兼容约束。DevFlow 的 `design.md` 结合了 Design 和 Plan，会确定代码落点、接口 Schema、数据分支、关键伪代码、复杂流程和验收 Case，同时给函数内部实现保留调整空间。

## 快速开始

### 1. 克隆工作区

```bash
git clone https://github.com/yujiashancheshen/devflow.git company-devflow
cd company-devflow
```

### 2. 配置业务仓库

```bash
cp workspace.toml.example workspace.toml
vim workspace.toml
```

`workspace.toml` 用来声明团队要接入哪些代码仓库。

```toml
name = "company-devflow"

[defaults]
branch = "master"

[[repositories]]
name = "schoolservice"
url = "git@git.example.com:team/schoolservice.git"
branch = "master"
kind = "backend"

[[repositories]]
name = "teacher-web"
url = "git@git.example.com:team/teacher-web.git"
branch = "master"
kind = "frontend"
```

`name` 会成为 `codebase/` 下的目录名。`kind` 目前支持 `backend` 和 `frontend`，用于后续流程选择 Go 或前端 Skill。

### 3. 初始化工作区

```bash
bash scripts/init_workspace.sh
```

初始化会做三件事。

- 创建 `codebase/`、`worktree/` 和 `knowledge/` 目录。
- 按 `workspace.toml` 把业务代码克隆到 `codebase/`。
- 安装 `plugins/devflow/` 下的 Claude 与 Codex 插件描述。

### 4. 生成或补充知识库

```bash
claude code .
/devflow:init-knowledge
```

`init-knowledge` 会读取 `codebase/` 里的代码，生成业务知识、架构边界和工程规范初稿。生成后需要人工补充和修正。

也可以直接手写 `knowledge/`。建议只写长期稳定的内容，如果一次普通需求改动就会让它失效，就不要写进知识库。

### 5. 准备 PRD 并启动流程

把本地 PRD 放到 `requirement/`，或者使用任意本地 Markdown 文件路径。

```bash
/devflow:start-flow requirement/某个需求.md
```

DevFlow 会准备需求工作区，冻结代码基线，创建需要修改的仓库 worktree，并从需求澄清加强开始推进。

已有需求可以用下面命令恢复。

```bash
/devflow:start
```

## 目录结构

```text
devflow/
├── workspace.toml.example
├── knowledge/
│   ├── business/
│   ├── architecture/
│   └── engineering/
├── codebase/
├── worktree/
│   └── <需求名>/
│       ├── docs/
│       │   ├── detailed-design/<仓库名>/design.md
│       │   └── implementation/<仓库名>/
│       └── <仓库名>/
├── requirement/
├── plugins/devflow/
│   ├── commands/
│   ├── skills/
│   └── scripts/
└── scripts/
```

| 目录 | 作用 | 是否提交 |
|---|---|---|
| `plugins/devflow/` | DevFlow 命令、Skill 和流程脚本 | 提交 |
| `knowledge/engineering/` | 通用工程规范 | 提交 |
| `knowledge/business/` | 业务背景和术语，公开仓库只提交示例 | 公司内部按需提交 |
| `knowledge/architecture/` | 模块边界和依赖，公开仓库只提交示例 | 公司内部按需提交 |
| `codebase/` | 业务代码只读基线 | 不提交真实代码 |
| `worktree/` | 每个需求的代码工作树和阶段产物 | 不提交真实需求产物 |
| `requirement/` | 本地 PRD | 不提交真实 PRD |
| `workspace.toml` | 公司真实仓库清单 | 不提交 |
| `workspace.toml.example` | 仓库清单示例 | 提交 |

## 命令能力

| 命令 | 作用 |
|---|---|
| `/devflow:start-flow <本地PRD路径>` | 从本地 PRD 启动一个新需求流程 |
| `/devflow:start` | 扫描已有需求，恢复并推进下一阶段 |
| `/devflow:init-knowledge` | 分析 `codebase/`，生成知识库初稿 |
| `/devflow:requirement-clarification` | 需求澄清，输出增强 PRD 和问题列表 |
| `/devflow:high-level-design` | 概要设计，确认仓库边界、接口契约、上线方案和验收 Case |
| `/devflow:detailed-design` | 统一详细设计，按仓库类型加载知识库，一仓一份 `design.md` |
| `/devflow:implementation` | 统一实施，包含编码、自测和 Review |
| `/devflow:code-review` | 独立 Review 入口，主流程中由实施阶段调用 |
| `/devflow:e2e-testing` | 编排和执行 E2E 测试流 |

阶段命令可以独立执行。完整流程建议从 `/devflow:start-flow` 开始，由 AI 根据阶段产物逐步推进。

## Skill 能力

| Skill | 能力 |
|---|---|
| `dev-flow` | 总控流程，读取状态，决定当前应该进入哪个阶段 |
| `requirement-clarification` | 结合 PRD、业务知识和代码，找出需求缺口和待确认问题 |
| `high-level-design` | 生成概要设计，关注用户旅程、仓库边界、接口契约和验收 Case |
| `detailed-design` | 统一详细设计，按仓库类型读取知识库和真实代码，一仓一份可实施 spec |
| `implementation` | 统一实施，按详细设计完成编码、自测和 Review 修复 |
| `code-review` | 统一 Review，按仓库类型加载知识库，优先发现行为缺陷、回归风险和测试缺口 |
| `e2e-testing` | 把验收 Case 转成测试流，执行并生成 E2E 报告 |
| `init-knowledge` | 从代码和现有文档生成知识库初稿 |

Skill 的原则是让 AI 处理大量上下文读取和重复检查，让研发保留业务判断、架构判断和上线判断。

## 脚本能力

| 脚本 | 作用 |
|---|---|
| `scripts/init_workspace.sh` | 初始化入口，调用 Python 初始化脚本并安装插件 |
| `scripts/init_workspace.py` | 读取 `workspace.toml`，创建目录，克隆 `codebase/`，生成知识库骨架 |
| `scripts/install_plugin.sh` | 把 `plugins/devflow/` 安装到 Claude 和 Codex 可识别的位置 |
| `plugins/devflow/scripts/ensure_baseline.py` | 只读验证需求 worktree 的 HEAD 已包含状态文件中的冻结基线 |
| `plugins/devflow/scripts/prepare_requirement.py` | 为单个需求冻结基线，创建 `worktree/<需求名>/<仓库名>` |
| `plugins/devflow/scripts/flow_state.py` | 读写 `flow-state.json`，记录五阶段状态和流程事件 |
| `plugins/devflow/scripts/e2e/` | E2E 脚本集：Case 提取、Playwright 脚本生成、执行和 HTML 报告生成 |

脚本尽量只做确定性动作。阶段判断、文档生成、代码修改和 Review 由 Skill 完成。

## E2E 测试流

一个测试流是 **Case 集合 + 有序步骤 + 数据依赖 + 变更检查点 + 断点续跑 + 每步证据 + 最终断言** 的完整编排。概要设计文档中的 Case 被直接转为可执行的 Playwright 脚本，在浏览器中跑通完整业务场景。

传统 E2E 把每个 Case 当成独立测试执行时，创建订单前要先准备客户，提交订单又要重新准备订单和商品，每个 Case 都从空环境开始，大部分时间花在重复造数据上。

DevFlow 的测试流把这些步骤串成一条线。前一步输出作为后一步输入，失败不意味着从头开始——已完成的变更通过检查点保留，修复后从断点继续。

### 管线

```
概要设计文档 → 提取 Case → 生成 script.js → Playwright 执行 → result.json → report.html
```

### 生成脚本

```bash
node plugins/devflow/scripts/e2e/create_case_script.js \
  --case worktree/<需求名>/docs/概要设计文档.md \
  --out worktree/<需求名>/docs/e2e/script.js \
  --base-url https://app.example.com
```

脚本自动包含 Case 目录（`CASE_CATALOG`）、步骤映射（`STEP_CASE_MAP`）、Playwright 运行时自动发现和浏览器录屏。

### 执行

```bash
node worktree/<需求名>/docs/e2e/script.js \
  --base-url https://app.example.com \
  --cookie "SESSION=xxx" \
  --headed
```

支持断点续跑：`--resume` 跳过已完成的检查点，从失败步骤继续。

### 生成报告

```bash
node plugins/devflow/scripts/e2e/generate_test_report.js \
  --description "需求名称" \
  --script worktree/<需求名>/docs/e2e/script.js \
  --result-json worktree/<需求名>/docs/e2e/result.json \
  --out-dir worktree/<需求名>/docs/e2e/
```

报告为 HTML 格式，包含 Case 级状态（通过/失败/阻塞/未执行）、步骤截图、执行录屏和业务链路覆盖。

### 产物

```text
worktree/<需求名>/docs/e2e/
  script.js           ← Playwright 脚本
  result.json         ← 执行结果
  report.html         ← HTML 报告
  artifacts/          ← 截图、录屏、网络证据
```

## 团队协作方式

建议由架构师或主 R 先维护一份公司内部 DevFlow 仓库。

```bash
git clone https://github.com/yujiashancheshen/devflow.git company-devflow
cd company-devflow
cp workspace.toml.example workspace.toml
vim workspace.toml
bash scripts/init_workspace.sh
claude code .
/devflow:init-knowledge
git remote set-url origin <公司内部仓库>
git push
```

团队成员之后直接克隆公司内部仓库。

```bash
git clone <公司内部仓库> company-devflow
cd company-devflow
bash scripts/init_workspace.sh
claude code .
```

上游 DevFlow 更新时，可以只同步插件目录。

```bash
git remote add upstream https://github.com/yujiashancheshen/devflow.git
git fetch upstream
git checkout upstream/main -- plugins/devflow/
bash scripts/install_plugin.sh
git commit -am "chore: sync devflow plugin"
```

## 当前边界

DevFlow 不是全自动开发系统。

它会尽量让 AI 多读代码、多整理上下文、多生成中间产物、多做重复检查，但业务口径、架构取舍、上线风险和最终交付责任仍然需要人来确认。

公开仓库保留了 DevFlow 的核心思路和可运行的工程结构。出于安全和隐私考虑，部分业务知识库、MCP 服务（如部署服务）、第三方服务、云端数据采集与存储，以及部分页面已经脱敏或删除。

真实业务仓库放在 `codebase/`，真实需求工作区放在 `worktree/`，真实 PRD 放在 `requirement/`，这些默认都会被 `.gitignore` 排除。使用者可以结合自己的项目补齐上述内容，并将这套流程适配到自己使用的 AI Agent。

## License

MIT
