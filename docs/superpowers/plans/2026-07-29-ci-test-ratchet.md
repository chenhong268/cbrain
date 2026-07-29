# CI Test Ratchet (#381) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ratchet the deterministic `tests/{core,storage,mcp,http}` suites into `bun run check:ci` (the PR gate) via a minimal directory-form source of truth — no per-file whitelist, no exclusion framework, zero product-code change.

**Architecture:** `check:ci` already runs lint + docs + recall-quality + `tests/bin/`. Extend its `bun test` leg to also cover the four target directories as **directory arguments** (`tests/core/ … tests/http/`). Directory-form args let `bun test` recursively auto-discover any new `*.test.ts`, so a newly added `tests/mcp/foo.test.ts` can never silently stay outside CI. A narrow contract test (appended to `tests/bin/ci-workflow.test.ts`) locks the four dirs into `check:ci`, forbids per-file whitelists, proves bun directory recursion with an isolated sentinel, and guards that the full `bun run check` and the separate network-backed `gate:dependencies` are not weakened or absorbed.

**Tech Stack:** Bun 1.3.14, bun:test, GitHub Actions (ubuntu-latest), existing `bin/check-docs-consistency.ts` + `bin/check-recall-quality-matrix.ts` + `bin/check-dependency-advisory-gate.ts`.

---

## Inventory evidence (deterministic triage)

Three runs (1 normal env + 2 clean env: empty `HOME`, all provider keys unset). All green, 0 fail, 0 flaky, stable timing. Clean-env parity = GitHub-Linux CI-equivalence proof (no real `cbrain.json` / vault / credentials / live provider).

| Dir | Files | Tests | 3-run result | Mean time | Classification |
|-----|-------|-------|--------------|-----------|----------------|
| tests/core | 137 | 2649 | all pass | ~61s | PR-safe |
| tests/storage | 21 | 211 | all pass | ~1.7s | PR-safe |
| tests/mcp | 50 | 943 | all pass | ~8.7s | PR-safe |
| tests/http | 4 | 24 | all pass | ~0.4s | PR-safe |
| **total** | **212** | **3827** | **0 fail** | **~73s** | **all PR-safe** |

Non-PR-safe trait audit (grep over the four dirs): external network `fetch`/`https` → **0**; fixed literal ports → **0**; `homedir()`/`.cbrain` real-vault fallback → **0**; real `await sleep(` → **0**. Subprocess use is limited to `git grep` (proactive-connection.test.ts, runner-standard) and `unzip`/`zipinfo` (dream-backup.test.ts, preinstalled on ubuntu-latest; GitHub-Linux CI run is the final judge). Tests self-isolate via `mkdtempSync(join(tmpdir(), "cbrain-…"))` temp vaults and mock LLM/embedding providers.

**Exclusions: 0.** No exclusion framework, no per-file registry, no 212-entry manifest is warranted.

## File structure

- **Modify:** `package.json` — extend `scripts.check:ci` to include the four dirs.
- **Modify:** `.github/workflows/ci.yml` — fix the stale top comment (it claims "only bin tests").
- **Modify:** `tests/bin/ci-workflow.test.ts` — append `describe("check:ci PR-test ratchet (#381)")` with the contract below.
- **No product/src change.** No new CLI/MCP/API. No new CI abstraction (no matrix/cache/retry).

---

### Task 1: Write the failing contract test (RED)

**Files:**
- Modify: `tests/bin/ci-workflow.test.ts` (append describe; extend imports)

- [ ] **Step 1: Extend imports**

In `tests/bin/ci-workflow.test.ts`, replace the import block (lines 1-3):

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
```

with:

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, tmpdir } from "node:path";
```

- [ ] **Step 2: Append the ratchet contract**

Append at the end of `tests/bin/ci-workflow.test.ts`:

```typescript
// ── #381: PR-test ratchet — check:ci covers deterministic core/storage/mcp/http ──

describe("check:ci PR-test ratchet (#381)", () => {
  const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  };
  const CHECK_CI = PKG.scripts["check:ci"] ?? "";
  const CHECK = PKG.scripts["check"] ?? "";

  // The four dirs are the source of truth: every *.test.ts under them MUST run
  // in PR CI. Directory-form args (not per-file whitelists) let bun auto-discover
  // new test files, so a newly added tests/mcp/foo.test.ts can never silently
  // stay outside the gate.
  const TARGET_DIRS = ["tests/core", "tests/storage", "tests/mcp", "tests/http"] as const;

  test("check:ci keeps lint, docs consistency, recall quality, and bin tests", () => {
    expect(CHECK_CI).toContain("bun run lint");
    expect(CHECK_CI).toContain("bun run check:docs");
    expect(CHECK_CI).toContain("bun run gate:recall-quality");
    expect(CHECK_CI).toMatch(/bun test[\s\S]*tests\/bin/);
  });

  test("check:ci covers every deterministic target directory", () => {
    for (const d of TARGET_DIRS) {
      expect(CHECK_CI).toMatch(new RegExp(`bun test[\\s\\S]*${d.replace(/\//g, "\\/")}\\/`));
    }
  });

  test("check:ci uses directory form, not a per-file whitelist (new tests auto-discovered)", () => {
    // No individual .test.ts path enumerated under a target dir — that would be
    // a per-file whitelist and silently drop new files.
    const perFile = CHECK_CI.match(/tests\/(?:core|storage|mcp|http)\/\S+\.test\.ts/g);
    expect(perFile ?? []).toEqual([]);
  });

  test("ci.yml declares a bounded job timeout", () => {
    expect(WORKFLOW).toMatch(/timeout-minutes:\s*\d+/);
  });

  test("bun run check (full/release gate) is not weakened — still runs the whole suite", () => {
    expect(CHECK).toContain("bun run lint");
    expect(CHECK).toContain("bun test");
    // `check` runs the whole suite (no dir filter); it must not be narrowed.
    expect(CHECK).not.toMatch(/bun test[^\n]*tests\//);
  });

  test("gate:dependencies stays a separate network-backed step, not absorbed into check:ci", () => {
    expect(PKG.scripts["gate:dependencies"]).toBeTruthy();
    expect(CHECK_CI).not.toContain("gate:dependencies");
  });

  test("bun recursively discovers new *.test.ts under a directory arg (auto-entry proof)", () => {
    // Proves bun directory recursion: drop a sentinel in an isolated tmp dir,
    // run `bun test <tmpdir>`, assert it is found and run. Combined with the
    // directory-form check:ci above, a new tests/mcp/*.test.ts cannot stay
    // outside CI. The tmp dir keeps the checkout clean.
    const tmp = mkdtempSync(join(tmpdir(), "cbrain-ratchet-sentinel-"));
    try {
      writeFileSync(
        join(tmp, "sentinel.test.ts"),
        'import { test, expect } from "bun:test";\n' +
          'test("ratchet sentinel", () => { expect(1 + 1).toBe(2); });\n',
      );
      const out = execSync(`bun test ${tmp}`, {
        encoding: "utf-8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(out).toContain("ratchet sentinel");
      expect(out).toMatch(/1 pass/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the new contract — verify it FAILS (RED)**

Run: `bun test tests/bin/ci-workflow.test.ts`
Expected: FAIL on "check:ci covers every deterministic target directory" (current `check:ci` lacks `tests/core/` etc.). The sentinel/recursion test should already PASS.

- [ ] **Step 4: Commit the RED test**

```bash
git add tests/bin/ci-workflow.test.ts
git commit -m "test(ci): #381 add check:ci PR-test ratchet contract (RED)"
```

---

### Task 2: Extend check:ci + fix ci.yml comment (GREEN)

**Files:**
- Modify: `package.json:42` (`scripts.check:ci`)
- Modify: `.github/workflows/ci.yml:1-10` (top comment)

- [ ] **Step 1: Extend check:ci**

In `package.json`, replace:

```json
    "check:ci": "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/"
```

with:

```json
    "check:ci": "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/"
```

- [ ] **Step 2: Fix the stale ci.yml top comment**

In `.github/workflows/ci.yml`, replace lines 1-10:

```yaml
# ci.yml — no-secret PR gate (deterministic core + one network-backed step).
#
# `bun run check:ci` is deterministic and offline (src+test typecheck, biome,
# docs consistency, bin tests). The dependency-advisory gate
# (`bun run gate:dependencies`) is a SEPARATE network-backed step that calls
# the Bun registry to resolve security advisories; because it depends on an
# external service, the overall workflow is no longer purely deterministic —
# but it remains no-secret. It does NOT run the full `bun test`
# (LLM/Hermes/runtime gates) — those remain local / release gates via
# `bun run check` and `bun run gate:v2-preflight`.
```

with:

```yaml
# ci.yml — no-secret PR gate (deterministic offline suite + one network-backed step).
#
# `bun run check:ci` is deterministic and offline: src+test typecheck, biome,
# docs consistency, recall-quality matrix, and the deterministic test suites
# under tests/bin, tests/core, tests/storage, tests/mcp, tests/http. These
# suites self-isolate via mkdtempSync temp vaults and mock LLM/embedding
# providers, so they need no real cbrain.json, vault, credentials, or network.
#
# The dependency-advisory gate (`bun run gate:dependencies`) is a SEPARATE
# network-backed step that calls the Bun registry to resolve security
# advisories; because it depends on an external service, the overall workflow
# is no longer purely deterministic — but it remains no-secret. It does NOT
# run the full `bun test` (LLM/Hermes/runtime gates) — those remain local /
# release gates via `bun run check` and `bun run gate:v2-preflight`.
```

- [ ] **Step 3: Run the contract — verify it PASSES (GREEN)**

Run: `bun test tests/bin/ci-workflow.test.ts`
Expected: PASS (all ratchet tests green).

- [ ] **Step 4: Commit GREEN**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci: #381 ratchet deterministic core/storage/mcp/http suites into check:ci"
```

---

### Task 3: Full verification

- [ ] **Step 1: Local CI-equivalent command**

Run: `bun run check:ci`
Expected: PASS (lint + docs + recall-quality + bin + core + storage + mcp + http). Bounded well under 15 min (~2 min local).

- [ ] **Step 2: Full release gate unaffected**

Run: `bun run check`
Expected: PASS (full `bun test`, semantics unchanged).

- [ ] **Step 3: Docs + dependency gates**

Run: `bun run check:docs && bun run gate:dependencies`
Expected: both PASS; `gate:dependencies` runs as the independent network-backed step.

- [ ] **Step 4: Whitespace + privacy**

Run: `git diff --check` → no whitespace errors. Grep the branch diff for credential-like strings (local fs paths, secret prefixes, auth-header tokens, real names, real vault paths) → none.

- [ ] **Step 5: GitHub Linux CI**

Push feature branch, open PR `Closes #381`. ubuntu-latest run is the final judge that `unzip`/`zipinfo` (dream-backup) and the four suites pass on a clean Linux runner with frozen lockfile + no secrets.

## Self-review

- **Spec coverage:** acceptance criteria (inventory ✓ evidence table; PR-safe suites executed ✓ check:ci; exclusions documented ✓ "Exclusions: 0"; new-test contract ✓ Task 1; bounded timeouts ✓ ci.yml 15m + contract; Linux+frozen+no-secret ✓ ci.yml + ci-workflow.test.ts; check:ci extended compatibly ✓; no private config dependency ✓ clean-env runs; exact CI cmd passes ✓ Task 3; full check + docs + diff --check ✓ Task 3) — all covered.
- **Placeholder scan:** none — all code blocks are final.
- **Type consistency:** `TARGET_DIRS` used consistently; `WORKFLOW`/`PKG` module-scope vars reused; new imports match usage.
