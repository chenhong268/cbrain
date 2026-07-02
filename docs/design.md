# CBrain Design

> Your Agent's Memory, Compounding.

## Architecture

```
┌──────────────────────────────────────────┐
│  Skills Layer (7 × SKILL.md)             │  ← Agent behavior: when to check, what to save
├──────────────────────────────────────────┤
│  MCP Server (85 tools, stdio + HTTP)     │  ← Agent interface: CRUD, search, graph, jobs
├──────────────────────────────────────────┤
│  Core Engine                             │
│  ┌──────────┬──────────┬──────────────┐  │
│  │ Ingest   │ Search   │ Graph        │  │
│  │ (NER +   │ (vector  │ (wiki-link   │  │
│  │  chunk)  │ +FTS+MQ) │ +traversal)  │  │
│  ├──────────┼──────────┼──────────────┤  │
│  │ Enrich   │ Version  │ Health       │  │
│  │ (tier)   │ (history)│ (8-dims)     │  │
│  └──────────┴──────────┴──────────────┘  │
├──────────────────────────────────────────┤
│  Storage Layer                           │
│  ┌────────────────┬────────────────────┐ │
│  │ SQLite         │ LanceDB            │ │
│  │ (pages, links, │ (vector + FTS      │ │
│  │  tags, chunks, │  indexes)          │ │
│  │  versions,     │                    │ │
│  │  jobs, config) │                    │ │
│  └────────────────┴────────────────────┘ │
├──────────────────────────────────────────┤
│  Obsidian Vault (SSOT)                   │  ← Human reads, Agent writes, same files
└──────────────────────────────────────────┘
```

### Key Principle

**Obsidian vault is the single source of truth.** SQLite and LanceDB are index layers — if corrupted, rebuild safely. Always `cbrain backup` first, then per-page `cbrain sync --slug <slug> --reindex`, quarantined pages `cbrain sync --reindex-quarantined`, or whole-index `cbrain sync --reindex-vectors`. Never delete them directly. All data lives in markdown files readable by both humans and agents.

## Why SQLite + LanceDB instead of Postgres

GBrain uses PGLite (embedded Postgres) with pgvector. CBrain chose a different stack:

| Concern | GBrain (PGLite + pgvector) | CBrain (SQLite + LanceDB) |
|:--------|:---------------------------|:--------------------------|
| Chinese FTS | tsvector — no trigram support, poor CJK tokenization | FTS5 trigram — proper bigram/trigram indexing for Chinese |
| Vector search | pgvector HNSW — works, but adds PG complexity | LanceDB — purpose-built for ANN, columnar storage, zero config |
| Deployment | Requires Postgres-compatible runtime (PGLite) | Embedded SQLite (bun:sqlite), zero external database dependencies |
| Embedding dims | 1536d (OpenAI) | 2048d (智谱 embedding-3) |
| Migration path | Easier to scale to Supabase | Stay SQLite, or migrate storage layer behind interface |

**The tradeoff**: SQLite can't do remote multi-writer. But for a single-user agentic memory kernel, single-writer is the correct model — you're the only one writing to your brain.

## Search Pipeline

### 4-Layer Hybrid Search

```
User Query: "人物A的项目"
     │
     ├─→ Layer 0: Multi-Query Expansion
     │   LLM (GLM-4-flash) generates variants:
     │   "人物A的项目" → ["人物A 项目管理", "人物A 负责的产品", ...]
     │
     ├─→ Layer 1: Vector Search (LanceDB)
     │   Cosine similarity over 2048d embeddings
     │
     ├─→ Layer 2: Chinese FTS (SQLite FTS5 trigram)
     │   Trigram tokenizer handles unsegmented Chinese
     │
     └─→ Layer 3: Graph Traversal
         Wiki-link based relationship discovery
     
     All results merged via Reciprocal Rank Fusion (k=60)
     score = Σ (1 / (60 + rank_in_strategy))
```

### Why RRF with k=60

Standard RRF uses k=60. Lower k (30) favors top-ranked results too aggressively — one strong signal drowns out others. Higher k (90) flattens the ranking — differentiators get washed out. k=60 is the empirically validated sweet spot from the information retrieval literature.

### Multi-Query Expansion

A single query often misses relevant results because the user's phrasing differs from how the content was written. The LLM generates 2-3 semantically equivalent variants, each searched independently, results merged with RRF. 

Fallback: if LLM is unavailable or errors, gracefully degrades to single-query mode.

### Chinese FTS: FTS5 Trigram

Standard FTS5 uses word-level tokenization which fails for Chinese (no spaces between words). The trigram tokenizer splits text into overlapping 3-character n-grams:

```
"知识图谱" → ["知识图", "识图谱"]
```

This works for CJK without requiring a segmenter. Combined with RRF fusion against vector results, recall is competitive with purpose-built Chinese search engines.

## Ingest Pipeline

