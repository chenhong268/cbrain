# Attention Audit Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, scalar-only `AttentionAuditSummary` to `next_actions` under `raw.audit` (only when `include_raw=true`), with exact post-merge accounting and source/severity/freshness breakdowns.

**Architecture:** A pure helper `computeAttentionAudit` derived from the arrays `buildAttentionQueue` already computes (no DB, no IO, no re-classification). It is attached to `AttentionQueueRaw.audit`, which is only built when `includeRaw=true`. The MCP tool (`next-actions.ts`) needs no change — `raw` is already serialized via passthrough, so `audit` rides along. Default `display`/`items`/`summary` are byte-for-byte unchanged.

**Tech Stack:** TypeScript, Bun (`bun:test`), zod, MCP SDK. Tests in `tests/core/` + `tests/mcp/`.

**Spec:** `docs/superpowers/specs/2026-07-10-attention-audit-summary-design.md`

---

## Execution Discipline (reviewer-mandated)

**Write the RED tests that lock the accounting invariants BEFORE implementing `computeAttentionAudit`.** The partition equation (`visibleCount + hiddenObserveOnlyCount + hiddenStaleCount + suppressedBeyondCapCount === rankedInputCount`), the breakdown sums, and the cross-checks against `summary` must exist as failing tests first. This prevents shipping field-existence-only tests that miss the core equation. Task 1 enforces this: the invariant test is written and confirmed failing (Step 3) before the helper is implemented (Step 4).

All fixtures are anonymous sentinels (`entity/aN`, `similar_entity*`). No real names, paths, or credentials anywhere — including in test descriptions.

## File Structure

- **Modify** `src/core/maintenance/attention-queue.ts` — add `AttentionAuditSummary` interface, `computeAttentionAudit` pure helper, attach `audit` (required) to `AttentionQueueRaw`, wire into `buildAttentionQueue` when `includeRaw`.
- **Modify** `tests/core/attention-queue.test.ts` — unit audit invariants (partition, breakdowns, cross-check, fresh-blocker).
- **Modify** `tests/mcp/next-actions.test.ts` — MCP audit presence/absence, scalar-only shape, read-only regression under `include_raw=true`, adversarial leakage.
- **No change** `src/mcp/tools/next-actions.ts` — `raw` passthrough already serializes the new `audit` field. (Verify, do not edit.)
- **No docs** — `audit` is an additive raw-channel field; `.description()` already says "审计明细".

---

## Task 1: Implement `computeAttentionAudit` + lock unit accounting invariants (RED → GREEN → commit)

**Files:**
- Modify: `src/core/maintenance/attention-queue.ts` (interfaces near line 96-107; `buildAttentionQueue` near line 235-291)
- Test: `tests/core/attention-queue.test.ts`

- [ ] **Step 1: Add the `AttentionAuditSummary` interface + optional `audit` stub on `AttentionQueueRaw`**

In `src/core/maintenance/attention-queue.ts`, add the interface after `AttentionQueueSummary` (after line 94):

```ts
/**
 * Scalar-only attention audit summary (#319). Pure counts over the post-merge
 * ranked set; no slugs, paths, scores, dedup keys, or refs. Surfaced only under
 * raw.audit (include_raw=true). Breakdowns partition the SAME ranked set as the
 * outcome buckets, so each breakdown sums to rankedInputCount.
 */
export interface AttentionAuditSummary {
  /** Pre-merge: raw drafts entering buildAttentionQueue (== summary.totalInput). */
  totalInput: number;
  /** Post-merge: dedup/merged ranked set size (== raw.allItemsRanked.length). */
  rankedInputCount: number;
  visibleCount: number;
  hiddenObserveOnlyCount: number;
  hiddenStaleCount: number;
  suppressedBeyondCapCount: number;
  bySource: Record<"health" | "discovery", number>;
  bySeverity: Record<RepairGroup, number>;
  byFreshness: Record<Freshness, number>;
}
```

Make `audit` a **required** field on `AttentionQueueRaw`, add a zero-returning stub for `computeAttentionAudit`, and wire it into `buildAttentionQueue`. The stub makes the RED tests fail *on the counts* (proving the invariant assertions catch wrong accounting) rather than at field-existence — this is the discipline 宏哥 demanded. Replace the existing `AttentionQueueRaw` interface (lines 96-101):

