# #342 Rich Record Zero-Link Backfill Implementation Plan

> **Required execution discipline:** follow this plan task-by-task with RED → GREEN → REFACTOR. Do not combine commits, alter production, or expand scope before the named gates pass.

**Goal:** Detect rich zero-link records, repair the missing existing-entity mention edge, schedule and consume privacy-safe idempotent NER batches, and perform an authorized 5 → 20 → 50 production rollout without merging or releasing.

**Architecture:** One shared maintenance module owns source fingerprints, manifest parsing, queue integrity, attempt classification, scalar projection, and enqueue transactions. Durable NER uses scoped lease-CAS plus a final source/commit fence. Existing worker/CLI/MCP/Health/fsck surfaces consume the shared contract; no surface reimplements marker parsing or privacy policy.

**Base:** `3e0d048`; approved spec through `8fe3df3`.

**Non-negotiable:** all examples anonymous; raw vault data never enters reports/tests; production commands run from the reviewed guarded SHA; no merge, tag, version bump, or release.

---

## Phase 1 — Pure contracts and read-only detection

### Task 1: Canonical source fingerprint and rich-record scanner

**Files**

- Create: `src/core/maintenance/zero-link-backfill.ts`
- Create: `src/core/ingestion/ner-backfill-contract.ts`
- Create: `tests/core/maintenance/zero-link-backfill.test.ts`

**RED**

Add focused tests for:

- record-only threshold union (`raw chunks >= 2 || raw chars >= 1000 || tags >= 3`);
- summary-level-1 chunks excluded;
- current-fact non-self link semantics identical to `getAllLinks().filter(isCurrentFactLink)`;
- candidate `reports_to`, rejected/superseded, and self links do not connect a page;
- pre-aggregated chunks/tags/links prevent join multiplication;
- deterministic ordering and post-order limit;
- sealed page always selects ordered raw chunks + full derived SHA-256 even with page hash;
- non-sealed page selects `page:<content_hash>`;
- canonical fixed-key JSON/UTF-8 handles newline/delimiter cases and unordered rows;
- no usable source returns `null` fingerprint/source kind;
- public projection contains scalars only and no fixture sentinel.

Run:

```bash
bun test tests/core/maintenance/zero-link-backfill.test.ts
```

Require failure because implementation is absent.

**GREEN**

Implement exported constants/types, `deriveZeroLinkSource`, `scanRichRecords`, current-link helper, and scalar projection. Keep DB reads uncapped and functions side-effect free. Put shared job/manifest/lease names and fixed outcome types in `ner-backfill-contract.ts` to avoid import cycles.

Run focused test, then:

```bash
bun run lint
git diff --check
```

Commit:

```bash
git add src/core/maintenance/zero-link-backfill.ts src/core/ingestion/ner-backfill-contract.ts tests/core/maintenance/zero-link-backfill.test.ts
git commit -m "feat(maintenance): detect rich zero-link records (#342)"
```

### Task 2: Manifest, ledger, classifier, and atomic enqueue

**Files**

- Modify: `src/core/maintenance/zero-link-backfill.ts`
- Modify: `tests/core/maintenance/zero-link-backfill.test.ts`

**RED**

Add state/transaction tests covering the complete approved matrix:

- new/legacy/content-changed/stale requeue, active, cancelled, failed, no-link, blocked, source-changed, invalid, lost-link, resolved;
- all pending/running rows considered before terminal history;
- exact claimed/committing and fresh/stale transition-pair internal dispositions and scalar projection;
- terminal `commit_unknown` precedence for ordinary/marked/single/pair and finalized-manifest rejection;
- malformed active JSON/name/kind/slug/marker/manifest/digest/aggregate blocks globally without payload leakage;
- sealed/current source fingerprint matching and full repair + ordinary terminal epoch ledgers;
- F1→F2→F3, repair/ordinary revert, old terminal vs old live behavior;
- manifest A finalized → child reused by B → A frozen audit/B validation;
- UUID uniqueness, wrong-name manifest discriminator, latest ownership, missing/corrupt child;
- canonical finalized ledger digest and scalar reconciliation;
- global commit-unknown count independent of pages/links;
- enqueue `BEGIN IMMEDIATE`, injected failure rollback, two-connection serialization, unchanged repeat idempotence;
- short batch stores returned selected count and random UUID only.

