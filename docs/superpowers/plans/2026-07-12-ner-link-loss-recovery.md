# NER Mention Link Loss Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent wikilink updates and NER failures from permanently deleting NER-owned mention links.

**Architecture:** Give wikilinks source-scoped storage operations, including an explicit-evidence promotion upsert for the existing edge unique key. Reuse the existing `ner-backfill` submitter as the sole durable recovery mechanism after synchronous NER failure.

**Tech Stack:** TypeScript, Bun test, SQLite.

## Global Constraints

- No schema migration or new queue/marker.
- No production-data mutation in this branch.
- NER remains fail-open and ingest remains available.
- Tests use anonymous fixtures only.
- TDD RED must precede each production change.

---

### Task 1: Source-owned wikilink storage operations

**Files:**
- Modify: `src/storage/sqlite.ts`
- Test: `tests/storage/wikilink-ownership.test.ts`

**Produces:**
- `deleteWikilinkMentions(fromSlug: string): void`
- `upsertWikilinkMention(fromSlug: string, toSlug: string): void`

- [ ] Write failing storage tests for source-scoped deletion, NER promotion,
  manual preservation, and single-row uniqueness.
- [ ] Run `bun test tests/storage/wikilink-ownership.test.ts` and confirm RED
  because the methods do not exist.
- [ ] Implement the two methods with bound SQL parameters and a single UPSERT.
- [ ] Rerun the focused test and confirm GREEN.
- [ ] Commit the storage behavior.

### Task 2: Replace only wikilink-owned mentions

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`
- Test: `tests/core/wikilink-ownership.test.ts`

**Consumes:** Task 1 storage methods.

- [ ] Write failing pipeline tests proving NER/manual/dialogue survival, stale
  wikilink deletion, new wikilink insertion, and same-edge promotion.
- [ ] Run the focused test and confirm it fails under the current all-source
  delete behavior.
- [ ] Change `replaceWikilinks()` to call `deleteWikilinkMentions()` and
  `upsertWikilinkMention()` only.
- [ ] Rerun focused storage/pipeline tests and confirm GREEN.
- [ ] Commit the pipeline ownership fix.

### Task 3: Queue durable recovery after synchronous NER failure

**Files:**
- Modify: `src/core/ingestion/ingest.ts`
- Test: `tests/core/ingest-ner-recovery.test.ts`

**Consumes:** Existing `submitDeferredNerForWritePath()` and
`DeferredNerSubmitter`.

- [ ] Write failing tests for timeout, provider error, repeated-failure dedup,
  missing-submitter fail-open, and entity-append recovery.
- [ ] Confirm RED: current sync failure returns `nerSkipped` but no job or
  `nerPending`.
- [ ] Add one private helper that submits recovery only when a submitter exists,
  and use it in both sync NER catch blocks.
- [ ] Keep error logs bounded to reason category and recovery-queued boolean.
- [ ] Rerun focused tests and confirm GREEN.
- [ ] Commit the durable recovery behavior.

### Task 4: Regression and adversarial verification

**Files:** No production changes unless a verified finding requires one.

- [ ] Run focused tests for storage, pipeline, ingest, and backfill.
- [ ] Run `bun run check`.
- [ ] Attack source ownership, same-edge trust precedence, active-job dedup,
  fail-open behavior, transaction rollback, privacy, and unrelated-link
  preservation.
- [ ] Run `git diff --check` and a privacy grep over the branch diff.
- [ ] Record findings and fix any CRITICAL/HIGH/MEDIUM regression before final
  acceptance.
