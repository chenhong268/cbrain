# CBrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal knowledge brain for AI Agents — human inputs, Agent compiles, knowledge compounds.

**Architecture:** Three-layer (Skills → Core → Storage) with Obsidian vault as SSOT. SQLite for structured data, LanceDB for vector + Chinese FTS. 智谱 embedding-3 for vectors.

**Tech Stack:** Bun + TypeScript, SQLite (bun:sqlite), LanceDB, 智谱 embedding-3, MCP Server (@modelcontextprotocol/sdk), MIT license.

---

## Phase 1: Project Scaffold + Storage

**并行**: 2 subagent 同时干

### Task 1: 项目初始化

- [ ] Create package.json (name: cbrain, bin: cbrain, type: module)
- [ ] Create tsconfig.json (Bun target, strict)
- [ ] Create directory structure: src/{cli,mcp,core,storage,embedding,skills,utils}, tests/, skills/, docs/
- [ ] Create cbrain.config.yaml schema + loader (vault_path, db_path, embedding.provider/dimensions/api_key)
- [ ] Create .gitignore, README.md (bilingual stub)
- [ ] bun install dependencies: lancedb, @modelcontextprotocol/sdk, zod, commander, yaml, gray-matter
- [ ] Create src/utils/config.ts — load config from yaml, env vars override
- [ ] Tests: config loading, defaults, env override
- [ ] Commit

### Task 2: SQLite Schema + Page CRUD

- [ ] Create src/storage/sqlite.ts — Database class (bun:sqlite, WAL mode, migrations)
- [ ] Schema: pages, links, tags, timeline, chunks, ingest_log, config tables
- [ ] Create src/core/page.ts — PageManager class (create, read, update, delete, list)
- [ ] Create src/utils/frontmatter.ts — parse/stringify YAML frontmatter (gray-matter)
- [ ] Create src/utils/slug.ts — Chinese-aware slug generation (pinyin + dash)
- [ ] Tests: schema migration, page CRUD, frontmatter parse, slug generation
- [ ] Commit

---

## Phase 2: Search Layer

**并行**: 2 subagent 同时干

### Task 3: Embedding + LanceDB

- [ ] Create src/embedding/provider.ts — EmbeddingProvider interface
- [ ] Create src/embedding/zhipu.ts — 智谱 embedding-3 implementation (fetch API, 2048d)
- [ ] Create src/storage/lancedb.ts — LanceDB manager (connect, create table, add/search/delete vectors)
- [ ] Tests: embedding call (mock), LanceDB round-trip
- [ ] Commit

### Task 4: Hybrid Search + FTS

- [ ] Create src/core/search.ts — HybridSearch class
  - vector_search: LanceDB ANN
  - fts_search: LanceDB fullText index (Chinese tokenizer)
  - graph_search: SQLite link traversal
  - RRF fusion: score = Σ(1/(60 + rank)) across all results
- [ ] Create src/core/sync.ts — sync vault files → SQLite + LanceDB indexes
- [ ] Tests: search with seeded data, RRF ranking
- [ ] Commit

---

## Phase 3: Core Pipeline (串行)

### Task 5: Ingest Pipeline

- [ ] Create src/core/ingest.ts — IngestManager
  - route by content type (markdown, url, text)
  - create page → write to vault → index to SQLite/LanceDB
  - extract entities → create/update entity pages
  - extract `[[links]]` → build graph edges
- [ ] Tests: ingest markdown file, verify vault file + indexes created
- [ ] Commit

### Task 6: Knowledge Graph

- [ ] Create src/core/graph.ts — GraphManager
  - add/remove/query relationships (SQLite links table)
  - graph traversal (BFS/DFS from entity, depth N)
  - backlink auto-completion
  - relationship inference from frontmatter context
- [ ] Tests: add links, traverse graph, find related entities
- [ ] Commit

### Task 7: Entity Enrichment

- [ ] Create src/core/enrich.ts — EnrichManager
  - tier tracking (mention count → tier 3/2/1)
  - auto-upgrade entity pages on threshold cross
  - tier 1: full profile with timeline + relationship network
- [ ] Tests: entity tier progression, page updates
- [ ] Commit

---

## Phase 4: Interfaces

**并行**: 2 subagent 同时干

### Task 8: MCP Server

- [ ] Create src/mcp/server.ts — MCP server (stdio transport)
- [ ] Tools: query, ingest, get_page, list_pages, graph_query, enrich, sync, status
- [ ] Each tool calls core layer, returns formatted results
- [ ] Tests: MCP tool invocation (mock transport)
- [ ] Commit

### Task 9: CLI Commands

- [ ] Create src/cli/index.ts — CLI entry (commander)
- [ ] Commands: init, doctor, ingest, query, embed, sync, dream, serve, graph-query
- [ ] init: create config + vault dirs + run migrations
- [ ] doctor: health check (DB exists, vault accessible, embedding works)
- [ ] serve: start MCP server
- [ ] Tests: CLI command parsing, init creates files
- [ ] Commit

---

## Phase 5: Skills + Polish

### Task 10: SKILL.md Files + Integration

- [ ] Write skills/signal-detector.md — extract entities + ideas from messages
- [ ] Write skills/ingest.md — content routing and compilation
- [ ] Write skills/query.md — hybrid search + synthesis
- [ ] Write skills/enrich.md — tiered entity enrichment
- [ ] Write skills/brain-ops.md — check brain before answering
- [ ] Write skills/maintain.md — health check procedures
- [ ] Write skills/dream.md — nightly maintenance pipeline
- [ ] Write README.md — full bilingual README with install guide, usage, architecture
- [ ] Write CONTRIBUTING.md + ISSUE_TEMPLATE + PR_TEMPLATE
- [ ] Add MIT LICENSE file
- [ ] Final commit

---

## Execution Order

```
Phase 1 (并行): Task 1 ─┐
                        ├→ Phase 3 (串行): Task 5 → Task 6 → Task 7
Phase 2 (并行): Task 3 ─┤
             Task 4 ────┘
                        ├→ Phase 4 (并行): Task 8
                        │                  Task 9
                        └→ Phase 5: Task 10
```

Total: 10 tasks, ~50 steps, estimated 2-3 focused sessions.