Run the focused suite before implementation and require assertion-level failures in the new cases (not only a missing import/file error):

```bash
bun test tests/core/maintenance/zero-link-backfill.test.ts
```

**GREEN**

Implement safe JSON parsers, uncapped manifest discovery, ownership/ledger index, pure `InternalJobDisposition` classifier, aggregate projection, canonical digest, `planZeroLinkBackfill`, and `enqueueZeroLinkBackfill`. Enqueue must rescan inside `BEGIN IMMEDIATE`; no writes occur on any conflict.

Run:

```bash
bun test tests/core/maintenance/zero-link-backfill.test.ts
bun run lint
git diff --check
```

Commit:

```bash
git add src/core/maintenance/zero-link-backfill.ts tests/core/maintenance/zero-link-backfill.test.ts
git commit -m "feat(maintenance): govern zero-link repair batches (#342)"
```

---

## Phase 2 — Durable NER execution safety

### Task 3: Structured submitter, supersession, atomic claim, and attempt lease

**Files**

- Modify: `src/storage/sqlite.ts`
- Modify: `src/core/ingestion/ner-backfill.ts`
- Modify: `src/core/ingestion/ner-write-path.ts`
- Modify: `tests/core/ner-backfill.test.ts`
- Modify/add focused SQLite race tests under `tests/storage/`

**RED**

Add tests for:

- structured disposition and truthful `pending` boolean;
- caller normalized-body hash, full-document hash, or missing hash never replaces DB-derived `pageContentHash`;
- full ordinary `sourceFingerprint`, including stable page hash with changing sealed raw chunks;
- repair + ordinary terminal dedupe and F2→F3→revert F2;
- pending supersession in-place; fresh-running successor; stale-running source-change + successor;
- sanctioned pair across exact TTL boundary; entity-facts unchanged;
- two-connection submit race creates one row;
- conditional NER claim grants one random claimed lease; direct lease-CAS primitives cover committing, complete, fail, skip, commit-unknown, token removal, ABA/reclaim rejection, and revoked zombie rejection;
- entity-facts data never receives attempt lease.

Run the focused suites before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/core/ner-backfill.test.ts tests/storage/sqlite.test.ts
```

**GREEN**

Implement scoped SQLite helpers for conditional NER claim, claimed→committing fence, lease-CAS complete/fail/skip/commit-unknown, and transactional job updates. Do not alter generic claim semantics. Refactor `JobQueueNerSubmitter` to derive identity inside `BEGIN IMMEDIATE`, return `DeferredNerSubmitResult`, and implement exact supersession rules. Make `submitDeferredNerForWritePath` return `.pending`.

Run:

```bash
bun test tests/core/ner-backfill.test.ts tests/storage
bun run lint
git diff --check
```

Commit:

```bash
git add src/storage/sqlite.ts src/core/ingestion/ner-backfill.ts src/core/ingestion/ner-write-path.ts tests/core/ner-backfill.test.ts tests/storage
git commit -m "fix(ner): add source epochs and attempt leases (#342)"
```

### Task 4: Final source fence, deferred alias intents, and mention-edge root fix

**Files**

- Modify: `src/core/ingestion/entity-resolver.ts`
- Modify: `src/core/ingestion/pipeline.ts`
- Modify: `tests/core/ner-quality.test.ts`
- Modify: `tests/core/shadow-verifier-integration.test.ts`
- Modify/add: `tests/core/ner-backfill.test.ts`

**RED**

Add tests for:

- `resolved_to_existing` and `alias_added` write weak candidate NER `提及`;
- no self-link; trusted edge not downgraded; repeat idempotent; skipMention count behavior preserved;
- guarded exact/normalized/parenthetical/semantic alias intents do not write before fence and preserve `ner-resolved` vs `llm-semantic`;
- F1 changes during extract or semantic await: final guard produces zero ingest-log/entity/alias/mention/page/fact/link/relation/event writes;
- source deleted during await maps to unavailable, not changed;
- revocation observed by either pipeline guard → zero writes; a successful final guard returns write authority to the caller;
- empty extraction guards before shadow audit.

Run the focused suites before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/core/ner-quality.test.ts tests/core/shadow-verifier-integration.test.ts tests/core/ner-backfill.test.ts
```