```
Content Input (text or markdown)
     │
     ├─→ Parse frontmatter (gray-matter)
     ├─→ Generate slug (Chinese-aware, preserves CJK, lowercases Latin)
     │
     ├─→ Write markdown to vault (SSOT)
     ├─→ Hash content → INSERT pages row (SQLite)
     ├─→ Chunk content → INSERT chunks rows (SQLite)
     ├─→ Embed chunks → INSERT vectors (LanceDB)
     │
     ├─→ Extract wiki-links → INSERT links rows (SQLite)
     ├─→ Increment mention counts for linked entities
     │
     └─→ NER (if LLM configured)
         Extract entities (people, companies, concepts)
         Extract relationships (works_at, founded, etc.)
         Extract timeline events (dates + participants)
         Auto-create entity stubs for discovered entities
```

## Page Type System

| Type | Directory | Semantic Role |
|:-----|:----------|:--------------|
| `entity` | `entities/` | People, companies, products, projects — nodes in the knowledge graph |
| `concept` | `concepts/` | Methods, terms, frameworks, principles — the "how" and "why" |
| `event` | `events/` | Meetings, trips, milestones — time-anchored nodes |
| `record` | `records/` | Reading notes, article summaries — multi-entity documents |
| `source` | `sources/` | Compiled artifacts from raw content — the raw material |

This classification is inspired by GBrain's "compiled truth + timeline" model but adapted for Chinese knowledge work patterns, where multi-entity documents (records) are more common than single-entity pages.

## Knowledge Graph

### Edge Creation

Three mechanisms create graph edges:

1. **Wiki-link extraction** (zero-LLM): Parse `[[target]]` from markdown content on every write. Resolve to page slugs. This is the primary mechanism — fast, deterministic, doesn't cost API calls.

2. **NER relationship inference** (LLM): During ingest, GLM-4-flash identifies typed relationships (works_at, knows, founded, invested_in, etc.) from unstructured text. Runs once per ingest, not on every read.

3. **Manual linking**: Users write `[[wikilinks]]` in Obsidian; agents use `put_page` and `add_timeline_entry` to create edges programmatically.

### Graph Traversal

```
graph_query(slug, mode="traverse", depth=2)
     │
     ├─→ traverse:  forward from seed through wiki-links
     ├─→ backlinks: reverse direction — who links to this page?
     └─→ related:   bidirectional with mention_count sorting
```

Traversal uses SQLite recursive CTEs with cycle prevention (visited-set tracking). Depth capped at ≤5 for performance.

## Entity Enrichment

Entities auto-promote through tiers based on mention frequency:

| Tier | Threshold | Meaning | Agent Behavior |
|:-----|:----------|:--------|:---------------|
| 1 | ≥10 mentions | Core entity | Always check before decisions |
| 2 | 3-9 mentions | Active entity | Check when contextually relevant |
| 3 | 0-2 mentions | Observed entity | Lookup on demand |

Mentions are counted from wiki-links extracted during ingest. Each `[[entity]]` reference increments the target entity's `mention_count`. Enrichment is idempotent, only upgrades (never downgrades), and can skip directly from tier 3 to tier 1 for surge mentions.

Enrichment also writes a `hotness_score` used as a small retrieval bonus and as a signal for trimming low-value stubs. Hotness is not a second ontology tier; it is a normalized freshness/usefulness score built from five bounded signals:

| Signal | Weight | Meaning |
|:-------|:-------|:--------|
| mention count | 0.25 | Explicit wiki-link mentions indicate repeated use. |
| graph links | 0.20 | Connected entities are more useful than isolated names. |
| activity | 0.30 | Recently read or written pages should surface while the context is active. |
| tier | 0.15 | Stable tier-1/tier-2 entities should not disappear only because recent activity is quiet. |
| body richness | 0.10 | Substantial pages get a small advantage over empty stubs. |

The current weights are fixed in code. They are documented before being made configurable so changes can be reviewed as behavior changes, not silent tuning.

## Version History

Every page mutation creates a version snapshot before the change. The `versions` table stores:

- Full content snapshot
- Frontmatter JSON
- Version number (auto-incrementing per page)
- Timestamp

`revert_version` creates a pre-revert snapshot then restores the target version, so revert is also a non-destructive operation.

## Job Queue

SQLite-backed async job system:

```
Job lifecycle:
  pending → running → done
                   → failed (attempts < max_attempts → pending)
                   → failed (exhausted)
                   → cancelled (only from pending/running)
```

Built-in handlers: `sync`, `embed`, `ner`. Jobs are priority-ordered with configurable max attempts. The work loop polls for pending jobs and dispatches to registered handlers.

## MCP Protocol Design

Tools organized into domains (full inventory in docs/mcp-tools.md):

| Domain | Tools | Design Rationale |
|:-------|:------|:-----------------|
| Core | query, ingest, status, health, sync, enrich, writeback, generate_indexes, remove_orphans | Every agent needs these |
| Pages | get_page, list_pages, put_page, delete_page, resolve_slugs | Full CRUD lifecycle |
| Tags | get_tags, add_tag, remove_tag | Lightweight categorization |
| Links | get_links, remove_link, graph_query | Graph edge management |
| Timeline | get_timeline, add_timeline_entry | Temporal event tracking |
| Versions | get_versions, revert_version | Non-destructive history |
| Jobs | job_submit, job_list, job_status, job_cancel, job_retry | Async work management |
| Observability | get_chunks, get_ingest_log | Debugging and inspection |

