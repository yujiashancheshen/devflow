---
name: init-knowledge
description: 分析 codebase 仓库并生成业务、架构和通用工程能力三类知识库初稿；具体实现仍以代码为准。
---

# 初始化知识库

## 输出

```text
knowledge/
├── business/
│   ├── overview.md.example
│   ├── glossary.md.example
│   ├── overview.md
│   └── glossary.md
├── architecture/
│   ├── modules.md.example
│   ├── layering.md.example
│   ├── external-dependencies.md.example
│   ├── modules.md
│   ├── layering.md
│   └── external-dependencies.md
└── engineering/
    ├── backend.md
    ├── frontend.md
    └── testing.md
```

## 工作流

1. 读取 `workspace.toml`、`codebase/` 和 business/architecture 下的 `.md.example`，确定输出结构。
2. 业务知识只提取业务目标、角色、主流程和概念边界。无法从代码判断的业务语义标为待人工确认。
3. 架构知识记录模块负责与不负责的范围、稳定分层、模块依赖和第三方系统。具体路由、字段、表结构和函数不写入知识库。
4. 工程知识从团队规范和多个仓库中的稳定共性提炼。后端重点覆盖超时、事务、幂等、分页、消息和可观测性；前端重点覆盖页面状态、请求、mock 和页面测试。
5. 保留已有人工内容。更新时给出差异并请求领域负责人确认，不以一次代码扫描静默覆盖业务定义。
6. `.md.example` 只作为公开示例，不覆盖；实际生成内容写入同名 `.md`。

## 事实边界

- 知识库保存稳定背景、边界和规则。
- 当前行为、接口字段、数据库结构和实现逻辑以代码为准。
- 普通需求会频繁改变的内容不进入知识库。
- 旧版 `standards/` 存在时作为迁移输入，规则统一归入 `engineering/`。
