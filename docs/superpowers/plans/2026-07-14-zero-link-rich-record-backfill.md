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
- two shared snapshots but one conditional NER claim/LLM call;
- random claimed lease, committing fence, token removal on every exit, ABA/reclaim rejection;
- revoked zombie completion/failure cannot overwrite terminal/new attempt;
- phase-before-freshness and commit-unknown terminalization;
- unresolved commit-unknown blocks same-run, later-run, and old-snapshot successor claim;
- any global conflict makes all reset/retry/completion/transition/snapshot mutations zero;
- entity-facts data never receives attempt lease.

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
- revocation wins before committing → zero writes; committing wins → cancel/stale non-applied and processed completion;
- synchronous exception after fence becomes commit-unknown;
- empty extraction guards before shadow audit.

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
- wrong/corrupt manifest-owned child protection before child parsing;
- source verification bytes, final guard, graph outcome from actual links;
- terminal counts/finalization/digest; commit-unknown stays unfinalized;
- ordinary commit-unknown list privacy and full predecessor identity;
- error precedence: batch rollback → integrity → state mismatch;
- accept/retry/release-successor table and claim-time successor block;
- broad retry skips marked/shadowed history but permits valid current ordinary failed row.

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
- Modify command/help consistency fixtures only as required by gates

**RED**

Test no-flags read-only behavior, missing DB/config errors, active-writer dry-run/enqueue split, strict limits, no provider construction, random batch UUID only, short selected guidance, atomic enqueue, scalar human/JSON output, sanitized thrown errors, and no fixture sentinel/path/job payload.

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
git add src/cli/commands/zero-link-backfill.ts src/cli/program.ts tests/cli/zero-link-backfill-cli.test.ts
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
- malformed manifest never weakens privacy.

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
4. Require zero pending/running and finalized true; any commitUnknown stays unfinalized and triggers matched-backup rollback.
5. Re-run dry-run/fsck/FK/consistency/privacy; record scalar deltas only.
6. Stop on every spec stop condition; canary requires at least one resolved.

Before reopening writes, rewrite every persistent client entrypoint to the guarded detached runtime, smoke reconnect/restart, run live MCP unified/alias privacy shape probes, and prove old installed runtime cannot acquire writer. Once writes reopen, never restore an older full archive; repair/deploy forward only.

Add a sanitized scalar rollout report to the PR, commit/push it, and leave PR ready but unmerged/unreleased.

Final evidence packet:

- branch and PR URL;
- reviewed code SHA and report SHA;
- focused/full pass counts;
- privacy and docs gates;
- per-batch scalar outcomes and stop/rollback status;
- active guarded runtime SHA/entrypoint proof (paths kept private);
- residual risks and explicit no-merge/no-release confirmation.