**GREEN**

Add optional resolver defer-write mode with deterministic `DeferredAliasIntent`. Add optional synchronous pipeline guard called after extraction and after final resolver await; defer non-empty shadow audit and all aliases until final guard. Acquire committing lease at final guard. Preserve unguarded sync/ingest behavior. Add the missing mention edge in the existing/alias branch.

Run:

```bash
bun test tests/core/ner-quality.test.ts tests/core/shadow-verifier-integration.test.ts tests/core/ner-backfill.test.ts
bun run lint
git diff --check
```

Commit:

```bash
git add src/core/ingestion/entity-resolver.ts src/core/ingestion/pipeline.ts tests/core/ner-quality.test.ts tests/core/shadow-verifier-integration.test.ts tests/core/ner-backfill.test.ts
git commit -m "fix(ner): fence stale extraction writes (#342)"
```

### Task 5: Batch-filtered/unfiltered consumers and commit-unknown resolution

**Files**

- Modify: `src/core/ingestion/ner-backfill.ts`
- Modify: `src/cli/commands/maintenance.ts`
- Modify: `tests/core/ner-backfill.test.ts`
- Modify: `tests/cli/ner-backfill-cli.test.ts`

**RED**

Test:

- exact UUID manifest only; no unrelated NER/entity-facts/stale reset;
- `--limit` equals returned selected, short-batch behavior, retry-failed conflict;
- unfiltered `BEGIN IMMEDIATE` rescan and global all-table zero-write on conflicts;
- two stages may share a snapshot but only one scoped claim invokes the LLM;
- phase-before-freshness, stale committing terminalization, synchronous post-fence exception → commit-unknown, and lease token cleanup;
- revocation wins before committing → zero pipeline/job overwrite; committing wins → cancel/stale return non-applied and the matching lease may complete processed;
- unresolved commit-unknown blocks the same transaction, later runs, and an old-snapshot direct successor claim;
- any global conflict leaves every reset/retry/completion/transition/snapshot row byte-for-byte unchanged;
- wrong/corrupt manifest-owned child protection before child parsing;
- vault-hash source verification reads and hashes one file snapshot; sealed repair reads the same ordered raw chunks used by its fingerprint and never an L1 summary; drift before LLM makes zero LLM calls;
- marked repair rows use `max_attempts=1`, so the first provider/timeout failure is terminal;
- terminal counts/finalization/digest; commit-unknown stays unfinalized; interrupted finalization resumes with the same UUID and zero additional LLM calls;
- ordinary commit-unknown list privacy and full predecessor identity;
- error precedence: batch rollback → integrity → state mismatch;
- accept/retry/release-successor table and claim-time successor block;
- broad retry skips marked/shadowed history but permits valid current ordinary failed row.

Run the focused suites before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/core/ner-backfill.test.ts tests/cli/ner-backfill-cli.test.ts
```

**GREEN**

Refactor `runNerBackfillStage` around the shared transactional preflight and scoped claims. Add repair-batch mode/status/finalization and ordinary commit-unknown list/resolve handlers. Keep entity-facts on its legacy branch. Ensure every fixed error is sanitized.

Run:

```bash
bun test tests/core/ner-backfill.test.ts tests/cli/ner-backfill-cli.test.ts
bun run lint
git diff --check
```

Commit:

```bash
git add src/core/ingestion/ner-backfill.ts src/cli/commands/maintenance.ts tests/core/ner-backfill.test.ts tests/cli/ner-backfill-cli.test.ts
git commit -m "feat(ner): consume governed repair batches (#342)"
```

---

## Phase 3 — Public surfaces and diagnostics

### Task 6: Safe zero-link CLI command

**Files**

- Create: `src/cli/commands/zero-link-backfill.ts`
- Modify: `src/cli/program.ts`
- Create: `tests/cli/zero-link-backfill-cli.test.ts`
- Modify if required by the docs gate: `bin/check-docs-consistency.ts`
- Modify if required by the docs gate: `tests/release/check-docs-consistency.test.ts`

**RED**

Test no-flags read-only behavior, missing DB/config errors, active-writer dry-run/enqueue split, strict limits, no provider construction, random batch UUID only, short selected guidance, atomic enqueue, scalar human/JSON output, sanitized thrown errors, and no fixture sentinel/path/job payload.

Run before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/cli/zero-link-backfill-cli.test.ts
```

