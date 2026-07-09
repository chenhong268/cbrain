# CI + Preflight Docs Contract Implementation Plan (#317)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the deterministic subset of CBrain's release gates into a reproducible GitHub Actions contract, and add a focused test that fails whenever release docs drift from `DEFAULT_PREFLIGHT_CHECKS`.

**Architecture:** Three layers. (1) Export a tiny `getPreflightCheckIds()` helper so tests read the single source of truth. (2) A focused unit test asserts `docs/product/*` name every check id and the documented count equals the real count — this is what catches the current `six` vs 7 drift. (3) A minimal `.github/workflows/ci.yml` runs a new `check:ci` script (src typecheck + biome + `check:docs` + the bin tests) on every PR and push to main. No secrets, no private vault, no Hermes/LLM/runtime.

**Tech Stack:** Bun 1.3.14, TypeScript (strict), `bun:test`, GitHub Actions (`oven-sh/setup-bun@v2`).

---

## Key design decision: CI must NOT run `bun run lint`

The issue packet says "include at least `bun run lint`". That is wrong for this repo and following it blindly makes CI permanently red.

`package.json` defines:
```
"lint": "bun run typecheck && bun run typecheck:tests && biome lint ./src ./tests",
```

`typecheck:tests` has **287 pre-existing type errors** (242 of them from test code reaching into `CBrainDB` private methods). `CLAUDE.md` explicitly states test typecheck is **not** an enforced gate yet ("暂不纳入强制门禁").

Therefore CI runs the **source-side** gate only: `bun run typecheck` (src) + `biome lint`. This exactly reproduces the enforced local gate without importing the deferred `typecheck:tests` failure. The new `check:ci` script encodes this split. Full `bun run lint` / `bun run check` / `gate:v2-preflight` stay local/release gates — documented as such.

If a future PR fixes the test-coupling debt and makes `typecheck:tests` clean, `check:ci` can be upgraded to call `bun run lint` then. That is out of scope for #317.

---

## Verified drift (baseline evidence)

- `bin/check-v2-preflight.ts:57-107` defines **7** checks: `offline-first-recall`, `rc-journeys`, `hermes-dialogue`, `performance`, `docs-consistency`, `resolver-pilot`, `storage-consistency`.
- `docs/product/v2-rc-release-checklist.md:10` says "aggregates **six** offline gates" and omits `storage-consistency`.
- `docs/product/v2-preflight-bug-audit.md` "What It Runs" table lists only 6 rows — missing `storage-consistency`.
- `bun run check:docs` currently **PASSes** — the existing docs checker does not recurse into `docs/product/**`, so it cannot see this drift. The new focused test closes that hole.
- `bun run typecheck` (src) currently clean.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `bin/check-v2-preflight.ts` | Modify | Export `getPreflightCheckIds()` — single source of truth for check ids |
| `tests/bin/check-v2-preflight-docs.test.ts` | Create | Focused test: release docs must match `DEFAULT_PREFLIGHT_CHECKS` (id list + count) |
| `docs/product/v2-rc-release-checklist.md` | Modify | Fix line 10: `six` → `seven`, list all 7 ids |
| `docs/product/v2-preflight-bug-audit.md` | Modify | Add `storage-consistency` row to "What It Runs" table |
| `package.json` | Modify | Add `check:ci` script (src gate, no `typecheck:tests`) |
| `.github/workflows/ci.yml` | Create | CI: PR + push main → bun → `check:ci` |

No changes to `bin/check-docs-consistency.ts` (752-line file; extending it risks false positives over `docs/superpowers/**` — explicitly warned against). The focused test is the safer, surgical fix.

---

## Task 1: Export `getPreflightCheckIds()` helper

**Files:**
- Modify: `bin/check-v2-preflight.ts` (add export after `DEFAULT_PREFLIGHT_CHECKS`, ~line 108)
- Test: `tests/bin/check-v2-preflight-docs.test.ts` (created here, but docs-assertion cases land in Task 2; this task adds only the helper-contract case)

- [ ] **Step 1: Write the failing test for the helper**

Create `tests/bin/check-v2-preflight-docs.test.ts` with only the helper-contract test for now:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPreflightCheckIds } from "../../bin/check-v2-preflight";

