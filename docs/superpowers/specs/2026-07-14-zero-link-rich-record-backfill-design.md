# #342 Rich Record Zero-Link Detection and Backfill Design

**Date:** 2026-07-14

**Issue:** #342

**Status:** Revision pending adversarial re-review

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
2. It has zero current-fact, non-self incoming and outgoing links.
3. At least one richness threshold is true:
   - raw chunk count is at least 2; or
   - total characters across raw chunks are at least 1000; or
   - tag count is at least 3.

Only `chunks.summary_level = 0` contributes to raw chunk count and raw character count. Derived summaries must not inflate the richness signal.

A current graph link is a row where the page is either `from_slug` or `to_slug`, `from_slug != to_slug`, its `trust_state` is not `rejected`/`superseded`, and it passes the existing `isCurrentFactLink` predicate:

- rejected and superseded rows are inactive;
- candidate `reports_to` is evidence, not a current fact, and is inactive for this repair;
- other candidate relations and trusted/user-thought relations are current graph links.

The shared helper therefore matches `db.getAllLinks().filter(isCurrentFactLink)` and additionally removes self-loops. It must not call `isCurrentFactLink` on unfiltered rejected/superseded rows or introduce a divergent SQL-only approximation. Health detection and post-worker `graphOutcome` use this same helper.

The scanner must aggregate chunks, tags, and links before joining them to pages so that cross-products cannot inflate counts.

Candidate ordering is deterministic:

1. raw character count descending;
2. raw chunk count descending;
3. tag count descending;
4. slug ascending as the final stable tie-breaker.

The scanner may carry slugs and content hashes internally, but no public dry-run report may expose them.

Public counters use two explicit populations:

