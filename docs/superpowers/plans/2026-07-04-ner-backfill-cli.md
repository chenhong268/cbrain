# NER Backfill CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, single-writer-safe CLI surface for processing deferred `ner-backfill` jobs without running the full Dream pipeline.

**Architecture:** Reuse existing `runNerBackfillStage(db, pipeline, pages, { maxItems })`. The CLI refuses to run when a live CBrain serve/watcher owns the writer lock, then constructs the same `NerEngine`, `ContentPipeline`, and `PageManager` used by Dream Stage 1.5. No MCP tool, no always-on worker, no NER algorithm changes.

**Tech Stack:** Bun, Commander CLI, existing `CBrainDB`, `ContentPipeline`, `PageManager`, `createLiveLockProbe`.

---

### Task 1: Add CLI Behavior Tests

**Files:**
- Create: `tests/cli/ner-backfill-cli.test.ts`

- [ ] Write RED tests:
  - `cbrain ner-backfill --help` lists `--limit` and `--json`.
  - command refuses when a live writer lock is present and does not process jobs.
  - `--limit 0 --json` is a safe dry processing pass and reports zero counts.

- [ ] Run:
  `bun test tests/cli/ner-backfill-cli.test.ts`

Expected before implementation: command is unknown or assertions fail.

### Task 2: Implement CLI Command

**Files:**
- Modify: `src/cli/commands/maintenance.ts`

- [ ] Add `.command("ner-backfill")` near `dream`.
- [ ] Options:
  - `--limit <n>` default `50`, integer `>= 0`
  - `--json`
- [ ] Before constructing the pipeline, call `createLiveLockProbe(dirname(resolve(config.dbPath))).blockingOwner()`.
- [ ] If owner exists:
  - print a clear diagnostic;
  - JSON mode emits `{ ok:false, blocked:true, owner:{...}, next_action:"stop serve or run during Dream maintenance window" }`;
  - exit code `1`.
- [ ] If no owner:
  - run `runNerBackfillStage`;
  - print human summary or JSON `{ ok:true, counts }`;
  - close DB in all paths.

### Task 3: Verify and Review

**Files:**
- Tests from Task 1
- Existing NER backfill tests

- [ ] Run targeted tests:
  `bun test tests/cli/ner-backfill-cli.test.ts tests/core/ner-backfill.test.ts tests/core/dream-ner-backfill.test.ts`
- [ ] Run lint:
  `bun run lint`
- [ ] Adversarial checks:
  - command must not connect LanceDB;
  - command must not run while serve/watcher lock is active;
  - command must not register an MCP tool or always-on worker;
  - JSON output must not include page slugs or body text;
  - `--limit 0` must not mutate jobs.
