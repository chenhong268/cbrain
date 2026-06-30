# Defer NER Extraction Out of Synchronous Write Path — Design

- **Issue**: #252
- **Date**: 2026-06-30
- **Status**: Design (pending implementation)
- **Related**: #228 (roadmap), must land before #251 / #236

---

## 1. Background & Problem

CBrain runs LLM-backed NER **synchronously** inside the ingest write path. The
call sequence in `IngestManager.ingestCore()` (`src/core/ingest.ts:360-486`) is:

```
validate → embed → page create/update → chunks/FTS/vectors (ContentPipeline)
         → wikilinks/links → [BLOCKING] pipeline.processNer() → applyExtraction
```

`pipeline.processNer()` (`src/core/pipeline.ts:252-270`) `await`s
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
effective mode = "defer"   → DEFER_NER          (no await; submit job; ner: "pending")
```

Implementation site: the NER gate in `ingestCore()` (`ingest.ts:428-437`) and
the parallel gate in `ingestEntityAppend()` (`ingest.ts:288-297`). The existing
type guard (`!type.startsWith("entity/"|"concept/"|"insight/")`) still applies
in all modes — derived page types never NER and never get a marker.

### 5.3 `DeferredNerSubmitter` injection

- Define `DeferredNerSubmitter` (above) in `src/core/ingest.ts` (or a small
  adjacent types file) — keep `ingest.ts` focused.
- `IngestManager` constructor gains two optional params: the resolved default
  `nerMode` and a `deferredNerSubmitter?`. When the submitter is absent
  (e.g. tests that only exercise sync), defer mode degrades to **sync** with a
  one-time logger warning — never crashes.
- Adapter: a thin `JobQueueNerSubmitter implements DeferredNerSubmitter` wraps
  `JobQueue` + the dedup query. Lives next to `jobs.ts` or `context.ts`.

### 5.4 Pending marker (jobs table) + dedup

- `submitDeferredNer({ slug, contentHash?, pageType? })`:
  1. Query existing `ner-backfill` jobs in `pending`/`running` whose
     `json_extract(data, '$.slug')` equals `slug`.
     - Add a focused DB method, e.g.
       `findPendingJobsBySlug(name, slug): { id; status; data }[]` using
       `json_extract` (SQLite JSON1). Avoids a full table scan pattern.
  2. If any exists → return `null` (deduped). Do **not** touch the running job.
  3. Else → `jobs.submit("ner-backfill", { slug, contentHash?, pageType? })`,
     return job id.
- Job `data` shape (stable contract for the processor):
  `{ slug: string; contentHash?: string; pageType?: string }`.
- `result.ner` for the ingest return value carries `"pending"` (internal/raw
  signal only — not surfaced noisily to end users).

### 5.5 Dream stage 1.5 processor

New stage in `runDream()` (`src/core/dream.ts`), placed after Stage 1 (sync)
and before Stage 2 (enrich):

```
stage 1.5 / ner-backfill:
  processed = 0; failed = 0; timed_out = 0; skipped = 0
  for i in [0, maxItems):
      job = db.claimJobForNames(["ner-backfill"])     // single-job claim; loop
      if !job: break
      slug = JSON.parse(job.data).slug
      resolved = resolveNerBody(pages, db, slug)       // §5.6 fallback chain
      if !resolved:
          db.failJob(job.id, "no usable body (sealed/no raw chunks)")
          failed++; continue
      try:
          pipeline.processNer(slug, resolved.body, resolved.type, …)  // reuse existing
          db.completeJob(job.id)
          processed++
      catch e if isNerTimeoutError(e):
          db.failJob(job.id, "NER_TIMEOUT")            // attempts++, retryable
          timed_out++
      catch e:
          db.failJob(job.id, msg)                       // attempts++, retryable
          failed++
  onStageProgress("ner_backfill", { processed, failed, timed_out, skipped })
```

- `maxItems` default **50** (bounded per run; remaining jobs wait for the next
  Dream cycle).
- Reuses `pipeline.processNer` → existing `applyExtraction` (stubs, links,
  timeline, facts). Zero new NER logic.
- `claimJobForNames` returns a single job (`sqlite.ts:1265`); the loop claims
  one at a time. No new batch-claim DB method needed.
- **No** handler registered with `ctx.jobs` for `ner-backfill` (§4.2 #5).

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

Add to `tests/core/ingest.test.ts` (defer/skipNer/off/dedup) and a new focused
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
| NER gate (sync/defer/off) | `src/core/ingest.ts` | `ingestCore:428-437`, `ingestEntityAppend:288-297` |
| `IngestInput.nerMode` + constructor | `src/core/ingest.ts` | `:81-128` |
| `DeferredNerSubmitter` + adapter | `src/core/ingest.ts` / `src/mcp/context.ts` | new |
| Dedup query | `src/storage/sqlite.ts` | new `findPendingJobsBySlug` (json_extract) |
| submit / claim / complete / fail | `src/storage/sqlite.ts` | `:1245-1313` (exist) |
| Dream stage 1.5 | `src/core/dream.ts` | after `:206`, before `:209` |
| `resolveNerBody` fallback | `src/core/dream.ts` or `ner-backfill.ts` | new; uses `:2087`, `:952`, `:2162` |
| `DreamReport.stages.ner_backfill` | `src/core/dream.ts` | `:30-52`, `:93-115`, `:363-385`, `buildBrief`, `:397-412` |
| MCP ingest option | `src/mcp/tools/ingest.ts` | `:31-39` |
| CLI flag + submitter wiring | `src/cli/commands/content.ts` | `:16-37` |
| Submitter wiring | `src/mcp/context.ts` | `:78`, `:81` |

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