```ts
export interface AttentionQueueRaw {
  observeOnlyItems: NextAction[];
  allItemsRanked: NextAction[];
  /** Stale low-evidence items hidden by default; auditable under include_raw (#315). */
  staleItems: NextAction[];
  /** Scalar-only audit summary (#319). Present whenever raw is built (includeRaw=true). */
  audit: AttentionAuditSummary;
}
```

Add the stub helper above `buildAttentionQueue` (before line 235). The real counting logic replaces the zero body in Step 4:

```ts
/**
 * Pure audit derivation (#319). Counts the post-merge ranked set along three
 * orthogonal dimensions (source / severity / freshness) and partitions it into
 * four outcome buckets. Scalar-only: no slugs, paths, scores, or refs.
 *
 * STEP 1 STUB: returns all zeros so RED invariant tests fail on the counts.
 * Replaced with real counting logic in Step 4.
 */
function computeAttentionAudit(
  all: NextAction[],
  observeOnly: NextAction[],
  staleHidden: NextAction[],
  shown: NextAction[],
  suppressed: number,
  totalInput: number,
): AttentionAuditSummary {
  return {
    totalInput: 0,
    rankedInputCount: 0,
    visibleCount: 0,
    hiddenObserveOnlyCount: 0,
    hiddenStaleCount: 0,
    suppressedBeyondCapCount: 0,
    bySource: { health: 0, discovery: 0 },
    bySeverity: { blocked: 0, auto_repairable: 0, needs_review: 0, observe_only: 0 },
    byFreshness: { fresh: 0, recurring: 0, stale: 0 },
  };
}
```

Wire it into `buildAttentionQueue`. Extract `totalInput` once (DRY) and pass to both `summary` and `audit`. Replace the return block (lines ~278-291):

```ts
  const totalInput = healthDrafts.length + discoveryDrafts.length;

  return {
    items: shown,
    summary: {
      totalInput,
      shownCount: shown.length,
      hiddenObserveOnly: observeOnly.length,
      suppressedBeyondTop3: suppressed,
      hiddenStale: staleHidden.length,
    },
    raw: includeRaw
      ? {
          observeOnlyItems: observeOnly,
          allItemsRanked: all,
          staleItems: staleHidden,
          audit: computeAttentionAudit(all, observeOnly, staleHidden, shown, suppressed, totalInput),
        }
      : null,
  };
```

- [ ] **Step 2: Write the RED unit invariant tests**

Append to `tests/core/attention-queue.test.ts`:

```ts
describe("buildAttentionQueue audit summary (#319)", () => {
  const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z
  const OLD = "2026-05-01 00:00:00";          // well outside FRESH_DAYS
  const RECENT = "2026-07-05 00:00:00";       // inside FRESH_DAYS

  test("audit counts partition the ranked set exactly; breakdowns sum to rankedInputCount", () => {
    // 9 raw drafts; dStale+dStale2 share source_type -> merge into 1 ranked item.
    const hBlocked = healthDraftAt("blocked", "high", "d-blk");
    const hAuto = healthDraftAt("auto_repairable", "medium", "d-auto");
    const hNeeds1 = healthDraftAt("needs_review", "high", "d-nr1");
    const hNeeds2 = healthDraftAt("needs_review", "high", "d-nr2");
    const hObserve = healthDraft("observe_only", "low");
    const dStale = discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD });
    const dStale2 = discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD });
    const dRecurring = discoveryDraft("high", "similar_entity_b", 3, { detectedAt: OLD, lastDetectedAt: OLD });
    const dFresh = discoveryDraft("high", "similar_entity_c", 1, { detectedAt: RECENT, lastDetectedAt: RECENT });

    const q = buildAttentionQueue(
      [hBlocked, hAuto, hNeeds1, hNeeds2, hObserve],
      [dStale, dStale2, dRecurring, dFresh],
      { includeRaw: true, now: NOW },
    );

    expect(q.raw).not.toBeNull();
    const audit = q.raw!.audit;
    expect(audit).toBeDefined();

    // pre-merge vs post-merge (dedup gap = 1 from the dStale merge)
    expect(audit.totalInput).toBe(9);
    expect(audit.rankedInputCount).toBe(8);
    expect(audit.rankedInputCount).toBe(q.raw!.allItemsRanked.length);

    // outcome partition: exact, anchored on post-merge rankedInputCount
    expect(audit.visibleCount).toBe(3);
    expect(audit.hiddenObserveOnlyCount).toBe(1);
    expect(audit.hiddenStaleCount).toBe(1);
    expect(audit.suppressedBeyondCapCount).toBe(3);
    expect(
      audit.visibleCount + audit.hiddenObserveOnlyCount + audit.hiddenStaleCount + audit.suppressedBeyondCapCount,
    ).toBe(audit.rankedInputCount);
    expect(audit.rankedInputCount).toBeLessThanOrEqual(audit.totalInput);

    // breakdowns: post-merge basis, each sums to rankedInputCount
    expect(audit.bySource.health + audit.bySource.discovery).toBe(audit.rankedInputCount);
    expect(audit.bySource.health).toBe(5);
    expect(audit.bySource.discovery).toBe(3);
    expect(
      audit.bySeverity.blocked + audit.bySeverity.auto_repairable +
        audit.bySeverity.needs_review + audit.bySeverity.observe_only,
    ).toBe(audit.rankedInputCount);
    expect(audit.bySeverity.blocked).toBe(1);
    expect(audit.bySeverity.auto_repairable).toBe(1);
    expect(audit.bySeverity.needs_review).toBe(5);
    expect(audit.bySeverity.observe_only).toBe(1);
    expect(
      audit.byFreshness.fresh + audit.byFreshness.recurring + audit.byFreshness.stale,
    ).toBe(audit.rankedInputCount);
    expect(audit.byFreshness.fresh).toBe(6);
    expect(audit.byFreshness.recurring).toBe(1);
    expect(audit.byFreshness.stale).toBe(1);

    // cross-check vs the always-on summary
    expect(audit.totalInput).toBe(q.summary.totalInput);
    expect(audit.visibleCount).toBe(q.summary.shownCount);
    expect(audit.hiddenObserveOnlyCount).toBe(q.summary.hiddenObserveOnly);
    expect(audit.hiddenStaleCount).toBe(q.summary.hiddenStale);
    expect(audit.suppressedBeyondCapCount).toBe(q.summary.suppressedBeyondTop3);

    // AC #6: recurring counted as recurring, NOT hidden stale
    expect(audit.byFreshness.recurring).toBe(1);
    expect(audit.hiddenStaleCount).toBe(1); // only the merged stale discovery
    // AC #7: health is freshness-immune — all 5 health items count as fresh
    expect(audit.byFreshness.fresh).toBeGreaterThanOrEqual(5);
  });

  test("audit absent when includeRaw is false (default surface clean)", () => {
    const q = buildAttentionQueue([healthDraft("needs_review", "high")], []);
    expect(q.raw).toBeNull();
  });

  test("fresh blocker stays visible alongside stale + observe; audit counts it visible", () => {
    const q = buildAttentionQueue(
      [healthDraftAt("blocked", "high", "d-blk"), healthDraft("observe_only", "low")],
      [discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD })],
      { includeRaw: true, now: NOW },
    );
    expect(q.items).toHaveLength(1);
    expect(q.items[0].severity).toBe("blocked");
    expect(q.raw!.audit.visibleCount).toBe(1);
    expect(q.raw!.audit.hiddenObserveOnlyCount).toBe(1);
    expect(q.raw!.audit.hiddenStaleCount).toBe(1);
    expect(q.raw!.audit.suppressedBeyondCapCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they FAIL on the counts**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: FAIL. The stub returns all zeros, so the partition test fails on `expect(audit.totalInput).toBe(9)` (received 0) and `expect(audit.visibleCount).toBe(3)` (received 0). The invariant assertions themselves are what fail — proving they actually lock the accounting rather than just checking the field exists. (The `audit absent when includeRaw is false` test still passes: `raw` is null without `includeRaw`.)

- [ ] **Step 4: Replace the stub body with the real counting logic**

In `src/core/maintenance/attention-queue.ts`, replace the zero-returning body of `computeAttentionAudit` (added in Step 1) with the real derivation. The signature, call site, and `audit` field are already correct from Step 1 — only the function body changes:

```ts
function computeAttentionAudit(
  all: NextAction[],
  observeOnly: NextAction[],
  staleHidden: NextAction[],
  shown: NextAction[],
  suppressed: number,
  totalInput: number,
): AttentionAuditSummary {
  const bySource: Record<"health" | "discovery", number> = { health: 0, discovery: 0 };
  const bySeverity: Record<RepairGroup, number> = {
    blocked: 0,
    auto_repairable: 0,
    needs_review: 0,
    observe_only: 0,
  };
  const byFreshness: Record<Freshness, number> = { fresh: 0, recurring: 0, stale: 0 };
  for (const a of all) {
    bySource[a.source] += 1;
    bySeverity[a.severity] += 1;
    byFreshness[a.freshness ?? "fresh"] += 1;
  }
  return {
    totalInput,
    rankedInputCount: all.length,
    visibleCount: shown.length,
    hiddenObserveOnlyCount: observeOnly.length,
    hiddenStaleCount: staleHidden.length,
    suppressedBeyondCapCount: suppressed,
    bySource,
    bySeverity,
    byFreshness,
  };
}
```

Also update the doc comment: drop the `STEP 1 STUB` note and add — `freshness` is assigned upstream by the `classifyFreshness` loop in `buildAttentionQueue`; the `?? "fresh"` guard is a TS-only safety net (`classifyFreshness` already fails open to fresh) that guarantees every ranked item is counted so each breakdown sums exactly to `rankedInputCount`.

- [ ] **Step 5: Run the tests to verify they PASS**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: PASS — all 52 tests (49 existing + 3 new) green. The partition equation, breakdown sums, and summary cross-checks all hold.

- [ ] **Step 6: Commit**

```bash
git add src/core/maintenance/attention-queue.ts tests/core/attention-queue.test.ts
git commit -m "feat(attention): add scalar audit summary with exact accounting (#319)

