# Dream Skill

> Nightly auto-maintenance pipeline — one command runs it all.

## Purpose

While you sleep, the brain consolidates. Dream runs the full 5-stage maintenance pipeline with cycle locking so two dreams never overlap.

## Quick Start

```bash
cbrain dream
```

## Pipeline

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Sync    │ ─→ │  Enrich  │ ─→ │ Cleanup  │ ─→ │  Health  │ ─→ │  Report  │
│          │    │          │    │          │    │          │    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

### Stage 1: Sync
Re-index all vault files. Updates content hashes, LanceDB vectors, FTS, and chunks.

### Stage 2: Enrich
Promote entities through tiers based on mention counts. Tier 1 (core) ← Tier 2 (active) ← Tier 3 (observed).

### Stage 3: Cleanup
Auto-remove orphaned DB entries (no vault file) and stale stubs (source no longer references them).

### Stage 4: Health
10-dimension health check: duplicates, orphans, broken links, stale stubs, content quality.

### Stage 5: Report
Write daily report to `outputs/dream/dream-YYYY-MM-DD.md`.

## Cycle Lock

Dream acquires a lock in the config table. If a dream is still running (or crashed within 30 min), the next dream skips. Prevents overlapping maintenance.

## Scheduling

```bash
# Cron: 3 AM daily
0 3 * * * cd /path/to/brain && cbrain dream
```

Or via Hermes:
```
对 Agent 说：每天早上 3 点跑一次 cbrain dream
```

## Guidelines

- Dream is idempotent — safe to run multiple times
- Failed stage doesn't block subsequent stages
- Dream only touches indexes and metadata, never vault files
- Report written to outputs/dream/ for auditing
