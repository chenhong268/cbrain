# CBrain Skills Resolver

> Intent → Skill routing table. The agent reads this first to decide which skill to load.
> Format: `intent-pattern → skill-file [priority] [condition]`

## Routing Rules

### Query & Search
- 查询、搜索、查找、查一下、找一下 → query.md
- 谁、是谁、什么是、介绍一下、了解 → query.md
- 有什么关系、关联、图谱、链接到 → query.md

### Content Ingestion
- 导入、录入、记一下、保存、收录 → ingest.md
- 添加新、新增、创建 → ingest.md
- 这篇文章、这段内容、记录下来 → ingest.md
- signal-detector 输出待入库内容 → ingest.md

### Enrichment
- 补充、丰富、完善、扩展 → enrich.md
- 增强实体、提升 → enrich.md

### Maintenance (One-Shot)
- 同步、sync、重新索引 → maintain.md
- 体检、健康检查、doctor、健康 → maintain.md
- 清理、删除孤立、去重 → maintain.md
- 合并重复、merge → maintain.md

### Nightly Full Pipeline
- 夜间维护、每日维护、全量同步 → dream.md [scheduled]
- 定时任务、cron、daily → dream.md [scheduled]

### Signal Detection
- 信号检测、扫描信号、检测 → signal-detector.md
- 这条消息有什么值得记的、提取信号 → signal-detector.md

### Brain Ops (Protocol)
- 日常操作、brain-ops、怎么用 → brain-ops.md [default]

## Skill Inventory

| # | Skill | Purpose | Trigger |
|---|-------|---------|---------|
| 1 | query.md | Hybrid search (vector+FTS+graph) + synthesis | On-demand: user asks about something |
| 2 | ingest.md | Route incoming content to correct type + index | On-demand: user wants to save content |
| 3 | enrich.md | Tier promotion + entity enrichment | On-demand / batch: after sync |
| 4 | maintain.md | Sync, health check, orphan cleanup (one-shot) | On-demand: user runs maintenance |
| 5 | dream.md | Nightly full pipeline (sync→enrich→doctor→report) | Scheduled: cron / timer |
| 6 | signal-detector.md | Scan messages for entities, concepts, events | Event-driven: on each user message |
| 7 | brain-ops.md | 5-step protocol + 37-tool reference | Default: agent startup / tool lookup |

## Resolution Logic

```
1. Match intent against Routing Rules (top to bottom, first match wins)
2. If no match → fall through to brain-ops.md [default]
3. If scheduled trigger → dream.md
4. If event-driven (new message) → signal-detector.md first, then matched skill
```

## Validation

Run `cbrain check-resolvable` to verify:
- **Coverage**: all intent categories mapped to at least one skill
- **No overlaps**: no two skills claim the same intent (unless chained)
- **No orphans**: every skill in the inventory is reachable via a route
- **File exists**: every referenced skill file exists on disk
