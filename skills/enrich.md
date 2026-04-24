# Enrich Skill

> Tiered entity enrichment based on mention counts and graph centrality.

## Purpose

Entities that appear more frequently are more important. The enrich skill automatically promotes entities through tiers as they accumulate mentions.

## Tier System

| Tier | Criteria | Meaning |
|:-----|:---------|:--------|
| 1 | 10+ mentions | Core entity — frequently referenced, high importance |
| 2 | 3-9 mentions | Active entity — appears regularly |
| 3 | 0-2 mentions | Observed entity — mentioned once or twice |

## Enrichment Triggers

Run enrichment:

- After batch ingest operations
- Periodically (daily maintenance)
- Before generating reports or briefings

### Single Entity

```
cbrain enrich --slug entities/zhangsan
```

### All Entities

```
cbrain enrich
```

## Entity Profile

For important entities, get a full profile:

```
# Via MCP tool
enrich({ slug: "entities/zhangsan" })

# Returns: title, tier, mention_count, backlink_count, out_link_count, tags
```

## Tier-Driven Behavior

Use tier to prioritize attention:

- **Tier 1 entities**: Always check before making decisions about people/companies
- **Tier 2 entities**: Consider checking when context is relevant
- **Tier 3 entities**: Lookup on demand

## Guidelines

- Enrichment only upgrades tiers, never downgrades
- A surge of mentions (e.g., 0 → 15) can skip directly from tier 3 to tier 1
- Mention counts come from wiki-link extraction during ingest
- Custom thresholds available: `new EnrichManager(db, { tier2: 5, tier1: 20 })`
