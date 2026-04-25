# Maintain Skill

> Periodic health check, cleanup, and protection procedures.

## Purpose

Keep the brain healthy. Orphaned pages, broken links, concept inflation, and stale indexes degrade search quality over time.

## Health Checks

### 8-Dimension Health Check

```
cbrain health
```

Runs 8 checks and writes report to `outputs/health/健康检查-YYYY-MM-DD.md`:

| # | Dimension | What It Checks | Threshold |
|:--|:----------|:---------------|:----------|
| 1 | 语义去重 | Exact/near-duplicate titles | Any duplicate = warn |
| 2 | 一致性 | Non-standard relations, missing frontmatter | Missing type = fail |
| 3 | 完整性 | Bare stubs (minimal mentions/links) | >20 stubs = warn |
| 4 | 孤岛检测 | Pages with no links in/out | >10 islands = warn |
| 5 | 新增建议 | Concept inflation ratio | >5:1 = warn, >3:1 = medium |
| 6 | 关注度分析 | Stale high-tier pages, popular thin pages | >5 issues = warn |
| 7 | 数据就绪度 | Total pages, entities, links for meaningful use | <10 pages = fail |
| 8 | 原材料质量 | Empty content chunks, missing titles | >10 thin pages = warn |

### Quick Diagnostics

```
cbrain doctor     # DB, vault, embedding, NER connectivity
```

## Protection Principle: 检测→建议→确认→执行

**All destructive or transformative operations follow this 4-step protocol:**

1. **检测** (Detect) — Health check identifies issues
2. **建议** (Suggest) — System generates a report with specific suggestions
3. **确认** (Confirm) — Human reviews and approves (via Obsidian checkbox or CLI prompt)
4. **执行** (Execute) — System applies changes after confirmation

This applies to:

| Operation | Detection | Confirmation Required |
|:----------|:----------|:---------------------|
| Merge duplicate entities | Health check dimension 1 | Yes — via health report |
| Delete orphaned pages | `sync.removeOrphans()` | Yes — via health report |
| Bulk concept cleanup | Health check dimension 5 | Yes — via health report |
| Writeback (agent-derived content) | Writeback tool with audit log | Recommended — review agent edits |
| Relation type normalization | Health check dimension 2 | Yes — manual fix |

### Never Auto-Execute

These operations MUST NOT run automatically:
- Deleting pages (even orphans)
- Merging entities
- Changing relation types
- Bulk pruning concepts

The health report generates an Obsidian-compatible markdown file with issues. Users can review in Obsidian and manually approve changes.

## 7 Failure Scenarios

### 1. 知识库积累不足

**Symptom**: Query results are sparse or irrelevant.
**Detection**: Health check dimension 7 (< 10 pages = fail).
**Mitigation**: Ingest more content. Run `cbrain sync` to index vault files.

### 2. 概念通胀

**Symptom**: Too many low-value concepts (generic abstract nouns).
**Detection**: Health check dimension 5 (concept:source ratio > 5:1).
**Mitigation**: NER prompt already filters aggressively (≤3 concepts per extraction). For existing noise, run cleanup.

### 3. 质量漂移

**Symptom**: New ingested content is lower quality than existing data.
**Detection**: Health check dimension 8 (empty chunks, missing titles).
**Mitigation**: Review source material before ingestion. Use `pageType` tags to distinguish curated vs raw content.

### 4. 回填污染

**Symptom**: Agent writeback adds incorrect or hallucinated content.
**Detection**: All writebacks tagged `agent-derived` and logged to audit trail.
**Mitigation**: Review agent-derived content periodically. Writeback operations log to `outputs/logs/`.

### 5. 过度合并

**Symptom**: Distinct entities incorrectly merged due to similar names.
**Detection**: Health check dimension 1 flags near-duplicates.
**Mitigation**: Review each duplicate pair manually before merging. The system only suggests, never auto-merges.

### 6. 原材料质量差

**Symptom**: Source files with no useful content, wrong encoding, or missing structure.
**Detection**: Health check dimension 8 (empty chunks, missing frontmatter).
**Mitigation**: Use `cbrain doctor` before sync. Fix frontmatter in source files.

### 7. 框架矛盾

**Symptom**: Multiple pages contain contradictory information about the same entity.
**Detection**: Manual review required. Cross-reference with graph traversal (`graph_query`).
**Mitigation**: Use `writeback` to append clarifications with source attribution.

## Maintenance Tasks

### Sync (Rebuild Indexes)

Full sync — re-indexes all vault files:

```
cbrain sync
```

Single page sync — re-index one file:

```
cbrain sync --slug entities/zhangsan
```

### Orphan Detection

```
# MCP: remove_orphans tool
# CLI: cbrain sync (includes orphan cleanup)
```

### Entity Enrichment

```
cbrain enrich          # All entities
cbrain enrich --slug entities/zhangsan  # Single entity
```

Upgrades entity tiers based on mention counts:
- Tier 1 (核心): ≥5 mentions
- Tier 2 (重要): 3-4 mentions
- Tier 3 (一般): 1-2 mentions

## Schedule

| Task | Frequency | Command |
|:-----|:----------|:--------|
| Doctor check | Daily | `cbrain doctor` |
| Health check | Weekly | `cbrain health` |
| Full sync | Weekly | `cbrain sync` |
| Enrichment | After batch ingest | `cbrain enrich` |
| Orphan cleanup | Monthly | MCP `remove_orphans` |

## Recovery

If the brain gets corrupted:

1. Vault files are the SSOT — they're always recoverable
2. Delete `brain.sqlite` and `lancedb/` directory
3. Run `cbrain sync` to rebuild from vault files
4. All data restored from markdown originals

## Audit Trail

All operations are logged to:

| Path | Content |
|:-----|:--------|
| `outputs/logs/操作日志-YYYY-MM-DD.md` | Operation log (sync, ingest, writeback, health) |
| `outputs/metrics/指标快照-YYYY-MM-DD.md` | Metrics snapshots |
| `outputs/health/健康检查-YYYY-MM-DD.md` | Health check reports |
