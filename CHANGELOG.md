# Changelog

> Current: `0.1.0-dev` — active development. Version bumps will resume at v0.3.0 for the first stable release.

## [Dev] — 2026-04-28

### Added
- **`skills/RESOLVER.md`** — 18 intent→skill routing rules across 7 categories, covering all 7 skills
- **`src/core/resolver.ts`** — `ResolverChecker` parses RESOLVER.md and validates coverage, overlap, orphan detection
- **`cbrain check-resolvable` CLI command** — validates RESOLVER.md completeness at any time

### Changed
- **task_plan.md** — updated to reflect completed Phases 1-5, feature comparison table synced to current state

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
