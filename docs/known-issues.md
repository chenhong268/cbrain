# Known Issues

## v0.3.0

### skill: 小爱 CBrain+Memory 双源融合不生效
- **现象**：brain-ops SKILL.md 已写"CBrain 是起点 + Memory 补全 + 必须双源输出"，但实际执行中，小爱查完 CBrain 后只输出 CBrain 结果，不补充 memory 中的隐式关系（组织架构、同团队人员等）。CBrain 正常时回答反而比宕机时更差。
- **影响**：关系查询（如"谁认识XX"）结果不完整，丢失组织架构推理。
- **方向**：可能需要在 SOUL.md 层面干预，或设计 answer-validation skill 做输出后检查。
