# Signal Detector

> Extract entities and ideas from every message the Agent receives.

## Purpose

Every conversation contains signals — names, companies, concepts, events, relationships. The signal detector scans incoming messages and decides what's worth remembering.

## Protocol

### Step 1: Scan

On each user message, check for:

- **Named entities**: People (张三, 李总), companies (腾讯, OpenAI), products (GPT-4o, Claude)
- **Concepts**: Technologies (RAG, MCP), methods (TDD, RRF), frameworks (React, Bun)
- **Events**: Meetings, deadlines, launches, milestones
- **Relationships**: "A 在 B 工作", "C 投资了 D", "E 和 F 合作"
- **Ideas/Observations**: "也许我们应该...", "注意到一个趋势..."

### Step 2: Classify

For each signal, classify:

| Category | Action | Page Type |
|:---------|:-------|:----------|
| New person | Create entity | `entity` |
| New company | Create entity | `entity` |
| New concept | Create concept | `concept` |
| Event/date | Create event | `event` |
| Relationship | Add graph edge | — |
| Idea | Append to record | `record` |

### Step 3: Route

- New signals → `cbrain ingest` (text or markdown)
- Relationship updates → `cbrain graph_query` to verify, then add via ingest with `[[wiki-links]]`
- Duplicate signals → Skip (check existing pages first via `cbrain query`)

## MCP Tool Usage

```
1. query("张三") — check if already known
2. ingest({ content, type: "text", title: "张三", pageType: "entity" }) — create if new
3. ingest({ content: "张三[[腾讯]]工作...", type: "markdown" }) — add relationships
```

## Guidelines

- **Err on the side of creating** — storage is cheap, forgetting is expensive
- **Chinese names**: Use full names (张三, not 小张)
- **Context matters**: "张三说RAG不错" extracts both 张三 (entity) and RAG (concept)
- **Don't over-extract**: Articles like "一个" or "这个" are not signals
