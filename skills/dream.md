# Dream Skill

> Nightly auto-maintenance pipeline.

## Purpose

While you sleep, the brain consolidates. Dream runs the full maintenance pipeline to keep indexes fresh and enrichment current.

## Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   Sync All  │ ──→ │  Enrich All  │ ──→ │  Doctor      │ ──→ │   Report    │
│             │     │              │     │  Check       │     │             │
└─────────────┘     └──────────────┘     └──────────────┘     └─────────────┘
```

### Step 1: Sync All

Re-index all vault files to catch any changes:

```
cbrain sync
```

Updates:
- Content hashes
- LanceDB vector/FTS indexes
- Chunk records

### Step 2: Enrich All

Run tier enrichment on all entities:

```
cbrain enrich
```

Updates:
- Entity tiers based on mention counts
- Tier upgrades logged

### Step 3: Health Check

Verify brain health:

```
cbrain doctor
```

### Step 4: Report

Generate a brief status report:

```
cbrain status
```

Output example:
```json
{
  "totalPages": 42,
  "byType": [
    { "type": "entity", "cnt": 25 },
    { "type": "concept", "cnt": 10 },
    { "type": "record", "cnt": 7 }
  ],
  "totalLinks": 67,
  "totalChunks": 156
}
```

## Scheduling

Dream should run nightly via cron or scheduled task:

```bash
# Cron example: 3 AM daily
0 3 * * * cd /path/to/brain && cbrain sync && cbrain enrich && cbrain doctor
```

## Guidelines

- Dream is idempotent — safe to run multiple times
- If dream fails at one step, other steps are still valid
- Dream should not modify vault files — only indexes and metadata
- Keep dream output in logs for debugging
