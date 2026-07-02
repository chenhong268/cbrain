# Defer NER Extraction Out of Synchronous Write Path — Design

- **Issue**: #252
- **Date**: 2026-06-30
- **Status**: Design (pending implementation)
- **Related**: #228 (roadmap), must land before #251 / #236

---

## 1. Background & Problem

CBrain runs LLM-backed NER **synchronously** inside the ingest write path. The
call sequence in `IngestManager.ingestCore()` (`src/core/ingestion/ingest.ts:360-486`) is:

```
validate → embed → page create/update → chunks/FTS/vectors (ContentPipeline)
         → wikilinks/links → [BLOCKING] pipeline.processNer() → applyExtraction
```

`pipeline.processNer()` (`src/core/ingestion/pipeline.ts:252-270`) `await`s
`NerEngine.extract()`. Recent fixes (#229) added a 60s timeout + fail-open, so a
slow/hung LLM no longer hard-fails ingest. But the write path **still pays NER
latency and API cost synchronously** on every capture.

For daily Agent use the dominant guarantee is: **store, index, make searchable —
fast**. Entity-graph enrichment can lag by a maintenance cycle.

## 2. Goal

Move LLM NER out of the synchronous default write path when deferred mode is
enabled. Ingest must return after deterministic storage/indexing/link work,
leaving a **durable** pending marker that a **bounded** maintenance processor
consumes later.

## 3. Non-goals

- No NER prompt rewrite.
- No LLM-free NER replacement.
- No schema-heavy new scheduler (reuse what exists).
- No recall/ranking change.
- No automatic entity merge.
- No removal of `skipNer`.
- No bypass of `ContentPipeline` as the single write/index point.
- No change to slug / file path / ontology / vault directory behavior.
- No private examples in tests or docs (anonymous fixtures only).

## 4. Design decisions

Three core decisions (confirmed in design review), plus six hardening
requirements that **must** be reflected in the plan to avoid known foot-guns.

### 4.1 Core decisions

| Decision | Choice |
|:---|:---|
| **Default NER mode** | `sync` (unchanged behavior). `defer` / `off` are opt-in via `CBRAIN_INGEST_NER_MODE` env, `cbrain.json` `ner.ingest_mode`, or per-call override. Flipping the default is explicitly **out of scope**. |
| **Pending marker** | Reuse the existing `jobs` table. Job name `ner-backfill`, `data = { slug, contentHash?, pageType? }`. Durable + retry/status/attempts come for free. |
| **Processor** | A new Dream stage (1.5) is the **only** consumer. Bounded `maxItems` per run. |

### 4.2 Hardening requirements (非 negotiate‑able)

These six points came out of design review; the implementation plan must address
each explicitly.

1. **Default stays `sync`.** `defer` / `off` opt-in only. `skipNer=true`
   overrides **all** modes (no sync NER, no pending marker).

2. **Pending-marker dedup.** Repeated ingest/update of the same slug must not
   insert unbounded `ner-backfill` jobs.
   - Before submit, check for an existing `pending`/`running` `ner-backfill`
     job with the same `slug` in `data`; if present, **skip** the submit.
   - If the content hash changed, the implementation **may** update existing
     job `data` or submit a new job — but either path needs an explicit test.
   - Minimum viable: query pending/running by slug, skip if exists.

3. **Dream stage position = 1.5** (after sync, before enrich). NER produces
   stubs / links / timeline that `enrich`, `learn`, and `stub_enrich` consume.
   Must update:
   - `DreamReport.stages` gains a `ner_backfill` field;
   - the **locked-skip** default report (`dream.ts:93-115`) fills the default;
   - the **final** report (`dream.ts:363-385`) fills the real counts;
   - `buildBrief` + the dream-report markdown table surface a line when nonzero.

4. **`IngestManager` must not depend on the full `JobQueue.work()` lifecycle.**
   `buildContext` (`src/mcp/context.ts:78/81`) constructs `ingest` **before**
   `jobs`, so the submitter is injected as a minimal interface, not the whole
   `JobQueue`:

   ```ts
   type DeferredNerSubmitter = {
     /** Returns job id, or null if deduped (pending/running job for slug exists). */
     submitDeferredNer(input: { slug: string; contentHash?: string; pageType?: string }): number | null;
   };
   ```

   Both construction sites — `src/mcp/context.ts:78` and
   `src/cli/commands/content.ts:24` — must wire the submitter. The CLI path
   uses the same config default.

5. **Do NOT register `ner-backfill` as an always-on MCP worker handler.**
   `ctx.jobs.start()` (`src/mcp/server.ts`) must **not** pick up `ner-backfill`.
   The Dream stage claims these jobs directly via the DB/job API. Rationale:
   an always-on worker would turn deferred NER into "real-time consumption",
   defeating the bounded-maintenance intent and racing Dream's lock. The
   `JobQueue.work()` loop already scopes to registered handler names only
   (`jobs.ts:44-48`), so simply never registering `ner-backfill` is sufficient.

6. **Sealed-page body fallback is in-spec, not deferred to plan.** When the
   Dream processor consumes a `ner-backfill` job, the page may already be
   sealed (its body is the L1 summary, not the original). The body source:
   1. current page body (vault frontmatter-stripped body);
   2. if sealed **or** body is empty/short, fall back to concatenating
      `summary_level = 0` raw chunks (`sqlite.ts:2162`,
      `getChunksByPage(slug, { summaryLevel: 0 })`);
   3. if no raw chunks exist either, **fail the job with a clear reason** —
      do not run NER on empty/summary-only content.
   Must have a test: sealed page with raw chunks available → processor
   reconstructs body from raw chunks and produces entities.

### 4.3 Review-driven hardening (spec amend)

Four issues raised in #252 spec review. All four are addressed in §5 and the
test matrix; listed here so the implementation plan cannot miss them.

7. **Stale `running` recovery (HIGH 1).** A `ner-backfill` job left `running` by
   a crashed Dream must be recoverable, not permanent. Dedup must treat stale
   `running` as inactive. See §5.4 (active definition) + §5.5
   (`resetStaleJobsForNames`, 30-min TTL).

8. **No retry starvation in one Dream run (HIGH 2).** A failing job is attempted
   **at most once per Dream stage**; remaining attempts wait for the next cycle.
   No claim→fail→claim loop on the same id. See §5.5 (`snapshotEligibleJobIds`
   + `claimJobById`).

9. **Do not overload `IngestResult.ner` (HIGH 3).** `ner` stays
   `NerPipelineResult | null`; defer sets `ner = null` + a separate `nerPending?
   : boolean`. `format-result.ts` needs no change. See §5.4.

10. **`defer` without submitter fails fast (MEDIUM).** No silent degrade-to-sync
    in production. Construction throws if `defer` and no submitter; tests may
    omit the submitter only in `sync`/`off`. See §5.3.

## 5. Detailed design

### 5.1 Config & env

`src/cli/context.ts`:

- Extend `CBrainConfig.ner` with `ingest_mode?: "sync" | "defer" | "off"`.
- In `createDeps()` / config load, resolve effective mode with precedence:
  `process.env.CBRAIN_INGEST_NER_MODE` > `config.ner.ingest_mode` > `"sync"`.
  Validate the value; invalid → fall back to `"sync"` + warn (do not throw —
  config errors must not break ingest).
- Expose the resolved mode so both `buildContext` and the CLI ingest path can
  inject it into `IngestManager`.

### 5.2 NER mode resolution (ingest side)

Effective mode per ingest call:

```
skipNer === true           → NO_NER_NO_MARKER   (overrides everything; acceptance #5)
effective mode = "off"     → NO_NER_NO_MARKER
effective mode = "sync"    → SYNC_NER           (current behavior, unchanged)
effective mode = "defer"   → DEFER_NER          (no await; submit job; ner=null, nerPending=true)
```

Implementation site: the NER gate in `ingestCore()` (`ingest.ts:428-437`) and
the parallel gate in `ingestEntityAppend()` (`ingest.ts:288-297`). The existing
type guard (`!type.startsWith("entity/"|"concept/"|"insight/")`) still applies
in all modes — derived page types never NER and never get a marker.

### 5.3 `DeferredNerSubmitter` injection

- Define `DeferredNerSubmitter` (above) in `src/core/ingestion/ingest.ts` (or a small
  adjacent types file) — keep `ingest.ts` focused.
- `IngestManager` constructor gains two params: the resolved default `nerMode`
  and a `deferredNerSubmitter?`.
- **`defer` without a submitter must NOT silently degrade to sync** (review
  MEDIUM): that hides wiring bugs and reintroduces the synchronous LLM latency
  #252 removes. Production paths (`buildContext`, CLI ingest) wire the submitter
  whenever effective mode is `defer`; if construction sees `defer` with no
  submitter it **fails fast** (throws during construction/config validation).
  Tests may construct `IngestManager` without a submitter **only** when mode is
  `sync` or `off`.
- Adapter: a thin `JobQueueNerSubmitter implements DeferredNerSubmitter` wraps
  `JobQueue` + the dedup query. Lives next to `jobs.ts` or `context.ts`.

### 5.4 Pending marker (jobs table) + dedup

- `submitDeferredNer({ slug, contentHash?, pageType? })`:
  1. Query existing `ner-backfill` jobs for this slug via a focused DB helper
     `findActiveNerJobs(slug)` using `json_extract(data, '$.slug')` (SQLite
     JSON1). **"Active"** = `status = 'pending'` **or** (`status = 'running'`
     **and not stale** — stale defined in §5.5). A stale `running` job does
     **not** count as active; it must never permanently suppress new work
     (review HIGH 1).
  2. If an active job exists → return `null` (deduped). The submit path never
     mutates a running job.
  3. Else → `jobs.submit("ner-backfill", { slug, contentHash?, pageType? })`,
     return job id.
- Job `data` shape (stable contract for the processor):
  `{ slug: string; contentHash?: string; pageType?: string }`.
- **Ingest return contract (review HIGH 3):** `IngestResult.ner` stays
  `NerPipelineResult | null` — defer mode sets `ner = null` (no extraction ran
  synchronously). The pending signal is a **separate** field `nerPending?:
  boolean` (defer → `true`); existing `nerSkipped` is unchanged.
  `format-result.ts` already gates the NER block on `result.ner != null`, so a
  defer ingest renders no NER line — user-facing display stays quiet with **zero
  formatter changes**.

### 5.5 Dream stage 1.5 processor

New stage in `runDream()` (`src/core/maintenance/dream.ts`), placed after Stage 1 (sync)
and before Stage 2 (enrich). Two review-driven invariants shape the loop:

- **HIGH 1 — stale `running` recovery.** If Dream crashes mid-job, the
  `ner-backfill` job stays `running` forever and (per §5.4 dedup) would block
  the slug permanently. `claimJobForNames` only claims `pending`
  (`sqlite.ts:1269`) and `retryJob` only resets `failed` (`:1349`), so neither
  recovers stale `running`. Before claiming, the stage resets stale `running`
  `ner-backfill` jobs back to `pending`. **Stale** = `started_at` older than a
  bounded TTL (default **30 min**, aligned with the Dream lock TTL
  `dream.ts:55`). Via a focused DB helper `resetStaleJobsForNames(names,
  ttlMs)`.
- **HIGH 2 — no in-run retry starvation.** `failJob()` (`sqlite.ts:1305-1311`)
  sets a failed job back to `pending` when `attempts < max_attempts`, and
  claiming increments `attempts` (`:1259`). A naive claim→fail→claim loop would
  re-claim the same job immediately (still the oldest pending) and burn all
  retries in one Dream run, starving later jobs. The stage therefore
  **snapshots** the eligible pending job ids once at start and processes each id
  **at most once** this run; a job that fails now stays pending until the *next*
  Dream cycle, which also spaces out retries naturally.

```
stage 1.5 / ner-backfill:
  // (a) recover stale running from a crashed previous Dream (HIGH 1)
  db.resetStaleJobsForNames(["ner-backfill"], STALE_TTL_MS)

  // (b) snapshot eligible ids ONCE — each processed at most once this run (HIGH 2)
  ids = db.snapshotEligibleJobIds(["ner-backfill"], maxItems)  // pending only,
                                                              // ORDER BY priority,id
  processed = 0; failed = 0; timed_out = 0; skipped = 0
  for id in ids:
      job = db.claimJobById(id)                  // null if no longer pending (race-safe)
      if !job: continue
      slug = JSON.parse(job.data).slug
      resolved = resolveNerBody(pages, db, slug)                 // §5.6
      if !resolved:
          db.failJob(id, "no usable body (sealed/no raw chunks)"); failed++; continue
      try:
          pipeline.processNer(slug, resolved.body, resolved.type, …)   // reuse existing
          db.completeJob(id); processed++
      catch e if isNerTimeoutError(e):
          db.failJob(id, "NER_TIMEOUT"); timed_out++     // retryable next Dream run
      catch e:
          db.failJob(id, msg); failed++
  onStageProgress("ner_backfill", { processed, failed, timed_out, skipped })
```

- `maxItems` default **50** (bounded per run; overflow waits for the next cycle).
- Reuses `pipeline.processNer` → existing `applyExtraction` (stubs, links,
  timeline, facts). Zero new NER logic.
- **New focused DB helpers** (`sqlite.ts` job section):
  - `resetStaleJobsForNames(names, ttlMs)` — `UPDATE jobs SET status='pending',
    started_at=NULL WHERE name IN (…) AND status='running' AND started_at <
    datetime('now','-$ttlMs seconds')`.
  - `snapshotEligibleJobIds(names, limit)` — `SELECT id FROM jobs WHERE
    status='pending' AND name IN (…) ORDER BY priority DESC, id ASC LIMIT ?`.
  - `claimJobById(id)` — claims a specific id (`status='running'`,
    `attempts+1`, `started_at=now`); returns null if the row is no longer
    pending (race-safe; also lets the snapshot skip ids claimed by another
    process).
- **No** handler registered with `ctx.jobs` for `ner-backfill` (§4.2 #5) — the
  always-on `JobQueue.work()` loop never touches these jobs.

### 5.6 Sealed-page body fallback (`resolveNerBody`)

The DB `pages` table stores **no body** — content lives in the vault file
(`file_path`), and after sealing the vault body may be the L1 summary, not the
original. So the body source is resolved explicitly:

```
resolveNerBody(pages, db, slug): { body: string; type: string } | null
  page = db.getPage(slug)
  if !page: return null
  type = page.type                                    // authoritative current type
                                                     // (NER may have flipped it)
  if isSealedPage(slug):                              // vault body is the summary
      raw = db.getChunksByPage(slug, { summaryLevel: 0 })
      if raw.length > 0: return { body: raw.map(c => c.content).join("\n\n"), type }
      return null                                     // → job fails, clear reason
  body = pages.readBody(slug)                         // vault file via file_path,
                                                     // frontmatter stripped
  if body.trim(): return { body, type }
  // not sealed but vault body empty → last resort raw chunks
  raw = db.getChunksByPage(slug, { summaryLevel: 0 })
  return raw.length > 0 ? { body: raw.map(c => c.content).join("\n\n"), type } : null
```

- `isSealedPage` (`sqlite.ts:2087-2090`) = page owns an L1 summary chunk.
- `pages.readBody(slug)` is the existing `PageManager` body-read path (vault
  file + frontmatter strip); if no such method exists, the plan adds a thin one
  rather than re-implementing frontmatter parsing inline.
- `type` comes from the current page row, **not** from `job.data.pageType`
  (which is only a hint captured at submit time).
- For entity-append path, the processor re-NERs the resolved current body;
  exact byte-equality with the original append is not required (non-goal).

### 5.7 `DreamReport` changes

- Add to `DreamReport.stages` interface (`dream.ts:30-52`):
  `ner_backfill: { processed: number; failed: number; timed_out: number; skipped: number }`.
- Locked-skip default report (`dream.ts:93-115`):
  `ner_backfill: { processed: 0, failed: 0, timed_out: 0, skipped: 0 }`.
- Final report (`dream.ts:363-385`): fill real counts.
- `buildBrief`: append one line when `processed + failed + timed_out > 0`, e.g.
  `NER backfill: {processed} 页补抽, {failed} 失败, {timed_out} 超时`.
- Dream-report markdown table (`dream.ts:397-412`): add a `| NER Backfill | … |`
  row.

### 5.8 MCP & CLI surface

- **MCP ingest tool** (`src/mcp/tools/ingest.ts:31-39`): add optional
  `nerMode: z.enum(["sync","defer","off"]).optional()`. Optional + no default
  means callers that omit it get the config/env default; zero breakage. The
  tool description (Chinese) notes the override exists but is rarely needed.
- **CLI** (`src/cli/commands/content.ts`): add optional
  `--ner-mode <sync|defer|off>` flag (Commander). Default = config/env. The CLI
  ingest path also wires the `DeferredNerSubmitter` so defer works there too.

## 6. Error handling & safety

- **defer ingest never introduces a new async failure surface.** Submitting the
  job is a local DB write. If the DB is down, ingest fails for its normal
  reasons (page write itself fails) — no fire-and-forget promise, no untracked
  background LLM call (explicit reject criterion in the issue).
- **Processor failures never corrupt page/index.** Page/chunks/FTS/vectors are
  committed during ingest; NER only *appends* stubs/links/timeline. Timeout /
  error → `failJob` (attempts++). When `attempts >= max_attempts`, the job lands
  in terminal `failed` state + an `ingest_log` entry; it does **not** retry
  forever (bounded noise).
- **Crash-safe via stale-running recovery.** A Dream crash mid-job leaves the
  job `running`; the next Dream run resets stale `running` back to `pending`
  (§5.5), so no slug is permanently stuck and dedup (§5.4) never blocks on a
  dead job.
- **Retries are bounded per cycle.** A failing job is attempted at most once per
  Dream run (§5.5 snapshot); attempts are not burned down in a single run.
- **Dedup prevents job storms** on repeated updates of the same slug.
- **Sealed-body fallback prevents empty-input NER** (would produce junk
  entities); missing body → clear fail, no extraction.

## 7. Test matrix (anonymous fixtures only)

| # | Assertion | Mode |
|:--|:---|:---|
| 1 | Ingest returns before `NerEngine.extract` is called (mock LLM counts `chat`) | defer |
| 2 | Ingest writes a `ner-backfill` pending job with `{ slug, … }` | defer |
| 3 | Raw content is searchable (FTS / chunks / vectors written) once ingest returns | defer |
| 4 | Existing sync behavior unchanged (current ingest NER tests still pass) | sync |
| 5 | `skipNer=true` → no NER, no pending marker, in **every** mode | all |
| 6 | `off` → no NER, no pending marker | off |
| 7 | Repeated defer-ingest of same slug → only one pending job (dedup) | defer |
| 8 | Dream processor consumes pending job → produces anonymous entity/link | defer→dream |
| 9 | Successful processing → job `done` (marker cleared) | defer→dream |
| 10 | Processor hits timeout → `failJob` (retryable), page/index intact | defer→dream |
| 11 | Processor hits error → `failJob`, attempts++, terminal `failed` after max | defer→dream |
| 12 | Sealed page with raw chunks → processor reconstructs body, produces entities | defer→dream |
| 13 | No usable body (sealed, no raw chunks) → job fails with clear reason, no NER | defer→dream |
| 14 | Existing NER timeout tests still pass (#229 regression) | sync |
| 15 | Stale `running` `ner-backfill` (`started_at` > TTL) → Dream resets to `pending` and processes it | defer→dream |
| 16 | Fresh `running` same slug → submit still dedupes (counts as active) | defer |
| 17 | A failing job is attempted **at most once** per Dream run; another pending job in the same snapshot still gets processed; attempts not exhausted in one run | defer→dream |
| 18 | Defer ingest returns `ner = null`, `nerPending = true`; `format-result` renders no NER line (existing formatter behavior unchanged) | defer |
| 19 | `buildContext` + CLI ingest wire the submitter under `defer`; constructing `IngestManager` with `defer` and no submitter throws | wiring |

Add to `tests/core/ingest.test.ts` (defer/skipNer/off/dedup/return-contract/wiring) and a new focused
`tests/core/ner-backfill.test.ts` (processor + sealed fallback). Mock LLM via
the existing `createMockLLM` sequential-response pattern.

## 8. Out-of-scope / explicitly unchanged

- Slug, file path, ontology, vault directory behavior (acceptance #11).
- `ContentPipeline` remains the single write/index point.
- `skipNer` semantics.
- NER prompt.
- Recall / ranking.

## 9. Verification

```bash
bun test tests/core/ingest.test.ts tests/core/ner-backfill.test.ts
bun test tests/core/ner.test.ts tests/core/ner-timeout.test.ts 2>/dev/null || true
bun run lint
# before final commit, if practical:
bun run check
```

If `bun run check` is impractical, report exactly which focused gates ran and
why full check was deferred.

## 10. Implementation footprint (reference)

| What | File | Anchor |
|:---|:---|:---|
| Config field + env override | `src/cli/context.ts` | `CBrainConfig.ner`, `createDeps` |
| NER gate (sync/defer/off) | `src/core/ingestion/ingest.ts` | `ingestCore:428-437`, `ingestEntityAppend:288-297` |
| `IngestInput.nerMode` + constructor | `src/core/ingestion/ingest.ts` | `:81-128` |
| `DeferredNerSubmitter` + adapter | `src/core/ingestion/ingest.ts` / `src/mcp/context.ts` | new |
| Dedup query | `src/storage/sqlite.ts` | new `findPendingJobsBySlug` (json_extract) |
| submit / claim / complete / fail | `src/storage/sqlite.ts` | `:1245-1313` (exist) |
| Dream stage 1.5 | `src/core/maintenance/dream.ts` | after `:206`, before `:209` |
| `resolveNerBody` fallback | `src/core/maintenance/dream.ts` or `ner-backfill.ts` | new; uses `:2087`, `:952`, `:2162` |
| `DreamReport.stages.ner_backfill` | `src/core/maintenance/dream.ts` | `:30-52`, `:93-115`, `:363-385`, `buildBrief`, `:397-412` |
| MCP ingest option | `src/mcp/tools/ingest.ts` | `:31-39` |
| CLI flag + submitter wiring | `src/cli/commands/content.ts` | `:16-37` |
| Submitter wiring | `src/mcp/context.ts` | `:78`, `:81` |
| `IngestResult.nerPending` field | `src/core/ingestion/ingest.ts` | `IngestResult` (`:93`) |
| Stale / snapshot / by-id job helpers | `src/storage/sqlite.ts` | job section (after `:1277`) |
| Formatter | `src/mcp/tools/format-result.ts` | **no change** (`:78` gates on `ner != null`) |

## 11. Review focus (reject criteria, from issue)

The implementation will be rejected if it:

- returns before chunks/FTS/vectors are safely written;
- silently drops NER work without a durable pending marker;
- introduces unbounded background LLM calls;
- runs a fire-and-forget NER promise inside the ingest process with no tracking;
- breaks `skipNer` or sync compatibility;
- bypasses `ContentPipeline` write/index guarantees;
- registers `ner-backfill` as an always-on MCP worker (this spec's addition);
- spawns duplicate `ner-backfill` jobs for the same slug (this spec's addition);
- runs NER on empty/summary-only sealed body without raw-chunk fallback (this
  spec's addition).
