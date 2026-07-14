# #342 Rich Record Zero-Link Detection and Backfill Design

**Date:** 2026-07-14

**Issue:** #342

**Status:** Approved for implementation after adversarial review

**Base:** `3e0d048`

## 1. Problem and outcome

CBrain currently has content-rich `record` pages that remain disconnected from the graph. They are searchable as text, but graph traversal, relation-based recall, and downstream reasoning cannot reach them.

The production snapshot reviewed for this issue contains 192 zero-link records. Under the thresholds in this design, 172 are rich enough to warrant one bounded NER repair attempt. Existing `ner-backfill` state already includes pending, failed, and completed rows for some of those records, so blindly submitting new jobs would create duplicate work and could loop forever on content with no extractable graph signal.

This issue must deliver four outcomes:

1. Detect rich zero-link records consistently in Health and `fsck`.
2. Fix the NER write-path gap that fails to create mention edges when an extracted entity resolves to an existing entity or alias.
3. Provide a dry-run-first, idempotent command that schedules a bounded repair batch without creating duplicate job rows.
4. Run a production backfill in verified batches of 5, then 20, then 50, stopping immediately on defined failure signals.

This is not a generic graph completion system. It is a bounded consistency repair for records that have enough source material but no active graph edge.

## 2. Root cause

`ContentPipeline.applyExtraction` currently behaves differently by entity-resolution result:

- `duplicate_candidate` and `stub_created` increment mention count and write a weak candidate `提及` edge from the source record to the entity.
- `resolved_to_existing` and `alias_added` increment mention count but do not write the corresponding `提及` edge.

This asymmetry means that a successful NER run can leave a record with zero graph links when every extracted entity resolves to an existing page or alias. Re-enqueuing NER without correcting this path does not guarantee progress.

The repair therefore includes a narrow root fix: every non-self entity resolution that is retained as a mention must attempt the same weak candidate NER `提及` edge. `CBrainDB.insertLink` uses `INSERT OR IGNORE`, so an existing trusted wikilink or manual edge with the same `(from, to, relation)` remains authoritative and is not downgraded.

## 3. Scope and non-goals

### 3.1 In scope

- A shared read-only scanner and state classifier for rich zero-link records.
- One aggregate Health dimension and one `fsck` finding.
- A new top-level CLI command: `cbrain zero-link-backfill`.
- Default dry-run and explicit `--enqueue --limit <n>` mutation.
- Reuse of the existing `ner-backfill` job kind and existing `cbrain ner-backfill` consumer.
- Job marker and content-hash semantics that prevent infinite repeat attempts.
- The `resolved_to_existing` / `alias_added` mention-edge consistency fix.
- Tests for detection, job lifecycle, transactionality, CLI safety, privacy, and the NER root fix.
- A production batch run with backups, stop conditions, and per-batch verification.

### 3.2 Non-goals

- No new LLM provider, prompt, ontology type, or relation type.
- No automatic semantic link invention outside normal NER extraction.
- No always-on worker and no direct LLM call from the scheduling command.
- No automatic deletion, merge, page rewrite, or link promotion.
- No change to recall routing, MCP tool contracts, structured output, or search ranking.
- No broad retry of unrelated failed NER jobs.
- No schema migration unless implementation proves the marker cannot be represented safely in existing job `data` and `result` JSON. Such a migration would require stopping and returning to design review.
- No release, version bump, merge, or tag in this issue.

## 4. Canonical eligibility definition

The shared scanner is the single source of truth for Health, `fsck`, and the CLI.

A page is a **rich zero-link record** when all of the following are true at scan time:

1. `pages.type = 'record'`.
2. It has zero active incoming and outgoing links.
3. At least one richness threshold is true:
   - raw chunk count is at least 2; or
   - total characters across raw chunks are at least 1000; or
   - tag count is at least 3.

Only `chunks.summary_level = 0` contributes to raw chunk count and raw character count. Derived summaries must not inflate the richness signal.

An active link is a row where the page is either `from_slug` or `to_slug` and `trust_state` is `NULL` or is not `rejected`/`superseded`. Candidate and trusted links both count as active. Rejected and superseded links do not disqualify the page from repair.

The scanner must aggregate chunks, tags, and links before joining them to pages so that cross-products cannot inflate counts.

