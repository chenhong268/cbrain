# Changelog

> Current: `v0.3.1` — first stable release. 23 CLI commands, 41 MCP tools, 11 skills.

## [Dev] — 2026-05-02 (下午)

### 关系类型规范化

46 种中英混杂关系 → 10 种 MECE 规范类型（认识/提及/任职/创立/归属/合作/竞争/资本/制造/间接关联）。`CANONICAL_RELATIONS` + `normalizeRelation()` 在 shared.ts，NER/reflect/health 三处同步。963 条 link 已迁移，health check 一致性维度 ✅。

### Insight Agent 访问

- type enum 补全 insight，list_pages/ingest/sync/pipeline 全部支持
- ReflectManager 注入 pipeline，insight 创建后立刻 embed+FTS，不等 sync
- dream_reset MCP 工具

### Dream Sub-Agent 方案

dream 不再受 MCP 30s 超时限制——Hermes sub-agent（`child_timeout_seconds: 600`）执行，锁冲突时人性化提示。

### Agent 记忆更新

小爱 MEMORY.md/SOUL.md/SKILL.md 全面更新：CBrain 数据路径、关系类型、insight 查询协议、dream sub-agent 协议。

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
- **Regex extraction filter** — `isValidEntityName()` blocks sentence fragments (24小时内或下个, 色的管理者就) and wiki-link path entities (brainentities夏震宇).
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
- **小爱 MEMORY.md 精简** — four verbose protocol rules replaced by pointer to AGENTS.md
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
- **Hermes Agent integration** — brain-ops skill (37-tool reference), signal-detector skill (SCAN→CLASSIFY→QUERY→INGEST)
- **Vault directory standardization** — `1_raw`→`raw`, `2_Cbrain`→`brain`, `3_outputs`→`outputs`
- **raw/ read-only boundary** — `PageManager.update()`, `writeback`, `put_page` all block writes to raw/ files
- **Auto version snapshot** — `put_page` and `sync` create version before every overwrite
- **2-char FTS fallback** — short CJK queries (e.g. "诺华") use LIKE search when trigram tokenizer lacks data
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