Pure computeAttentionAudit helper counts the post-merge ranked set along
source/severity/freshness and partitions it into four outcome buckets.
Attached to raw.audit (include_raw=true only). totalInput (pre-merge) and
rankedInputCount (post-merge) split; partition === rankedInputCount is
locked by RED tests written before the helper.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Lock the MCP audit contract (presence / absence / scalar shape)

**Files:**
- Test: `tests/mcp/next-actions.test.ts`
- Verify (do not edit): `src/mcp/tools/next-actions.ts`

- [ ] **Step 1: Confirm `next-actions.ts` needs no change**

Open `src/mcp/tools/next-actions.ts` and confirm the response builder passes `raw: queue.raw` through `JSON.stringify` (line ~133). Since `queue.raw` now carries `audit`, it serializes automatically. No edit. If for any reason it does not pass `raw` through, stop and surface it — the spec's "no MCP change" assumption is violated.

- [ ] **Step 2: Write the MCP audit contract tests**

Append to `tests/mcp/next-actions.test.ts` (inside the existing `describe("next_actions MCP (#309)", ...)` block):

```ts
  test("include_raw=true exposes scalar-only raw.audit with exact partition (#319)", async () => {
    for (let i = 0; i < 2; i++) {
      db.upsertDiscovery("similar_entity", [`entity/a${i}`, `entity/b${i}`], 0.9, undefined, undefined, "high", false, {});
    }
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeTruthy();
    expect(payload.raw.audit).toBeTruthy();
    const audit = payload.raw.audit;

    // all scalar values are numbers
    for (const v of [
      audit.totalInput, audit.rankedInputCount, audit.visibleCount,
      audit.hiddenObserveOnlyCount, audit.hiddenStaleCount, audit.suppressedBeyondCapCount,
    ]) {
      expect(typeof v).toBe("number");
    }
    // fixed enum keys present
    expect(audit.bySource).toHaveProperty("health");
    expect(audit.bySource).toHaveProperty("discovery");
    expect(audit.bySeverity).toHaveProperty("blocked");
    expect(audit.bySeverity).toHaveProperty("auto_repairable");
    expect(audit.bySeverity).toHaveProperty("needs_review");
    expect(audit.bySeverity).toHaveProperty("observe_only");
    expect(audit.byFreshness).toHaveProperty("fresh");
    expect(audit.byFreshness).toHaveProperty("recurring");
    expect(audit.byFreshness).toHaveProperty("stale");
    // partition invariant holds on the wire
    expect(
      audit.visibleCount + audit.hiddenObserveOnlyCount + audit.hiddenStaleCount + audit.suppressedBeyondCapCount,
    ).toBe(audit.rankedInputCount);

    // scalar-only: no item-derived strings leak into the audit blob
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("entity/");
    expect(auditJson).not.toContain("discovery:");
    expect(auditJson).not.toMatch(/\bscore\b/i);
    expect(auditJson).not.toContain("dedup_key");
    expect(auditJson).not.toContain("/Users/");
  });

  test("default call leaves raw null and exposes no audit key (#319)", async () => {
    db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    const server = createServer(deps);
    const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
    const payload = JSON.parse(res.content[0].text);
    expect(payload.raw).toBeNull();
    // audit must not exist anywhere on the default response
    expect(payload).not.toHaveProperty("audit");
    expect(payload.items.length).toBeLessThanOrEqual(3);
    expect(payload.display).not.toContain("entity/");
  });
```