**GREEN**

Implement safe config load, existence check, true read-only SQLite open for dry-run, writer lock before writable open, and dedicated command registration. Do not call `loadConfig()`/`createDeps()` or migrations in dry-run.

Run:

```bash
bun test tests/cli/zero-link-backfill-cli.test.ts
bun run check:docs
bun run lint
```

Commit:

```bash
git add src/cli/commands/zero-link-backfill.ts src/cli/program.ts tests/cli/zero-link-backfill-cli.test.ts bin/check-docs-consistency.ts tests/release/check-docs-consistency.test.ts
git commit -m "feat(cli): add governed zero-link backfill (#342)"
```

### Task 7: MCP job privacy and mutation boundary

**Files**

- Modify: `src/mcp/tools/jobs.ts`
- Modify: `tests/mcp/server.test.ts`

**RED**

Cover unified plus aliases for:

- every NER row safe projection;
- reserved/wrong-name manifest discriminator safe projection;
- no data/result/error/slug/fingerprint/token/provider sentinel;
- reserved NER/manifest submit rejection under any name/discriminator;
- owned/shadowed/commit-unknown/committing mutation rejection;
- valid ordinary current retry compatibility;
- shared `isManifestLike` predicate for submit/list/status/cancel/retry;
- malformed manifest never weakens privacy;
- malformed/duplicate/unknown manifest integrity makes unified and compatibility cancel/retry reject **every** `ner-backfill` row with fixed `REPAIR_BATCH_OWNED`; committing rows return fixed `ATTEMPT_COMMITTING`; both paths preserve byte-for-byte zero mutation, while ordinary non-NER behavior remains unchanged.

