# Links Migration Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the low-risk links migrations from `sqlite.ts` into a small storage migration registry without changing schema behavior.

**Architecture:** Add `src/storage/migrations/links.ts` for the three additive links migrations and `src/storage/migrations/index.ts` as the registry entrypoint. `CBrainDB.migrate()` keeps the same call order by replacing the three private method calls with `runLinkMigrations(this.db)`.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, existing storage tests.

---

## Files

- Create: `src/storage/migrations/links.ts`
- Create: `src/storage/migrations/index.ts`
- Create: `tests/storage/migrations/links.test.ts`
- Modify: `src/storage/sqlite.ts`

## Task 1: Add Registry Contract Test

- [ ] Write `tests/storage/migrations/links.test.ts`.
- [ ] Create a temporary SQLite database with a legacy `links` table containing only `id`, `from_slug`, `to_slug`, `relation`, `context`, and `created_at`.
- [ ] Seed one anonymous row with `created_at = "2026-01-01T00:00:00Z"`.
- [ ] Import and call `runLinkMigrations(db)`.
- [ ] Assert new columns exist: `weight`, `strength`, `source_type`, `confidence`, `last_validated_at`, `effective_weight`.
- [ ] Assert default/backfilled values: `weight = 1.0`, `strength = "medium"`, `source_type = "unknown"`, `confidence = 0.5`, `last_validated_at = created_at`, `effective_weight = weight * confidence`.
- [ ] Assert `idx_links_last_validated` exists.
- [ ] Run `bun test ./tests/storage/migrations/links.test.ts` and verify RED because the module does not exist.

## Task 2: Implement Links Migration Registry

- [ ] Create `src/storage/migrations/links.ts`.
- [ ] Implement `runLinkMigrations(db: Database): void` with the exact SQL bodies currently in `sqlite.ts`.
- [ ] Create `src/storage/migrations/index.ts` that re-exports `runLinkMigrations`.
- [ ] Run `bun test ./tests/storage/migrations/links.test.ts` and verify GREEN.

## Task 3: Wire CBrainDB To Registry

- [ ] Import `runLinkMigrations` in `src/storage/sqlite.ts`.
- [ ] Replace the three calls `migrateLinksStrength()`, `migrateLinksCredibility()`, `migrateLinkDecayFields()` with one `runLinkMigrations(this.db)` at the same sequence location.
- [ ] Remove the three private method bodies from `sqlite.ts`.
- [ ] Run `bun test ./tests/storage/migrations/links.test.ts tests/storage/sqlite.test.ts tests/storage/sqlite-migrations.test.ts`.

## Task 4: Verification And Adversarial Review

- [ ] Run `git diff --check`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run lint`.
- [ ] Run `bun run check`.
- [ ] Verify no destructive migration, FK repair, or completion key code changed.
- [ ] Verify migration call order did not drift except the three adjacent links migrations becoming one registry call.
- [ ] Verify tests use anonymous placeholder values only.