All tools return JSON via MCP text content. Zod schemas on every input for type safety and auto-generated tool descriptions.

## Embedding

Default: 智谱 embedding-3 (2048 dimensions).

The embedding provider interface is pluggable:

```typescript
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<{ embedding: number[]; tokenCount: number }>;
  embedBatch(texts: string[]): Promise<Array<{ embedding: number[]; tokenCount: number }>>;
}
```

To add a new provider (OpenAI, Ollama, etc.), implement this interface and pass to `createServer()`.

## NER Pipeline

Named Entity Recognition runs during ingest when an LLM provider is configured:

1. Send content to GLM-4-flash with a structured extraction prompt
2. Parse JSON response for entities (people, companies, locations, concepts, products)
3. For each discovered entity: check if a page exists → create stub if new
4. For each relationship: write typed edge to links table
5. For each temporal event: write to timeline table

The prompt is optimized for Chinese — it understands Chinese name patterns, company suffixes (有限公司, 集团), and domain-specific entity types.

## CLI Design

```
cbrain <command> [options]

init        Initialize vault + DB + config
doctor      Health check (DB, vault, embedding, NER connectivity)
ingest      Ingest content (--type, --title, --slug, --tags)
query       Hybrid search (--strategy 默认 all, --limit)
sync        Re-index vault files → SQLite + LanceDB
enrich      Entity tier enrichment (--slug for single)
graph-query Graph traversal (--mode, --depth)
serve       Start MCP server over stdio
```

All commands are thin wrappers around the core engine. The CLI and MCP server share the same code paths — no duplication.

> 搜索默认值差异：CLI `cbrain query` 默认 `--strategy all`（全量混合）；MCP 工具 `query` 默认 `smart`（FTS 优先，空结果回退混合）。两者底层都走 HybridSearch，仅默认策略不同。

## Skills Layer

7 Agent-facing skills teach the Agent how to use the brain:

| Skill | Protocol | Trigger |
|:------|:---------|:--------|
| `brain-ops` | CHECK → GET → INTEGRATE → LEARN → UPDATE | Before answering any substantive question |
| `signal-detector` | SCAN → CLASSIFY → QUERY → INGEST | Every incoming message |
| `ingest` | Content routing by source type | On detected signals |
| `query` | Strategy selection + result synthesis | On brain-ops CHECK |
| `enrich` | Tier promotion cycle | After batch ingest, periodically |
| `cleanup` | scan duplicates/orphans/stale-stubs → suggest → confirm → execute | Periodic |
| `dream` | sync → enrich → health → report | Nightly (cron) |

Skills follow GBrain's "fat skills, thin harness" philosophy: intelligence lives in the skill files, not the runtime. The MCP server provides tools; skills teach the Agent when and how to use them.

## Comparison with GBrain

### What CBrain Does Differently (by design)

| Decision | CBrain | GBrain | Why |
|:---------|:-------|:-------|:----|
| Storage | SQLite + LanceDB | PGLite/Postgres + pgvector | Zero-dependency for personal use; Chinese FTS requires trigram tokenizer |
| Embedding | 智谱 embedding-3 (2048d) | OpenAI (1536d) | Better Chinese semantic understanding |
| MCP tools | 81 | ~30 | Fuller CRUD coverage for agents |
| Agent integration | Skill files for any agent framework | Plugin system | Designed as MCP-first, works with any agent |
| NER | LLM-based (GLM-4-flash) | Regex + LLM hybrid | Chinese entity extraction needs LLM for name boundaries |
| Deployment | `git clone` + `bun install`（源码安装，未发布 npm） | `git clone + bun install + bun link` | CBrain 暂未发布 npm 包，源码安装 |

### What GBrain Has That CBrain Doesn't (yet)

| Feature | Priority | Rationale for deferring |
|:--------|:---------|:------------------------|
| eval framework (BrainBench) | P0 | Need objective search quality measurement |
| File import/export | P1 | `gbrain import <dir>` is useful for onboarding |
| Durable job queue (supervisor, stall detection) | P1 | Current SQLite queue works but lacks crash recovery |
| Supabase/Postgres backend | P2 | SQLite is sufficient for single-user |
| Voice/Email/Calendar integration | P2 | Nice-to-have, not core memory function |
| skillify/skillpack management | P3 | Current manual skill creation is adequate for now |
| Durable Agents | P3 | Out of scope for personal knowledge brain |

### What CBrain Does That GBrain Can't

- **Chinese FTS** — FTS5 trigram gives native-quality CJK search without a segmenter
- **Chinese embeddings** — 智谱 embedding-3 outperforms OpenAI on Chinese semantic similarity
- **Chinese NER** — LLM-based extraction understands Chinese name boundaries and company suffixes
