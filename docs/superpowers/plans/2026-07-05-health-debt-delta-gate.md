# Health Debt Delta Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic gate that fails only when a change introduces new hard consistency debt compared with a saved baseline.

**Architecture:** Reuse the existing consistency gate report as the stable input contract. Add a pure evaluator in `src/core/fsck/debt-delta-gate.ts`, then a small CLI wrapper in `bin/check-health-debt-gate.ts` that loads a baseline file, generates the current consistency report, and emits stable JSON.

**Tech Stack:** TypeScript, Bun test, existing `runFsck`, `buildRepairPlan`, `evaluateConsistencyGate`, `CBrainDB`.

---

## Files

- Create: `src/core/fsck/debt-delta-gate.ts`
- Create: `tests/core/fsck/debt-delta-gate.test.ts`
- Create: `bin/check-health-debt-gate.ts`
- Create: `tests/cli/health-debt-gate.test.ts`
- Modify: `package.json`

## Task 1: Pure Delta Evaluator

**Files:**
- Create: `src/core/fsck/debt-delta-gate.ts`
- Test: `tests/core/fsck/debt-delta-gate.test.ts`

- [ ] **Step 1: Write failing pure tests**

Create `tests/core/fsck/debt-delta-gate.test.ts` with clean, new-hard, same-hard, lower-hard, and warning-delta cases.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/core/fsck/debt-delta-gate.test.ts
```

Expected: fail because module does not exist.

- [ ] **Step 3: Implement evaluator**

Create `src/core/fsck/debt-delta-gate.ts` with:

- `ConsistencyLikeReport`
- `DebtDeltaFinding`
- `DebtDeltaGateReport`
- `evaluateDebtDeltaGate()`

The function compares aggregate counts by `layer:check`.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
bun test tests/core/fsck/debt-delta-gate.test.ts
```

Expected: all pass.

## Task 2: CLI Gate

**Files:**
- Create: `bin/check-health-debt-gate.ts`
- Test: `tests/cli/health-debt-gate.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli/health-debt-gate.test.ts` with:

- clean DB vs clean baseline exits `0`;
- page_without_chunks vs clean baseline exits `1`;
- missing baseline exits `2`;
- invalid baseline exits `2`.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/cli/health-debt-gate.test.ts
```

Expected: fail because bin script and package command do not exist.

- [ ] **Step 3: Implement CLI**

Create `bin/check-health-debt-gate.ts`:

- parse `--baseline <file>`;
- parse baseline JSON;
- generate current consistency report using the same code path as `bin/check-consistency-gate.ts`;
- call `evaluateDebtDeltaGate`;
- emit JSON;
- exit `0`, `1`, or `2`.

Add package script:

```json
"gate:health-debt": "bun bin/check-health-debt-gate.ts"
```

- [ ] **Step 4: Run CLI tests and confirm GREEN**

Run:

```bash
bun test tests/cli/health-debt-gate.test.ts
```

Expected: all pass.

## Task 3: Verification and Adversarial Review

**Files:**
- All touched files.

- [ ] **Step 1: Focused tests**

Run:

```bash
bun test tests/core/fsck/debt-delta-gate.test.ts tests/cli/health-debt-gate.test.ts tests/core/fsck/consistency-gate.test.ts tests/cli/gate-consistency.test.ts
```

- [ ] **Step 2: Type/lint/check**

Run:

```bash
bun run typecheck
bun run lint
bun run check
```

- [ ] **Step 3: Adversarial review**

Check:

- Does the gate fail only on new/increased hard debt?
- Does it avoid failing on unchanged historical hard debt?
- Does it avoid leaking paths or raw slugs?
- Does it avoid automatic repair?
- Does it reuse consistency-gate semantics instead of inventing a parallel health model?

- [ ] **Step 4: Commit and push**

Commit:

```bash
git add src/core/fsck/debt-delta-gate.ts tests/core/fsck/debt-delta-gate.test.ts bin/check-health-debt-gate.ts tests/cli/health-debt-gate.test.ts package.json docs/superpowers/specs/2026-07-05-health-debt-delta-gate-design.md docs/superpowers/plans/2026-07-05-health-debt-delta-gate.md
git commit -m "feat(gate): add health debt delta gate"
```

Merge fast-forward to `main`, run the focused tests again, then push.
