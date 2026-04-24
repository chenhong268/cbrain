# CBrain Design Spec

> **CBrain — Your Agent's Memory, Compounding. Agent 的记忆，复利生长。**

## Goal

Build an open-source personal knowledge brain for AI Agents. Inspired by Karpathy's LLM Wiki pattern and GBrain's architecture. Human inputs, Agent compiles. Knowledge grows with every interaction.

## Philosophy

**Karpathy's LLM Wiki pattern**: The wiki is a persistent, compounding artifact. Cross-references are already there. Contradictions are already flagged. Synthesis reflects everything you've read. The wiki keeps getting richer with every source and every question.

**Human's job**: curate sources, direct analysis, ask good questions.
**Agent's job**: everything else — summarizing, cross-referencing, filing, bookkeeping.

## Architecture: Three Layers

```
┌─────────────────────────────────────────┐
│  Skills Layer (SKILL.md = Agent Brain)  │  ← Judgment, workflow, domain knowledge
├─────────────────────────────────────────┤
│  CBrain Core (CLI + MCP Server)         │  ← File I/O, indexing, search
├─────────────────────────────────────────┤
│  Storage (SQLite + LanceDB)             │  ← Structured data + vector/FTS search
└─────────────────────────────────────────┘
    ↕ bidirectional sync
┌─────────────────────────────────────────┐
│  Obsidian Vault (SSOT)                  │  ← Human reads, Agent writes, same files
└─────────────────────────────────────────┘
```

### Key Principle: Obsidian is Single Source of Truth

CBrain never hoards data. All compiled artifacts are written as Obsidian-readable markdown. SQLite/LanceDB are index layers — delete and rebuild anytime.

## Tech Stack

| Component | Choice | Reason |
|:----------|:-------|:-------|
| Runtime | Bun | Fast, native TS, consistent with Hermes ecosystem |
| Structured Storage | SQLite (bun:sqlite) | Zero config, fast enough, relational queries |
| Search Layer | LanceDB | Vector + Chinese FTS (tantivy/lindera) in one engine, native Bun support |
| Embedding | Pluggable providers | Default: 智谱 embedding-3 (2048d). Also supports OpenAI, Ollama |
| Interface | MCP Server | Hermes Agent native support |
| Human UI | Obsidian | Graph view, backlinks, Dataview |

## Page Types

Five types cover all personal + work scenarios:

| Type | Directory | Frontmatter type | Typical Content |
|:-----|:----------|:-----------------|:----------------|
| entity | `entities/` | entity | People, companies, products, projects |
| concept | `concepts/` | concept | Methodologies, terms, frameworks, principles |
| event | `events/` | event | Meetings, trips, milestones |
| record | `records/` | record | Reading notes, materials, article summaries |
| source | `sources/` | source | Compiled artifacts from raw articles/videos |

Each page uses unified frontmatter format for Dataview compatibility.

## Entry Points and Data Flow

```
Entry 1: Human writes in Obsidian → CBrain file watcher → auto-index
Entry 2: Chat with Agent → signal-detector extracts → CBrain compiles → write Obsidian + index
Entry 3: Social links (WeChat/Bilibili/X/Xiaohongshu) → Agent fetches → CBrain compiles → write Obsidian + index
Entry 4: Agent API submit → CBrain compiles → write Obsidian + index
Entry 5: Calendar/meeting sync → CBrain compiles → write Obsidian + index
```

All paths converge: Obsidian markdown files + SQLite/LanceDB indexes.

## Search System

Three-layer hybrid search:

1. **Vector search** (LanceDB, configurable embedding provider)
2. **Chinese full-text search** (LanceDB built-in tantivy + lindera tokenizer)
3. **Graph traversal** (SQLite stores relationship edges)

Fusion strategy: RRF (Reciprocal Rank Fusion). Simple, effective.

## Knowledge Graph

Borrowed from GBrain, optimized for Chinese:

- **Link extraction**: Agent adds `[[name]]` links + frontmatter relationship annotations
- **Relationship types**: `knows`, `works_at`, `invested_in`, `founded`, `attended`, `mentions` (configurable)
- **Chinese relationship inference**: Not just regex — LLM-assisted judgment ("张三是诺华的经理" → `works_at`)
- **Backlinks**: Auto-completed to maintain graph connectivity

## Person Auto-Enrichment (CRM Core)

GBrain's most valuable feature:

| Tier | Trigger | Processing |
|:-----|:--------|:-----------|
| Tier 3 (stub) | Mentioned 1 time | Create stub page |
| Tier 2 (medium) | 3+ times across different sources | Auto-enrich with web data |
| Tier 1 (full) | Meeting/8+ mentions | Full profile + timeline + relationship network |

## Embedding Provider Plugin System

Abstract interface for multiple providers:

```typescript
interface EmbeddingProvider {
  name: string
  dimensions: number
  embed(texts: string[]): Promise<number[][]>
}
```

Built-in providers:
- **zhipu**: 智谱 embedding-3 (2048d) — default, best Chinese quality
- **openai**: text-embedding-3-small/large
- **ollama**: Local models via Ollama API

## Skills (SKILL.md Files)

Prioritized from GBrain's 26 skills:

### P0 (MVP)

| Skill | Function |
|:------|:---------|
| signal-detector | Extract entities + ideas from every message |
| ingest | Content router, dispatch by type |
| query | Three-layer hybrid search + synthesis |
| enrich | Person/company tiered enrichment |
| brain-ops | Check brain before answering, 5-step protocol |