Run before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/mcp/server.test.ts
```

**GREEN**

Implement one shared policy/projection helper used by every unified/alias action. Query ownership uncapped through shared maintenance code. Preserve ordinary non-NER behavior.

Run:

```bash
bun test tests/mcp/server.test.ts
bun run lint
git diff --check
```

Commit:

```bash
git add src/mcp/tools/jobs.ts tests/mcp/server.test.ts
git commit -m "fix(mcp): protect governed NER job state (#342)"
```

### Task 8: Health and fsck aggregate debt

**Files**

- Modify: `src/core/maintenance/health.ts`
- Modify: `src/core/maintenance/health-debt.ts`
- Modify: `src/core/fsck/sqlite-probe.ts`
- Modify/add focused Health/fsck tests

**RED**

Test one synthetic aggregate issue, needs-review classification, anonymous samples, no deterministic repair, zero-link counts, distinct resolved pages, and global commit-unknown warning even when total=0 and a partial link exists.

Run before implementation and require assertion-level failures in the new cases:

```bash
bun test tests/core/maintenance tests/core/fsck
```

**GREEN**

Wire the shared scanner/projection only. Health passes iff total and commitUnknown are both zero. fsck finding uses audit-unit count and keeps populations separate in scalar detail.

Run:

```bash
bun test tests/core/maintenance tests/core/fsck
bun run lint
git diff --check
```

Commit:

```bash
git add src/core/maintenance/health.ts src/core/maintenance/health-debt.ts src/core/fsck/sqlite-probe.ts tests/core/maintenance tests/core/fsck
git commit -m "feat(health): surface zero-link and NER audit debt (#342)"
```

---

## Phase 4 — Integration, adversarial review, and release gate

### Task 9: Integrated verification and privacy audit

Run focused suites from every task, then:

```bash
bun run lint
bun run check:docs
bun run check
git diff --check
git status --short
```

Run a changed-file privacy scan for non-anonymous names, paths, emails, credentials, raw payload logging, and stack traces. Run mutation/barrier tests at least twice to detect nondeterminism.

Invoke the adversarial Agent against the full diff with explicit focus on:

- double claim/zombie lease/commit fence;
- manifest/ledger corruption and historical reuse;
- unfiltered global zero-write;
- public MCP/CLI privacy;
- commit-unknown visibility/resolution;
- dry-run true read-only behavior.

Fix all CRITICAL/HIGH and plan-required MEDIUM findings using new RED tests. Re-run full suite after every material correction.

Commit only verified review fixes, then record exact reviewed code SHA.

### Task 10: PR first, then guarded production rollout

Push the reviewed branch and create a ready PR referencing #342 **before live mutation**, without merging. Record the reviewed code SHA.

Preflight production exactly as approved:

1. Use a clean detached deployment worktree at reviewed SHA; tracked source read-only; record digest.
2. Define `CBRAIN_RUN=(bun run src/cli/index.ts)` with private live config.
3. Stop all writers; prove no unsafe multi-writer environment.
4. Create unique mode-0700 preflight backup directory, run full backup, verify zip/content privately.
5. Run dry-run, FK, fsck, consistency, and scalar privacy gates.

For each requested batch 5, 20, 50:

1. Create and verify a distinct private full backup.
2. Enqueue `--limit N`; require clean conflicts and `0 < selected <= N`.
3. Consume exact UUID using `--limit selected`.
4. If all children are terminal and `commitUnknown=0` but the manifest is still unfinalized, rerun the **same UUID** with the same `selected` limit; require finalization-only behavior and zero additional LLM calls.
5. Require zero pending/running and `finalized=true`. Any `commitUnknown>0` stays unfinalized and triggers matched-backup rollback. Any other manifest that still cannot finalize keeps every writer stopped and also triggers matched-backup rollback.
6. Before the DB/vault restore, stage and validate Lance from the same matched archive under the live Lance parent. Then run repository restore for DB/vault, install staged Lance by same-filesystem directory rename, compare the restored live file digest with the staged digest, and keep the post-batch tree quarantined until FK/fsck/consistency gates pass. Never run sync between restore and verification. Follow spec §13.4 exactly; DB/vault-only restore is forbidden.
7. Re-run dry-run/fsck/FK/consistency/privacy; record scalar deltas only.
8. Stop on every spec stop condition; canary requires at least one resolved.

Runtime correction (2026-07-15): only a validated manifest-owned zero-link repair immediately indexes each newly created stub before job completion; `sourceGuard` alone does not enable it because ordinary fingerprinted deferred NER may race the watcher. Corrective regression tests must prove SQLite chunks, FTS, and Lance coverage on success; batched embedding cardinality; no immediate index for ordinary deferred NER; and `commit_unknown` plus an unfinalized manifest for embedding/Lance/SQLite/FTS failures. Re-run the five-item canary from a fresh matched backup before any 20/50 progression.

No unfinalized manifest may cross the reopen-writes boundary. Before reopening writes, rewrite every persistent client entrypoint to the guarded detached runtime, smoke reconnect/restart, run live MCP unified/alias privacy shape probes, and prove old installed runtime cannot acquire writer. Once writes reopen, never restore an older full archive; repair/deploy forward only.

Add a sanitized scalar rollout report to the PR. Before committing it, verify the report-only diff contains no runtime code change, run the privacy scan, `git diff --check`, `bun run check:docs`, and an adversarial report-only review. Commit/push only after those gates pass. Record `reviewedCodeSha` separately from `reportSha`, and leave the PR ready but unmerged/unreleased.

Final evidence packet:

- branch and PR URL;
- reviewed code SHA and report SHA;
- focused/full pass counts;
- privacy and docs gates;
- per-batch scalar outcomes and stop/rollback status;
- active guarded runtime SHA/entrypoint proof (paths kept private);
- residual risks and explicit no-merge/no-release confirmation.