Candidate ordering is deterministic:

1. raw character count descending;
2. raw chunk count descending;
3. tag count descending;
4. slug ascending as the final stable tie-breaker.

The scanner may carry slugs and content hashes internally, but no public dry-run report may expose them.

Public counters use two explicit populations:

- **current debt population:** records that meet the richness threshold and currently have zero active links. `total`, `actionable`, `selected`, `active`, `cancelled`, `terminalNoGraphLinks`, and `failed` describe this population.
- **processed success population:** rich records with a current-fingerprint repair result of `graphOutcome = resolved`. `resolved` describes this cumulative success population even though those pages normally leave current debt after receiving an active link.

This distinction is required for rollout measurement: a successful repair reduces `total` and increases `resolved`. The CLI labels these counters explicitly in human output; it must not imply that `resolved` is a subset of current zero-link debt.

## 5. Shared module and types

Add `src/core/maintenance/zero-link-backfill.ts` as the only implementation of eligibility and job-state classification.

Required constants:

```ts
export const ZERO_LINK_REPAIR_NAME = "zero-link-rich-records";
export const ZERO_LINK_REPAIR_VERSION = 1;
export const ZERO_LINK_MIN_RAW_CHUNKS = 2;
export const ZERO_LINK_MIN_RAW_CHARS = 1000;
export const ZERO_LINK_MIN_TAGS = 3;
export const ZERO_LINK_JOB_PRIORITY_BASE = 1000;
```

Required internal types:

```ts
export interface ZeroLinkCandidate {
  slug: string;
  contentHash: string | null;
  contentFingerprint: string;
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

export type ZeroLinkDisposition =
  | "new"
  | "legacy_requeue"
  | "content_changed_requeue"
  | "active"
  | "cancelled"
  | "resolved"
  | "terminal_no_graph_links"
  | "failed";

export interface ZeroLinkBackfillReport {
  version: 1;
  mode: "dry_run" | "enqueue";
  status: "ok" | "blocked" | "error";
  total: number;
  actionable: number;
  selected: number;
  newJobs: number;
  requeuedJobs: number;
  active: number;
  cancelled: number;
  resolved: number;
  terminalNoGraphLinks: number;
  failed: number;
  thresholds: {
    rawChunks: number;
    rawChars: number;
    tags: number;
    union: number;
  };
}
```

The public JSON field names are exactly the camelCase names shown above. Human output uses fixed Chinese labels for the same counters. Tests lock both surfaces.

`contentFingerprint` is the repair invalidation key. It is `pages.content_hash` when present. For a legacy page whose content hash is `NULL`, it is a fixed prefix plus the page `updated_at` value. The fallback is not a content proof, but it is deterministic for an unchanged legacy row and reopens the repair after the normal page-update path advances `updated_at`. The fingerprint never appears in public output.

Required functions:

```ts
export function scanZeroLinkCandidates(db: CBrainDB): ZeroLinkCandidate[];
export function planZeroLinkBackfill(db: CBrainDB, limit: number): ZeroLinkBackfillReport;
export function enqueueZeroLinkBackfill(db: CBrainDB, limit: number): ZeroLinkBackfillReport;
export function countActiveLinks(db: CBrainDB, slug: string): number;
```

`planZeroLinkBackfill` is strictly read-only. `enqueueZeroLinkBackfill` performs selection and all job mutations inside one SQLite transaction.

## 6. Job marker and state machine

### 6.1 Marker shape

The issue reuses the existing `ner-backfill` job name. The repair identity lives in job `data`, and the terminal graph outcome lives in job `result`.

New or requeued job `data` must include:

```json
{
  "slug": "<internal>",
  "kind": "ner",
  "contentHash": "<current page content hash or null>",
  "repair": {
    "name": "zero-link-rich-records",
    "version": 1,
    "contentFingerprint": "<current repair invalidation key>"
  }
}
```

After successful processing, `runNerBackfillStage` completes a marked repair job with:

```json
{
  "outcome": "processed",
  "kind": "ner",
  "repair": {
    "name": "zero-link-rich-records",
    "version": 1,
    "contentFingerprint": "<fingerprint captured when scheduled>"
  },
  "graphOutcome": "resolved | terminal_no_graph_links",
  "activeLinkCount": 0
}
```

