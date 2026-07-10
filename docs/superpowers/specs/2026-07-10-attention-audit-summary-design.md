# Attention Audit Summary — Design Spec

**Issue:** #319 (parent: #276 attention governance)
**Date:** 2026-07-10
**Status:** Direction approved; pending spec review

## Problem

`next_actions` already hides observe-only and stale low-occurrence items by default and caps visible output at 3. The existing `summary` carries five counts (`totalInput`, `shownCount`, `hiddenObserveOnly`, `suppressedBeyondTop3`, `hiddenStale`) but no source/severity/freshness breakdowns, so it is hard to evaluate over time whether the attention layer is reducing noise without hiding important work.

> Why did CBrain show these items, and what did it intentionally keep quiet?

## Scope

Add a small, read-only, scalar-only attention audit summary to the existing `next_actions` path, surfaced only under `include_raw=true`. No change to default display, items, compact summary, ranking policy, or lifecycle. No DB writes. No new persistence.

## Design

### Shape

New interface in `src/core/maintenance/attention-queue.ts`:

```ts
export interface AttentionAuditSummary {
  totalInput: number;               // pre-merge: raw drafts entering buildAttentionQueue (== summary.totalInput)
  rankedInputCount: number;         // post-merge: dedup/merged ranked set size (== raw.allItemsRanked.length)
  visibleCount: number;             // shown.length
  hiddenObserveOnlyCount: number;   // observeOnly.length
  hiddenStaleCount: number;         // staleHidden.length
  suppressedBeyondCapCount: number; // eligible.length - shown.length
  bySource: Record<"health" | "discovery", number>;
  bySeverity: Record<RepairGroup, number>;   // blocked / auto_repairable / needs_review / observe_only
  byFreshness: Record<Freshness, number>;     // fresh / recurring / stale
}
```

