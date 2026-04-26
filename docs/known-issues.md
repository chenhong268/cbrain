# Known Issues

## v0.1.0-dev

### skill: 小爱 CBrain+Memory 双源融合不生效
- **现象**：brain-ops SKILL.md 已写"CBrain 是起点 + Memory 补全 + 必须双源输出"，但实际执行中，小爱查完 CBrain 后只输出 CBrain 结果，不补充 memory 中的隐式关系（组织架构、同团队人员等）。CBrain 正常时回答反而比宕机时更差。
- **影响**：关系查询（如"谁认识XX"）结果不完整，丢失组织架构推理。
- **方向**：可能需要在 SOUL.md 层面干预，或设计 answer-validation skill 做输出后检查。

### skill: 小爱不先查 CBrain query，直接搜 session
- **现象**：知识性问题（如"CBrain watcher 什么时候改的"），小爱先调 4 次 session_search + terminal，最后才调 get_config。CBrain First 规则未生效。
- **影响**：搜索效率低，知识可能滞后。
- **方向**：SOUL.md 可能被小爱的默认行为模式覆盖，需进一步调查。

### FTS 短词 LIKE 排名平权
- **现象**：2-char 短词（如"诺华"）走 LIKE fallback，所有结果同分（0.8），排名按插入顺序而非相关性。
- **方向**：加 TF（词频）排序或 BM25 简化版。