`activeLinkCount` is a scalar audit field whose example value is illustrative. `graphOutcome` is determined after `processNer` finishes by re-reading active incoming/outgoing links. A job is `resolved` when the count is greater than zero; otherwise it is `terminal_no_graph_links`.

The consumer must not trust only the NER return object because a valid extraction can still produce no non-self graph edge.

### 6.2 Classification precedence

For each eligible candidate, inspect all matching `ner-backfill` jobs whose parsed `data.slug` equals the candidate slug and whose kind is absent/`ner`. Malformed or other-kind rows do not match.

Apply this precedence:

1. Any `pending` or `running` matching row → `active`. Do not submit or mutate another row.
2. Any `cancelled` matching row → `cancelled`. Respect operator intent permanently; do not reopen it even if content changes.
3. A current repair-marker terminal row whose marker fingerprint equals the current page fingerprint:
   - result `graphOutcome = resolved` → `resolved`;
   - result `graphOutcome = terminal_no_graph_links` → `terminal_no_graph_links`.
4. A current repair-marker `failed` row whose marker fingerprint equals the current page fingerprint → `failed`. It is visible debt but not automatically retried by this command.
5. A current repair-marker terminal or failed row whose marker fingerprint differs from the current page fingerprint → `content_changed_requeue`.
6. An unmarked legacy `done` or `failed` row → `legacy_requeue`.
7. No matching row → `new`.

When more than one row exists in the same applicable class, reuse the highest job id. Never create another row merely because historical duplicates exist.

The only actionable dispositions are `new`, `legacy_requeue`, and `content_changed_requeue`.

This makes one repair attempt terminal for an unchanged content fingerprint. A page update is the only automatic way to make a marked terminal/failed candidate actionable again. A cancelled row is never automatically reopened.

### 6.3 Requeue mutation

Requeue must reuse the selected row and atomically:

- set `status = 'pending'`;
- replace `data` with the current marked payload;
- clear `result`, `error`, `started_at`, and `finished_at`;
- reset `attempts = 0`;
- set bounded repair priority.

New rows use the same marked payload and priority.

Priorities preserve scanner order within the selected batch and place this explicit repair batch ahead of ordinary default-priority NER jobs. A legal `--limit` must be small enough that all computed priorities remain positive.

If any mutation fails, the entire batch transaction rolls back. The command must never return a partial success count.

### 6.4 Failed jobs

Provider errors and timeouts continue through the existing `failJob` behavior. The repair marker remains in `data`, so the scanner reports the failure without resubmitting it on every run.

The existing broad `cbrain ner-backfill --retry-failed` command is not called automatically by this issue. Investigation and explicit operator action are required before retrying a current-fingerprint repair failure.

## 7. NER write-path correction

In `ContentPipeline.applyExtraction`, the `resolved_to_existing` and `alias_added` branch must attempt a weak candidate `提及` edge using the same provenance as existing duplicate/stub mention edges:

```ts
db.insertLink(
  fromSlug,
  result.slug,
  "提及",
  null,
  0.3,
  "weak",
  "ner",
  0.5,
  undefined,
  { source_page_slug: fromSlug },
);
```

Guard conditions:

- Never write a self-link when `fromSlug === result.slug`.
- Preserve the existing `skipMentionSlugs` behavior for mention counts; it does not suppress a missing graph edge unless tests prove an ingest caller relies on that stronger behavior. If such reliance exists, stop and revise this design rather than silently changing semantics.
- Existing trusted/manual/wikilink relations must not be downgraded or overwritten.
- Repeated NER runs must remain idempotent for the same `(from, to, 提及)` edge.

This change is intentionally limited to mention-edge consistency. It does not promote candidate trust or alter relation extraction.

## 8. CLI contract

Register a top-level command in `src/cli/commands/maintenance.ts`:

```text
cbrain zero-link-backfill [--limit <n>] [--enqueue] [--json]
```

Rules:

- Default mode is dry-run. It performs no job writes and is safe while serve/watcher is active.
- `--enqueue` is the only mutation flag.
- `--enqueue` requires an explicit positive `--limit`; no implicit bulk default is allowed for a write.
- `--limit` must be an integer in `[1, 500]` for enqueue mode. Dry-run may omit it and reports all counts; if supplied it controls only `selected`, not `total`/state counts.
- Enqueue mode calls the existing live lock probe and refuses when an active serve or watcher owns the profile.
- Enqueue does not require an LLM because it schedules jobs only.
- The command never processes jobs. The operator invokes `cbrain ner-backfill --limit <same batch size> --json` separately while the writer remains stopped.
- Non-JSON output contains only the same scalar categories and fixed guidance. It must not print candidate titles, slugs, bodies, paths, job payloads, or LLM text.
- JSON errors use stable `status`, `code`, and a sanitized fixed message. No stack trace or raw exception message is emitted.

Suggested stable error codes:

- `INVALID_LIMIT`
- `WRITER_ACTIVE`
- `ENQUEUE_FAILED`

The lock-blocked response may include operational owner kind and PID, matching the existing `ner-backfill` safety response, but no filesystem path.

## 9. Health integration

Add one aggregate dimension to `HealthChecker.checkAll`, after structural consistency and before per-page completeness/island reporting.

Dimension name: `富记录图谱覆盖`.

When the scanner finds no rich zero-link records, the dimension passes with no issues.

When any exist, emit exactly one medium-severity issue:

- stable synthetic slug: `system/zero-link-rich-records`;
- fixed title with no page-derived text;
- description containing only scalar current-debt `total`, `actionable`, `active`, `terminal_no_graph_links`, and `failed` counts plus cumulative current-fingerprint `resolved` count;
- suggestion: run dry-run `cbrain zero-link-backfill --json`.

The dimension is `warn`, not `fail`. This is semantic repair debt, not proof of database corruption.

Update `health-debt.ts` so this dimension is always classified as `needs_review`, never `auto_repairable`. The reason is that enqueueing triggers LLM work later and terminal no-link can be a legitimate result.

The aggregate issue avoids adding hundreds of page-level entries, avoids leaking page identity into health summaries, and avoids unbounded report growth.

## 10. `fsck` integration

`probeSqlite` must call the shared scanner/state summarizer and add one finding when `total > 0`:

- `check`: `sqlite.zero_link_rich_records`
- `layer`: `sqlite`
- `severity`: `warning`
- `count`: total rich zero-link records
- `sampleSlugs`: at most five values, passed through the existing `anonymizeSlugs` helper
- `detail`: scalar current-debt totals for actionable, active, terminal-no-link, and failed plus cumulative current-fingerprint resolved count
- `suggestedCommand`: `cbrain zero-link-backfill --json`

The finding is diagnostic only. It is not added to deterministic `fsck` repair execution rules.

The samples are anonymous display tokens, not real slugs. No title, body, path, raw job data, result payload, or error text is surfaced.

## 11. Privacy boundary

Allowed public output:

- fixed schema/version/mode/status/error code;
- scalar counts and threshold counts;
- boolean blocked state;
- live owner kind/PID when mutation is refused;
- anonymous `fsck` sample tokens;
- fixed commands and guidance.

Forbidden public output:

- real title, slug, body, chunk content, tag value, filename, vault path, database path, username, email, credential, prompt, LLM response, job `data`, job `result`, provider error, or stack trace.

Internal SQLite job payloads may contain the slug and content hash because the existing worker requires them. Tests and documentation examples must use anonymous fixtures such as `record/item-a` and `entity/item-b`.

Logs added by this issue must be scalar-only. Existing lower-level logs are not widened by this issue.

## 12. Concurrency and consistency

- Dry-run is read-only and may execute while serve/watcher is active.
- Enqueue refuses an active writer before opening the mutation transaction.
- The transaction repeats candidate scan and state classification inside the write transaction; it must not reuse a stale plan produced before the lock check.
- All selected job rows are inserted/requeued atomically.
- The existing worker claims each pending job atomically by id.
- A concurrent job appearing between an external dry-run and enqueue is detected by the transactional rescan and classified `active`.
- The command does not write the vault. The worker may write vault/entity state through the existing pipeline, so it remains subject to the existing writer lock rule.

## 13. Production execution and stop gates

Production repair is authorized for this issue, but must occur only after focused tests, the full suite, privacy scan, and adversarial code review pass.

### 13.1 Preflight

