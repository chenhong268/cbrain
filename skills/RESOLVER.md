# CBrain Skills Resolver

> Intent → Skill routing table. The agent reads this first to decide which skill to load.
> Format: `intent-pattern → skill-file [priority] [condition]`

## Routing Rules

### Grounded Recall（最高优先级，SOUL.md 硬规则）
- 讨论过吗、聊过吗、之前说过、以前讨论过 → query.md [grounded]
- CBrain 里有吗、有没有相关记录、有没有依据 → query.md [grounded]
- 为什么这么定、上次怎么定的 → query.md [grounded]
- 这个判断有没有遗漏、这个判断对不对、是不是真的 → query.md [grounded]
- 和之前说的矛盾吗、哪些是确定的 → query.md [grounded]

### Content Recall（同样高优先级，禁止 grounded）
- 当时怎么设计、为什么选、具体方案是什么 → query.md [detail=normal, limit=3, no-expand]
- 具体怎么说、展开全文、怎么做的 → query.md [detail=normal]
- 首轮禁止自动 expand_entity（除非用户追问或结果 insufficient）
- ⚠️ 回答用槽位式压缩：5个槽位（核心设计对象/架构机制/为什么这样选/当时审查/后续变化），结构词硬保留

### Relationship Analysis
- 什么关系、有什么关系、怎么认识的、关联、connect → connect.md
- A和B、之间、联系、关联分析 → connect.md

### Deep Review
- 总结、全面了解、梳理、汇总、复盘、review → review.md
- 帮我梳理、帮我理一下、什么来头、所有信息 → review.md
- 深度了解、知识总览、全景 → review.md

### Query & Search
- 查询、搜索、查找、查一下、找一下 → query.md
- 谁、是谁、什么是、是什么、介绍一下 → query.md
- 图谱、链接到 → query.md

### Writing
- 帮我写、写一段、写个、写篇、写周报、写介绍 → write.md
- 朋友圈、生成文案、写报告 → write.md

### Content Ingestion
- 导入、录入、记一下、保存、收录、存入 → ingest.md
- 添加新、新增、创建 → ingest.md
- 这篇文章、这段内容、记录下来 → ingest.md
- signal-detector 输出待入库内容 → ingest.md

### Enrichment
- 补充、丰富、完善、扩展 → enrich.md
- 增强实体、提升 → enrich.md

### Maintenance
- 同步、sync、重新索引 → dream.md
- 体检、健康检查、doctor、健康 → dream.md

### Cleanup
- 清理、删除孤立、去重、整理 → cleanup.md
- 有什么该删的、合并重复、merge → cleanup.md
- 大脑整理、清理一下 → cleanup.md

### Nightly Full Pipeline
- 夜间维护、每日维护、全量同步、做个梦、做梦 → dream.md [scheduled]
- 定时任务、cron、daily → dream.md [scheduled]

### Dossier
- 完整档案、全貌、dossier、RAGmap、详细档案、个人信息表 → review.md
- 结构化、档案页、信息表 → review.md

### Brainstorm
- 分析一下、联想、知识缺口、cross-domain、有什么盲点、帮我想想 → query.md
- 推理、背后逻辑、深层原因、为什么、思维链 → query.md

### Merge & Dedup
- 这两个重复了、合并、一样的、重复页面 → cleanup.md
- merge、合并页面 → cleanup.md

### Insights & Discoveries
- 最近有什么发现、有什么我漏掉的、有什么关联没注意到的 → query.md
- 洞察、insight、discovery、发现 → query.md

### Timeline
- 时间线、事件、发生了什么、历史记录、什么时候 → review.md
- 按时间排列、事件流、回顾 → review.md

### Tags
- 打个标签、加标签、标签管理、按标签找 → ingest.md
- 批量打标、tag → ingest.md

### Hierarchy
- 分类、层级、上下级、属于哪个、子分类 → query.md
- 组织结构、归属、parent/child → query.md

### Feedback
- 这个信息不对、纠正、反馈、投诉、错了 → query.md

### Config
- 改一下配置、调整参数、配置 → dream.md

### Signal Detection
- 信号检测、扫描信号、检测 → signal-detector.md
- 这条消息有什么值得记的、提取信号 → signal-detector.md

### Brain Ops (Protocol)
- 日常操作、brain-ops、怎么用 → brain-ops.md [default]

## Skill Inventory

| # | Skill | Purpose | Trigger |
|---|-------|---------|---------|
| 1 | query.md | Hybrid search (vector+FTS+graph) + synthesis | On-demand: user asks about something |
| 2 | review.md | Deep topic review — gather everything, synthesize coherent picture | On-demand: user wants full understanding |
| 3 | connect.md | Relationship analysis — find and explain connections between entities | On-demand: user asks how A and B relate |
| 4 | ingest.md | Route incoming content to correct type + index | On-demand: user wants to save content |
| 5 | enrich.md | Tier promotion + entity enrichment | On-demand / batch: after sync |
| 6 | cleanup.md | Guided cleanup — find duplicates, orphans, stale stubs | On-demand: user wants to clean up |
| 7 | dream.md | Full maintenance pipeline (sync→enrich→cleanup→health→report) with cycle lock | Scheduled / on-demand |
| 8 | signal-detector.md | Scan messages for entities, concepts, events | Event-driven: on each user message |
| 9 | write.md | Knowledge-based writing — gather from brain, produce polished output | On-demand: user wants to write something |
| 10 | brain-ops.md | 5-step protocol + 38-tool reference | Default: agent startup / tool lookup |

## Resolution Logic

```
1. Match intent against Routing Rules (top to bottom, first match wins)
2. If no match → fall through to brain-ops.md [default]
3. If scheduled trigger → dream.md
4. If event-driven (new message) → signal-detector.md first, then matched skill
```

## Validation

Manual checklist:
- **Coverage**: all intent categories mapped to at least one skill
- **No overlaps**: no two skills claim the same intent (unless chained)
- **No orphans**: every skill in the inventory is reachable via a route
- **File exists**: every referenced skill file exists on disk
