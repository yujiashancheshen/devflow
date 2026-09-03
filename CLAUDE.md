# 工作区开发规范

本文件是工作区通用规范索引。规范正文放在 `knowledge/`，按阶段按需读取，不在本文件内联。

## 目录约定

| 路径 | 用途 |
|---|---|
| `codebase/` | 各仓库主干代码，只读基线，只 pull 不改 |
| `worktree/<需求名>/` | 单个需求的工作区，含流程产物与 worktree |
| `knowledge/` | 业务说明、模块边界、开发规范 |
| `requirement/` | 产品需求仓库，只读输入源 |

所有代码改动只发生在 `worktree/` 下的 worktree 中。禁止直接修改 `codebase/`。

## 阶段与知识库映射

| 阶段 | 读取代码 | 读取知识库 |
|---|---|---|
| requirement-clarification | `codebase/` 全量 | `business/`、`architecture/modules.md` |
| high-level-design | `codebase/` 全量 | `business/`、`architecture/` |
| detailed-design | 对应 worktree | `architecture/`、`engineering/` 对应技术 |
| implementation | 对应 worktree | `engineering/` 对应技术与 `testing.md` |
| e2e-testing | 对应 worktree | `business/`、`architecture/`、`engineering/testing.md` |

## 事实来源

知识库只描述模块边界与核心能力。具体逻辑、字段、接口细节一律以代码为准。发现知识库与代码不一致时，以代码为准，并提示更新知识库。

## 通用要求

- 优先复用已有代码，不重复造轮子。
- 优先简单方案，不过度设计。
- 命令使用工作目录参数或绝对路径，不用 `cd /path && command`。
- 未经明确要求，不主动 commit 或 push。
- 未经明确授权，不执行 `git push --force`、`git reset --hard` 或改写历史。