1. Record the current git commit and sanitized config summary.
2. Back up SQLite, vault, and required runtime configuration using the repository-supported backup path.
3. Verify the backup artifact exists and is non-empty.
4. Stop the active serve/watcher writer and verify the lock probe reports no owner.
5. Run `cbrain zero-link-backfill --json` and record scalar counts only.
6. Run FK and consistency checks before the first batch.

### 13.2 Per-batch sequence

Run batch sizes in this exact progression: 5, then 20, then 50.

For each batch:

1. Create or verify a restorable pre-batch backup.
2. Run `cbrain zero-link-backfill --enqueue --limit <N> --json`.
3. Assert `selected <= N` and `newJobs + requeuedJobs = selected`.
4. Run `cbrain ner-backfill --limit <N> --json` using the existing configured provider.
5. Re-run dry-run, `fsck`, FK checks, and consistency checks.
6. Record scalar deltas for resolved, terminal-no-link, active, actionable, and failed.
7. Proceed only when every stop gate remains clear.

The first batch is a canary. At least one of its five candidates must become `resolved`. If all five finish as `terminal_no_graph_links`, stop before the 20 batch because the repair is not demonstrating useful graph recovery.

### 13.3 Immediate stop conditions

Stop the rollout and do not enqueue the next batch on any of:

- provider error, timeout, or unexpected exception;
- duplicate job creation or any partial transaction;
- zero resolved records in the five-item canary;
- FK violation increase;
- new SQLite/vault/FTS consistency regression;
- public output or logs leaking forbidden private fields;
- writer process detected during mutation;
- mismatch between selected count and inserted/requeued count.

### 13.4 Rollback

If a batch creates a data or vault consistency regression:

1. Keep serve/watcher stopped.
2. Preserve sanitized diagnostics and scalar counts.
3. Restore SQLite and vault from the pre-batch backup as one matched snapshot.
4. Re-run FK, `fsck`, and consistency checks.
5. Restart serve only after the restored state passes the preflight checks.

If the batch merely produces legitimate `terminal_no_graph_links` outcomes without data corruption, do not restore; those terminal markers prevent repeated LLM spend. Stop the progression if the canary usefulness gate fails.

### 13.5 Restart

After the final accepted batch:

1. Restart the normal serve/MCP chain.
2. Verify `/health` or MCP `serverInfo.version` and a read-only CBrain query.
3. Confirm no pending/running repair jobs remain from the executed batches.
4. Retain the backup until the PR is merged and the post-run check remains stable.

## 14. TDD and verification matrix

All production changes follow RED → GREEN → REFACTOR. Each behavior must have a failing test before implementation.

### 14.1 Scanner tests

- excludes non-record pages;
- excludes records below all richness thresholds;
- includes independently by raw chunks, raw chars, and tags;
- ignores derived summary chunks;
- excludes a page with active candidate or trusted incoming/outgoing link;
- does not count rejected or superseded links as active;
- prevents chunk/tag/link join multiplication;
- orders deterministically and applies selection limit after ordering;
- returns no page-derived text in the public report.

### 14.2 State-machine and transaction tests

- no job → new row;
- legacy done → same row requeued once;
- legacy failed → same row requeued once;
- pending/running → skipped as active;
- cancelled → never reopened, including after content change;
- marked resolved same fingerprint → terminal resolved;
- marked no-link same fingerprint → terminal no-link;
- marked failed same fingerprint → reported failed, not automatically retried;
- marked terminal/failed changed fingerprint → same row requeued;
- multiple historical matching rows → deterministic reuse, no new duplicate;
- malformed/unrelated-kind jobs do not match;
- injected mutation failure rolls back every row in the selected batch;
- repeated enqueue with unchanged state creates no duplicate work.

### 14.3 Pipeline tests

- `resolved_to_existing` writes one weak candidate NER `提及` edge;
- `alias_added` writes the same edge;
- existing trusted mention edge remains trusted;
- repeated extraction remains idempotent;
- source resolving to itself creates no self-link;
- existing duplicate/stub behavior remains unchanged.

### 14.4 Worker-result tests

