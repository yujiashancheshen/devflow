# 前端 Review

- 按 `design.md` 核对页面入口、路由、组件边界、状态归属、接口字段和 UI 来源。
- 检查 Loading、Empty、Error、Disabled、Permission 等本需求涉及的页面状态，以及表单、跳转、刷新和返回恢复。
- 页面测试遵循 `knowledge/engineering/testing.md`：从真实页面入口触发，使用 fixture 或 API Mock，断言用户可观察结果。
- 不机械要求每个组件、hook、computed 或工具函数单测。只有缺失验证会掩盖当前改动的具体行为风险时才形成 Finding。
- 检查生产代码没有 fixture、Mock、调试入口，以及绕过统一请求、鉴权和错误处理的逻辑。
- 类型检查、lint、测试、构建和视觉证据必须对应最终 HEAD 与工作区指纹；构建成功不能替代页面行为验证。
