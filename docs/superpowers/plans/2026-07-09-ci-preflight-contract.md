# CI + Preflight Docs Contract Implementation Plan (#317)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the deterministic subset of CBrain's release gates into a reproducible GitHub Actions contract, and add focused tests that fail whenever release docs drift from `DEFAULT_PREFLIGHT_CHECKS` or the workflow shape drifts from the contract.

**Architecture:** Three layers. (1) Export a tiny `getPreflightCheckIds()` helper so tests read the single source of truth (`DEFAULT_PREFLIGHT_CHECKS`). (2) A focused test asserts `docs/product/*` name every check id and the documented count equals the real count — this catches the current `six` vs 7 drift. (3) A minimal `.github/workflows/ci.yml` runs a new `check:ci` script (`bun run lint` + `check:docs` + the bin tests) on every PR and push to main. No secrets, no private vault, no Hermes/LLM/runtime. A second focused test pins the workflow shape so it cannot silently regress.

**Tech Stack:** Bun 1.3.14, TypeScript (strict), `bun:test`, GitHub Actions (`oven-sh/setup-bun@v2`).

---

## CI gate scope

CI runs the **currently-green enforced local gate subset**: `bun run lint` (src typecheck + test typecheck + biome), `bun run check:docs`, and the deterministic `tests/bin/` suite. This is packaged as a new `check:ci` script.

Verified baseline (run in the worktree):
- `bun run lint` → exit 0 (`tsc --noEmit`, `tsc --noEmit -p tsconfig.test.json`, `biome lint` over 420 files, no errors). The historical "287 test typecheck errors" debt is already cleared; CI reproduces the full `lint` gate as the issue packet asks.
- `bun run check:docs` → `Verdict: PASS`, exit 0.
- Full `bun test` (LLM/Hermes/runtime gates) and `bun run gate:v2-preflight` remain **local / release** gates — they are not run in PR CI. This is documented in `ci.yml` so the split is not oral memory.

> Note: `CLAUDE.md` still claims test typecheck has 287 deferred errors and is "暂不纳入强制门禁". That is stale — `bun run typecheck:tests` is clean today. This plan runs the real current gate; the `CLAUDE.md` line is a separate doc-sync issue, out of scope here.

---

## Verified drift (baseline evidence)

- `bin/check-v2-preflight.ts:57-107` defines **7** checks: `offline-first-recall`, `rc-journeys`, `hermes-dialogue`, `performance`, `docs-consistency`, `resolver-pilot`, `storage-consistency`.
- `docs/product/v2-rc-release-checklist.md:10` says "aggregates **six** offline gates" and omits `storage-consistency`.
- `docs/product/v2-preflight-bug-audit.md` "What It Runs" table lists only 6 rows — missing `storage-consistency`.
- `bun run check:docs` currently **PASSes** — the existing docs checker does not recurse into `docs/product/**`, so it cannot see this drift. The new focused test closes that hole.

---

## Single source of truth

`DEFAULT_PREFLIGHT_CHECKS` (in `bin/check-v2-preflight.ts:57`) is the only authority for which gates exist. No test hardcodes the gate list. `getPreflightCheckIds()` is a thin accessor; the helper-contract test compares it against `DEFAULT_PREFLIGHT_CHECKS.map(c => c.id)`, and every other assertion derives ids from `getPreflightCheckIds()`. Adding/removing a gate in one place propagates everywhere.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `bin/check-v2-preflight.ts` | Modify | Export `getPreflightCheckIds()` — single source of truth for check ids |
| `tests/bin/check-v2-preflight-docs.test.ts` | Create | Helper contract + release-docs consistency (ids + count) |
| `docs/product/v2-rc-release-checklist.md` | Modify | Fix line 10: `six` → `seven`, list all 7 ids |
| `docs/product/v2-preflight-bug-audit.md` | Modify | Add `storage-consistency` row to "What It Runs" table |
| `package.json` | Modify | Add `check:ci` script |
| `.github/workflows/ci.yml` | Create | CI: PR + push main → bun → `check:ci` |
| `tests/bin/ci-workflow.test.ts` | Create | Pins `.github/workflows/ci.yml` shape (triggers, bun setup, command, no secrets) |