- marked job with resulting active edge completes as `resolved`;
- marked job with no resulting active edge completes as `terminal_no_graph_links`;
- legacy job retains legacy compatible completion shape;
- NER timeout/provider failure preserves marker in `data` and produces sanitized existing error code;
- content fingerprint in the terminal marker is the scheduled fingerprint, not a later mutable page value.

### 14.5 CLI tests

- no flags is read-only dry-run;
- enqueue without explicit limit fails before writes;
- invalid/zero/over-max limits fail;
- dry-run works with active writer;
- enqueue refuses active writer before writes;
- enqueue does not require an LLM;
- output schema and counts are stable;
- human and JSON outputs contain no fixture slug/title/body/path/job payload;
- thrown internal error maps to a stable sanitized code/message.

### 14.6 Health and `fsck` tests

- Health emits zero or exactly one aggregate issue;
- aggregate issue uses only stable synthetic identity and scalar counts;
- health-debt classifies it as `needs_review`;
- `fsck` emits the stable check id, warning severity, correct count, and at most five anonymous samples;
- no deterministic repair-plan rule executes it.

### 14.7 Final gates

- focused tests for all changed modules;
- `bun run lint`;
- `bun run check:docs` if command/document inventories require updates;
- `bun run check` full suite;
- `git diff --check` and `git show --check` for every new commit;
- privacy scan across changed source, tests, docs, and captured reports;
- adversarial review with no unresolved CRITICAL or HIGH findings;
- production 5 → 20 → 50 report with scalar evidence and stop-gate result.

## 15. Likely files

Required/allowed changes are limited to:

- `src/core/maintenance/zero-link-backfill.ts` (new)
- `src/core/ingestion/pipeline.ts`
- `src/core/ingestion/ner-backfill.ts`
- `src/core/maintenance/health.ts`
- `src/core/maintenance/health-debt.ts`
- `src/core/fsck/sqlite-probe.ts`
- `src/cli/commands/maintenance.ts`
- focused tests under `tests/core/maintenance`, `tests/core/ingestion`, `tests/core/fsck`, and `tests/cli`
- command/help/docs consistency files only if required by existing gates

Changes outside this list require an explicit explanation in the implementation plan. Public API, schema, routing, MCP, or release changes are out of scope and require stopping for a new decision.

## 16. Acceptance criteria

#342 is implementation-complete when:

1. The shared scanner deterministically finds the approved rich zero-link population.
2. Health and `fsck` surface bounded, anonymous, aggregate debt.
3. `cbrain zero-link-backfill` is dry-run by default and enqueue is explicit, bounded, locked, atomic, and idempotent.
4. Existing job rows are reused under the state machine; unchanged terminal content is not sent to the LLM repeatedly.
5. Resolved-existing and alias NER outcomes create a candidate mention edge without downgrading trusted data.
6. The worker records `resolved` versus `terminal_no_graph_links` after inspecting actual graph state.
7. Focused and full verification pass with no privacy leak.
8. An independent adversarial review has no unresolved CRITICAL/HIGH finding.
9. Production batches 5, 20, and 50 complete without a stop condition, or the rollout stops safely with documented scalar evidence and a verified rollback.
10. The branch is pushed and a ready PR references #342; it is not self-merged, tagged, or released.

## 17. Adversarial self-review

Before independent review, the design was attacked against the five most likely failure modes:

1. **A successful NER call still leaves zero links.** Root cause was the missing mention edge for existing/alias resolution. The design fixes that path and classifies the result from actual post-run graph state rather than the NER return object.
2. **Repeated runs spend LLM tokens forever.** The repair marker, fingerprint, terminal no-link outcome, cancelled-state rule, and current-fingerprint failed state make unchanged work non-actionable.
3. **A legacy job or concurrent writer creates duplicates.** Matching inspects all historical rows, reuses one deterministic row, skips pending/running work, refuses a live writer, and rescans inside one transaction.
4. **Successful repairs disappear from the report.** Current debt and cumulative processed success are defined as separate populations, so `total` can fall while `resolved` rises.
5. **Diagnostics leak private knowledge.** CLI/Health expose scalar-only reports; `fsck` samples pass through existing anonymization; internal slugs/fingerprints remain in SQLite only; errors are stable and sanitized.

These defenses are requirements, not commentary. The independent adversarial reviewer must still verify them against current code and identify any missing state, privacy, or rollback path before implementation starts.
