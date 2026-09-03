# 后端 Review

- 先按 `design.md` 核对入口、完整契约、领域不变量、事务、幂等和异常结果。
- 测试遵循 `knowledge/engineering/testing.md`：从受影响接口或业务入口进入，保留真实内部链路，只 Mock 外部 IO 或进程边界。
- 不机械要求内部函数单测。只有缺失验证会掩盖当前改动的具体行为风险时才形成 Finding。
- 改动涉及并发时读取 `concurrency.md`；涉及数据库、缓存或消息时读取 `database-and-messaging.md`；所有后端审查读取 `errors-and-resources.md`。
- 测试通过不能覆盖字段、权限、错误或副作用契约不一致，因为测试可能复制了错误实现。
