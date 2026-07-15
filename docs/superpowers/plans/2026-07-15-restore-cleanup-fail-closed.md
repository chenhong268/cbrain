# Restore Cleanup Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:test-driven-development and execute the tasks in order.

**Goal:** Complete Issue #345 so restore reports success only after all exact
managed post-restore artifacts are verified absent, while preserving the valid
restored database/vault when cleanup is incomplete.

**Architecture:** Add an exact-entry (`lstatSync`, ENOENT-only) predicate and a
closed-result finalizer that runs at most three global cleanup rounds with
50/150/300 ms stabilization waits. Inject the finalizer and temp-directory
factory through the backup command registration for a real Commander fault
test. Both full and DB-only restore verify applicable managed artifacts before
success; cleanup-incomplete sets exit code 1 and returns through `finally`.

**Tech Stack:** TypeScript, Bun, Commander, bun:test, Node filesystem APIs.

**Spec:** `docs/superpowers/specs/2026-07-15-restore-cleanup-fail-closed-design.md`

---

## Task 1: Exact-entry and finalizer unit contract (RED → GREEN)

**Files:**
- Modify: `tests/cli/restore.test.ts`
- Modify: `src/cli/commands/backup.ts`

- [ ] Add failing unit tests for exact-entry presence, including a broken
  symlink whose target is absent.
- [ ] Add failing tests for the managed-artifact finalizer:
  - already absent: zero attempts and waits;
  - first removal failure then success: attempts stop after round two and waits
    are `[50, 150]`;
  - persistent failure: exactly three rounds, waits `[50, 150, 300]`, no fourth
    removal;
  - a partial recursive deletion before failure leaves active vault untouched
    and preserves whatever residual remains;
  - rollback and WAL/SHM removal failures independently yield incomplete.
- [ ] Run `bun test tests/cli/restore.test.ts` and capture the expected failures
  caused by missing exports/behavior.
- [ ] Implement `exactPathEntryExists`, `finalizeRestoreArtifacts`, typed deps,
  result type, retry schedule, and fixed diagnostic. Catch and collapse every
  filesystem error; never return raw error data.
- [ ] Re-run focused tests to GREEN.

## Task 2: Wire fail-closed command behavior (RED → GREEN)

**Files:**
- Modify: `tests/cli/restore.test.ts`
- Modify: `src/cli/commands/backup.ts`

- [ ] Add a failing real Commander test using optional `register` dependencies.
  Seed distinct old/restored DB and vault markers, inject persistent
  `.pre-restore` cleanup failure, and assert:
  - exit code 1;
  - fixed privacy-safe stderr only;
  - no database/vault success and no sync instruction;
  - restored DB and active vault remain usable;
  - old vault content remains only in the residual to the extent not removed;
  - `.rollback` is finalized and rollback is not invoked;
  - extraction temp directory is removed by `finally`.
- [ ] Add broken-symlink preflight regression.
- [ ] Observe RED.
- [ ] Add optional internal deps to `register`; replace swallowed cleanup with
  unified finalization for full and DB-only paths; set `process.exitCode = 1`
  and return on incomplete without throwing.
- [ ] Re-run focused tests to GREEN.

## Task 3: Real argument boundary and documentation

**Files:**
- Modify: `tests/cli/restore.test.ts`
- Modify: `docs/vault-spec.md`
- Modify: `docs/install-onboarding.md`

- [ ] Add an argument-array subprocess test for a zip/config/vault under a
  synthetic `Mobile Documents/File Provider Root` path containing spaces.
- [ ] Strengthen normal full-restore assertions for exact `.pre-restore`,
  `.rollback`, WAL, and SHM absence.
- [ ] Document the cleanup state machine, fixed diagnostic, non-rollback
  semantics, operator next action, partial recursive-delete limitation, and
  #341 boundary. Explicitly prohibit restore from scanning/deleting numbered or
  misplaced siblings.
- [ ] Run focused tests and `bun run check:docs`.

## Task 4: Adversarial review, full verification, and delivery

- [ ] Run focused restore tests, typechecks, lint, docs consistency, full test
  suite, `git diff --check`, and privacy scan.
- [ ] Use adversarial Agents for separate code/data-safety review and
  test/mutation review. Fix all CRITICAL/HIGH/MEDIUM findings and re-run gates.
- [ ] Commit intentionally, push `codex/fix-345-restore-cleanup`, open a PR
  linked to #345, wait for CI, merge only when green, and verify issue state.
- [ ] Do not run restore against the live vault. Deployment, if needed, is a
  separate read-only/runtime-ownership decision after merge.
