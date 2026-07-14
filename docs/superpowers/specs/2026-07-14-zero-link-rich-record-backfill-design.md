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
- A narrow repair-aware projection/mutation guard in the existing MCP job tools so internal batch ownership is neither disclosed nor bypassed.
- A production batch run with backups, stop conditions, and per-batch verification.

### 3.2 Non-goals

- No new LLM provider, prompt, ontology type, or relation type.
- No automatic semantic link invention outside normal NER extraction.
- No always-on worker and no direct LLM call from the scheduling command.
- No automatic deletion, merge, page rewrite, or link promotion.
- No change to recall routing, structured output, or search ranking. Ordinary non-NER MCP job responses retain their current contract; only #342 manifests/owned rows and fail-closed unknown-integrity NER rows receive the protected projection.
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
  sourceKind: "vault_hash" | "raw_chunks" | null;
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
  finalized: boolean;
  integrityConflicts: number;
  selected: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  outcomes: {
    resolved: number;
    terminalNoGraphLinks: number;
    blockedSourceUnavailable: number;
    sourceChanged: number;
    invalidTerminal: number;
  };
}
```

The public JSON field names are exactly the camelCase names shown above. Human output uses fixed Chinese labels for the same counters. Tests lock both surfaces.

`contentFingerprint` is the repair invalidation key:

1. Determine sealed state first: a page is sealed when it owns any `summary_level = 1` chunk, matching existing `isSealedPage` semantics.
2. A sealed page always uses `sourceKind = raw_chunks` and the derived fingerprint below, even when `pages.content_hash` is non-empty. Its vault body is an L1 summary and is never the repair NER input.
3. A non-sealed page with a non-empty `pages.content_hash` uses `sourceKind = vault_hash` and `page:` plus that hash.
4. A page using raw chunks computes a full SHA-256 over the UTF-8 bytes of `JSON.stringify` applied to an object constructed in this exact key order: `{version:1,type,chunks,tags}`. `chunks` is ordered by `(chunk_index, id)` and each object is constructed as `{index,id,content}` in that key order. `tags` is a lexicographically sorted string array. JSON escaping makes delimiter/newline content unambiguous. Prefix the lowercase 64-hex digest with `derived:`.
5. If the selected source cannot provide a page hash or at least one raw chunk, fingerprint and `sourceKind` are both `null`. Classify the current debt as `unverifiable_fingerprint`; do not enqueue it automatically.

`scanRichRecords` returns the source decision with the candidate. Enqueue copies it verbatim and must not re-derive or override source selection. `updated_at`, empty strings, and sentinel fingerprints are forbidden. Only a non-empty `page:` or `derived:` fingerprint with its consistent non-null source kind may enter a repair marker. Non-content metadata can advance timestamps, and timestamp resolution cannot prove body identity. The derived hash is computed internally and never appears in public output.

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
    "batchId": "<random batch UUID>"
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
    "batchId": "<same random batch UUID>"
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
- every row containing this repair marker, regardless of status, must have the exact marker name/version, a valid slug, kind `ner`, a non-empty `page:`/`derived:` fingerprint, consistent source kind, and a syntactically valid batch UUID;
- every marked repair row must reference an existing valid batch manifest that includes its job id.
- every batch manifest must parse with a unique UUID, valid ownership entries, and a valid finalized/unfinalized result; latest ownership must resolve its child as defined in §6.3 even when the child marker itself is missing/corrupt.

Manifest ownership is discovered **before** trusting child JSON. A safely parsed manifest contributes every listed child id to a protected set even when that child's `data` is absent or malformed. Any malformed manifest, duplicate UUID, protected-child mismatch, or unclassifiable live `ner-backfill` row is an integrity conflict.

For each owned slug, the same scan derives a complete finalized repair ledger plus the latest unfinalized ownership. Each finalized ledger entry records manifest row id, child id, frozen fingerprint, terminal status, and recognized graph outcome. Protection is attempt-aware:

- every manifest-owned/marked row is batch-only regardless of id;
- an unmarked `kind = ner` row with `job.id <=` the slug's first manifest row id is a shadowed pre-repair legacy attempt and is excluded from broad retry/reset/snapshot/claim and rejected by generic MCP retry/cancel;
- after repair history exists, unmarked terminal rows (`done`/`failed`/`cancelled`) whose `contentHash` differs from the current page hash are superseded historical attempts: retain read-only, never retry, and do not count as conflicts;
- an old-hash unmarked `pending`/`running` row is a stale live conflict because it could overwrite the current epoch;
- for the current page hash, exactly zero or one unmarked post-repair row may exist. It is a valid current deferred attempt only when its non-empty `contentHash` equals `pages.content_hash`, the shared current source fingerprint exists, and that fingerprint is absent from the complete finalized repair ledger;
- more than one current-hash row, missing-page live work, or otherwise unverifiable live work is an integrity conflict;
- when the current fingerprint already appears in any finalized repair ledger entry, `JobQueueNerSubmitter` dedupes the internal submission. If a race/pre-existing unmarked current-hash row exists anyway, the ordinary worker completes it with fixed `skipped/already_repaired` and zero LLM calls;
- `kind = entity_facts` is outside this NER attempt control and retains its existing lifecycle.

This permits one trusted internal deferred NER for a genuinely unseen content fingerprint after update or delete/recreate, while permanently shadowing pre-repair attempts and preventing a revert to any already-repaired fingerprint from spending LLM again. An active row whose payload cannot be classified is an integrity conflict.

Each invalid row increments only a scalar conflict count; raw job data/error/result is never emitted. Any queue integrity conflict makes enqueue fail closed globally with zero mutations.

A valid row matches a candidate only when `data.slug` equals the candidate slug and kind is absent/`ner`; `entity_facts` is valid queue state but is a different enrichment kind.

`running` freshness uses `NER_BACKFILL_STALE_TTL_MS` (30 minutes). A running row is fresh only when `started_at` parses and is newer than the cutoff. Missing, invalid, or older timestamps are stale.

When the page fingerprint is unavailable, still surface live rows and live/cancellation conflicts because work already exists. If there is no live row, classify `unverifiable_fingerprint` before interpreting historical terminal rows; without a current fingerprint the scheduler cannot prove idempotency and performs no mutation.

Apply this deterministic algorithm:

1. Collect **all live rows** for the slug: every `pending` row and every `running` row, irrespective of fingerprint or freshness. More than one live row is always `stateConflicts`; no lower-id live row may be ignored, and enqueue fails closed.
2. If exactly one live row exists:
   - a marked row must belong to its latest **unfinalized** manifest and is always `active`; stale running also increments `staleRunning`. It is resumed only through that existing batch UUID, never moved into a new batch. A marked live row whose latest manifest claims to be finalized is a queue-integrity conflict.
   - legacy `pending` or fresh legacy `running` → `active`;
   - stale legacy `running` → `stale_requeue` on that same row;
   - when the current fingerprint is unavailable, no new batch is created; existing marked live ownership remains `active`, while stale legacy running is `unverifiable_fingerprint` plus `staleRunning`.
   - if the live row coexists with a current-fingerprint cancellation or unverifiable legacy cancellation, also increment `stateConflicts` and perform no mutation.
3. If there is no live row and the fingerprint is unavailable, classify `unverifiable_fingerprint`.
4. If the current fingerprint matches one or more finalized repair-ledger entries, choose the highest-manifest-id matching entry and use its frozen terminal status/outcome before any ordinary terminal row. `resolved` still requires a current fact non-self link and otherwise becomes `lost_link`; no-link, blocked, source-changed, invalid, failed, and cancelled retain their corresponding classifications. A revert to an older fingerprint therefore reuses historical evidence and never re-enters LLM work.
5. If the current fingerprint is absent from the ledger and there is one validated current-hash post-repair deferred terminal row, that row owns the unseen content epoch: `done` with current zero links → `terminal_no_graph_links`; `failed` → `failed`; `cancelled` → `cancelled`. It is not automatically resubmitted by this repair. A failed row may use existing explicit broad retry because attempt-aware preflight proved it current; a later content change makes it superseded history. More than one row for the current `(slug, contentHash)` is an integrity conflict.
6. Otherwise choose the highest-id marked terminal row whose repair fingerprint equals the current fingerprint. If its latest manifest is unfinalized, classify `active` pending batch finalization and do not reuse it. With a finalized manifest it is the canonical current row:
   - `cancelled` → `cancelled` for this fingerprint only;
   - `failed` → `failed`;
   - `done` + `graphOutcome = terminal_no_graph_links` → `terminal_no_graph_links`;
   - `done` + `graphOutcome = blocked_source_unavailable` → `blocked_source_unavailable`;
   - `done` + `graphOutcome = source_changed` → `source_changed`;
   - `done` + `graphOutcome = invalid_terminal`, missing, malformed, or unknown terminal outcome → `invalid_terminal`;
   - `done` + `graphOutcome = resolved` requires an actual current-fact non-self link. With a current link it contributes one distinct page to `resolved`; without one it is `lost_link`, not resolved and not automatically requeued.
7. If no current-fingerprint row exists, choose the highest-id marked terminal row for an older/different fingerprint. It is `content_changed_requeue` only when its latest manifest is finalized; an unfinalized manifest remains `active` pending finalization. Finalized cancellation is row/fingerprint-scoped, not a permanent page-wide veto.
8. If no marked row exists, choose the highest-id unmarked legacy terminal row:
   - `done` or `failed` → `legacy_requeue`;
   - `cancelled` has no trustworthy fingerprint scope → `cancelled` and needs review; it is never automatically reopened.
9. No matching row → `new`.

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
- `data` contains version, repair name, a random UUID `batchId`, and ordered ownership entries `{jobId, slug, contentFingerprint}` for the selected rows;
- `result` starts as `{finalized:false}`.

The public `batchId` is only the random UUID. Manifest job ids, child job ids, slugs, and fingerprints remain internal. Manifest lookup scans only `zero-link-backfill-batch` rows, parses them safely in TypeScript, and requires exactly one valid matching UUID. Any malformed manifest or duplicate token makes batch processing fail closed; no unguarded `json_extract` is used.

An unfinalized manifest owns its selected rows strictly in both directions: every ownership entry must resolve to a child with the exact job name/slug/fingerprint/batch marker, and every child carrying that batch id must appear once in the manifest. Missing/corrupt/mismatched child data produces `BATCH_INTEGRITY_CONFLICT` and zero claims. Batch status counts rows by manifest-selected id and therefore still sees a pending/running row even if its child JSON is corrupt.

When all selected rows are terminal and integrity checks pass, the batch-filtered worker finalizes the manifest in one transaction. It freezes each internal ownership entry with `terminalStatus` and a recognized `graphOutcome` (or `null` for failed/cancelled), preserving the per-fingerprint ledger even after the child row is reused. The public batch status is derived from a frozen scalar `result` containing only `finalized:true`, repair/manifest version, terminal status counts, graph outcome counts, and completion time. MCP projection never returns manifest `data`; public status contains no slug, fingerprint, title, path, body, child id, or child payload.

Job-row reuse is allowed only when the row's previous manifest exists, validates, and is finalized. Enqueue creates the new unfinalized manifest and changes the child's batch marker atomically. For ownership checks, the highest manifest-row id containing a child id is its latest ownership:

- latest unfinalized ownership requires strict bidirectional child validation;
- every finalized ownership records the child's slug/fingerprint/terminal outcome as an immutable repair-ledger entry. If the latest child row is missing or its data becomes corrupt, global queue integrity uses frozen ownership to classify/block instead of treating the page as new;
- older finalized manifests are historical and do not require the reused child to keep pointing at them.

Querying an older finalized batch returns its frozen result, not the child row's later status and not an integrity error. If a crash leaves every child terminal but the manifest unfinalized, rerunning the same batch consumer processes no terminal rows and finalizes the manifest. A row cannot enter a later batch until this finalization completes.

Selection, manifest creation, receipt generation, rescan, inserts, requeues, and final manifest update run under `BEGIN IMMEDIATE`. This obtains the SQLite write reservation before reading candidate/job state, preventing two concurrent CLI processes from both planning the same rows. On success the command commits; on any error it rolls back. It must never return a partial success count or a manifest without all selected rows.

### 6.4 Failed jobs

Provider errors and timeouts continue through the existing `failJob` behavior. Because marked jobs have `max_attempts = 1`, their first claimed failure becomes `failed`, not `pending`. The repair marker remains in `data`, so the scanner reports the failure without resubmitting it on every run.

The existing broad `cbrain ner-backfill --retry-failed` command must skip every manifest-owned/marked row and every shadowed pre-repair legacy attempt. It may retain normal retry behavior for a valid canonical post-repair deferred attempt and unrelated legacy/ordinary jobs. Current-fingerprint repair failure is terminal for this issue; changed content may create a later batch, but broad retry cannot mutate finalized ownership.

Before an unfiltered Dream/CLI stage performs stale reset, retry, snapshot, or claim, it safely scans all manifests and live `ner-backfill` rows. Every manifest-owned/marked row and shadowed pre-repair attempt is excluded before mutation. A validated canonical unseen-fingerprint deferred attempt enters the ordinary candidate set; a current-hash row whose fingerprint is already in the finalized repair ledger enters a separate `alreadyRepairedIds` set that may only be claimed/completed as fixed `skipped/already_repaired` with zero LLM. Superseded terminal rows are ignored, while superseded live rows conflict. If manifest parsing, ownership validation, or any live-row classification fails, the whole stage returns fixed `QUEUE_INTEGRITY_CONFLICT` with **zero job mutations**, including zero mutations to otherwise ordinary jobs. This preflight is shared by Dream and the CLI so neither path can bypass exclusive batch ownership.

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
- A successful non-empty enqueue returns one random UUID `batchId`; it contains no page identity, internal job id, or user data. Every selected job receives the same `repair.batchId`.
- The command never processes jobs. The operator invokes `cbrain ner-backfill --repair-batch <batchId> --limit <selected> --json` separately while the writer remains stopped. `selected` is the exact scalar returned by enqueue and may be smaller than the requested limit.
- Non-JSON output contains only the same scalar categories and fixed guidance. It must not print candidate titles, slugs, bodies, paths, job payloads, or LLM text.
- JSON errors use stable `status`, `code`, and a sanitized fixed message. No stack trace or raw exception message is emitted.

The existing `ner-backfill` command gains `--repair-batch <uuid>`:

- validate UUID syntax before opening the DB;
- when present, locate the unique safely parsed manifest with that UUID, then snapshot and claim only its selected `ner-backfill` job ids after verifying their complete markers;
- ignore ordinary NER jobs and every `entity_facts` job, regardless of priority;
- do **not** call the existing global `resetStaleJobsForNames` in filtered mode; reset only manifest-selected stale-running rows whose complete marker matches the UUID;
- when `--repair-batch` is absent, run the integrity preflight from §6.4 before mutation; preserve existing behavior for `entity_facts`, unrelated legacy/ordinary NER, and validated canonical post-repair deferred NER only after it passes, while excluding every manifest-owned/marked row and shadowed pre-repair attempt from stale reset, snapshot, claim, and broad `--retry-failed`; marked ownership is processed only through its UUID manifest;
- reject combination with broad `--retry-failed`;
- return scalar per-batch terminal status counts (`pending`, `running`, `done`, `failed`, `cancelled`) after processing so the operator can prove no selected row remains active.
- require the supplied `--limit` to equal the manifest's selected count; callers pass enqueue's returned `selected`, not the earlier requested limit. Mismatch returns fixed `BATCH_LIMIT_MISMATCH` before reset/claim, preventing an apparently successful partial batch.

Filtering is performed by manifest ids plus safe TypeScript JSON parsing, not unguarded SQLite `json_extract`. Manifest/child corruption returns `BATCH_INTEGRITY_CONFLICT`, processes zero rows, and reports the manifest-selected status counts rather than treating corruption as non-membership.

### 8.1 Generic MCP job-tool boundary

The existing unified `job` tool and compatibility aliases must not expose or mutate repair ownership:

- generic `submit` rejects reserved names `zero-link-backfill-batch` and `ner-backfill` with fixed `REPAIR_BATCH_RESERVED`, regardless of payload. Only internal ingestion and the dedicated enqueue transaction may create NER ownership; the public generic queue is not an NER scheduling API;
- `list`/`status` always project `zero-link-backfill-batch` rows to fixed operational fields and scalar finalized/status counts; `data`, raw `result`, and `error` are omitted;
- **every** `ner-backfill` row uses a fixed safe projection with no `data`, raw `result`, `error`, slug, `contentHash`, fingerprint, or provider text. Lifecycle class may add only fixed booleans/enums such as `protectedRepair`/`attemptClass`; projection privacy never depends on manifest validity or attempt eligibility;
- malformed/duplicate manifest still fails ownership mutation closed, but no special privacy fallback is needed because all NER rows are always sanitized;
- generic `cancel` and `retry` reject manifest rows, every manifest-owned/marked child, and every shadowed pre-repair attempt with fixed `REPAIR_BATCH_OWNED`; a validated canonical post-repair deferred row retains ordinary behavior. When manifest integrity is unknown they reject mutation of all `ner-backfill` rows;
- batch-owned cancellation/retry is not added to this issue. The dedicated batch consumer is the only mutation path.

Ordinary non-NER job projection and mutation behavior remain unchanged. Put the ownership/projection predicate in shared deterministic code used by both unified and alias handlers; do not duplicate policy in each handler. Ownership discovery queries all manifest rows directly and must not use the capped default `listJobs()` result.

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

### 8.2 CLI dependency and open order

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
- random non-sensitive repair batch UUID;
- boolean blocked state;
- live owner kind/PID when mutation is refused;
- anonymous `fsck` sample tokens;
- fixed commands and guidance.

Forbidden public output:

- real title, slug, body, chunk content, tag value, filename, vault path, database path, username, email, credential, prompt, LLM response, job `data`, job `result`, provider error, or stack trace.

Internal SQLite job payloads may contain the slug and content hash because the existing worker requires them. Tests and documentation examples must use anonymous fixtures such as `record/item-a` and `entity/item-b`.

The MCP job tools are a public output surface for this boundary. Their repair-aware projection from §8.1 is mandatory; internal storage does not make a field private when `job_list`, `job_status`, or unified `job` can serialize it.

Logs added by this issue must be scalar-only. Existing lower-level logs are not widened by this issue.

## 12. Concurrency and consistency

- Dry-run uses a SQLite read-only connection, runs no migrations, and may execute while serve/watcher is active.
- Enqueue refuses an active writer before opening the mutation transaction.
- Enqueue starts with `BEGIN IMMEDIATE`, then repeats candidate scan and state classification inside the write transaction; it must not reuse a stale plan produced before the lock check.
- All selected job rows are inserted/requeued atomically.
- The existing worker claims each pending job atomically by id.
- Batch-filtered worker validates the UUID manifest, then snapshots and claims only its exact selected ids; unrelated NER and entity-facts rows are outside its candidate set.
- A concurrent job appearing between an external dry-run and enqueue is detected by the transactional rescan and classified `active`.
- The command does not write the vault. The worker may write vault/entity state through the existing pipeline, so it remains subject to the existing writer lock rule.

## 13. Production execution and stop gates

Production repair is authorized for this issue, but must occur only after focused tests, the full suite, privacy scan, and adversarial code review pass.

### 13.1 Preflight

Because the issue forbids self-merge, the installed production CLI does not yet contain these commands. Start a private zsh in the clean, fully reviewed feature worktree and define one entry for every rollout command:

```zsh
export CBRAIN_CONFIG="<private-live-config>"
CBRAIN_RUN=(bun run src/cli/index.ts)
```

Every command below uses `"${CBRAIN_RUN[@]}"`; bare installed `cbrain` is forbidden for this rollout. Fixed reports must not expose the worktree or config path.

1. Require empty staged/unstaged status, record `git rev-parse HEAD`, and record `"${CBRAIN_RUN[@]}" --version`.
2. Stop the active serve/watcher writer and verify the lock probe reports no owner.
3. Create a new mode-0700 private subdirectory with a random UUID component, assert it did not previously exist, then run `"${CBRAIN_RUN[@]}" backup -o <that-private-subdir>` to create the repository-supported full archive.
4. Verify the zip exists, is non-empty, passes `unzip -t`, and contains the configured DB basename plus `vault/`; when the configured Lance path exists, also require `lancedb/` entries. Do not print archive paths in the delivery report.
5. Record a sanitized configuration summary separately; configuration and credentials are not claimed to be restorable from the archive.
6. Run `"${CBRAIN_RUN[@]}" zero-link-backfill --json` and record scalar counts only.
7. Run FK and consistency checks before the first batch.

### 13.2 Per-batch sequence

Run batch sizes in this exact progression: 5, then 20, then 50.

For each batch:

1. Create a fresh mode-0700 private subdirectory with a random UUID component and assert it did not previously exist. Run `"${CBRAIN_RUN[@]}" backup -o <that-private-subdir>` to create a **new** full backup immediately before this batch, verify that newly created artifact, and record its private mapping to batch size and start time. A prior directory/artifact may not be reused as the next batch's pre-batch snapshot.
2. Run `"${CBRAIN_RUN[@]}" zero-link-backfill --enqueue --limit <N> --json` and capture its random `batchId` privately.
3. Assert `0 < selected <= N`, `newJobs + requeuedJobs = selected`, `stateConflicts = 0`, and `queueIntegrityConflicts = 0`. If `selected = 0`, no manifest exists: stop cleanly and do not invoke the consumer.
4. Run `"${CBRAIN_RUN[@]}" ner-backfill --repair-batch <batchId> --limit <selected> --json` using the existing configured provider. This deliberately uses the enqueue response, not requested `N`.
5. Assert this exact manifest reports `finalized = true`, zero integrity conflicts, zero `pending`, and zero `running`; ordinary and stale NER/entity-facts jobs must be unchanged.
6. Re-run dry-run, `fsck`, FK checks, and consistency checks.
7. Record scalar deltas for resolved, terminal-no-link, blocked-source, source-changed, cancelled, invalid-terminal, lost-link, active, actionable, and failed.
8. Proceed only when every stop gate remains clear.

The first requested batch is a canary. At least one of its selected candidates must become `resolved`. If zero resolve—whether the outcomes are all terminal-no-link or a mix of blocked/failed/invalid states—stop before the 20 batch because the repair is not demonstrating useful graph recovery.

### 13.3 Immediate stop conditions

Stop the rollout and do not enqueue the next batch on any of:

- provider error, timeout, or unexpected exception;
- duplicate job creation or any partial transaction;
- duplicate active/state conflict reported by the scanner;
- any queue-integrity or batch-manifest integrity conflict;
- any `sourceChanged > 0`, `cancelled > 0`, `invalidTerminal > 0`, or `blockedSourceUnavailable > 0` in the selected batch;
- zero resolved records in the five-item canary;
- FK violation increase;
- new SQLite/vault/FTS consistency regression;
- public output or logs leaking forbidden private fields;
- writer process detected during mutation;
- mismatch between selected count and inserted/requeued count;
- any selected batch row left pending/running after the batch-filtered consumer returns.

The batch consumer attempts finalization after all selected children are terminal even when their outcomes trigger a stop gate. A provider/error exit does not authorize abandoning an unfinalized manifest: rerun the **same** UUID consumer with the same `selected` limit. It performs no LLM call for terminal children and only finalizes. If `finalized = true`, apply the stop gate and keep later batches stopped. If finalization still cannot complete, classify it as manifest-integrity failure, keep serve/watcher stopped, and restore the current batch's matched backup before any restart.

### 13.4 Rollback

If a batch creates a data or vault consistency regression **while the maintenance window is still closed to all user writes**:

1. Keep serve/watcher stopped.
2. Preserve sanitized diagnostics and scalar counts.
3. Run `"${CBRAIN_RUN[@]}" restore <pre-batch-zip> --force` to restore its matched SQLite + vault snapshot.
4. The NER backfill path in this issue does not call Lance write APIs, so the pre-batch Lance directory remains unchanged and stays matched to the restored source snapshot. If verification detects any unexpected Lance mutation, restore `lancedb/` manually from the same archive while services remain stopped.
5. Re-run FK, `fsck`, and consistency checks, including Lance verification.
6. Restart serve only after the restored state passes the preflight checks.

The authority to restore a pre-batch/preflight archive expires permanently when any writer is reopened. After that point the archive predates possible legitimate ingest/sync/link/job changes and must never be applied wholesale. A guarded-runtime failure after write reopening is handled by stopping all entries and repairing/deploying forward from the current live state; if the guarded code cannot be restored, the service remains stopped until the reviewed/merged runtime is available. There is no fallback to the old runtime or an old full archive after new writes.

If the batch merely produces legitimate `terminal_no_graph_links` outcomes without data corruption, do not restore; those terminal markers prevent repeated LLM spend. Stop the progression if the canary usefulness gate fails.

### 13.5 Restart

Whenever the live DB retains any #342 manifest or marked row—whether rollout completed, stopped after a finalized canary/batch, or retained legitimate terminal-no-link/failed/source outcomes—service recovery must follow this section. It is not limited to an "accepted" final batch:

1. Do **not** restart the installed/pre-merge runtime: it lacks the repair privacy and ownership guards while the live DB now contains repair manifests.
2. Before reopening writes, create a dedicated detached deployment worktree at the final reviewed commit. It is not used for development; require clean status, make tracked source files read-only, and record HEAD plus a tracked-file digest. Every startup and production probe rechecks all three so later dynamic imports cannot silently load drifted code.
3. Enumerate persistent CBrain launch points for Hermes, Codex, Claude, launch agents, shell wrappers, and any other discovered MCP client. Back up their configs privately, then point every entry to either the guarded HTTP endpoint or the exact absolute command in the detached deployment worktree. Assert `CBRAIN_UNSAFE_ALLOW_MULTI_WRITER` is absent from process and persistent environments.
4. Start every serve/MCP entry from the detached guarded commit. Privately verify process command, working directory, recorded HEAD/digest, and config identity; `serverInfo.version` alone is insufficient because two commits may share a version.
5. Prove persistence, not only the current process: smoke each configured client entrypoint; verify the old installed command cannot acquire the writer while guarded serve is active; restart the guarded process once and prove clients reconnect to the same guarded path rather than auto-spawning the installed runtime.
6. Verify `/health`, a read-only CBrain query, and zero pending/running repair jobs from executed batches.
7. Through the live guarded MCP, exercise unified `job` list/status and compatibility `job_list`/`job_status`. A local shape probe must assert that every manifest/protected row lacks `data`, raw `result`, `error`, slug, and fingerprint and print only scalar PASS/FAIL—not the response bodies.
8. Only after steps 2–7 pass may user writes reopen. At that instant the full-backup rollback authority expires as defined in §13.4.
9. Keep the detached guarded runtime and rewritten persistent entrypoints active until the PR is merged and deployed to the normal service entry. If any entrypoint cannot be proven guarded, do not reopen writes.
10. After merge/deploy, restore normal entrypoints to a runtime containing the same guards, then retain backups until post-run checks remain stable. Do not delete the detached worktree while any config points to it.

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
- sealed page with non-null page hash still selects `raw_chunks`/derived fingerprint; non-sealed equivalent selects `vault_hash`;
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
- manifest UUID and ownership list are atomic; missing/corrupt manifest or child marker fails closed;
- batch A finalizes, the same row is legally requeued into batch B after content change, batch A still returns frozen audit counts, and batch B validates/consumes normally;
- unfinalized child corruption blocks globally; latest finalized child corruption is associated through frozen ownership and cannot make the same fingerprint look new;
- a child cannot be requeued while its previous manifest remains unfinalized;
- malformed manifest, corrupt manifest-owned pending child, and corrupt manifest-owned stale-running child each make Dream, ordinary CLI, and broad retry return an integrity error with every job row byte-for-byte unchanged;
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
- sealed repair with non-null page hash sends raw chunks, never vault L1 summary, to the LLM;
- vault/raw source drift after enqueue completes `source_changed` with zero LLM calls;
- batch-filtered consumer processes only the exact repair batch and leaves ordinary NER/entity-facts jobs untouched;
- filtered mode leaves unrelated stale NER and stale entity-facts rows byte-for-byte unchanged;
- same-batch stale row is the only row targeted for reset;
- unfiltered Dream/CLI stale reset, snapshot, claim, and `--retry-failed` leave every marked repair row unchanged while ordinary jobs retain existing behavior;
- unfiltered preflight derives protected ids from manifests before parsing child data; corrupt owned children are never reset, claimed, retried, or completed by ordinary workers;
- finalized repair plus a lower-id legacy failed row for the same controlled slug leaves that legacy row byte-for-byte unchanged under broad retry and unfiltered processing, with zero LLM calls;
- a higher-id internal deferred NER whose current page hash matches and whose source fingerprint is absent from the finalized ledger is processed exactly once; same-ledger fingerprint is skipped with zero LLM, while missing-page live and duplicate-current rows fail closed;
- F1 repair → F2 post-repair `done`/`failed`/`cancelled` → F3 deferred treats each F2 terminal as superseded history, permits J3 once, and refuses retry of J2; an F2 pending/running row at F3 is a conflict;
- F1 repair → F2 repair → revert F1 reuses F1's frozen resolved/no-link/failed/cancelled outcome with zero LLM; a historical resolved entry without a current link is `lost_link`;
- deleting and recreating a slug with changed content permits one new internal deferred NER instead of inheriting permanent repair starvation;
- `entity_facts` rows sharing a slug with repair history retain ordinary reset/claim/retry behavior;
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
- enqueue returns a random UUID only for selected work;
- enqueue returning fewer rows than requested instructs and accepts consumer `--limit <selected>`; using the requested limit fails before mutation;
- output schema and counts are stable;
- human and JSON outputs contain no fixture slug/title/body/path/job payload;
- thrown internal error maps to a stable sanitized code/message.

### 14.6 MCP job-tool tests

- manifest list/status and unified equivalents omit `data`, raw `result`, `error`, slug, and fingerprint while preserving fixed operational scalars;
- every `ner-backfill` row—including validated post-repair deferred and unrelated ordinary NER—uses the safe projection in unified and alias list/status;
- malformed/duplicate manifest cannot change NER projection privacy and still blocks protected mutations;
- generic retry/cancel and unified equivalents return fixed `REPAIR_BATCH_OWNED` for manifest, owned child, marked child, and shadowed pre-repair legacy row without changing bytes; a validated post-repair deferred failed row retains ordinary retry;
- generic submit and unified submit reject both reserved names `zero-link-backfill-batch` and `ner-backfill` with fixed `REPAIR_BATCH_RESERVED` and zero writes, regardless of payload;
- unknown manifest integrity rejects generic mutation of every `ner-backfill` row but does not change ordinary non-NER job behavior;
- fixtures assert no private sentinel appears in any returned JSON.

### 14.7 Health and `fsck` tests

- Health emits zero or exactly one aggregate issue;
- aggregate issue uses only stable synthetic identity and scalar counts;
- health-debt classifies it as `needs_review`;
- `fsck` emits the stable check id, warning severity, correct count, and at most five anonymous samples;
- no deterministic repair-plan rule executes it.
- current-success `resolved` counts distinct pages, not historical job rows, and requires a current non-self fact link.

### 14.8 Final gates

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
- `src/mcp/tools/jobs.ts` only for the repair-aware safe projection and generic mutation guard
- focused tests under `tests/core/maintenance`, `tests/core/ingestion`, `tests/core/fsck`, `tests/cli`, and `tests/mcp`
- command/help/docs consistency files only if required by existing gates

Changes outside this list require an explicit explanation in the implementation plan. Schema, routing, unrelated MCP, or release changes are out of scope and require stopping for a new decision. The repair-specific MCP boundary above was added only because the fourth adversarial review proved that the pre-existing raw job projection would expose new manifest ownership.

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
9. Each enqueue receives a random batch UUID, and the consumer validates its exact manifest ownership list instead of processing unrelated NER jobs.
10. Dry-run uses a true read-only SQLite connection and fixed safe config/DB error envelopes; enqueue checks the writer before writable open and uses no unrelated providers.
11. Production backup is the repository full archive; rollback restores DB+vault and explicitly accounts for the worker's non-mutation of Lance.

The same independent reviewer must re-run after this correction commit. Implementation may start only when the reviewer reports no CRITICAL/HIGH findings.

## 19. Second adversarial review correction record

The re-review of commit `5c80cae` still returned FAIL with four HIGH and three MEDIUM findings. This revision closes them as follows:

1. Unavailable fingerprints are represented only as `null`; empty/sentinel values cannot be scheduled.
2. Every pending/running row is treated as live before canonical terminal selection. More than one live row per slug fails closed, regardless of fingerprint.
3. Batch mode bypasses global stale reset and may reset only stale ids listed by its validated manifest.
4. A UUID-addressed manifest stores exact selected ownership, so malformed child JSON cannot disappear from batch status; global queue-integrity validation blocks malformed active/repair rows.
5. Derived fingerprint bytes now use fixed-key JSON, fixed ordering, UTF-8, and full SHA-256 with collision-boundary tests.
6. The worker verifies the scheduled source before LLM use: vault-hash jobs read/hash one file snapshot; derived jobs consume the exact raw chunks used for hashing; drift becomes terminal `source_changed` with zero LLM calls.
7. Every 5/20/50 batch creates and verifies a fresh full backup; no earlier artifact may stand in for the current pre-batch state.
8. Because the branch remains unmerged, production commands run from the exact reviewed clean worktree commit rather than assuming the installed CLI already contains the feature.

The independent reviewer must run a third pass. The gate remains no CRITICAL/HIGH findings.

## 20. Third adversarial review correction record

The third review still returned FAIL with two new HIGH and three MEDIUM findings. This revision closes them as follows:

1. Source choice is sealed-first: sealed pages always carry `raw_chunks` + derived fingerprint even when a page hash exists; the worker receives raw chunks, never the vault L1 summary.
2. Manifests now have explicit ownership/finalization semantics. Unfinalized batches validate children bidirectionally; completion freezes scalar outcomes; a child may be reused only after finalization; old UUID queries return frozen results.
3. Finalized ownership entries retain internal job id/slug/fingerprint, so latest-child corruption cannot erase prior same-fingerprint ownership and silently create a new attempt.
4. Public `batchId` is a random UUID found by safe manifest scanning. Internal manifest/child ids are not exposed.
5. Production stops on source drift, cancellation, invalid terminal, or blocked source and records those scalar deltas.
6. All rollout commands use the same `CBRAIN_RUN` array from the reviewed clean feature worktree; bare installed `cbrain` is forbidden before merge.

The independent reviewer must run a fourth pass. The gate remains no CRITICAL/HIGH findings.

## 21. Fourth adversarial review correction record

The fourth review returned FAIL with three HIGH and three MEDIUM findings. This revision closes all six rather than deferring the medium-risk bypasses:

1. Unfiltered Dream/CLI computes manifest-owned protected ids before trusting child JSON. Malformed ownership or an unclassifiable live row blocks the entire stage before stale reset, retry, snapshot, or claim.
2. MCP unified/alias job tools use a repair-aware safe projection. Manifest/owned rows never expose raw payloads, and unknown manifest integrity sanitizes every NER row for that response.
3. Generic MCP submit reserves both manifest and NER names; cancel/retry cannot mutate manifest, owned repair rows, or any legacy row for a controlled slug. The dedicated UUID consumer is the only batch mutation path.
4. Short enqueue batches are legal and the consumer uses the returned `selected` count, not the requested upper bound.
5. Terminal children are finalized even when their outcomes trigger a rollout stop. An interrupted finalization is recovered with the same UUID and zero extra LLM calls or rolled back before restart.
6. Every preflight and per-batch backup uses a newly created private mode-0700 UUID subdirectory, eliminating timestamp-name collision ambiguity.

The independent reviewer must run a fifth pass. The gate remains no CRITICAL/HIGH findings.

## 22. Fifth adversarial review correction record

The fifth review returned FAIL with three HIGH findings. This revision closes each bypass:

1. Ownership now derives a slug-level control set as well as job ids. Lower-id legacy rows for a controlled slug cannot be retried, reset, claimed, cancelled, or exposed as raw job payloads.
2. Generic MCP submit reserves the entire `ner-backfill` name, not only recognizable repair markers, so an Agent cannot create a same-slug unmarked duplicate or malformed queue blocker.
3. The production restart gate forbids the old pre-merge runtime. All live serve/MCP entries must remain on the exact reviewed guarded commit, proven by process command/cwd/HEAD and live unified+alias projection probes, until merge/deploy. This revision originally allowed preflight rollback before an old-runtime fallback; §23 supersedes that once writes reopen because later data must not be discarded.

The independent reviewer must run a sixth pass. The gate remains no CRITICAL/HIGH findings.

## 23. Sixth adversarial review correction record

The sixth review returned FAIL with three HIGH and one MEDIUM finding. This revision closes all four:

1. Permanent slug locking is replaced by attempt-aware control: manifest/marked rows and pre-manifest legacy attempts stay protected, while one higher-id internal deferred NER is allowed only for provably current, changed content. Delete/recreate and `entity_facts` are explicitly covered.
2. Full-archive rollback is legal only while the maintenance window remains write-closed. Once user writes reopen, fallback is forward repair/deploy with services stopped; an older full snapshot can never overwrite later legitimate writes.
3. Before reopening writes, every persistent MCP/client/launch entrypoint is rewritten to a guarded detached deployment worktree, unsafe multi-writer override is prohibited, and a restart/reconnect smoke proves no old binary can auto-spawn.
4. The deployment worktree is detached, clean, tracked-source read-only, and digest-checked at startup/probe time so recorded HEAD cannot mask filesystem drift or late dynamic imports.

The independent reviewer must run a seventh pass. The gate remains no CRITICAL/HIGH findings.

## 24. Seventh adversarial review correction record

The seventh review returned FAIL with three HIGH and one MEDIUM finding. This revision closes them:

1. Attempt control now retains a complete finalized per-fingerprint ledger, not only the latest manifest. Reverting F1 after F2 reuses F1's frozen outcome with zero LLM.
2. Superseded post-repair terminal rows are historical and non-blocking/non-retryable; only old-hash live rows conflict. A new unseen F3 epoch can therefore proceed once after F2 terminal state.
3. All NER job list/status responses use the safe projection, including legitimate post-repair deferred rows. Eligibility affects mutation, never privacy.
4. Guarded restart applies whenever any repair metadata remains in the live DB, including a stopped/unaccepted but finalized canary or batch.

The independent reviewer must run an eighth pass. The gate remains no CRITICAL/HIGH findings.
