# Changelog

> Current: `v1.6.1` — 学习闭环：从使用模式中动态调整实体权重。

## [v1.6.1] — 2026-05-16

### 学习闭环（5 Phases）

**Phase 1 — 查询日志：**
- `query_log` 表：记录所有 MCP 查询（recall/search/graph），含 tool、query、result_slugs、latency、session_id
- recall.ts / search.ts / graph.ts 三个工具在返回结果前自动记录

**Phase 2 — 活动权重：**
- `pages` 表新增 `activity_weight` + `last_queried_at` 列
- `LearnManager`（`src/core/learn.ts`）：recomputeAll（dream 调用）+ bumpOnQuery（实时微增）
- 权重公式：`Σ(query_value × position_weight × time_decay)`，14 天半衰期
- Dream 管线新增 Stage 3: Learn，自动重算权重

**Phase 3 — 排序集成：**
- Search RRF 加 activity_weight bonus（W_ACTIVITY = 0.15）
- Graph 排序改为复合排序：`activity_weight + LOG(mention_count + 1)`
- Enrich tier 计算改为：`mention_count × 0.4 + activity_weight × 0.6`
- Recall quality label 修正：tier ≤ 1 = "high"，不再反转

**Phase 4 — 反馈机制：**
- `query_feedback` 表 + `record_feedback` MCP 工具
- 小爱可回报 relevant/irrelevant/expanded 信号
- LearnManager.recomputeAll 中反馈影响权重

**Phase 5 — 会话共现：**
- query_log 含 session_id，共现信号增强已有 link weight
- 只增强已有关系，不凭空发明新关系

### 备份优化
- Dream backup 不再包含 vault（有 iCloud 备份），只备份 DB + LanceDB（1.3GB → 143MB）
- 修复 dbPath 解析错误导致备份静默失败（0MB）

## [v1.6.0] — 2026-05-16

## [v1.6.0] — 2026-05-16

### 性能优化（19 fixes，4 Sprints）

**Sprint 1 — 独立高影响：**
- reflect 图邻接缓存 — BFS/label propagation 不再每次重建邻接表
- NER Stage 1 并发 — 串行 LLM 调用改为 CONCURRENCY=5 batch
- getBySlug LRU 缓存 — 200 上限，30s TTL，list/update 自动 invalidat
- resolveEntityName 预构建小写索引 — 消除 O(n) 线性扫描
- pipeline Set 去重 — Array.includes → Set.has
- deletePageCascaded 去冗余 DELETE — 依赖 ON DELETE CASCADE
- stripCodeBlocks O(n^2) → O(n) — 逐字符拼接 → parts.join

**Sprint 2 — 批查询 + 缓存：**
- recall 批量查询 — N+1 → batchGetLinks/Timeline/Tags
- graph traverse 批量 — 逐节点查询 → 按层批量取
- search 查询扩展缓存 — 5 分钟 TTL
- countNewPagesSince — 两条 COUNT → GROUP BY 一条
- insight TTL 配置缓存 — 1 分钟 TTL
- insight 签名从 SQLite 取 — 不再读磁盘

**Sprint 3 — 异步 I/O + SQL 优化：**
- sync/dream/watcher/shared 全部同步 I/O → async
- dream 并行阶段 — cleanup+health+insight archive Promise.all
- rewriteVaultLinks 按需扫描 — chunks_fts LIKE 定位候选文件
- resolveSlugs 批量 — 逐条查询 → 3 条批量 SQL
- 关联子查询 → LEFT JOIN

**Sprint 4 — 清理：**
- ingest 代码去重 — ingestMarkdown/ingestText 提取 ingestCore

## [v1.5.2] — 2026-05-13

### 索引时间戳

- **时间戳格式** — All-Entities、All-Concepts、Dashboard 的 updated 列从纯日期 `YYYY-MM-DD` 改为完整时间 `YYYY-MM-DDTHH:MM:SS`

## [v1.4.1] — 2026-05-12

### Dream 索引生成

- **Stage 6: indexes** — dream 维护流程末尾自动调用 `IndexGenerator.generateAll()`，刷新 All-Entities、All-Concepts、Dashboard 索引文件，不再需要手动 `cbrain index`

## [v1.4.0] — 2026-05-12

### Wiki-link 全生命周期

- **delete 死链清理** — 删除页面时自动扫描 vault，将 `[[slug]]` 还原为纯文本
- **merge 链接重写** — 合并页面时自动将 `[[source]]` → `[[target]]` 全 vault 替换
- **rewriteVaultLinks 共享函数** — merge（替换）和 delete（移除）共用一套 vault 扫描逻辑

### Raw 类型移除