Naming is camelCase to match the existing `AttentionQueueSummary` convention (the issue's snake_case was illustrative; "names can be adjusted"). `bySeverity` is tightened to `Record<RepairGroup, number>` (four fixed keys) rather than the issue's loose `Record<string, number>`, so the key set is stable for machine consumers.

### Placement

The audit lives on `AttentionQueueRaw.audit`:

```ts
export interface AttentionQueueRaw {
  observeOnlyItems: NextAction[];
  allItemsRanked: NextAction[];
  staleItems: NextAction[];
  audit: AttentionAuditSummary;   // #319 — present whenever raw is built
}
```

`raw` is built only when `includeRaw === true`; default calls return `raw: null`, so the audit cannot reach the default response. The MCP tool (`next-actions.ts`) needs no change — `raw` is already passed through via `JSON.stringify`, so `audit` rides along.

### Computation

A pure helper derived from the arrays `buildAttentionQueue` already computes:

```ts
function computeAttentionAudit(
  all: NextAction[],            // post-merge ranked set
  observeOnly: NextAction[],
  staleHidden: NextAction[],
  shown: NextAction[],
  suppressed: number,
  totalInput: number,           // pre-merge raw draft count
): AttentionAuditSummary
```

Called inside `buildAttentionQueue` only when `includeRaw` is true. No DB access, no IO, no re-classification — it reads `source` / `severity` / `freshness` already assigned to each `NextAction`.

## Hard Constraints (reviewer-mandated)

1. **Pre-merge vs post-merge counted separately.** `totalInput` = raw draft count (pre-merge, == `summary.totalInput`). `rankedInputCount` = `allItemsRanked.length` (post-merge). The exact equality is anchored on post-merge (see Accounting Invariants), never on `totalInput`.

2. **Breakdown basis is post-merge `allItemsRanked`.** `bySource`, `bySeverity`, `byFreshness` count the ranked (merged) set only. Raw drafts are never mixed in — merged `sourceRefs` would otherwise make totals not reconcile.

3. **Audit is scalar-only.** The audit summary contains numbers and fixed enum keys only. It must not introduce slug, title, sourceRefs, dedup_key, path, or score fields. The existing `include_raw` lists (`observeOnlyItems`, `allItemsRanked`, `staleItems`) are unchanged; the audit is an additional scalar blob alongside them.

## Accounting Invariants

For every `buildAttentionQueue` call with `includeRaw=true`:

- `visibleCount + hiddenObserveOnlyCount + hiddenStaleCount + suppressedBeyondCapCount === rankedInputCount` — exact partition of the post-merge ranked set; every ranked item lands in exactly one outcome bucket.
- `rankedInputCount <= totalInput` — dedup/merge only reduces.
- `bySource.health + bySource.discovery === rankedInputCount`.
- `Σ bySeverity (4 keys) === rankedInputCount`.
- `Σ byFreshness (3 keys) === rankedInputCount`.

Cross-checks against the existing always-on `summary`:

- `totalInput === summary.totalInput`
- `visibleCount === summary.shownCount`
- `hiddenObserveOnlyCount === summary.hiddenObserveOnly`
- `hiddenStaleCount === summary.hiddenStale`
- `suppressedBeyondCapCount === summary.suppressedBeyondTop3`

## What Does NOT Change

- Default `display`, `items[]`, and `summary` — byte-for-byte unchanged.
- Ranking policy, severity taxonomy, freshness classification, cap ceiling (3), observe-only hiding, stale gate, recurring eligibility, health immunity.
- No DB schema, no persistence, no lifecycle transitions.
- `next_actions` stays read-only (see Hard Acceptance).

## Hard Acceptance Criteria

1. Default `next_actions` shows at most 3 items.
2. Default `next_actions` display/items/summary expose no raw slugs, paths, scores, debug terms, SQL, secrets, or dedup keys.
3. `include_raw=true` returns `raw.audit` with counts for: total input, ranked input, visible, observe-only hidden, stale hidden, cap-suppressed, source breakdown, severity breakdown, freshness breakdown.
4. Accounting is exact (invariants above); tests cover mixed fresh/stale/observe/recurring inputs.
5. Stale low-occurrence discovery items are counted (`hiddenStaleCount`) but not displayed by default.
6. Recurring stale discovery items remain eligible and are counted under `byFreshness.recurring`, not `hiddenStaleCount`.
7. Health-derived items remain freshness-immune (counted under `byFreshness.fresh`).
8. **Read-only (hard):** `next_actions` runs no `HealthChecker.checkAll`, writes no reports/files, updates no discovery status, inserts no action candidates, and calls no put_page/sync/repair/merge. `buildAttentionQueue` stays a pure function (no DB, no IO). The `include_raw=true` path is held to the same read-only invariant.

## Test Plan (anonymous sentinel fixtures only)

`tests/core/attention-queue.test.ts`:
- Mixed health + discovery + observe-only + stale + recurring inputs; assert all audit fields and every invariant (partition `===`, breakdown sums, cross-check vs `summary`).
- Audit present only when `includeRaw=true`; absent (raw null) otherwise.
- Recurring counted as `recurring`, not `hiddenStale`; health counted as `fresh`.

`tests/mcp/next-actions.test.ts`:
- `include_raw=true`: `raw.audit` exists; all values are numbers; all keys are fixed enum literals; no item-derived string values (no slug/title/path/score/dedup_key anywhere on the audit object).
- Default call: `raw === null` (audit does not leak).
- Read-only regression with `include_raw=true`: pending discovery count unchanged; no `action_*` rows inserted; no health output directory created.

## Adversarial Review Checklist

1. Default display remains clean and capped; no audit field reaches the default response.
2. Raw audit introduces no private examples and no unbounded payloads — scalar counts only, fixed enum keys.
3. A fresh blocker stays visible when stale and observe-only items are present; the audit counts it under `visibleCount`, not hidden.
4. Stale low-evidence candidates are quiet but counted (`hiddenStaleCount`).
5. The tool remains read-only under `include_raw=true`: no DB status update, no report write, no repair/sync/merge call.

## Non-goals

No DB schema changes; no new persistence table; no automatic repair/delete/merge/resolve/dismiss/promote; no ranking policy change beyond exact accounting; no recall/search/ingest changes; no connector notification work; no real names, paths, or private knowledge in tests/docs/issues.

## Files

- `src/core/maintenance/attention-queue.ts` — add `AttentionAuditSummary`, `computeAttentionAudit`, attach `audit` to `AttentionQueueRaw`.
- `src/mcp/tools/next-actions.ts` — no change (raw passthrough already serializes audit).
- `tests/core/attention-queue.test.ts` — audit unit tests + invariants.
- `tests/mcp/next-actions.test.ts` — audit presence/absence, bounded shape, read-only regression.

Docs: none. `audit` is an additive raw-channel field; the tool `.description()` already says "审计明细" and needs no change, so no auto-gen doc regeneration is triggered.
