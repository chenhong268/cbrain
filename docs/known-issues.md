# Known Issues

## v0.3.0

### sync 首次全量较慢

- **现象**：100+ 页的首次全量 sync 需 30-60 秒（主要耗时在向量化和 NER）。
- **影响**：新用户首次初始化后需等待。增量 sync 不受影响。
- **缓解**：v0.3.0 已做批量 embedding 优化。

### NER 短内容过度提取

- **现象**：NER 从简短事实描述中提取弱实体（如"国务院"、"中共党员"等）。
- **影响**：需要手动清理低质量 stub。
- **缓解**：ingest 已支持 `--no-ner` / `skipNer` 跳过 LLM 提取。小爱对 <200 字的结构化录入自动传 skipNer。

### Hermes SKILL.md 修改不生效

- **现象**：修改 `~/.hermes/skills/brain-ops/cbrain/SKILL.md` 后重启 gateway，小爱不按新规则执行。
- **影响**：协议更新需要写 MEMORY.md 才生效。
- **临时方案**：关键规则写 MEMORY.md，SKILL.md 保留作为参考文档。
