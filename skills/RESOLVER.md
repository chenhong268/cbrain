# CBrain Skills Resolver

> Intent → Skill routing table. The agent reads this first to decide which skill to load.
> Format: `intent-pattern → skill-file [priority] [condition]`

## Routing Rules

### Startup / Cron
- Agent 启动或 cron 初始化 → **hermes-cbrain-brief.md**（启动必读速查）
- 日常操作、brain-ops → brain-ops.md [default]

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

### Source Tracking / Provenance（来源追踪，优先于通用搜索）
- 这条信息哪来的、来源是什么、证据来源是什么 → query.md [provenance]
- 这个关系是谁说的、谁告诉你的、这条依据从哪来 → query.md [provenance]
- 这件事有证据吗、这个结论确认过吗 → query.md [provenance]
- 这条记忆可靠吗、可信吗、这个来源可靠吗 → query.md [provenance]
- ⚠️ 区分 grounded vs provenance："有依据吗/是不是真的/讨论过吗" → 走 grounded（问有没有），"依据从哪来/来源是什么/谁说的" → 走 provenance（问来源）
- ⚠️ 不适用：普通内容回忆（"当时怎么设计的"）→ 走 deep_recall

### Episodic Person Recall（情境找人，优先于通用搜索）
- 那个人是谁、哪个人、叫什么来着、想不起名字、忘了名字 → query.md [episodic]
- ⎿条件：时间/地点/事件/场景/主题 + 见过/认识/遇到/一起做过 + 谁/那个人/人
- ⎿关系事件组合：已知人物 + 共同事件/活动 + 忘名信号 + 找另外的人 → query.md [episodic]
- ⎿示例：去年团建见过谁、上个月聚餐认识的那个、项目上线一起干的人、主题C相关的人
- ⎿示例（关系事件）：想不起名字了，之前和人物A、人物B一起旅行的另外几个人、忘了叫什么就是和人物A一起做项目的那个人
- ⚠️ 不适用：用户提到具体人名（"人物A认识谁"）→ 走 query/connect；纯关系查询（"A和B什么关系"）→ 走 connect
- ⚠️ 区分：已知人物+共同事件+**找别人**→episodic；已知人物+共同事件+**问经历/内容**→deep_recall

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

### Agentic Research（EXPERIMENTAL — 非默认路由）
- A 和 B 的差异/取舍/哪个更适合 → query.md [agentic_research detail=normal]
- 我还遗漏了什么/这个判断有什么盲区 → query.md [agentic_research detail=normal]
- A、B、C 之间有什么内在联系 → query.md [agentic_research detail=normal]
- 这个结论依据够不够/有哪些证据和缺口 → query.md [agentic_research detail=normal]
- 复杂复盘需要多步推理和交叉验证 → query.md [agentic_research detail=full]
- ⚠️ 不适用：单一实体查找、简单关键词搜索、找人、内容回忆 → 走 query / deep_recall / recall_episode
- ⚠️ 不适用：核查确认 → 走 deep_recall(grounded=true)
- ⚠️ 不适用：两人关系查询 → 走 graph_query / connect

### Merge & Dedup
- 这两个重复了、合并、一样的、重复页面 → cleanup.md
- merge、合并页面 → cleanup.md

### Insights & Discoveries
- 最近有什么发现、有什么我漏掉的、有什么关联没注意到的 → query.md
- 洞察、insight、discovery、发现 → query.md
- ⚠️ 展示约束：discovery 输出只使用 `display`、`cards`、`summary` 字段
- ⚠️ 禁止暴露：score、distance、shared_neighbors、debug、_debug、candidate、filter、图距离、跳、桥接、候选、过滤
- ⚠️ `run_discovery` 默认返回用户可读摘要（最多 3 条卡片），不需要二次格式化

### Timeline
- 时间线、事件、发生了什么、历史记录、什么时候 → review.md
- 按时间排列、事件流、回顾 → review.md

### Tags
- 打个标签、加标签、标签管理、按标签找 → ingest.md
- 批量打标、tag → ingest.md

### Hierarchy — 组织层级
- 下属、谁向X汇报、X的团队、X管谁、直属下属 → get_org_tree(direction=down)
- 上级、X向谁汇报、X的老板、谁的下属包含X → get_org_tree(direction=up)
- 汇报线、汇报关系、报告链、reporting line → get_org_tree(direction=both)
- 组织架构、组织结构、组织树、某组织下面有哪些人 → get_org_tree(direction=down)
- ⚠️ 禁止先跑 deep_recall / query / graph_query 再拼层级 — 直接调 get_org_tree
- ⚠️ get_hierarchy 保留为单点上下文工具（manager+subordinates+peers），不用于树形遍历
- ⚠️ 两人关系（"A和B什么关系"）走 connect 分支，不走这里

### Hierarchy — 分类归属
- 分类、层级、属于哪个、子分类、parent/child → query.md

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
| 1 | **hermes-cbrain-brief.md** | CBrain 启动必读速查（~1200 字） | Agent 启动 / cron 初始化 |
| 2 | query.md | Hybrid search (vector+FTS+graph) + synthesis | On-demand: user asks about something |
| 3 | review.md | Deep topic review — gather everything, synthesize coherent picture | On-demand: user wants full understanding |
| 4 | connect.md | Relationship analysis — find and explain connections between entities | On-demand: user asks how A and B relate |
| 5 | ingest.md | Route incoming content to correct type + index | On-demand: user wants to save content |
| 6 | enrich.md | Tier promotion + entity enrichment | On-demand / batch: after sync |
| 7 | cleanup.md | Guided cleanup — find duplicates, orphans, stale stubs | On-demand: user wants to clean up |
| 8 | dream.md | Full maintenance pipeline (sync→enrich→cleanup→health→report) with cycle lock | Scheduled / on-demand |
| 9 | signal-detector.md | Scan messages for entities, concepts, events | Event-driven: on each user message |
| 10 | write.md | Knowledge-based writing — gather from brain, produce polished output | On-demand: user wants to write something |
| 11 | brain-ops.md | 5-step protocol + 38-tool reference | Default: agent startup / tool lookup |

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
