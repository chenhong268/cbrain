# Maintain Skill

> Periodic health check and cleanup procedures.

## Purpose

Keep the brain healthy. Orphaned pages, broken links, and stale indexes degrade search quality over time.

## Health Checks

### Quick Check

```
cbrain doctor
```

Checks: DB accessible, vault exists, embedding provider working.

### Page Integrity

```
cbrain status
```

Returns: total pages, by-type counts, total links, total chunks.

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

Orphaned pages exist in DB but not in vault (or vice versa). The sync command handles this:

- Vault file deleted → sync removes from DB
- DB entry without vault file → sync marks as missing

### Broken Link Detection

Check for links pointing to non-existent pages:

```
# Query all links, check if target pages exist
cbrain graph-query --mode traverse <seed> --depth 2
```

## Schedule

| Task | Frequency | Command |
|:-----|:----------|:--------|
| Doctor check | Daily | `cbrain doctor` |
| Full sync | Weekly | `cbrain sync` |
| Enrichment | After batch ingest | `cbrain enrich` |
| Status check | As needed | `cbrain status` |

## Recovery

If the brain gets corrupted:

1. Vault files are the SSOT — they're always recoverable
2. Delete `brain.sqlite` and `lancedb/` directory
3. Run `cbrain sync` to rebuild from vault files
4. All data restored from markdown originals