- **current debt population:** records that meet the richness threshold and currently have zero current-fact non-self links. `total`, `actionable`, `selected`, `active`, `cancelled`, `terminalNoGraphLinks`, `blockedSourceUnavailable`, `sourceChanged`, `invalidTerminal`, `lostLink`, `unverifiableFingerprint`, `failed`, and `stateConflicts` describe this population. `queueIntegrityConflicts` is a separate global count over malformed/referentially invalid repair queue rows.
- **current processed-success population:** distinct rich record pages whose canonical current-fingerprint repair result is `graphOutcome = resolved` **and** that still have at least one current-fact non-self link. `resolved` counts pages, never job rows.

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
export const ZERO_LINK_BATCH_MANIFEST_JOB = "zero-link-backfill-batch";
```

Required internal types:

```ts
export interface ZeroLinkCandidate {
  slug: string;
  contentHash: string | null;
  contentFingerprint: string | null;
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

export type ZeroLinkDisposition =
  | "new"
  | "legacy_requeue"
  | "content_changed_requeue"
  | "stale_requeue"
  | "active"
  | "cancelled"
  | "resolved"
  | "terminal_no_graph_links"
  | "blocked_source_unavailable"
  | "source_changed"
  | "invalid_terminal"
  | "lost_link"
  | "unverifiable_fingerprint"
  | "failed";

export interface ZeroLinkBackfillReport {
  version: 1;
  mode: "dry_run" | "enqueue";
  status: "ok" | "blocked" | "error";
  batchId?: string;
  total: number;
  actionable: number;
  selected: number;
  newJobs: number;
  requeuedJobs: number;
  active: number;
  cancelled: number;
  resolved: number;
  terminalNoGraphLinks: number;
  blockedSourceUnavailable: number;
  sourceChanged: number;
  invalidTerminal: number;
  lostLink: number;
  unverifiableFingerprint: number;
  failed: number;
  staleRunning: number;
  stateConflicts: number;
  queueIntegrityConflicts: number;
  thresholds: {
    rawChunks: number;
    rawChars: number;
    tags: number;
    union: number;
  };
}

export interface RepairBatchStatus {
  version: 1;
  batchId: string;
  integrityConflicts: number;
  selected: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
}
```

The public JSON field names are exactly the camelCase names shown above. Human output uses fixed Chinese labels for the same counters. Tests lock both surfaces.

`contentFingerprint` is the repair invalidation key:

1. If `pages.content_hash` is a non-empty string, use `page:` plus that hash.
2. Otherwise, when at least one raw chunk exists, compute a full SHA-256 over the UTF-8 bytes of `JSON.stringify` applied to an object constructed in this exact key order: `{version:1,type,chunks,tags}`. `chunks` is ordered by `(chunk_index, id)` and each object is constructed as `{index,id,content}` in that key order. `tags` is a lexicographically sorted string array. JSON escaping makes delimiter/newline content unambiguous. Prefix the lowercase 64-hex digest with `derived:`.
3. If neither a page hash nor any raw chunk exists, the fingerprint is unavailable. Classify the current debt as `unverifiable_fingerprint`; do not enqueue it automatically.

`updated_at`, empty strings, and sentinel fingerprints are forbidden. Only a non-empty `page:` or `derived:` fingerprint may enter a repair marker. Non-content metadata can advance timestamps, and timestamp resolution cannot prove body identity. The derived hash is computed internally and never appears in public output.

Required functions:

```ts
export function scanRichRecords(db: ZeroLinkDb): ZeroLinkCandidate[];
export function scanZeroLinkCandidates(db: ZeroLinkDb): ZeroLinkCandidate[];
export function planZeroLinkBackfill(db: ZeroLinkDb, limit?: number): ZeroLinkBackfillReport;
export function enqueueZeroLinkBackfill(db: ZeroLinkDb, limit: number): ZeroLinkBackfillReport;
export function countCurrentGraphLinks(db: ZeroLinkDb, slug: string): number;
export function snapshotRepairBatchJobIds(db: ZeroLinkDb, batchId: string, limit: number): number[];
export function summarizeRepairBatch(db: ZeroLinkDb, batchId: string): RepairBatchStatus;
```

`ZeroLinkDb` exposes only a `bun:sqlite` raw database connection. `planZeroLinkBackfill` is strictly read-only. `enqueueZeroLinkBackfill` performs selection and all job mutations inside one SQLite transaction.

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
    "contentFingerprint": "<current repair invalidation key>",
    "sourceKind": "vault_hash | raw_chunks",
    "batchId": "<opaque manifest receipt token>"
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
    "contentFingerprint": "<fingerprint captured when scheduled>",
    "sourceKind": "vault_hash | raw_chunks",
    "batchId": "<same opaque manifest receipt token>"
  },
  "graphOutcome": "resolved | terminal_no_graph_links",
  "activeLinkCount": 0
}
```

`activeLinkCount` is a scalar audit field whose example value is illustrative. `graphOutcome` is determined after `processNer` finishes by re-reading current-fact non-self incoming/outgoing links. A job is `resolved` when the count is greater than zero; otherwise it is `terminal_no_graph_links`.

The consumer must not trust only the NER return object because a valid extraction can still produce no current-fact non-self graph edge.

Every early terminal path for a marked job must preserve the scheduled `repair` object:

- unusable/missing source completes with fixed `outcome = skipped`, `reason = SOURCE_UNAVAILABLE`, and `graphOutcome = blocked_source_unavailable`;
- source bytes no longer matching the scheduled fingerprint complete with fixed `outcome = skipped`, `reason = SOURCE_CHANGED`, and `graphOutcome = source_changed` without calling the LLM;
- an impossible marked payload discovered after claim completes with fixed `outcome = skipped`, `reason = INVALID_JOB`, and `graphOutcome = invalid_terminal` when the repair object is parseable enough to preserve;
- provider timeout/error uses a fixed existing reason code and becomes terminal on the first attempt because marked repair jobs have `max_attempts = 1`.

No marked `done` row is allowed to lack a recognized fixed terminal outcome. Historical/corrupt marked `done` rows that do lack one are classified `invalid_terminal`, never guessed as success and never automatically retried.

Before any marked job calls the LLM, the worker verifies and freezes the exact input source:

- `sourceKind = vault_hash`: read the raw vault file once, compute the existing `hashContent(rawFile)` value, and require `page:<hash>` to equal the scheduled fingerprint. Parse the NER body from those same bytes; do not re-read through a cache.
- `sourceKind = raw_chunks`: re-read page type, raw chunks, and tags, reconstruct the byte-exact canonical JSON from §5, and require the `derived:` digest to equal the scheduled fingerprint. The NER body is the same ordered raw chunk contents joined with the existing `\n\n` convention; do not prefer the vault for this job.

The mapping is fixed and performs zero LLM calls: an absent required vault file/raw chunk set is `blocked_source_unavailable`; present source bytes whose recomputed hash differs are `source_changed`; an unknown source kind, invalid fingerprint prefix, or source-kind/prefix disagreement is `invalid_terminal`. After a normal sync changes the DB fingerprint, the old terminal marker becomes `content_changed_requeue`.

### 6.2 Classification precedence

Load all `ner-backfill` rows and parse `data`/`result` in TypeScript under `try/catch`. Malformed JSON must not throw out of Health, `fsck`, dry-run, enqueue, or the filtered consumer.

Before per-page classification, compute global `queueIntegrityConflicts`:

- every `pending` or `running` `ner-backfill` row must have parseable data, a non-empty valid slug, and kind absent/`ner` or `entity_facts`; otherwise it is a conflict because an ordinary worker can execute or recover it;
- every row containing this repair marker, regardless of status, must have the exact marker name/version, a valid slug, kind `ner`, a non-empty `page:`/`derived:` fingerprint, consistent source kind, and a syntactically valid manifest receipt token;
- every marked repair row must reference an existing valid batch manifest that includes its job id.

Each invalid row increments only a scalar conflict count; raw job data/error/result is never emitted. Any queue integrity conflict makes enqueue fail closed globally with zero mutations.

A valid row matches a candidate only when `data.slug` equals the candidate slug and kind is absent/`ner`; `entity_facts` is valid queue state but is a different enrichment kind.

`running` freshness uses `NER_BACKFILL_STALE_TTL_MS` (30 minutes). A running row is fresh only when `started_at` parses and is newer than the cutoff. Missing, invalid, or older timestamps are stale.

When the page fingerprint is unavailable, still surface live rows and live/cancellation conflicts because work already exists. If there is no live row, classify `unverifiable_fingerprint` before interpreting historical terminal rows; without a current fingerprint the scheduler cannot prove idempotency and performs no mutation.

Apply this deterministic algorithm:

1. Collect **all live rows** for the slug: every `pending` row and every `running` row, irrespective of fingerprint or freshness. More than one live row is always `stateConflicts`; no lower-id live row may be ignored, and enqueue fails closed.
2. If exactly one live row exists:
   - fresh `running` → `active`;
   - stale `running` with current marker → `stale_requeue`;
   - stale `running` with old marker and a current fingerprint → `content_changed_requeue`;
   - stale legacy `running` → `legacy_requeue`;
   - `pending` with current marker → `active`;
   - `pending` with old marker and a current fingerprint → `content_changed_requeue` on that same row;
   - legacy `pending` → `active`;
   - when the current fingerprint is unavailable, do not refresh any marked live row; report `active` for pending/fresh-running or `unverifiable_fingerprint` plus `staleRunning` for stale-running.
   - if the live row coexists with a current-fingerprint cancellation or unverifiable legacy cancellation, also increment `stateConflicts` and perform no mutation.
3. If there is no live row and the fingerprint is unavailable, classify `unverifiable_fingerprint`.
4. Otherwise choose the highest-id marked row whose repair fingerprint equals the current fingerprint. This is the canonical current row:
   - `cancelled` → `cancelled` for this fingerprint only;
   - `failed` → `failed`;
   - `done` + `graphOutcome = terminal_no_graph_links` → `terminal_no_graph_links`;
   - `done` + `graphOutcome = blocked_source_unavailable` → `blocked_source_unavailable`;
   - `done` + `graphOutcome = source_changed` → `source_changed`;
   - `done` + `graphOutcome = invalid_terminal`, missing, malformed, or unknown terminal outcome → `invalid_terminal`;
   - `done` + `graphOutcome = resolved` requires an actual current-fact non-self link. With a current link it contributes one distinct page to `resolved`; without one it is `lost_link`, not resolved and not automatically requeued.
5. If no current-fingerprint row exists, choose the highest-id marked terminal row for an older/different fingerprint. A done, failed, or cancelled old-fingerprint row is `content_changed_requeue`; cancellation is row/fingerprint-scoped, not a permanent page-wide veto.
6. If no marked row exists, choose the highest-id unmarked legacy terminal row:
   - `done` or `failed` → `legacy_requeue`;
   - `cancelled` has no trustworthy fingerprint scope → `cancelled` and needs review; it is never automatically reopened.
7. No matching row → `new`.

Lower-id historical **terminal** rows are ignored after canonical selection and never counted as additional pages; live rows are never ignored. Conflicting current-fingerprint terminal outcomes increment `stateConflicts` even though the highest id remains canonical.

The only actionable dispositions are `new`, `legacy_requeue`, `content_changed_requeue`, and `stale_requeue`.

If any current-debt page contributes `stateConflicts > 0` or the global `queueIntegrityConflicts > 0`, enqueue is fail-closed for the whole invocation: return `status = blocked`, create no `batchId`, and perform zero job mutations. Dry-run still reports scalar conflict counts so the operator can investigate.

`lost_link` is conservative: an edge may have been deliberately deleted, rejected, or superseded. It remains visible `needs_review` debt instead of silently recreating a relation against later governance. A content fingerprint change makes the old marker eligible for `content_changed_requeue`.

This makes one repair attempt terminal for an unchanged content fingerprint. Current-fingerprint cancellation is respected; changed content may be reconsidered. A legacy cancellation without a fingerprint remains review-only because its intended scope cannot be proven.

### 6.3 Requeue mutation

Requeue must reuse the selected row and atomically:

- set `status = 'pending'`;
- replace `data` with the current marked payload;
- clear `result`, `error`, `started_at`, and `finished_at`;
- reset `attempts = 0`;
- set `max_attempts = 1` for this marked repair;
- set bounded repair priority.

New rows use the same marked payload and priority with `max_attempts = 1`.

Priorities preserve scanner order within the selected batch and place this explicit repair batch ahead of ordinary default-priority NER jobs. A legal `--limit` must be small enough that all computed priorities remain positive.

Each non-empty enqueue creates one internal batch manifest row in the same transaction:

- `name = zero-link-backfill-batch`;
- `status = done`, so ordinary workers never claim it;
- `data` contains only version, repair name, the opaque receipt token, and the ordered selected job-id list;
- the public `batchId` receipt has the exact form `<manifestJobId>.<uuid>`.

The manifest id prefix lets a later process locate the exact manifest row without searching or trusting child job JSON. The UUID prevents a caller from substituting another manifest id. Manifest job ids and child ids remain internal; only the opaque receipt token is public.

Batch validation parses the manifest by its id, requires the stored token to match exactly, requires a unique positive selected-id list, then loads every selected job by id and verifies its job name and complete repair marker. Missing/corrupt/mismatched child data produces `BATCH_INTEGRITY_CONFLICT` and zero claims. Batch status counts rows by manifest-selected id and therefore still sees a pending/running row even if its child JSON is corrupt.

Selection, manifest creation, receipt generation, rescan, inserts, requeues, and final manifest update run under `BEGIN IMMEDIATE`. This obtains the SQLite write reservation before reading candidate/job state, preventing two concurrent CLI processes from both planning the same rows. On success the command commits; on any error it rolls back. It must never return a partial success count or a manifest without all selected rows.

### 6.4 Failed jobs

Provider errors and timeouts continue through the existing `failJob` behavior. Because marked jobs have `max_attempts = 1`, their first claimed failure becomes `failed`, not `pending`. The repair marker remains in `data`, so the scanner reports the failure without resubmitting it on every run.

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

Register a top-level command through a dedicated `src/cli/commands/zero-link-backfill.ts` module and `src/cli/program.ts`:

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
- A successful non-empty enqueue returns one opaque manifest receipt `batchId`; it contains no page identity or user data. Every selected job receives the same `repair.batchId`.
- The command never processes jobs. The operator invokes `cbrain ner-backfill --repair-batch <batchId> --limit <same batch size> --json` separately while the writer remains stopped.
- Non-JSON output contains only the same scalar categories and fixed guidance. It must not print candidate titles, slugs, bodies, paths, job payloads, or LLM text.
- JSON errors use stable `status`, `code`, and a sanitized fixed message. No stack trace or raw exception message is emitted.

The existing `ner-backfill` command gains `--repair-batch <receipt>`:

- validate the `<positive-integer>.<uuid>` receipt syntax before opening the DB;
- when present, locate and validate the receipt manifest, then snapshot and claim only its selected `ner-backfill` job ids after verifying their complete markers;
- ignore ordinary NER jobs and every `entity_facts` job, regardless of priority;
- do **not** call the existing global `resetStaleJobsForNames` in filtered mode; reset only manifest-selected stale-running rows whose complete marker matches the receipt;
- retain the existing global stale recovery unchanged when `--repair-batch` is absent;
- reject combination with broad `--retry-failed`;
- preserve current unfiltered behavior when the option is absent;
- return scalar per-batch terminal status counts (`pending`, `running`, `done`, `failed`, `cancelled`) after processing so the operator can prove no selected row remains active.
- require the supplied `--limit` to equal the manifest's selected count; mismatch returns fixed `BATCH_LIMIT_MISMATCH` before reset/claim, preventing an apparently successful partial batch.

Filtering is performed by manifest ids plus safe TypeScript JSON parsing, not unguarded SQLite `json_extract`. Manifest/child corruption returns `BATCH_INTEGRITY_CONFLICT`, processes zero rows, and reports the manifest-selected status counts rather than treating corruption as non-membership.

Suggested stable error codes:

- `INVALID_LIMIT`
- `WRITER_ACTIVE`
- `ENQUEUE_FAILED`
- `CONFIG_INVALID`
- `DB_NOT_FOUND`
- `DB_OPEN_FAILED`
- `INVALID_BATCH_ID`
- `STATE_CONFLICT`
- `QUEUE_INTEGRITY_CONFLICT`
- `BATCH_INTEGRITY_CONFLICT`
- `BATCH_LIMIT_MISMATCH`

The lock-blocked response may include operational owner kind and PID, matching the existing `ner-backfill` safety response, but no filesystem path.

### 8.1 CLI dependency and open order

This command does not call `loadConfig()` or `createDeps()`.

1. Use `loadConfigSafe()` and validate that `dbPath` is a non-empty string. Map missing/malformed config to fixed `CONFIG_INVALID` without printing the config path.
2. Verify the DB path exists before opening it. `DB_NOT_FOUND` must not create a parent directory or empty database.
3. For enqueue, derive the profile directory, run the live lock probe, and refuse before opening a writable DB.
4. Dry-run opens `bun:sqlite` `Database` with `{ readonly: true }`; it runs no migrations and constructs no embedding, LLM, or Lance dependency.
5. Enqueue opens only the existing SQLite database, sets bounded busy timeout and foreign keys, but runs no migrations. `BEGIN IMMEDIATE` provides the mutation lock.
6. Any open/config/internal exception maps to a fixed sanitized envelope; raw exception messages and paths are never printed.

The shared scanner accepts a minimal raw-database interface so Health/`fsck` can pass `CBrainDB.rawDb` while the CLI can use a truly read-only connection.

## 9. Health integration

Add one aggregate dimension to `HealthChecker.checkAll`, after structural consistency and before per-page completeness/island reporting.

Dimension name: `富记录图谱覆盖`.

When the scanner finds no rich zero-link records, the dimension passes with no issues.

When any exist, emit exactly one medium-severity issue:

- stable synthetic slug: `system/zero-link-rich-records`;
- fixed title with no page-derived text;
- description containing only scalar current-debt `total`, `actionable`, `active`, `terminal_no_graph_links`, `blocked_source_unavailable`, `source_changed`, `invalid_terminal`, `lost_link`, `unverifiable_fingerprint`, `failed`, `state_conflicts`, and `queue_integrity_conflicts` counts plus distinct current-success `resolved` count;
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
- `detail`: scalar current-debt totals for actionable, active, terminal-no-link, blocked-source, source-changed, invalid-terminal, lost-link, unverifiable-fingerprint, failed, state-conflict, and queue-integrity-conflict plus distinct current-success resolved count
- `suggestedCommand`: `cbrain zero-link-backfill --json`

The finding is diagnostic only. It is not added to deterministic `fsck` repair execution rules.

The samples are anonymous display tokens, not real slugs. No title, body, path, raw job data, result payload, or error text is surfaced.

## 11. Privacy boundary

Allowed public output:

- fixed schema/version/mode/status/error code;
- scalar counts and threshold counts;
- opaque repair batch receipt token;
- boolean blocked state;
- live owner kind/PID when mutation is refused;
- anonymous `fsck` sample tokens;
- fixed commands and guidance.

Forbidden public output:

- real title, slug, body, chunk content, tag value, filename, vault path, database path, username, email, credential, prompt, LLM response, job `data`, job `result`, provider error, or stack trace.

Internal SQLite job payloads may contain the slug and content hash because the existing worker requires them. Tests and documentation examples must use anonymous fixtures such as `record/item-a` and `entity/item-b`.

Logs added by this issue must be scalar-only. Existing lower-level logs are not widened by this issue.

## 12. Concurrency and consistency

- Dry-run uses a SQLite read-only connection, runs no migrations, and may execute while serve/watcher is active.
- Enqueue refuses an active writer before opening the mutation transaction.
- Enqueue starts with `BEGIN IMMEDIATE`, then repeats candidate scan and state classification inside the write transaction; it must not reuse a stale plan produced before the lock check.
- All selected job rows are inserted/requeued atomically.
- The existing worker claims each pending job atomically by id.
- Batch-filtered worker validates the receipt manifest, then snapshots and claims only its exact selected ids; unrelated NER and entity-facts rows are outside its candidate set.
- A concurrent job appearing between an external dry-run and enqueue is detected by the transactional rescan and classified `active`.
- The command does not write the vault. The worker may write vault/entity state through the existing pipeline, so it remains subject to the existing writer lock rule.

## 13. Production execution and stop gates

Production repair is authorized for this issue, but must occur only after focused tests, the full suite, privacy scan, and adversarial code review pass.

### 13.1 Preflight

Because the issue forbids self-merge, the installed production CLI does not yet contain these commands. All rollout invocations use `bun run src/cli/index.ts` from the clean, fully reviewed feature worktree with the live config supplied through `CBRAIN_CONFIG`. Record the exact HEAD and require an empty worktree before the first backup. Fixed reports must not expose either path.

1. Record the current git commit.
2. Stop the active serve/watcher writer and verify the lock probe reports no owner.
3. Run `cbrain backup -o <private-backup-dir>` to create the repository-supported full archive.
4. Verify the zip exists, is non-empty, passes `unzip -t`, and contains the configured DB basename plus `vault/`; when the configured Lance path exists, also require `lancedb/` entries. Do not print archive paths in the delivery report.
5. Record a sanitized configuration summary separately; configuration and credentials are not claimed to be restorable from the archive.
6. Run `cbrain zero-link-backfill --json` and record scalar counts only.
7. Run FK and consistency checks before the first batch.

### 13.2 Per-batch sequence

Run batch sizes in this exact progression: 5, then 20, then 50.

For each batch:

1. Create a **new** full backup immediately before this batch, verify that newly created artifact, and record its private mapping to batch size and start time. A prior batch artifact may not be reused as the next batch's pre-batch snapshot.
2. Run `cbrain zero-link-backfill --enqueue --limit <N> --json` and capture its opaque `batchId` privately.
3. Assert `selected <= N`, `newJobs + requeuedJobs = selected`, `stateConflicts = 0`, and `queueIntegrityConflicts = 0`.
4. Run `cbrain ner-backfill --repair-batch <batchId> --limit <N> --json` using the existing configured provider.
5. Assert this exact manifest reports zero integrity conflicts, zero `pending`, and zero `running`; ordinary and stale NER/entity-facts jobs must be unchanged.
6. Re-run dry-run, `fsck`, FK checks, and consistency checks.
7. Record scalar deltas for resolved, terminal-no-link, blocked-source, invalid-terminal, lost-link, active, actionable, and failed.
8. Proceed only when every stop gate remains clear.

The first batch is a canary. At least one of its five candidates must become `resolved`. If zero resolve—whether the outcomes are all terminal-no-link or a mix of blocked/failed/invalid states—stop before the 20 batch because the repair is not demonstrating useful graph recovery.

### 13.3 Immediate stop conditions

Stop the rollout and do not enqueue the next batch on any of:

- provider error, timeout, or unexpected exception;
- duplicate job creation or any partial transaction;
- duplicate active/state conflict reported by the scanner;
- any queue-integrity or batch-manifest integrity conflict;
- zero resolved records in the five-item canary;
- FK violation increase;
- new SQLite/vault/FTS consistency regression;
- public output or logs leaking forbidden private fields;
- writer process detected during mutation;
- mismatch between selected count and inserted/requeued count.
- any selected batch row left pending/running after the batch-filtered consumer returns.

### 13.4 Rollback

If a batch creates a data or vault consistency regression:

1. Keep serve/watcher stopped.
2. Preserve sanitized diagnostics and scalar counts.
3. Run `cbrain restore <pre-batch-zip> --force` to restore its matched SQLite + vault snapshot.
4. The NER backfill path in this issue does not call Lance write APIs, so the pre-batch Lance directory remains unchanged and stays matched to the restored source snapshot. If verification detects any unexpected Lance mutation, restore `lancedb/` manually from the same archive while services remain stopped.
5. Re-run FK, `fsck`, and consistency checks, including Lance verification.
6. Restart serve only after the restored state passes the preflight checks.

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
- does not count candidate `reports_to` or any self-loop as a current graph link;
- prevents chunk/tag/link join multiplication;
- orders deterministically and applies selection limit after ordering;
- derives a stable SHA-256 fallback from ordered raw content/type/tags, never `updated_at`;
- canonical JSON/UTF-8 fingerprint distinguishes delimiter/newline boundary cases and is stable under unordered query results;
- classifies a no-hash/no-raw-chunk page as unverifiable and non-actionable;
- represents unavailable fingerprint as `null`; empty/sentinel values never enter a marker;
- returns no page-derived text in the public report.

### 14.2 State-machine and transaction tests

- no job → new row;
- legacy done → same row requeued once;
- legacy failed → same row requeued once;
- one pending/fresh running → skipped as active;
- current-pending + old-pending, two old-pending, and legacy-pending + old-pending → conflict/fail-closed with both rows unchanged;
- stale running → same row requeued, with TTL boundary covered;
- current-fingerprint cancelled → not reopened; changed fingerprint → same row requeued;
- legacy cancelled without fingerprint → review-only, not reopened;
- marked resolved same fingerprint + current non-self fact link → distinct-page resolved;
- marked resolved same fingerprint + lost/rejected/superseded link → lost-link, not resolved or auto-requeued;
- marked no-link same fingerprint → terminal no-link;
- marked failed same fingerprint → reported failed, not automatically retried;
- marked source-unavailable → blocked terminal;
- marked done with missing/unknown result → invalid terminal;
- marked terminal/failed changed fingerprint → same row requeued;
- multiple historical matching rows → deterministic reuse, no new duplicate;
- duplicate active/conflicting current rows → scalar conflict, no mutation;
- malformed active JSON, invalid active slug/kind, and incomplete repair marker increment queue-integrity conflict and block all enqueue without leaking payload;
- unrelated valid `entity_facts` does not match and does not create a conflict;
- manifest receipt is atomic with its ordered selected ids; missing/corrupt manifest or child marker fails closed;
- injected mutation failure rolls back every row in the selected batch;
- two connections racing enqueue serialize under `BEGIN IMMEDIATE` and create one batch of work;
- repeated enqueue with unchanged state creates no duplicate work.

### 14.3 Pipeline tests

- `resolved_to_existing` writes one weak candidate NER `提及` edge;
- `alias_added` writes the same edge;
- existing trusted mention edge remains trusted;
- repeated extraction remains idempotent;
- source resolving to itself creates no self-link;
- existing duplicate/stub behavior remains unchanged.

### 14.4 Worker-result tests

- marked job with a resulting current-fact non-self edge completes as `resolved`;
- marked job with no resulting active edge completes as `terminal_no_graph_links`;
- source unavailable preserves repair marker/fingerprint/batch and completes blocked;
- impossible marked terminal preserves what can be safely retained and completes invalid;
- legacy job retains legacy compatible completion shape;
- first NER timeout/provider failure is immediately terminal for a marked job (`max_attempts = 1`) while legacy retry behavior remains unchanged;
- content fingerprint in the terminal marker is the scheduled fingerprint, not a later mutable page value.
- vault-hash repair reads and hashes one raw-file snapshot before parsing its body;
- derived repair consumes the exact ordered raw chunks used by its fingerprint, not an unsealed vault body;
- vault/raw source drift after enqueue completes `source_changed` with zero LLM calls;
- batch-filtered consumer processes only the exact repair batch and leaves ordinary NER/entity-facts jobs untouched;
- filtered mode leaves unrelated stale NER and stale entity-facts rows byte-for-byte unchanged;
- same-batch stale row is the only row targeted for reset;
- malformed child JSON is still found through the manifest id list and produces batch-integrity failure;
- filtered result reports zero active rows only when every manifest-selected id is terminal.

### 14.5 CLI tests

- no flags is read-only dry-run;
- enqueue without explicit limit fails before writes;
- invalid/zero/over-max limits fail;
- dry-run works with active writer;
- enqueue refuses active writer before writes;
- enqueue does not require an LLM;
- dry-run uses a true read-only connection, performs no migration, and does not create a missing DB;
- enqueue checks the writer lock before opening a writable connection;
- missing/malformed config and missing/open-failed DB use fixed sanitized codes;
- enqueue returns an opaque manifest receipt only for selected work;
- output schema and counts are stable;
- human and JSON outputs contain no fixture slug/title/body/path/job payload;
- thrown internal error maps to a stable sanitized code/message.

### 14.6 Health and `fsck` tests

- Health emits zero or exactly one aggregate issue;
- aggregate issue uses only stable synthetic identity and scalar counts;
- health-debt classifies it as `needs_review`;
- `fsck` emits the stable check id, warning severity, correct count, and at most five anonymous samples;
- no deterministic repair-plan rule executes it.
- current-success `resolved` counts distinct pages, not historical job rows, and requires a current non-self fact link.

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
- `src/core/ingestion/ner-backfill-contract.ts` (new; shared job name/TTL/repair marker constants, re-exported for compatibility)
- `src/core/ingestion/pipeline.ts`
- `src/core/ingestion/ner-backfill.ts`
- `src/core/maintenance/health.ts`
- `src/core/maintenance/health-debt.ts`
- `src/core/fsck/sqlite-probe.ts`
- `src/cli/commands/zero-link-backfill.ts` (new, isolated safe open/error wiring)
- `src/cli/commands/maintenance.ts` and `src/cli/program.ts` only for `ner-backfill --repair-batch` and command registration
- focused tests under `tests/core/maintenance`, `tests/core/ingestion`, `tests/core/fsck`, and `tests/cli`
- command/help/docs consistency files only if required by existing gates

Changes outside this list require an explicit explanation in the implementation plan. Public API, schema, routing, MCP, or release changes are out of scope and require stopping for a new decision.

## 16. Acceptance criteria

#342 is implementation-complete when:

1. The shared scanner deterministically finds the approved rich zero-link population.
2. Health and `fsck` surface bounded, anonymous, aggregate debt.
3. `cbrain zero-link-backfill` is dry-run by default and enqueue is explicit, bounded, locked, atomic, idempotent, and fail-closed on queue integrity debt.
4. Existing job rows are reused under the state machine; unchanged terminal content is not sent to the LLM repeatedly.
5. Resolved-existing and alias NER outcomes create a candidate mention edge without downgrading trusted data.
6. The manifest-filtered worker mutates only the exact batch, verifies scheduled source bytes before LLM use, and records resolved/no-link/source-changed terminal state from actual evidence.
7. Focused and full verification pass with no privacy leak.
8. An independent adversarial review has no unresolved CRITICAL/HIGH finding.
9. Production batches 5, 20, and 50 complete without a stop condition, or the rollout stops safely with documented scalar evidence and a verified rollback.
10. The branch is pushed and a ready PR references #342; it is not self-merged, tagged, or released.

## 17. Adversarial self-review

Before independent review, the design was attacked against the five most likely failure modes:

1. **A successful NER call still leaves zero links.** Root cause was the missing mention edge for existing/alias resolution. The design fixes that path and classifies the result from actual post-run graph state rather than the NER return object.
2. **Repeated runs spend LLM tokens forever.** The repair marker, fingerprint, terminal no-link outcome, cancelled-state rule, and current-fingerprint failed state make unchanged work non-actionable.
3. **A legacy job or concurrent writer creates duplicates.** Matching safely parses all historical rows, reuses one deterministic row, respects active/current-fingerprint state, refuses a live writer, and rescans under `BEGIN IMMEDIATE`.
4. **Successful repairs disappear from the report.** Current debt and distinct current processed success are separate populations; success still requires a live non-self current-fact edge, so `total` can fall while trustworthy `resolved` rises.
5. **Diagnostics leak private knowledge.** CLI/Health expose scalar-only reports; `fsck` samples pass through existing anonymization; internal slugs/fingerprints remain in SQLite only; errors are stable and sanitized.

These defenses are requirements, not commentary. The independent adversarial reviewer must still verify them against current code and identify any missing state, privacy, or rollback path before implementation starts.

## 18. Independent adversarial review correction record

The first independent review of commit `cf6bf92` returned FAIL with nine HIGH and two MEDIUM findings. This revision resolves them as follows:

1. Marked source-unavailable and invalid terminal paths now preserve repair identity and have complete classifications.
2. Fresh and stale running jobs use the existing 30-minute TTL; stale rows are recovered individually.
3. Marked repair jobs set `max_attempts = 1`, making the first provider failure terminal while legacy retry behavior remains unchanged.
4. Connectivity now requires active-trust + `isCurrentFactLink` + non-self semantics.
5. Historical resolved results are revalidated against the current graph; lost links become review debt.
6. `resolved` counts canonical current-fingerprint distinct pages, never historical job rows.
7. NULL page hashes use a deterministic content-derived SHA-256 when possible; unverifiable pages are not enqueued.
8. Cancellation is scoped to the canonical fingerprint; legacy cancellation is review-only and conflicting active/cancelled state fails closed.
9. Each enqueue receives an opaque manifest receipt, and the consumer validates its exact job-id list instead of processing unrelated NER jobs.
10. Dry-run uses a true read-only SQLite connection and fixed safe config/DB error envelopes; enqueue checks the writer before writable open and uses no unrelated providers.
11. Production backup is the repository full archive; rollback restores DB+vault and explicitly accounts for the worker's non-mutation of Lance.

The same independent reviewer must re-run after this correction commit. Implementation may start only when the reviewer reports no CRITICAL/HIGH findings.

## 19. Second adversarial review correction record

The re-review of commit `5c80cae` still returned FAIL with four HIGH and three MEDIUM findings. This revision closes them as follows:

1. Unavailable fingerprints are represented only as `null`; empty/sentinel values cannot be scheduled.
2. Every pending/running row is treated as live before canonical terminal selection. More than one live row per slug fails closed, regardless of fingerprint.
3. Batch mode bypasses global stale reset and may reset only stale ids listed by its validated manifest.
4. A receipt-addressed manifest stores exact selected job ids, so malformed child JSON cannot disappear from batch status; global queue-integrity validation blocks malformed active/repair rows.
5. Derived fingerprint bytes now use fixed-key JSON, fixed ordering, UTF-8, and full SHA-256 with collision-boundary tests.
6. The worker verifies the scheduled source before LLM use: vault-hash jobs read/hash one file snapshot; derived jobs consume the exact raw chunks used for hashing; drift becomes terminal `source_changed` with zero LLM calls.
7. Every 5/20/50 batch creates and verifies a fresh full backup; no earlier artifact may stand in for the current pre-batch state.
8. Because the branch remains unmerged, production commands run from the exact reviewed clean worktree commit rather than assuming the installed CLI already contains the feature.

The independent reviewer must run a third pass. The gate remains no CRITICAL/HIGH findings.