### P1 (Post-MVP)

| Skill | Function |
|:------|:---------|
| maintain | Periodic health check: orphans, broken links, stale |
| dream | Nightly auto-maintenance (lint + sync + embed) |
| daily-briefing | Daily briefing with person context |
| idea-ingest | Article/link compilation |

### P2 (Nice-to-have)

| Skill | Function |
|:------|:---------|
| meeting-ingestion | Meeting notes → person + event extraction |
| citation-fixer | Citation format standardization |
| publish | Encrypted page sharing |

## CLI Commands

```bash
cbrain init                    # Initialize: create DB + configure vault path
cbrain doctor                  # Health check
cbrain ingest <path|url>       # Ingest content
cbrain query "search text"     # Three-layer search
cbrain embed --stale           # Generate/update embeddings
cbrain sync                    # Sync vault → index
cbrain dream                   # Nightly maintenance (6 phases)
cbrain serve                   # Start MCP Server (stdio)
cbrain graph-query <entity> --depth 2  # Graph traversal
```

## MCP Integration

```json
{
  "mcpServers": {
    "cbrain": { "command": "cbrain", "args": ["serve"] }
  }
}
```

## SQLite Schema

### Core Tables

```sql
-- Pages index (mirrors Obsidian vault files)
CREATE TABLE pages (
  slug TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- entity|concept|event|record|source
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,      -- relative to vault root
  content_hash TEXT,            -- for change detection
  tier INTEGER DEFAULT 3,       -- enrichment tier (1=highest)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Relationships (knowledge graph edges)
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  relation TEXT NOT NULL,       -- knows|works_at|invested_in|founded|attended|mentions
  context TEXT,                 -- surrounding text for provenance
  created_at TEXT NOT NULL,
  FOREIGN KEY (from_slug) REFERENCES pages(slug),
  FOREIGN KEY (to_slug) REFERENCES pages(slug)
);

-- Tags (many-to-many)
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug TEXT NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (page_slug) REFERENCES pages(slug)
);

-- Timeline entries (structured events)
CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug TEXT NOT NULL,
  event_date TEXT NOT NULL,
  source TEXT,                  -- meeting|email|chat|manual
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (page_slug) REFERENCES pages(slug)
);

-- Content chunks for search
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_slug TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  FOREIGN KEY (page_slug) REFERENCES pages(slug)
);

-- Ingest log (audit trail)
CREATE TABLE ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,         -- obsidian|agent|api|calendar
  action TEXT NOT NULL,         -- create|update|delete
  page_slug TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

-- Configuration
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

## Directory Structure

```
cbrain/
├── src/
│   ├── cli/                    # CLI entry point
│   │   └── index.ts
│   ├── mcp/                    # MCP Server
│   │   └── server.ts
│   ├── core/
│   │   ├── engine.ts           # BrainEngine interface
│   │   ├── page.ts             # Page CRUD operations
│   │   ├── search.ts           # Hybrid search (vector + FTS + graph)
│   │   ├── graph.ts            # Knowledge graph operations
│   │   ├── ingest.ts           # Content ingestion pipeline
│   │   ├── enrich.ts           # Entity enrichment
│   │   └── sync.ts             # Vault ↔ index sync
│   ├── storage/
│   │   ├── sqlite.ts           # SQLite operations
│   │   └── lancedb.ts          # LanceDB operations
│   ├── embedding/
│   │   ├── provider.ts         # EmbeddingProvider interface
│   │   ├── zhipu.ts            # 智谱 embedding-3
│   │   ├── openai.ts           # OpenAI embeddings
│   │   └── ollama.ts           # Ollama local embeddings
│   ├── skills/                 # Skill implementations
│   │   ├── signal-detector.ts
│   │   ├── ingest.ts
│   │   ├── query.ts
│   │   ├── enrich.ts
│   │   ├── brain-ops.ts
│   │   ├── maintain.ts
│   │   ├── dream.ts
│   │   └── daily-briefing.ts
│   └── utils/
│       ├── frontmatter.ts      # Frontmatter parse/stringify
│       ├── slug.ts             # Slug generation (Chinese-aware)
│       └── tokenizer.ts        # Chinese text utilities
├── skills/                     # SKILL.md files (Agent reads these)
│   ├── signal-detector.md
│   ├── ingest.md
│   ├── query.md
│   ├── enrich.md
│   ├── brain-ops.md
│   ├── maintain.md
│   ├── dream.md
│   └── daily-briefing.md
├── tests/
│   ├── core/
│   ├── storage/
│   ├── embedding/
│   └── skills/
├── docs/
│   ├── README.md               # Bilingual (EN/CN)
│   └── ...
├── cbrain.config.yaml          # User config
├── package.json
├── tsconfig.json
└── README.md
```

## What CBrain Does NOT Do

- NOT a GBrain fork — borrow patterns, build from scratch
- NOT a data store — blood pressure/BTC prices stay in specialized apps
- NOT multi-user — designed for single personal use
- NOT a chatbot — CBrain is the brain, Agent is the mouth
- NOT cloud-dependent — everything runs locally

## Open Source Requirements

- **License**: MIT
- **README**: Bilingual (English + Chinese)
- **Contributing guide**: CONTRIBUTING.md
- **Issue/PR templates**: Standard GitHub templates
- **CI**: Basic lint + test on push
- **Installation**: `npx cbrain init` or `bunx cbrain init` — 30 seconds to running