No changes to `bin/check-docs-consistency.ts` (752-line file; extending it risks false positives over `docs/superpowers/**` — explicitly warned against). The focused tests are the safer, surgical fix.

---

## Task 1: Export `getPreflightCheckIds()` helper

**Files:**
- Modify: `bin/check-v2-preflight.ts` (add export after `DEFAULT_PREFLIGHT_CHECKS`, ~line 108)
- Create: `tests/bin/check-v2-preflight-docs.test.ts` (helper-contract case only; docs cases land in Task 2)

- [ ] **Step 1: Write the failing test for the helper**

Create `tests/bin/check-v2-preflight-docs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PREFLIGHT_CHECKS, getPreflightCheckIds } from "../../bin/check-v2-preflight";

const DOCS_DIR = join(import.meta.dir, "..", "..", "docs", "product");

function readDoc(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf-8");
}

describe("getPreflightCheckIds", () => {
  test("returns exactly the ids of DEFAULT_PREFLIGHT_CHECKS, in order", () => {
    expect([...getPreflightCheckIds()]).toEqual(DEFAULT_PREFLIGHT_CHECKS.map((c) => c.id));
  });

  test("is non-empty (guards against an accidental empty list)", () => {
    expect(getPreflightCheckIds().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: FAIL — `getPreflightCheckIds is not exported` (module resolves, named export missing).

- [ ] **Step 3: Implement the helper**

In `bin/check-v2-preflight.ts`, immediately after the closing `];` of `DEFAULT_PREFLIGHT_CHECKS` (line 107) and before `function tail(...)` (line 109), insert:

```ts
export function getPreflightCheckIds(): readonly string[] {
  return DEFAULT_PREFLIGHT_CHECKS.map((c) => c.id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: PASS (2 tests, 0 failures).

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

- [ ] **Step 1: Append the docs-consistency helpers and cases**

At the bottom of `tests/bin/check-v2-preflight-docs.test.ts`, append:

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

`IDS` derives from `getPreflightCheckIds()`, not a hardcoded list — adding a gate in `DEFAULT_PREFLIGHT_CHECKS` automatically raises the expected count and id set.

- [ ] **Step 2: Run the test to verify it fails (confirms the test catches the drift)**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: FAIL on three new cases:
- "release checklist documents the real gate count" → expected `7`, got `6` (the word "six").
- "release checklist names every preflight check id" → missing `offline-first-recall` and `storage-consistency` (current prose uses short labels, not ids).
- "preflight bug audit lists every check id" → missing `storage-consistency`.

The two helper-contract cases from Task 1 still pass.

- [ ] **Step 3: Do NOT commit yet**

The repo is failing by design. Task 3 makes it green and commits test + docs together.

---

## Task 3: Fix the release docs to match `DEFAULT_PREFLIGHT_CHECKS` (GREEN)

**Files:**
- Modify: `docs/product/v2-rc-release-checklist.md` (lines 10-13)
- Modify: `docs/product/v2-preflight-bug-audit.md` (table, ~after line 20)

- [ ] **Step 1: Fix the release checklist sentence**

In `docs/product/v2-rc-release-checklist.md`, replace lines 10-13:

```
`gate:v2-preflight` aggregates six offline gates (first-recall, RC journeys,
Hermes dialogue, performance, docs consistency, resolver pilot). They are
deterministic and fully offline — they cannot drive a real Hermes
conversation, measure end-to-end latency on real search traffic, or validate a
```

with:

```
`gate:v2-preflight` aggregates seven offline gates (`offline-first-recall`,
`rc-journeys`, `hermes-dialogue`, `performance`, `docs-consistency`,
`resolver-pilot`, `storage-consistency`). They are deterministic and fully
offline — they cannot drive a real Hermes conversation, measure end-to-end
latency on real search traffic, or validate a
```

- [ ] **Step 2: Add the missing `storage-consistency` row to the bug audit table**

In `docs/product/v2-preflight-bug-audit.md`, the "What It Runs" table currently ends with the `resolver-pilot` row. Append one row immediately after the `resolver-pilot` row (before the blank line that precedes `## Report Contract`):

```
| `storage-consistency` | `bun run gate:consistency` | Storage fsck + repair-plan stays green (no silent drift) |
```

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `bun test tests/bin/check-v2-preflight-docs.test.ts`
Expected: PASS (5 tests, 0 failures).

- [ ] **Step 4: Run `check:docs` to confirm no collateral damage**

Run: `bun run check:docs`
Expected: `Verdict: PASS`, exit 0.

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

Replace it with:

```json
    "check:docs": "bun bin/check-docs-consistency.ts",
    "check:ci": "bun run lint && bun run check:docs && bun test tests/bin/"
```

`check:ci` = full `lint` (src + test typecheck + biome) + docs consistency + the deterministic bin suite. The full `bun test` (LLM/runtime) stays out of PR CI; it remains a local/release gate via `bun run check`.

- [ ] **Step 2: Run `check:ci` locally to verify it is green**

Run: `bun run check:ci`
Expected: all three stages pass — `bun run lint` clean (420 files), `check:docs` PASS, `bun test tests/bin/` PASS (preflight docs + agent-contract tests). Exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(ci): add check:ci script (lint + check:docs + bin tests) (#317)"
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
# Runs the full `bun run lint` (src + test typecheck + biome), docs
# consistency, and the bin test suite. It does NOT run the full `bun test`
# (LLM/Hermes/runtime gates) — those remain local / release gates via
# `bun run check` and `bun run gate:v2-preflight`.
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

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow running check:ci on PR + push main (#317)"
```

---

## Task 6: Pin the workflow shape with a contract test

The workflow must not silently regress (drop a trigger, swap the bun action, add a secret, or stop calling `check:ci`). Task 6 of the issue packet's adversarial review demands this be machine-checked, not eyeballed.

**Files:**
- Create: `tests/bin/ci-workflow.test.ts`

The test asserts the raw YAML text with string/regex checks. A YAML parser (`js-yaml`) would be heavier than this needs and would add a dependency for a file that rarely changes shape; text assertions are stable and dependency-free.

- [ ] **Step 1: Write the contract test**

Create `tests/bin/ci-workflow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_PATH = join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml");

describe(".github/workflows/ci.yml contract", () => {
  test("file exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  const yaml = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf-8") : "";

  test("triggers on pull_request", () => {
    expect(yaml).toMatch(/pull_request:/);
  });

  test("triggers on push to main", () => {
    expect(yaml).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  test("uses oven-sh/setup-bun@v2", () => {
    expect(yaml).toContain("oven-sh/setup-bun@v2");
  });

  test("installs with frozen lockfile", () => {
    expect(yaml).toContain("bun install --frozen-lockfile");
  });

  test("runs the ci script", () => {
    expect(yaml).toContain("bun run check:ci");
  });

  test("declares least-privilege contents:read permission", () => {
    expect(yaml).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  test("does not require secrets", () => {
    expect(yaml).not.toContain("secrets.");
  });

  test("does not reference private/local paths", () => {
    expect(yaml).not.toMatch(/\/Users\/|\/Volumes\/|\\Users\\/);
  });

  test("does not depend on Hermes / LLM / provider env", () => {
    expect(yaml).not.toMatch(/\bHERMES|LLM_|OPENAI|DEEPSEEK|ZHIPU|ANTHROPIC\b/);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test tests/bin/ci-workflow.test.ts`
Expected: PASS (10 tests, 0 failures). All assertions match the workflow created in Task 5.

- [ ] **Step 3: Run the full bin suite + check:ci to confirm nothing regressed**

Run: `bun run check:ci`
Expected: exit 0 (lint + check:docs + `tests/bin/`, which now includes the new workflow contract test).

- [ ] **Step 4: Commit**

```bash
git add tests/bin/ci-workflow.test.ts
git commit -m "test(ci): pin .github/workflows/ci.yml shape (triggers, bun, no secrets) (#317)"
```

---

## Task 7: Adversarial review + final verification

**Files:** none (verification + audit only). Fix forward if a check finds a real defect.

- [ ] **Step 1: Run the exact CI command one more time**

Run: `bun run check:ci`
Expected: exit 0, all stages green. This is the exact command GitHub Actions runs.

- [ ] **Step 2: Adversarial check 1 — CI passes locally but would fail on GitHub Linux**

Audit:
- No absolute macOS paths in the touched files. The new tests use `import.meta.dir` (repo-relative), not `/Users/...`. `tests/bin/ci-workflow.test.ts` even asserts the workflow contains no `/Users/` path.
- Bun version pinned to 1.3.14 in the workflow (matches local `bun --version`).
- `--frozen-lockfile` will fail loud in CI if `bun.lock` drifts. Verify locally: `bun install --frozen-lockfile` → exit 0.

- [ ] **Step 3: Adversarial check 2 — release docs claim a stale count/name**

Enforced by `tests/bin/check-v2-preflight-docs.test.ts`. Re-run `bun test tests/bin/check-v2-preflight-docs.test.ts` — green. Mental check: if `DEFAULT_PREFLIGHT_CHECKS` gains an 8th entry, `IDS.length` becomes 8 → count test expects 8 → checklist says 7 → red. Coupling is the point.

- [ ] **Step 4: Adversarial check 3 — flaky/env-dependent test hidden by weakening the real gate**

Confirm CI is a subset, never a weakening:
- `check:ci` does not edit or bypass `gate:v2-preflight` / `check:docs` / any `bin/check-*`.
- `bun install --frozen-lockfile` works locally (Step 2).
- `tests/bin/` tests are pure text/structure assertions — no LLM, no DB, no network, no subprocess needing runtime. Read each test file to confirm.

- [ ] **Step 5: Adversarial check 4 — docs checker scans `docs/superpowers/**` and creates noise**

Confirm the new tests read **only** `docs/product/v2-rc-release-checklist.md`, `docs/product/v2-preflight-bug-audit.md`, and `.github/workflows/ci.yml` (grep each test file for `docs/superpowers` — must be none). `check:docs` is untouched and still does not recurse into `docs/product` or `docs/superpowers`.

- [ ] **Step 6: Adversarial check 5 — CI logs or fixtures leak private data**

Confirm:
- Touched docs, tests, and workflow contain no real names, vault paths, or credentials. Grep the diff for identifier-like strings, email patterns, `/Users/`, `/Volumes/`, bearer/key tokens — must be none.
- The workflow does not print env or upload artifacts beyond the default CI log.
- `check-v2-preflight.ts` `tail()` already redacts `PROJECT_DIR` and `HOME` (line 109-116); no test logs gate stdout.

- [ ] **Step 7: Report the local CI-equivalent command + evidence**

In the handoff comment, state the exact command (`bun run check:ci`), the stage-by-stage green evidence, the workflow contract test result, and the adversarial review results (all 5 passed).

---

## Self-Review (completed by plan author)

**Spec coverage** (against the #317 packet):
- "minimal GitHub Actions workflow, PR + push main, deterministic Bun, no-secret commands" → Task 5; shape pinned by Task 6. ✓
- "small CI script over full `bun run check`; includes lint + check:docs + focused deterministic tests; document full gates stay local" → Task 4 + CI gate scope section. ✓ (`bun run lint` included as the packet asks; verified green today.)
- "preflight docs source-of-truth consistent; export helper or use `DEFAULT_PREFLIGHT_CHECKS` in tests; tests fail on wrong count / omitted id; update both docs" → Tasks 1, 2, 3. ✓
- "extend docs consistency OR focused unit test; avoid `docs/superpowers/**` noise" → focused unit tests (File Structure rationale); Task 7 Step 5 guards it. ✓
- Acceptance tests (every id mentioned; documented count == real count; CI script referenced by workflow; no secret steps) → Tasks 2, 5, 6. ✓
- Adversarial review (5 failure modes) → Task 7. ✓
- Review-blocker fixes: `check:ci` runs full `lint` (no gate weakening); helper test compares against `DEFAULT_PREFLIGHT_CHECKS` dynamically (no second gate list); workflow shape is machine-tested (Task 6). ✓

**Placeholder scan:** none — every code step contains literal code/commands.

**Type consistency:** `getPreflightCheckIds()` (Task 1) used in Task 2 via `IDS`; `DEFAULT_PREFLIGHT_CHECKS` already exported at `bin/check-v2-preflight.ts:57`; `parseDocumentedGateCount` defined and used within Task 2. `WORKFLOW_PATH`/`yaml` consistent within Task 6. No drift.
