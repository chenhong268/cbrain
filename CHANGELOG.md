# Changelog

All notable changes to this project will be documented in this file.

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

### v0.2 — NER + Auto Relationships
- [ ] Auto entity extraction (NER) from ingested content
- [ ] Relationship type inference (knows, works_at, invested_in, etc.)
- [ ] LLM-assisted Chinese relationship reasoning

### v0.3 — Auto Enrichment
- [ ] Tier 2 auto-enrichment: web data for frequently mentioned entities
- [ ] Tier 1 full profile: timeline + relationship network
- [ ] Timeline table and event extraction

### v0.4 — Automation
- [ ] File watcher: auto-index on Obsidian file changes
- [ ] Signal detector: auto-extract entities from conversations
- [ ] Dream: nightly maintenance pipeline
- [ ] Daily briefing with person context

### v0.5 — Quality of Life
- [ ] Content hash change detection in sync
- [ ] Deduplication / merge detection
- [ ] Additional embedding providers (OpenAI, Ollama)
- [ ] CI pipeline (lint + test)