- **raw→record 统一** — 去掉 raw 页面类型，所有 raw/* 迁移为 records/*
- **slug 路径简化** — TYPE_PREFIX map 替代 pluralize+prefix 双层逻辑
- **DB v5 迁移** — 自动将 raw/* 和 brain/records/* 统一为 records/*，覆盖 pages/links/chunks/tags/timeline/versions/ingest_log 全部表
- **vault 目录结构** — 不再创建 raw/ 目录，init 只建 records/
- **sync inferTypeFromPath** — 路径类型推断去掉 raw 分支，records/ → record
- **health check 适配** — health 检查中 raw 引用全部改为 record

### Profile 热重载

- **mtime stale 检测** — Profile 文件修改后自动重新加载，无需重启

### Auto-link 撤回

- **移除 autoLink 功能** — CJK 正则匹配不成熟，撤回待后续重做

## [v1.3.1] — 2026-05-11

### Raw 类型 + 合并层级隔离

- **`raw` 页面类型** — 新增 raw 类型，`raw/` 目录文件不再被错误标记为 record
- **层级系统** — `getLayer()` + `canMerge()` 抽象，source 层（raw/record）与 derived 层（entity/concept/insight）隔离
- **合并防护三重机制** — MCP tool、核心 merge 方法、canonicalSlug 均强制层级隔离
- **sync 路径映射修复** — `raw/xxx` 正确推断为 raw 类型（之前错误返回 record）
- **DB schema 迁移** — pages 表 CHECK 约束增加 raw，存量 92 条 raw 路径记录批量修正
- **slug 工具兼容** — canonicalSlug 对 raw 类型跳过目录重写，避免 `raw/raws/` 错误路径

## [v1.1.0] — 2026-05-09

### Insight 系统 (P0-1)

- **insights 表 + InsightManager** — 新表存储 LLM 生成的跨域洞察，独立于 discoveries
- **6 个 Insight MCP 工具** — `create_insight`, `read_insights`, `get_insight`, `promote_discovery`, `mark_insight_read`, `read_unread_insights`
- **reflect 从 dream 拆出独立** — `cbrain reflect` CLI 命令，reflect 不再阻塞 dream 流程
- **insight 页面类型全面支持** — list_pages/ingest/sync/pipeline 全部识别 insight 类型

### Discovery 闭环 (P0-2)

- **discoveries 表扩展** — 新增 `actionable`(high/medium/low)、`suggestion`(LLM 建议)、`proposed_actions`(JSON)、`auto_applicable` 四列
- **发现分级** — `classifyActionable()` 基于 score+type+entityTypes 自动分级
- **LLM 建议生成** — 对 actionable != low 的发现自动生成中文建议和操作建议
- **`run_discovery` MCP 工具** — Agent 可按需触发发现管线
- **`read_discoveries` 人类可读** — 返回中文格式化输出，不再是原始 JSON
- **`cbrain discover` CLI 命令** — 手动/cron 触发发现管线
- **embedding 缓存** — `scoreCandidate()` 加 `embCache`，O(N²) embedding 调用降为 O(N)

### 文档

- **Agent 兼容性说明** — README 明确 CBrain 以 Hermes Agent 为开发对象
- **功能分类表** — 三类：独立 CLI / Agent 按需 / Agent 定时任务

## [v1.0.1] — 2026-05-05

### Fixes

- **Config loading: dual cbrain.json architecture fix** — `CBRAIN_DIR` env var removed (caused stale config reads from iCloud vault). New `CBRAIN_CONFIG` env var points directly to config file. Eliminates dual-config drift risk. (`src/cli/context.ts`)
- **NER UNIQUE constraint fix** — `upsertPage()` in dialogue.ts now uses INSERT OR REPLACE instead of raw INSERT, preventing crash on duplicate entity names during dialogue ingestion. (`src/core/dialogue.ts`)
- **Undefined relation type in stub bodies** — `pipeline.ts` stored raw `rel.relation` (could be undefined) instead of `normalizeRelation()` result in stub body generation. Now uses `normRel` consistently. (`src/core/pipeline.ts`)

## [v1.0.0] — 2026-05-05

### HTTP API

- **`cbrain serve --http`:** New HTTP transport on `127.0.0.1:3399`. All 41 MCP tools exposed as `POST /tools/:name`. Persistent via launchd.
- **Binary build:** `bun build --compile` produces self-contained 152MB binary. Zero dependencies at runtime.

### NER Refactoring

- **Model upgrade:** glm-4-flash → glm-5-turbo. Dramatically improved entity classification accuracy.
- **Classifier simplified:** 5-layer ~50 rules → 3-layer ~10 rules. LLM as primary classifier, rules as safety net.
- **Text chunking:** Long texts split at sentence boundaries, merged with dedup. Replaces blunt 3000-char truncation.

### Vault Cleanup

- entities 492→309, removed 200+ misclassified concept stubs
- concepts 582→553, removed 29 empty stubs
- Legacy `brain/nodes/` directory removed

### Fixes

- summarize/deep_recall: use `fts` strategy instead of vector search (1000x faster, avoids embedding timeout)
- sync: insight pages excluded from NER (both batch and single-page paths)
- PID lock removed for multi-Agent support
- classifyEntity: 2-3 char Chinese no longer blindly classified as entity
- MCP server version → 1.0.0

## [v0.4.1] — 2026-05-04

### P1: 数据质量基础设施

- **时效性标记：** pages 表新增 `expires_at` + `confidence_decay` 字段。health 新增"时效性"维度，自动检测过期和低置信度内容。
- **关系强度：** links 表新增 `weight` (0-1) + `strength` (strong/medium/weak) 字段。关系自动推导（任职→strong/1.0，提及→weak/0.3）。`graph_query` 支持 `minWeight` 过滤。
- **矛盾检测：** health 新增"矛盾检测"维度。同一 entity 被多个 raw/ 源引用时，Jaccard 词重叠检测潜在矛盾。

### P2: 上下文动态摘要

- **新增 `summarize` MCP tool：** 搜索 + 图遍历 + 权重过滤 + 上下文聚合，一次调用给出领域全貌（正文、关系链、时间线、标签、邻居、近期动态）。

### Insight 功能重构

- **`generateInsights` 禁用。** 旧系统 65 条 auto insight 全部归档删除。auto insight 替换为新架构。
- **discoveries 表：** 新表，存图算法发现的结构化异常（bridge/community_crossing/structural_hole）。
- **dream 新增 discovery stage：** 每次 dream 跑 5 维打分 + 社区检测 + BFS，产出 top-20 结构化发现（0 LLM 调用）。
- **MCP tools：** `read_discoveries` + `mark_discovery_seen`。Agent 读取发现 → 呈现给用户 → 用户判断 → 确认后写成 `brain/insights/` 笔记。
- **brain_storm：** `cross_domain_insights` 改名为 `connections`。description 重写，明确"推理找空白用 brain_storm，查事实用 search/query"。
- **诊断工具：** `diagnose-insight` CLI 命令 + `tests/insight-sim.ts` 模拟脚本。

### Bug 修复（8 个）

- **悬空链接清理：** 新增 `cleanDanglingLinks()`，sync 时自动清理引用不存在页面的 link（修复 `brain/nodes/` 迁移残留 8 条）。
- **`audit.ts` 死代码：** AuditLogger 类及 14 处调用全部删除。只保留 `MetricsSnapshot` 接口。
- **多 serve 进程保护：** PID 文件锁（`cbrain.pid`），重复启动自动拒绝。
- **`source`/`event` 类型残留：** slug.ts、audit.ts、health.ts、brain.ts 中死代码清理。DB CHECK 约束修复。3 条 event 页面转为 record。
- **空 catch 日志：** 3 处静默吞错的 catch 块加 `console.error`。
- **brain_storm slug 空路径：** 加长度检查，无效 slug 跳过。
- **`outputs/` 文件误入图谱：** `collectMarkdownFiles` 加 `excludeDirs`。清理 19 条误同步的 outputs 页面。
- **关系强度 SELECT 漏列：** `getOutgoingLinks`/`getIncomingLinks` 补上 weight/strength 列。

### 运维

- **`cbrain-restart` alias:** shell alias for quick serve restart.
- **团队数据入库:** batch entity structuring with relation links.

## [v0.4.0] — 2026-05-03

### 目录结构重构：entities/ + concepts/ 恢复独立

`brain/nodes/` 是历史妥协，统一目录模糊了 entity（人/公司/产品）和 concept（方法论/理论/效应）的边界。恢复为 `brain/entities/` + `brain/concepts/`，581 个文件按 type 迁移，DB 全量更新。

### Slug 规范化：`canonicalSlug()`

所有页面创建路径（put_page、NER stub、wikilink stub、ingest、writeback）强制校验 slug 目录前缀。`syncPage` 发现错放文件自动迁移。不再产生 `brain/nodes/` 或路径错误。

### NER 分类器重构：统一三路分流

三个碎片函数（`isNoiseEntity`、`isGenericConcept`、`correctEntityType`）合并为单一 `classifyEntity(name, llmType) → entity | concept | null`。五层优先级：黑名单 → 强 concept 信号 → 强 entity 信号 → 泛化词过滤 → LLM 信任。Prompt 从平铺列表改为决策树。

中英文实体全量人工审查：22 个泛化词删除，30 个 entity→concept，1 个 concept→entity，9 个重复合并。最终 315 entities + 227 concepts。

### 新增 `deep_recall` MCP 工具

一次 MCP 调用替代之前 5-7 次串行查询（query→get_page→graph_query→get_links→get_timeline）。内部 `Promise.all` 并行获取搜索结果 + 每个实体的 page/links/timeline/tags/related，返回结构化 bundle + quality/tier 评估。

### put_page 补全 NER + wikilink

`put_page` 创建/更新页面时同步执行 NER 实体提取和 wikilink 解析。之前只更新了索引，NER 靠 watcher 补跑但被 hash 检查跳过。

### Tags 同步写文件

`add_tag` / `remove_tag` 改为通过 `PageManager.update()` 同时写 DB 和 vault 文件 frontmatter，不再出现"标签只在 DB 不在文件"的问题。`get_tags` 合并两处来源。

### 禁用 inferred relations

ReflectManager 的 LLM 推断关系质量太差（746 条垃圾链接，方向搞反、间接关联当直接关系）。`inferRelations()` 改为直接 return []，保留 entity synthesis 和 insight generation。

### 健康检查阈值调整

overall status 从"任一维度有 high issue → fail"改为"high issue > 5 个 → fail"，避免 3 个疑似重复就把 715 页的健康检查拉红。

### 每日简报推送

Dream 报告新增 `buildBrief()`：人类可读的日报替代枯燥计数。`DreamReport` 加 `brief` 字段，MCP dream handler 返回 brief。

### deep_recall 跨域关联

`deep_recall` 新增 Phase 3 `cross_refs`：查询实体时列出关联实体中最近 7 天有更新的，Agent 能主动说"对了，XX 3天前更新了笔记"。

### brain_storm：大脑思考模式

新增 MCP tool `brain_storm`，实现感知 → 推理+自省 → 发现（写回CBrain）→ 呈现+提问 的完整循环。当内部知识不足时返回 `search_queries` 建议外部搜索。与 `deep_recall` 分工：查实体用 deep_recall，需要分析/出主意用 brain_storm。

### outputs/ 移入 vault

`outputs/` 从 vault 外侧移到 `vault/outputs/`，和 `brain/` 平级。Obsidian 可以直接看到备份、健康报告、索引。清理了残留的 `outputs/records/` 目录，移除无用的 `All-Records.md`。



### 关系类型规范化

46 种中英混杂关系 → 10 种 MECE 规范类型（认识/提及/任职/创立/归属/合作/竞争/资本/制造/间接关联）。`CANONICAL_RELATIONS` + `normalizeRelation()` 在 shared.ts，NER/reflect/health 三处同步。963 条 link 已迁移，health check 一致性维度 ✅。

### Insight Agent 访问

- type enum 补全 insight，list_pages/ingest/sync/pipeline 全部支持
- ReflectManager 注入 pipeline，insight 创建后立刻 embed+FTS，不等 sync
- dream_reset MCP 工具

### Dream Sub-Agent 方案

dream no longer limited by MCP 30s timeout — sub-agent mode with extended timeout, user-friendly message on lock conflict.

### Agent 记忆更新

Agent protocol files updated: CBrain data paths, relation types, insight query protocol, dream sub-agent protocol.

## [Dev] — 2026-05-02

### 系统大扫除

- **死功能清理** — 删 raw_data 全链路（0 行数据）、ResolverChecker + RoutingEval（无关代码）、config MCP 工具（无人使用）。AuditLogger 空壳化，Logger 只写 warn/error，info 不进磁盘。共计 **-666 行**。
- **页面类型合并** — event + source → record，从 6 种减为 4 种（entity/concept/record/insight）。brain/ 目录从 5 个减为 3 个（nodes/insights/records）。`normalizePageType()` 在 PageManager 入口把关，raw/ 文件的非标类型自动归一化。

### 两阶段 NER 提取（借鉴 Hyper-Extract）

- **阶段 1** — 只抽实体 + 事件，过滤后产出精确 entity list。
- **阶段 2** — 用 entity list 作为 context 只抽关系，LLM 只能引用列表里的名字，彻底杜绝 dangling reference。
- **Schema-Guideline 分离** — ENTITY_SCHEMA/GUIDELINE + RELATION_SCHEMA/GUIDELINE，为领域定制铺路。

### DeepSeek 迁移

- 新增 `DeepSeekLLMProvider`（deepseek-v4-flash），reflect 走 DeepSeek，NER 继续走智谱 glm-4-flash。
- 并发 2 → 3。

### Insight 质量优化

- 置信度门槛 >= 0.8，source_entities 重叠度 >50% 去重，标题限 10 字。
- prompt 去风格化——强调"好的洞察是稀有的"，默认为空。
- 三阶段 `Promise.all` 并行。产出从 87 个降至 11 个精选。

### Bug Fixes

- 修复 22 个实体文件的 wikilink 双链接错误（brain/sources/ → brain/records/）。

## [Dev] — 2026-05-01

### ReflectManager — 洞察质量 + 速度优化

- **去AI化 prompt 重写** — INSIGHT_SYSTEM 全部重写：短句、口语化、有节奏、不铺垫。给出好坏范例对比，禁止"不仅...而且""揭示""表明"等 AI 套路句式。要求洞察是推理结论，不是摘要复述。
- **glm-5-turbo 模型** — 通过 coding plan 端点调用，质量远超 glm-4-flash。
- **串行阶段执行** — reflectAll() 从 Promise.all 并行改为串行，避免三阶段同时打 API 导致 429。
- **Retry + 指数退避** — callLLM 加 3 次重试，退避 3s/6s/9s。
- **CONCURRENCY=2** — 从 5 降到 2，稳定跑完不触发限流。

### Health Check — 从数据 dump 变成诊断工具

- **状态持久化** — `outputs/health/state.json` 存 issue 快照 + 慢性计数器。
- **Delta 计算** — 每次运行对比上次：新增、消失、慢性（连续 3+ 次）、不变。
- **三层输出** — summary（<50 行给人看）、actions（只有新增/恶化）、detail（JSON 给工具消费）。
- **Severity 折叠** — high 全列、medium 前 10、low 只报数量。
- **滚动清理** — 自动删除 7 天前的报告文件。
- **CLI 增强** — `--full` 完整 Markdown、`--json` 输出 JSON、`--dimension <name>` 单维度检查。
- **终端 delta 展示** — 显示 vs 上次变化：新增/消失/慢性数量。

### Bug Fixes
- **health.ts dead code 删除** — lines 83-93 unreachable 重复代码块。
- **page.ts 类型修复** — 参数类型对齐。

### Repository Layer — 消灭 131 处 SQL 泄漏

- **CBrainDB 成为唯一 SQL 入口** — 18 个消费者文件中的 131 处 `db.prepare("SQL")` 全部替换为 CBrainDB 方法调用。
- **`prepare()` 改为 `private`** — 从外部无法再直接写 raw SQL，改表结构只需改 `sqlite.ts` 一处。
- **新增 ~50 个 typed 方法** — pages (25+), links (12+), chunks (3), config (3), ingest log (2), timeline (3), tags (2), FTS (1)。
- **MCP server 拆分为 12 个 per-domain tool 文件** — server.ts 从 866→83 行，每个 tool 独立文件：`pages.ts`, `graph.ts`, `search.ts`, `ops.ts`, `tags.ts`, `timeline.ts`, `versions.ts`, `jobs.ts`, `raw-data.ts`, `sync.ts`, `config.ts`, `ingest.ts`。

### Bug Fixes
- **maintenance.ts 死代码清理** — 删除引用已不存在的 `enrichWithContent`/`enrichAllWithContent`。
- **EnrichManager 构造函数修复** — maintenance.ts 多传了 `vaultPath` 参数。
- **pipeline.ts addTimelineEntry 参数顺序** — 与 CBrainDB 原始签名对齐。

## [Dev] — 2026-04-30

### NER Quality Overhaul
- **Prompt philosophy reversed** — from "cast a wide net" to "precision first". Explicit skip rules for daily items, roles, departments, abstract qualities, generic business terms.
- **New `isGenericConcept()` filter** — pattern-based rejection of generic compound Chinese terms (管理/策略/能力/思维 suffixes, 大众/消费者/市场 prefixes).
- **Expanded noise detection** — job titles (经理/总监/人员/管理员/作家), departments (团队/部门/小组/中心), 30+ new `GENERIC_TERMS` entries.
- **Extraction limits tightened** — 12 entities + 5 concepts → 8 entities + 3 concepts (MAX_TOTAL_ENTITIES=8, MAX_CONCEPTS=3).
- **Strict concept rules** — only recognized methodologies, theories, effects, laws, models pass. Examples: 奥卡姆剃刀 ✅, 注意力管理 ❌.
- **Relevance-aware capping** — entities sorted by relevance before slicing; low-relevance dropped first.
- **Production cleanup** — deleted 75 garbage entities (41 concepts + 36 daily items/roles/departments) from DB + vault.
- **5 new tests** — generic concepts, daily items, job titles, type preservation, limit enforcement.

### Architecture
- **entities + concepts → `brain/nodes/`** — merged into single directory. Type field distinguishes entity vs concept, no more classification guesswork.
- **`ContentPipeline`** — extracted unified write pipeline. `writeIndexes`, wikilink processing, and NER application now have one implementation shared by sync, ingest, and MCP server. Removed 508 lines of duplicated code across sync.ts (617→406), ingest.ts (324→143), shared.ts.

### NER Prompt
- **"Broad extraction" philosophy** — LLM casts wide net, downstream filters decide what to keep. Removed 65 lines of DO/DON'T rules, replaced with simple Golden Rule.
- **Six-filter pipeline**: `findEntitySlug` (known entities) → `relevance` (low = skip) → `length` (≤20 chars) → `GENERIC_TERMS` (blacklist) → `isNoiseEntity` (phones/emails/titles) → `isValidEntityName` (fragments).

### Watcher
- **Polling mode** — replaced `fs.watch` (broken on iCloud Drive) with 3-second content-hash polling.
- **Full pipeline** — watcher now runs wikilink extraction + NER (previously only synced file metadata).
- **Reuses deps** — watcher shares embedding/lance instances with MCP server, no duplicate API connections.

### Bug Fixes
- `syncPage` now runs wikilink extraction (was missing — watcher-triggered syncs ignored `[[...]]`).
- `isValidEntityName` no longer rejects names ending in 着 (was blocking 功能固着).
- `resolveLinkTarget` in ingest uses `findEntitySlug` (was matching raw/ records as wikilink targets).
- `upsertLinks` only deletes "mentions" links, preserving NER-created relations.
- Image embeds (`![[img.png]]`) no longer treated as wikilinks.
- `removeOrphans` uses `PageManager.delete()` for cascade cleanup.
- `enrich.ts` reads `type` from DB directly (was broken by nodes/ migration).

### Added
- **`DialogueIngest`** (`src/core/dialogue.ts`) — conversation-aware ingestion with incremental entity matching, avoids re-creating known entities
- **`dialogue` MCP tool** — agents can ingest conversation snippets directly

### Removed
- **`cbrain watch` command** — `cbrain serve` already includes watcher. Having both caused double-watcher conflict and MCP disconnection.
- **API key plaintext warning** — `console.error` nag on every command removed. Key-in-config is the expected default.
- `extractEnglishTerms` — regex-based English acronym extraction (LLM does this better).
- `extractChineseRelations` — regex-based Chinese relation extraction (sentence fragment source).
- `extractMarkdownLinks` — unused.
- Duplicate `extractWikiLinks` in ingest.ts — unified with extract.ts.
- Duplicate `indexPageContent` in MCP server — unified with shared.ts.
- Dead `parallelBatch` method in sync.ts.
- **Relevance scoring** — LLM rates each entity high/medium/low. Low-relevance entities don't create stubs.
- **Prompt-level noise filter** — Skip generic gov bodies (国务院), political titles (中共党员), common locations.
- **Regex extraction filter** — `isValidEntityName()` blocks sentence fragments (24小时内或下个, 色的管理者就) and wiki-link path entities (e.g. brainentities某实体名).
- **Entity/concept NER skip** — No more re-extracting entities from entity pages (cascade noise amplifier). Speed 4.8x, noise -79%.
- **Parallel NER batching** — 5 concurrent LLM calls instead of sequential.
- **Dollar amounts & time periods** — Explicitly excluded from extraction (93亿美元, Q1 2026).
- **Sync time**: ~12min → 2.5min. **Auto-extracted noise**: 264 → 80 (-70%).

### Added
- **`cbrain backup` / `cbrain restore`** — zip backup of vault + DB + LanceDB
- **Auto-backup before dream** — `cbrain dream` creates pre-maintenance backup, keeps last 7
- **`AGENTS.md`** — agent protocols for open source users (review/connect/cleanup/write)
- **UX improvements**: human-readable `query` output, `init` shows next steps, `health` uses plain language, `serve` prints MCP config

### Fixed
- **Cascade cleanup** — `PageManager.delete()` now cleans links/tags/timeline/chunks/FTS/ingest_log/raw_data
- **NER async** — ingest no longer blocks on LLM extraction, fixing timeout on long documents
- **Backup path** — auto-backups now go to `outputs/backups/` not vault root
- **TypeScript** — `tsc --noEmit` now zero errors

### Changed
- **maintain merged into dream** — `cbrain dream` is the single maintenance command
- **Agent memory streamlined** — verbose protocol rules replaced by pointer to AGENTS.md
- **cli/index.ts split** — 997-line file → 8 command modules + thin registry

## [Dev] — 2026-04-28

### Added
- **`cbrain dream` CLI command** — 5-stage nightly pipeline (sync→enrich→cleanup→health→report) with cycle lock
- **`src/core/dream.ts`** — `runDream()` with 30-min cycle lock, stage-level error isolation, daily markdown report
- **NER English entity extraction** — now extracts drugs, regulators, medical terms (Cosentyx, FDA, CHMP, IgAN...)

### Fixed
- **ingest path** — all types (record/event/source) now go to `brain/` instead of `raw/`
- **broken references** — all 26 auto-extracted stubs updated from `raw/records/` to `brain/records/`
- **NER now extracts English** — drugs, regulators, medical terms (Cosentyx, FDA, CHMP, IgAN)

### Earlier today
- **10 new CLI commands**: `show`, `list`, `delete`, `status`, `versions`, `revert`, `config`, `maintain`, `tags`, `timeline` — now 23 total
- **4 new skills**: `review.md`, `connect.md`, `cleanup.md`, `write.md` — 11 total
- **`skills/RESOLVER.md`** + `cbrain check-resolvable` — 26 rules, 11 categories, skill routing validation

## [Dev] — 2026-04-26

### Added (afternoon)
- **`merge_pages` MCP tool** — merge duplicate pages: links, timeline, tags all moved to target, source deleted
- **`PageManager.merge(sourceSlug, targetSlug)`** — core merge logic with version snapshot, body append, link/timeline migration
- **Slug collision detection** in health check — new "疑似重复" dimension detects `王强` vs `王强-1` patterns with `merge_pages` suggestion
- **Content hash change detection** — verified working; unchanged files skip re-index on sync
- **System Logger** (`src/core/logger.ts`) — info/warn/error levels, daily markdown log files, wired into PageManager, SyncManager, MCP server, CLI
- **Error detection in health check** — new "系统错误" dimension (10 dimensions now), reads recent 7-day error log
- **Health check relation whitelist** expanded — added 下级, 汇报给, 负责, 职位, 就读于, 毕业于, 专业, 专业为, 配偶关系, 条线
- **CBrain 技术全景** + **CBrain vs GBrain 横向对比** + **CBrain 使用指南** — three technical docs saved to Obsidian

### Added (morning)
- **Zero-LLM regex extraction engine** (`src/core/extract.ts`) — GBrain-inspired deterministic fallback
  - `extractWikiLinks()`: `[[target]]` wikilink extraction
  - `extractEnglishTerms()`: 3+ uppercase acronyms with known-term whitelist (RAG, LLM, MMLU...)
  - `extractChineseRelations()`: 任职于/创立了/投资了/认识/指导/成员 patterns
  - `stripCodeBlocks()`: no false positives from code samples
  - Runs alongside LLM NER in sync pipeline; creates stubs for missed entities
- **File Watcher as standalone daemon** — `cbrain watch` command + launchd plist
  - Auto-sync on file change (debounce 2s)
  - Auto-clean orphans on file delete
- **Stale stub auto-cleanup** — auto-extracted stubs whose source no longer references them are removed on sync
- **38 MCP tools** — added `maintain` tool (sync → enrich → health → brief)

### Changed
- **NER prompt**: relation types English→Chinese (任职于/认识/创业了...)
- **NER prompt**: expanded to extract English tech terms (benchmarks, acronyms, architectural patterns)
- **NER limits**: concepts 3→5, entities 8→12
- **Health check whitelist**: synced to Chinese relation types
- **Outputs fully Chinese**: 健康检查, 操作日志, 指标快照
- **`mcp_cbrain_query`**: strategy hidden from agents, always uses optimal hybrid

### Fixed
- NER noise filter: phone numbers, email/WeChat, bare locations, abbreviations, job titles, dates
- 2-char abbreviation filter narrowed to avoid killing LLM/GPU/RAG etc
- English terms now extracted: MMLU, C-Eval, GPT, Claude, CBrain, API, RAG...
- `put_page` now indexes content (chunks, vector, FTS) after create/update
- `inferTypeFromPath` updated for `raw/` / `brain/` dir naming
- `get_timeline` returns unified events list (structured + body date lines)
- `add_timeline_entry` appends to page body + auto-reindex
- Date regex fixed: single-separator dates (2007.12) now matched
- `cbrain sync` auto-runs removeOrphans + cleanStaleStubs

## [Dev] — 2026-04-25

### Added
- **Agent integration** — brain-ops skill (37-tool reference), signal-detector skill (SCAN→CLASSIFY→QUERY→INGEST)
- **Vault directory standardization** — `1_raw`→`raw`, `2_Cbrain`→`brain`, `3_outputs`→`outputs`
- **raw/ read-only boundary** — `PageManager.update()`, `writeback`, `put_page` all block writes to raw/ files
- **Auto version snapshot** — `put_page` and `sync` create version before every overwrite
- **2-char FTS fallback** — short CJK queries (e.g. "星辰") use LIKE search when trigram tokenizer lacks data
- **Design doc** — `docs/design.md` covering architecture, search pipeline, storage rationale, GBrain comparison
- **Known issues** — `docs/known-issues.md`

### Fixed
- `put_page` now indexes content (chunks, vector, FTS) after create/update — pages created via put_page were unsearchable
- `inferTypeFromPath` updated for new `raw/` / `brain/` dir naming
- `mcp_cbrain_query` no longer exposes `strategy` parameter to agents — always uses optimal hybrid

### Testing
- 264 tests, 22 files, 574 expect() calls, all green
- MCP server tests: 54 tests covering all 37 tools
- New test files: version, audit, health, zhipu (LLM)

## [0.3.0] - 2026-04-25

### Added
- **25 new MCP tools** — MCP tools grew from 12 to 37, fully covering page CRUD, tags, links, timeline, chunks, ingest log, config, versions, jobs, and raw data
- **Page tools** — `put_page`, `delete_page`, `resolve_slugs` for full page lifecycle management
- **Tag tools** — `get_tags`, `add_tag`, `remove_tag` for page-level tagging
- **Link tools** — `get_links`, `remove_link` for knowledge graph edge management
- **Timeline tools** — `get_timeline`, `add_timeline_entry` for event tracking
- **Utility tools** — `get_chunks`, `get_ingest_log`, `get_config`, `set_config` for observability and configuration
- **Version History** — `versions` table in SQLite, `VersionManager` class, `get_versions` and `revert_version` MCP tools. Auto-snapshot before revert.
- **Multi-query Expansion** — `HybridSearch` uses LLM (GLM-4-flash) to generate 2-3 query variants, searches each independently, merges with RRF. Default enabled, configurable via `multiQuery: false`.
- **SQLite Job Queue** — `jobs` table with priority, retry, and status tracking. `JobQueue` class with handler registration and work loop. 5 MCP tools: `job_submit`, `job_list`, `job_status`, `job_cancel`, `job_retry`.
- **Raw Data Storage** — `raw_data` table for BLOB storage attached to pages. 4 MCP tools: `put_raw_data`, `get_raw_data`, `list_raw_data`, `delete_raw_data`. Supports base64-encoded binary data.

### Changed
- `HybridSearch` constructor accepts optional `{ llm, multiQuery }` config
- `CBrainDB` now exposes 35+ query methods across all tables
- MCP server script in package.json updated to `--serve` command

## [0.2.0] - 2025-04-25

### Added
- **NER (Named Entity Recognition)** — LLM-based entity extraction from ingested content using 智谱 GLM-4-flash
- **Auto entity stubs** — Discovered entities (people, companies, locations, concepts, products) auto-create pages
- **Relationship inference** — Typed relations (works_at, knows, invested_in, founded, attended, etc.) written to links table
- **Timeline extraction** — Events with dates and participants extracted to timeline table
- **LLM provider interface** — Pluggable LLM backend (`src/llm/provider.ts` + `src/llm/zhipu.ts`)
- **NER config** — `ner` section in config (enabled, llm_provider, llm_model, llm_api_key, llm_base_url)
- NER runs automatically during ingest when LLM provider is configured
- MCP server version bumped to 0.2.0
- 11 new tests for NER pipeline (unit + integration)

### Changed
- `IngestManager` constructor now accepts optional `LLMProvider` for NER
- `CBrainDeps` includes optional `llm` field
- CLI `createDeps()` auto-creates `ZhipuLLMProvider` when NER is enabled
- Config type fix: `normalizeJsonConfig` now uses proper `NormalizedConfig` type

## [0.1.1] - 2025-04-25

### Fixed
- `get_page` now returns full file content via `body` field, not just metadata
- `ingestMarkdown` now uses externally passed `title` and `pageType` as fallback when frontmatter lacks them (was defaulting to "Untitled")
- Full `sync` now auto-runs `removeOrphans` — deleting vault files no longer leaves stale DB entries
- Added standalone `remove_orphans` MCP tool

### Changed
- Skill file updated: instruct agents to pass content whole (no splitting), one ingest call per document
- Skill file updated: `record` is the default pageType for multi-entity content

## [0.1.0] - 2025-04-24

### Added
- SQLite storage layer with FTS5 trigram (Chinese full-text search)
- LanceDB vector storage with pluggable embedding provider
- 智谱 embedding-3 provider (2048d)
- Hybrid search: vector + FTS + graph, fused with RRF
- Obsidian bidirectional sync (vault ↔ SQLite/LanceDB indexes)
- Ingest pipeline: text and markdown with auto-chunking
- Page CRUD with Chinese-aware slug generation
- Knowledge graph: traverse, backlinks, related entities (wiki-link based)
- Entity enrichment: tier promotion based on mention count
- MCP server with 8 tools (query, ingest, get_page, list_pages, graph_query, enrich, sync, status)
- CLI: init, doctor, ingest, query, sync, enrich, graph-query, serve
- P0 skills: brain-ops, signal-detector, ingest, query, enrich
- Open source scaffolding: README, CONTRIBUTING, issue/PR templates

## Roadmap

### v0.2 — NER + Auto Relationships ✅
- [x] Auto entity extraction (NER) from ingested content
- [x] Relationship type inference (knows, works_at, invested_in, etc.)
- [x] LLM-assisted Chinese relationship reasoning
- [x] Timeline event extraction

### v0.3 — Full MCP Coverage + Infrastructure ✅
- [x] 25 new MCP tools (12 → 37) — page CRUD, tags, links, timeline, chunks, config
- [x] Version History — versions table, VersionManager, get_versions, revert_version
- [x] Multi-query Expansion — LLM query variant generation + RRF merge
- [x] SQLite Job Queue — jobs table, JobQueue class, 5 MCP tools
- [x] Raw Data Storage — raw_data table, 4 MCP tools (base64 BLOB)

### v0.4 — Automation ✅
- [x] File watcher: auto-index on Obsidian file changes
- [x] Signal detector: auto-extract entities from conversations
- [x] Dream: nightly maintenance pipeline
- [x] Daily briefing with person context

### v0.5 — Quality of Life (current)
- [ ] Auto entity enrichment (web data) for Tier 1 entities
- [x] Content hash change detection in sync
- [x] Deduplication / merge detection
- [ ] Additional embedding providers (OpenAI, Ollama)
- [ ] CI pipeline (lint + test)
