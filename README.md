# CBrain

> Your Agent's Memory, Compounding. Agent 的记忆，复利生长。

CBrain is an open-source personal knowledge brain for AI Agents. Inspired by [Karpathy's LLM Wiki pattern](https://x.com/karpathy) — human inputs, Agent compiles, knowledge compounds with every interaction.

CBrain 是一个开源的 AI Agent 个人知识大脑。受 Karpathy 的 LLM Wiki 模式启发 —— 人类输入，Agent 编译，知识在每次交互中复利增长。

## Why CBrain

LLMs forget everything between conversations. CBrain gives your Agent a persistent, compounding memory that grows richer over time.

- **Obsidian-native** — All pages are markdown files you can read, edit, and browse in Obsidian
- **Three-layer search** — Vector + Chinese FTS + Graph traversal, fused with RRF
- **Knowledge graph** — Auto-extracted relationships between entities
- **Entity enrichment** — People and companies auto-promote through tiers as you mention them
- **MCP Server** — Plug into any MCP-compatible Agent (Claude, Hermes, etc.)
- **Runs locally** — No cloud dependency, your data stays on your machine

LLM 在对话之间会遗忘一切。CBrain 为你的 Agent 提供持久的、复利增长的记忆。

- **Obsidian 原生** — 所有页面都是 Obsidian 可读的 Markdown 文件
- **三层搜索** — 向量 + 中文全文 + 图遍历，RRF 融合排序
- **知识图谱** — 自动提取实体间关系
- **实体丰富** — 人物和组织随提及次数自动升级
- **MCP 服务器** — 接入任何兼容 MCP 的 Agent
- **本地运行** — 无云依赖，数据留在你的机器上

## Quick Start

```bash
# Install
bun add cbrain
# or
npm install cbrain

# Initialize (creates vault + DB + config)
npx cbrain init

# Ingest content
npx cbrain ingest --type markdown --title "张三" "张三是产品经理，负责AI产品线"

# Search
npx cbrain query "张三的项目"

# Health check
npx cbrain doctor
```

## Architecture

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

**Key principle**: Obsidian vault is the single source of truth. SQLite and LanceDB are index layers — delete and rebuild anytime. All data lives in markdown files.

**核心原则**：Obsidian vault 是唯一事实来源。SQLite 和 LanceDB 只是索引层 —— 随时可以删除重建。所有数据都存在于 Markdown 文件中。

## Page Types

| Type | Directory | For |
|:-----|:----------|:----|
| entity | `entities/` | People, companies, products, projects |
| concept | `concepts/` | Methods, terms, frameworks, principles |
| event | `events/` | Meetings, trips, milestones |
| record | `records/` | Reading notes, article summaries |
| source | `sources/` | Compiled artifacts from raw content |

## CLI Commands

```bash
cbrain init                    # Initialize vault + DB + config
cbrain doctor                  # Health check
cbrain ingest <content>        # Ingest content (--type, --title, --slug)
cbrain query "search text"     # Three-layer hybrid search
cbrain sync                    # Re-sync all vault files → indexes
cbrain enrich                  # Run entity tier enrichment
cbrain graph-query <entity>    # Graph traversal (--mode, --depth)
cbrain serve                   # Start MCP server (stdio)
```

## MCP Integration

Add to your Agent's MCP config:

```json
{
  "mcpServers": {
    "cbrain": {
      "command": "cbrain",
      "args": ["serve"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|:-----|:------------|
| `query` | Hybrid search (vector + FTS + graph) |
| `ingest` | Ingest content into the brain |
| `get_page` | Retrieve a page by slug |
| `list_pages` | List pages with optional type filter |
| `graph_query` | Graph traversal and backlinks |
| `enrich` | Entity tier enrichment |
| `sync` | Re-index vault files |
| `status` | Brain statistics |

## Search System

Three search strategies, fused with Reciprocal Rank Fusion (RRF):

1. **Vector search** — Semantic similarity via embedding (default: 智谱 embedding-3, 2048d)
2. **Chinese FTS** — Full-text search with lindera Chinese tokenizer
3. **Graph traversal** — Relationship-based discovery through the knowledge graph

```bash
# Default: all three combined
cbrain query "怎么优化RAG性能"

# Single strategy
cbrain query "张三" --strategy fts
cbrain query "RAG optimization" --strategy vector
```

## Entity Enrichment

Entities auto-promote through tiers based on mention frequency:

| Tier | Criteria | Behavior |
|:-----|:---------|:---------|
| 1 | 10+ mentions | Core entity — always check before decisions |
| 2 | 3-9 mentions | Active entity — check when relevant |
| 3 | 0-2 mentions | Observed — lookup on demand |

实体根据提及频率自动升级：

| 层级 | 标准 | 行为 |
|:-----|:-----|:-----|
| 1 | 10+ 次提及 | 核心实体 —— 决策前必查 |
| 2 | 3-9 次提及 | 活跃实体 —— 相关时查阅 |
| 3 | 0-2 次提及 | 观察实体 —— 按需查阅 |

## Skills

CBrain includes Agent-facing skill files that teach your Agent how to use the brain:

| Skill | Purpose |
|:------|:--------|
| `brain-ops` | 5-step protocol: CHECK → GET → INTEGRATE → LEARN → UPDATE |
| `signal-detector` | Extract entities and ideas from messages |
| `ingest` | Content routing and compilation |
| `query` | Hybrid search + synthesis protocol |
| `enrich` | Tiered entity enrichment |
| `maintain` | Health check and cleanup |
| `dream` | Nightly auto-maintenance pipeline |

## Configuration

CBrain uses `cbrain.json` in your project directory:

```json
{
  "vault_path": "./vault",
  "db_path": "./brain.sqlite",
  "lancedb_path": "./lancedb",
  "embedding": {
    "provider": "zhipu",
    "model": "embedding-3",
    "dimensions": 2048,
    "api_key": "your-api-key"
  }
}
```

Set `CBRAIN_ZHIPU_API_KEY` environment variable as an alternative to config file.

## Tech Stack

| Component | Choice | Why |
|:----------|:-------|:----|
| Runtime | Bun | Fast, native TypeScript |
| Structured Storage | SQLite (bun:sqlite) | Zero config, relational queries |
| Vector + FTS | LanceDB | Vector + Chinese FTS in one engine |
| Embedding | 智谱 embedding-3 | Best Chinese embeddings, 2048d |
| Agent Interface | MCP Server | Standard protocol for Agent tools |
| Human Interface | Obsidian | Graph view, backlinks, Dataview |

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run lint

# Run CLI in dev mode
bun run dev init
```

## License

MIT