- [ ] **Step 3: Run the tests to verify they PASS**

Run: `bun test tests/mcp/next-actions.test.ts`
Expected: PASS. The implementation from Task 1 already produces `raw.audit`; these tests lock the MCP wire contract (presence under `include_raw`, absence by default, scalar-only shape, partition holds on the wire). If any assertion fails, do not relax the test — fix the implementation.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/next-actions.test.ts
git commit -m "test(attention): lock MCP audit presence/absence + scalar shape (#319)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Lock read-only invariant under `include_raw=true`

**Files:**
- Test: `tests/mcp/next-actions.test.ts`

Adversarial leakage of the audit blob is already locked by Task 2's scalar-shape test (audit JSON carries no `entity/`, `discovery:`, `score`, `dedup_key`, `/Users/`). Since the audit is counts-only by construction, a corrupted persisted row can leak no more than a clean one, so a separate hostile-fixture audit test would be redundant. This task focuses on 宏哥's third audit point: the `include_raw=true` path stays read-only.

- [ ] **Step 1: Write the read-only test**

Append to `tests/mcp/next-actions.test.ts` (inside the existing describe block):

```ts
  test("include_raw=true path stays read-only: no DB write, no FS write, no candidate insert (#319)", async () => {
    const { id } = db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
    backdateDiscovery(db, id, 30); // stale candidate exercises the audit path
    const beforePending = db.getUnseenDiscoveries(50).length;
    const server = createServer(deps);
    await getTools(server).next_actions.handler({ include_raw: true }); // default sources + raw
    // no discovery status flip
    expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
    // no action candidate insertion
    expect(db.getDiscoveriesByType("action_review_discovery", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_health_review", 50)).toHaveLength(0);
    expect(db.getDiscoveriesByType("action_repair_preview", 50)).toHaveLength(0);
    // no HealthChecker.checkAll FS write
    expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it PASSes**

Run: `bun test tests/mcp/next-actions.test.ts`
Expected: PASS. The `include_raw=true` path performs only SELECTs (same as default); `computeAttentionAudit` is pure. If the read-only test fails, the audit wiring accidentally triggered a write — stop and fix the implementation, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp/next-actions.test.ts
git commit -m "test(attention): lock read-only under include_raw=true (#319)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Full gate + adversarial self-review (宏哥's 3 audit points)

**Files:** none (verification only)

- [ ] **Step 1: Run the full lint + typecheck gate**

Run: `bun run lint`
Expected: exit 0 (per memory `cbrain-typecheck-tests-clean`, lint including `typecheck:tests` is currently green). If it fails, the change introduced a type or lint regression — fix before proceeding.

- [ ] **Step 2: Run the touched test files together**

Run: `bun test tests/core/attention-queue.test.ts tests/mcp/next-actions.test.ts`
Expected: all pass (52 + the new MCP tests).

- [ ] **Step 3: Run `check:ci` to confirm no doc/contract drift**

Run: `bun run check:ci`
Expected: pass. Confirms the no-docs-change assumption holds (`.description()` unchanged → auto-gen tables unchanged).

- [ ] **Step 4: Adversarial self-review — 宏哥's 3 audit points**

Verify each by reading the final `buildAttentionQueue` return block and the MCP response builder:

1. **Default output completely unchanged.** Confirm: when `includeRaw` is false, `raw` is `null` and the `display`/`items`/`summary` fields are produced by exactly the same code paths as before (the only edit in that path is extracting `const totalInput = ...` — a pure rename, same value). Re-run the pre-existing default tests (`returns at most 3 items`, `never writes DB or filesystem`, `dismissed discovery never surfaces`, `default sources merges health + discovery`) — all still green.
2. **Audit has no string leakage.** Confirm `computeAttentionAudit` only reads `source` / `severity` / `freshness` and array lengths — never `title`, `reason`, `suggestion`, `sourceRefs`, `groupKey`, `detectedAt`, `occurrenceCount`, or any ref. Grep the helper body: `grep -nE 'sourceRef|title|reason|suggestion|groupKey|detectedAt|occurrenceCount|dedup' src/core/maintenance/attention-queue.ts` — the only matches must be outside `computeAttentionAudit` (in `toNextAction` / `dedupAndMerge` / `NextAction`).
3. **`include_raw=true` still read-only.** Confirm the audit is computed from in-memory arrays only; no new DB call, no `HealthChecker.checkAll`, no `put_page`/`sync`/`repair`/`merge`, no `updateDiscoveryStatus`, no candidate insert. The Task 3 read-only test is the executable proof.

- [ ] **Step 5: Hand off for 宏哥's review**

Report: diff summary (1 source file + 2 test files, `next-actions.ts` untouched), test counts, the 3 adversarial self-review results, and the `check:ci` result. Do not merge to `main` — leave on the worktree branch for 宏哥's audit.

---

## Self-Review

**Spec coverage:**
- AC #1 (≤3 default) — pre-existing tests, re-verified Task 4 Step 4.1. ✓
- AC #2 (default no leakage) — pre-existing + Task 2 default test. ✓
- AC #3 (include_raw audit with all 8 counts + 3 breakdowns) — Task 1 partition test asserts every field. ✓
- AC #4 (exact accounting, mixed inputs) — Task 1 partition + breakdown + cross-check tests, 9-draft mixed scenario. ✓
- AC #5 (stale counted not displayed) — Task 1 `hiddenStaleCount === 1` + pre-existing stale tests. ✓
- AC #6 (recurring counted as recurring) — Task 1 `byFreshness.recurring === 1`, `hiddenStaleCount === 1`. ✓
- AC #7 (health freshness-immune) — Task 1 `byFreshness.fresh >= 5`. ✓
- AC #8 (read-only) — Task 3 read-only test under `include_raw=true`. ✓
- Hard constraint 1 (pre/post-merge split) — `totalInput` vs `rankedInputCount`, partition anchored on `rankedInputCount`. ✓
- Hard constraint 2 (breakdowns post-merge) — Task 1 breakdown sums === `rankedInputCount`. ✓
- Hard constraint 3 (scalar-only) — Task 2 scalar-shape test asserts the audit JSON carries no item-derived strings (`entity/`, `discovery:`, `score`, `dedup_key`, `/Users/`); audit is counts-only by construction, so this also covers the corrupted-row case. ✓

**Placeholder scan:** None. Every code step has complete code; every run step has a concrete command and expected result.

**Type consistency:** `AttentionAuditSummary` field names (`totalInput`, `rankedInputCount`, `visibleCount`, `hiddenObserveOnlyCount`, `hiddenStaleCount`, `suppressedBeyondCapCount`, `bySource`, `bySeverity`, `byFreshness`) are identical across the interface (Task 1 Step 1), the helper return (Task 1 Step 4), and all test assertions (Tasks 1-3). `computeAttentionAudit` signature is identical at definition (Task 1 Step 4) and call site (Task 1 Step 4 return block). `RepairGroup` and `Freshness` are already imported/defined in `attention-queue.ts`.