const DOCS_DIR = join(import.meta.dir, "..", "..", "docs", "product");

function readDoc(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf-8");
}

describe("getPreflightCheckIds", () => {
  test("returns the real preflight check ids in order", () => {
    const ids = getPreflightCheckIds();
    expect(ids).toEqual([
      "offline-first-recall",
      "rc-journeys",
      "hermes-dialogue",
      "performance",
      "docs-consistency",
      "resolver-pilot",
      "storage-consistency",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: FAIL — `getPreflightCheckIds is not exported from "../../bin/check-v2-preflight"` (module exists, named export missing).

- [ ] **Step 3: Implement the helper**

In `bin/check-v2-preflight.ts`, immediately after the closing `];` of `DEFAULT_PREFLIGHT_CHECKS` (line 107) and before `function tail(...)` (line 109), insert:

```ts
export function getPreflightCheckIds(): readonly string[] {
  return DEFAULT_PREFLIGHT_CHECKS.map((c) => c.id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: PASS (1 test, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add bin/check-v2-preflight.ts tests/bin/check-v2-preflight-docs.test.ts
git commit -m "feat(preflight): export getPreflightCheckIds() helper (#317)"
```

---

## Task 2: Write the preflight docs-consistency test (RED)

This task only adds the failing assertions. It deliberately does NOT commit — the repo must stay green at every commit, and these assertions fail until Task 3 fixes the docs.

**Files:**
- Modify: `tests/bin/check-v2-preflight-docs.test.ts` (append docs cases + shared helpers)

- [ ] **Step 1: Append the docs-consistency cases**

Add the following to the top of `tests/bin/check-v2-preflight-docs.test.ts` (just under the existing imports, before the `describe("getPreflightCheckIds"...)` block) so the helpers are in module scope:

```ts
const WORD_TO_NUM: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Extract the documented gate count from a sentence like "aggregates seven offline gates". */
function parseDocumentedGateCount(doc: string): number | null {
  const line = doc.split("\n").find((l) => /aggregates\s+\w+\s+offline\s+gates/i.test(l));
  if (!line) return null;
  const match = line.match(/aggregates\s+(\w+)\s+offline\s+gates/i);
  if (!match) return null;
  const token = match[1];
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return WORD_TO_NUM[token.toLowerCase()] ?? null;
}

const IDS = getPreflightCheckIds();
```

Then append this second `describe` block at the end of the file:

```ts
describe("preflight release docs consistency", () => {
  test("release checklist documents the real gate count", () => {
    const checklist = readDoc("v2-rc-release-checklist.md");
    const documented = parseDocumentedGateCount(checklist);
    expect(
      documented,
      `checklist must state how many gates the preflight aggregates (expected ${IDS.length})`,
    ).toBe(IDS.length);
  });

  test("release checklist names every preflight check id", () => {
    const checklist = readDoc("v2-rc-release-checklist.md");
    for (const id of IDS) {
      expect(checklist, `release checklist missing check id ${id}`).toContain(id);
    }
  });

  test("preflight bug audit lists every check id", () => {
    const audit = readDoc("v2-preflight-bug-audit.md");
    for (const id of IDS) {
      expect(audit, `bug audit missing check id ${id}`).toContain(id);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (confirms the test actually catches the drift)**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: FAIL on three new cases:
- "release checklist documents the real gate count" → expected `7`, got `6` (the word "six").
- "release checklist names every preflight check id" → missing `offline-first-recall` and `storage-consistency` (current prose uses short labels, not ids).
- "preflight bug audit lists every check id" → missing `storage-consistency`.

The helper-contract case from Task 1 still passes.

- [ ] **Step 3: Do NOT commit yet**

The repo is in a failing state by design. Task 3 makes it green and commits test + docs together.

---

## Task 3: Fix the release docs to match `DEFAULT_PREFLIGHT_CHECKS` (GREEN)

**Files:**
- Modify: `docs/product/v2-rc-release-checklist.md` (line 10-12)
- Modify: `docs/product/v2-preflight-bug-audit.md` (table rows, ~line 15-21)

- [ ] **Step 1: Fix the release checklist sentence**

In `docs/product/v2-rc-release-checklist.md`, replace lines 10-12:

```
`gate:v2-preflight` aggregates six offline gates (first-recall, RC journeys,
Hermes dialogue, performance, docs consistency, resolver pilot). They are
deterministic and fully offline — they cannot drive a real Hermes
```

with:

```
`gate:v2-preflight` aggregates seven offline gates (`offline-first-recall`,
`rc-journeys`, `hermes-dialogue`, `performance`, `docs-consistency`,
`resolver-pilot`, `storage-consistency`). They are deterministic and fully
offline — they cannot drive a real Hermes
```

- [ ] **Step 2: Add the missing `storage-consistency` row to the bug audit table**

In `docs/product/v2-preflight-bug-audit.md`, the "What It Runs" table currently ends with the `resolver-pilot` row. Append one row immediately after the `resolver-pilot` row (before the blank line that precedes `## Report Contract`):

```
| `storage-consistency` | `bun run gate:consistency` | Storage fsck + repair-plan stays green (no silent drift) |
```

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: PASS (4 tests, 0 failures).

- [ ] **Step 4: Run `check:docs` to confirm no collateral damage**

Run: `bun run check:docs`
Expected: `Verdict: PASS`, exit 0. (The release docs are not in `check:docs`'s current load set, so this just guards against accidental edits to the files it does scan.)

- [ ] **Step 5: Commit**

```bash
git add tests/bin/check-v2-preflight-docs.test.ts docs/product/v2-rc-release-checklist.md docs/product/v2-preflight-bug-audit.md
git commit -m "fix(docs): align preflight release docs with DEFAULT_PREFLIGHT_CHECKS (7 gates) (#317)"
```

---

## Task 4: Add the `check:ci` script

**Files:**
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Add the script**

In `package.json`, the last entry in the `"scripts"` block is currently:
```
"check:docs": "bun bin/check-docs-consistency.ts"
```

Add a new entry after it (keep the trailing comma rules valid — `check:docs` line gains a trailing comma):

```json
    "check:docs": "bun bin/check-docs-consistency.ts",
    "check:ci": "bun run typecheck && biome lint ./src ./tests && bun run check:docs && bun test tests/bin/"
```

Rationale encoded in the script: `typecheck` (src only) + biome + `check:docs` + the deterministic `tests/bin/` suite. **No `typecheck:tests`** (287 deferred errors), **no full `bun test`** (LLM/runtime gates stay local).

- [ ] **Step 2: Run `check:ci` locally to verify it is green**

Run: `bun run check:ci`
Expected: all four stages pass — `tsc --noEmit` clean, biome lint clean, `check:docs` PASS, `bun test tests/bin/` PASS (the new preflight docs test + the existing agent-contract test). Exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(ci): add check:ci script (src gate + docs + bin tests, no typecheck:tests) (#317)"
```

---

## Task 5: Add the GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
# ci.yml — deterministic, no-secret PR gate.
#
# Runs the src typecheck, biome lint, docs consistency, and the bin test
# suite. It does NOT run the full `bun test` (LLM/Hermes/runtime gates) or
# `typecheck:tests` (deferred 287-error debt). Those remain local / release
# gates via `bun run check` and `bun run gate:v2-preflight`.
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - name: Install deps (frozen lockfile)
        run: bun install --frozen-lockfile
      - name: Run check:ci
        run: bun run check:ci
```

- [ ] **Step 2: Sanity-check the workflow has no secret/private assumptions**

Confirm by inspection (no `secrets.*`, no `env:` vault paths, no network beyond Bun registry install). The `permissions: contents: read` block is least-privilege.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow running check:ci on PR + push main (#317)"
```

---

## Task 6: Adversarial review + final verification

**Files:** none (verification + audit only). Fix forward if a check finds a real defect.

- [ ] **Step 1: Run the exact CI command one more time**

Run: `bun run check:ci`
Expected: exit 0, all stages green. This is the exact command GitHub Actions will run.

- [ ] **Step 2: Adversarial check 1 — CI passes locally but would fail on GitHub Linux**

Audit:
- No absolute macOS paths (no `/Users/...`, no `/tmp/cbrain-test-*` hardcoded) in the touched files. The preflight docs test uses `import.meta.dir` (repo-relative), not an absolute path.
- Bun version pinned to 1.3.14 in the workflow (matches local).
- `--frozen-lockfile` will fail loud in CI if `bun.lock` is out of sync — verify locally that `bun install --frozen-lockfile` succeeds (see Step 4).

- [ ] **Step 3: Adversarial check 2 — release docs claim a stale count/name**

Already enforced by `tests/bin/check-v2-preflight-docs.test.ts`. Re-run `bun test tests/bin/check-v2-preflight-docs.test.ts` — must be green. Confirm the test would fail if `DEFAULT_PREFLIGHT_CHECKS` gained an 8th entry (mental check: `IDS.length` would become 8, count test would expect 8, checklist says 7 → red). That coupling is the whole point.

- [ ] **Step 4: Adversarial check 3 — flaky/env-dependent test hidden by weakening the real gate**

Confirm the CI gate is a **subset** of the local gate, never a weakening:
- `check:ci` does not edit or bypass `gate:v2-preflight` / `check:docs` / any `bin/check-*`.
- `--frozen-lockfile` works locally: run `bun install --frozen-lockfile` and confirm exit 0.
- `tests/bin/` tests are pure text/structure assertions — no LLM, no DB, no network. Confirm none of them spawn subprocesses needing runtime (read each test file).

- [ ] **Step 5: Adversarial check 4 — docs checker scans `docs/superpowers/**` and creates noise**

Confirm the new test reads **only** `docs/product/v2-rc-release-checklist.md` and `docs/product/v2-preflight-bug-audit.md` (grep the test file for any `docs/superpowers` reference — must be none). The existing `check:docs` is untouched and still does not recurse into `docs/product` or `docs/superpowers`.

- [ ] **Step 6: Adversarial check 5 — CI logs or fixtures leak private data**

Confirm:
- The touched docs and the test contain no real names, vault paths, or credentials. Grep the diff for `宏哥`-style identifiers, email patterns, `/Users/`, `/Volumes/`, bearer/key tokens — must be none.
- The workflow does not print env or upload artifacts beyond the default CI log.
- `check-v2-preflight.ts` `tail()` already redacts `PROJECT_DIR` and `HOME` (line 109-116); the test does not log gate stdout.

- [ ] **Step 7: Final full local release gate sanity (optional but recommended)**

Run: `bun run check:docs && bun run typecheck`
Expected: both green. (Full `bun run check` / `gate:v2-preflight` are not required for this docs/CI-only change but confirm they still run if time permits.)

- [ ] **Step 8: Report the local CI-equivalent command + evidence**

In the handoff comment, state the exact command (`bun run check:ci`), the green evidence (stage-by-stage exit), and the adversarial review results (all 5 passed).

---

## Self-Review (completed by plan author)

**Spec coverage** (against the #317 packet):
- "minimal GitHub Actions workflow, PR + push main, deterministic Bun, no-secret commands" → Task 5. ✓
- "small CI script over full `bun run check`; includes lint + check:docs + focused deterministic tests; document full gates stay local" → Task 4 + Key Design Decision section. ✓ (lint split explicitly justified.)
- "preflight docs source-of-truth consistent; export helper or use `DEFAULT_PREFLIGHT_CHECKS` in tests; tests fail on wrong count / omitted id; update both docs" → Tasks 1, 2, 3. ✓
- "extend docs consistency OR focused unit test; avoid `docs/superpowers/**` noise" → chose focused unit test (File Structure rationale); Task 6 Step 5 guards it. ✓
- Acceptance tests (every id mentioned; documented count == real count; CI script referenced by workflow; no secret steps) → Tasks 2, 5. ✓
- Adversarial review (5 failure modes) → Task 6 Steps 2-6. ✓

**Placeholder scan:** none — every code step contains the literal code/commands.

**Type consistency:** `getPreflightCheckIds()` (Task 1) is the name used in Tasks 2; `IDS` derived from it; `parseDocumentedGateCount` defined in Task 2 Step 1 and used in Task 2 Step 1's test. `PreflightCheckSpec` and `DEFAULT_PREFLIGHT_CHECKS` already exist in `bin/check-v2-preflight.ts`. No drift.
