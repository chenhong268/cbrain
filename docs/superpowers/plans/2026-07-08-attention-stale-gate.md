# Hide Stale Low-Evidence next_actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a freshness/age gate to `buildAttentionQueue` / `next_actions` so the default top-1..3 output hides stale low-evidence discovery candidates, while keeping them auditable under `include_raw`. No writes, no schema migration, no new MCP tool.

**Architecture:** Freshness metadata (`detected_at` / `last_detected_at` / `occurrence_count`) already lives on persisted discovery rows and is already fetched by `next_actions` via `getDiscoveryById`. We only thread it through `ActionCandidateDraft.metadata` → a new optional block on `NextAction`, then classify it (`fresh` / `recurring` / `stale`) inside the pure `buildAttentionQueue`. The stale gate runs AFTER ranking but BEFORE the top-3 slice, so hidden stale items release their budget to fresher items without ever bypassing the cap. Health-source items are immune to the gate (a stale structural health signal is not less important); only discovery / action-review items can go stale. Missing/malformed timestamps fail OPEN as fresh.

**Tech Stack:** TypeScript (strict, ESNext), `bun:test`, `bun:sqlite`. No new deps.

**Issue:** #315 (parent roadmap #276). Builds on the read-only `next_actions` surface from #309.

---

## Scope & Non-goals (from #315)

In scope: freshness metadata on `NextAction`, `classifyFreshness` pure function, stale gate in `buildAttentionQueue`, `summary.hiddenStale`, `raw.staleItems`, `next_actions` display hint.

Non-goals (hard boundaries):
- No new MCP tool. No schema migration. No `sqlite.ts` SELECT changes (fields already present).
- No mutation of discoveries, `seen`, statuses, pages, links, aliases, health files, filesystem.
- No `HealthChecker.checkAll` anywhere on this surface.
- No change to `read_discoveries` / `run_discovery` / `read_action_candidates` behavior (only shared type plumbing on `DiscoveryCandidateSource`).
- `next_actions` stays strictly read-only.

## Design decisions (locked, call out during review)

1. **Health source is immune to the stale gate.** `classifyFreshness` returns `"fresh"` for any `source === "health"` (covers `blocked` / `auto_repairable` / `needs_review` health). Issue #315 only requires `blocked` / `auto_repairable` to stay eligible; extending immunity to all health is strictly more conservative and correct (a stale structural health signal is not lower priority). Discovery is always `needs_review` (#309 invariant), so only discovery / action-review items can ever be `stale`.
2. **Gate order: rank → drop stale → slice(cap).** Dropping stale BEFORE the slice means a hidden stale item frees its slot for the next fresh/recurring item, but the displayed count can never exceed `cap` (adversarial #2).
3. **Merge keeps the most favorable freshness.** `dedupAndMerge` takes the newest `lastDetectedAt`/`detectedAt` and the max `occurrenceCount` across merged peers, so a merged group is never hidden when any peer would individually stay eligible.
4. **Effective timestamp = `lastDetectedAt ?? detectedAt`.** "Stale" means "hasn't re-occurred recently", so the last-seen timestamp governs; first-seen is fallback.
5. **Fail open.** Missing / malformed timestamp → `fresh` (never hide). Verified by parse returning `null` and classify short-circuiting.
6. **`now` is injectable** into `buildAttentionQueue` for deterministic core tests. MCP tests cannot inject `now` (handler uses `Date.now()`), so they seed a real old `detected_at` via `db.rawDb` (existing pattern).

## File Structure

- `src/core/maintenance/attention-queue.ts` — ADD `Freshness` type, `FRESH_DAYS`, `RECURRING_MIN_OCCURRENCES`, `parseDetectedAt`, `classifyFreshness`; EXTEND `NextAction` + `AttentionQueueSummary` + `AttentionQueueRaw`; MODIFY `toNextAction`, `dedupAndMerge`, `buildAttentionQueue`.
- `src/core/maintenance/action-candidates.ts` — EXTEND `DiscoveryCandidateSource` with optional `detected_at` / `last_detected_at`; thread them through `reviewDiscoveryDraft` and `persistedCandidateRowToDraft` metadata.
- `src/mcp/tools/next-actions.ts` — EXTEND the plain-discovery `map` to also carry `last_detected_at`; EXTEND `renderDisplay` with a `hiddenStale` hint. `items[]` mapping is UNCHANGED (no freshness metadata leaks to the public surface).
- `src/storage/sqlite.ts` — **no changes** (`getDiscoveryById` already returns all three fields).
- `tests/core/attention-queue.test.ts` — ADD freshness/stale tests + extend helpers.
- `tests/mcp/next-actions.test.ts` — ADD stale-hiding / recurring / include_raw / read-only / privacy tests.

---

## Task 1: `Freshness` primitives + `NextAction` fields (pure, TDD)

**Files:**
- Modify: `src/core/maintenance/attention-queue.ts` (top of file: types + constants + helpers; `NextAction` interface)
- Test: `tests/core/attention-queue.test.ts` (new describe block; new import)

- [ ] **Step 1: Write failing tests for `parseDetectedAt` + `classifyFreshness`**

Append to `tests/core/attention-queue.test.ts` (add to the existing import line at top: `parseDetectedAt`, `classifyFreshness`, `FRESH_DAYS`, `RECURRING_MIN_OCCURRENCES`):

```ts
import {
  buildAttentionQueue,
  parseDetectedAt,
  classifyFreshness,
  FRESH_DAYS,
  RECURRING_MIN_OCCURRENCES,
} from "../../src/core/maintenance/attention-queue.js";
```

Append a new describe block at the end of the file:

```ts
describe("freshness primitives (#315)", () => {
  const NOW = Date.UTC(2026, 6, 8, 12, 0, 0); // 2026-07-08T12:00:00Z, deterministic

  test("named constants are the issue-mandated values", () => {
    expect(FRESH_DAYS).toBe(14);
    expect(RECURRING_MIN_OCCURRENCES).toBe(3);
  });

  test("parseDetectedAt normalizes SQLite datetime (UTC) and ISO; null/missing/garbage -> null", () => {
    expect(parseDetectedAt("2026-06-20 12:00:00")).toBe(Date.UTC(2026, 5, 20, 12, 0, 0));
    expect(parseDetectedAt("2026-06-20T12:00:00Z")).toBe(Date.UTC(2026, 5, 20, 12, 0, 0));
    expect(parseDetectedAt(null)).toBe(null);
    expect(parseDetectedAt(undefined)).toBe(null);
    expect(parseDetectedAt("")).toBe(null);
    expect(parseDetectedAt("not-a-date")).toBe(null);
  });

  test("health source is always fresh regardless of age (immune to stale gate)", () => {
    const old = "2020-01-01 00:00:00";
    expect(classifyFreshness({ source: "health", severity: "blocked", detectedAt: old, lastDetectedAt: old, occurrenceCount: 0, now: NOW })).toBe("fresh");
    expect(classifyFreshness({ source: "health", severity: "auto_repairable", detectedAt: old, lastDetectedAt: old, occurrenceCount: 0, now: NOW })).toBe("fresh");
    expect(classifyFreshness({ source: "health", severity: "needs_review", detectedAt: old, lastDetectedAt: old, occurrenceCount: 0, now: NOW })).toBe("fresh");
  });

  test("discovery within FRESH_DAYS is fresh", () => {
    const recent = "2026-07-01 12:00:00"; // 7 days before NOW
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: recent, lastDetectedAt: recent, occurrenceCount: 1, now: NOW })).toBe("fresh");
  });

  test("old discovery with occurrence_count < 3 is stale", () => {
    const old = "2026-06-01 12:00:00"; // > FRESH_DAYS before NOW
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: old, lastDetectedAt: old, occurrenceCount: 2, now: NOW })).toBe("stale");
  });

  test("old discovery with occurrence_count >= 3 is recurring (stays eligible)", () => {
    const old = "2026-06-01 12:00:00";
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: old, lastDetectedAt: old, occurrenceCount: 3, now: NOW })).toBe("recurring");
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: old, lastDetectedAt: old, occurrenceCount: 9, now: NOW })).toBe("recurring");
  });

  test("missing/malformed timestamp fails OPEN as fresh (never hidden)", () => {
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: null, lastDetectedAt: null, occurrenceCount: 1, now: NOW })).toBe("fresh");
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: "garbage", lastDetectedAt: undefined, occurrenceCount: 0, now: NOW })).toBe("fresh");
  });

  test("effective timestamp prefers lastDetectedAt over detectedAt", () => {
    // first-seen ancient, last-seen recent -> fresh
    expect(classifyFreshness({ source: "discovery", severity: "needs_review", detectedAt: "2020-01-01 00:00:00", lastDetectedAt: "2026-07-05 12:00:00", occurrenceCount: 1, now: NOW })).toBe("fresh");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: FAIL — `parseDetectedAt` / `classifyFreshness` / `FRESH_DAYS` / `RECURRING_MIN_OCCURRENCES` not exported.

- [ ] **Step 3: Implement primitives + extend `NextAction`**

In `src/core/maintenance/attention-queue.ts`, add after the existing `import` lines and before `export interface NextAction`:

```ts
/** Freshness bucket assigned by the stale gate (#315). Pure, derived, never persisted. */
export type Freshness = "fresh" | "recurring" | "stale";

/** Issue #315 constants — named, not magic. */
export const FRESH_DAYS = 14;
export const RECURRING_MIN_OCCURRENCES = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Parse a persisted discovery timestamp to epoch ms. SQLite `datetime('now')` emits
 * "YYYY-MM-DD HH:MM:SS" in UTC; normalize to ISO-UTC before parsing. Returns null for
 * missing/malformed input so callers fail OPEN (treat as fresh, never hide). #315
 */
export function parseDetectedAt(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const iso = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

interface ClassifyFreshnessArgs {
  source: "health" | "discovery";
  severity: RepairGroup;
  detectedAt: string | null | undefined;
  lastDetectedAt: string | null | undefined;
  occurrenceCount: number | null | undefined;
  now: number;
}

/**
 * Pure freshness classification (#315).
 *   - health source is immune: structural health signals do not lose priority with age;
 *   - missing/malformed timestamp fails OPEN as fresh (never silently hidden);
 *   - discovery older than FRESH_DAYS with occurrence_count < RECURRING_MIN_OCCURRENCES is stale;
 *   - recurring (occurrence_count >= RECURRING_MIN_OCCURRENCES) stays eligible.
 * Effective timestamp is lastDetectedAt ?? detectedAt ("hasn't re-occurred recently").
 */
export function classifyFreshness(args: ClassifyFreshnessArgs): Freshness {
  if (args.source === "health") return "fresh";
  const ts = parseDetectedAt(args.lastDetectedAt) ?? parseDetectedAt(args.detectedAt);
  if (ts === null) return "fresh";
  const ageDays = (args.now - ts) / MS_PER_DAY;
  if (ageDays <= FRESH_DAYS) return "fresh";
  const occ = typeof args.occurrenceCount === "number" && args.occurrenceCount > 0 ? args.occurrenceCount : 0;
  return occ >= RECURRING_MIN_OCCURRENCES ? "recurring" : "stale";
}
```

Extend the `NextAction` interface (add the optional freshness block at the end — do not change existing fields):

```ts
export interface NextAction {
  severity: RepairGroup;
  source: "health" | "discovery";
  title: string;
  reason: string;
  suggestion: string;
  evidenceCount: number;
  groupKey: string;
  /** raw/debug only — stable refs, never reach default display */
  sourceRefs: string[];
  /** raw/debug + classification input — never reaches the public items[] surface (#315). */
  detectedAt?: string | null;
  lastDetectedAt?: string | null;
  occurrenceCount?: number;
  freshness?: Freshness;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: PASS — all freshness-primitive tests green; existing #309 tests still green (new fields are optional, `classifyFreshness`/`parseDetectedAt` are additive exports).

- [ ] **Step 5: Commit**

```bash
git add src/core/maintenance/attention-queue.ts tests/core/attention-queue.test.ts
git commit -m "feat(attention): freshness primitives + NextAction fields (#315)"
```

---

## Task 2: Thread freshness metadata draft → NextAction

**Files:**
- Modify: `src/core/maintenance/action-candidates.ts` (`DiscoveryCandidateSource`, `reviewDiscoveryDraft`, `persistedCandidateRowToDraft`)
- Modify: `src/core/maintenance/attention-queue.ts` (`toNextAction`)
- Test: `tests/core/attention-queue.test.ts` (extend helpers; new wiring test)

- [ ] **Step 1: Extend the core-test draft helpers to optionally carry timestamps**

In `tests/core/attention-queue.test.ts`, replace the `discoveryDraft` helper with a version that accepts optional timestamps, and add a tiny reader test. Replace the existing `discoveryDraft` function (lines ~43-65) with:

```ts
function discoveryDraft(
  actionable: "high" | "medium" | "low",
  sourceType = "similar_entity",
  occurrence = 1,
  opts: { detectedAt?: string; lastDetectedAt?: string } = {},
): ActionCandidateDraft {
  return {
    type: "action_review_discovery",
    entities: [`discovery:${sourceType}|entity/a|entity/b`],
    score: 0.7,
    actionable,
    displayTitle: "有一条发现值得复核",
    displayReason: "sentinel discovery reason",
    suggestedAction: "sentinel discovery suggestion",
    evidence: [{ source: "discovery", ref: `discovery:${sourceType}|entity/a|entity/b`, kind: sourceType }],
    proposedActions: [{ type: "review", target: `discovery:${sourceType}|entity/a|entity/b`, reason: "sentinel" }],
    metadata: {
      source: "discovery",
      source_type: sourceType,
      source_ref: `discovery:${sourceType}|entity/a|entity/b`,
      occurrence_count: occurrence,
      detected_at: opts.detectedAt,
      last_detected_at: opts.lastDetectedAt,
    },
  };
}
```

Append a wiring test (new describe block at end of file):

```ts
describe("toNextAction freshness metadata wiring (#315)", () => {
  test("discovery draft metadata is carried onto NextAction timestamp/occurrence fields", () => {
    const q = buildAttentionQueue(
      [],
      [discoveryDraft("high", "similar_entity", 2, { detectedAt: "2026-06-01 00:00:00", lastDetectedAt: "2026-06-01 00:00:00" })],
      { includeRaw: true },
    );
    const item = q.raw!.allItemsRanked[0];
    expect(item.detectedAt).toBe("2026-06-01 00:00:00");
    expect(item.lastDetectedAt).toBe("2026-06-01 00:00:00");
    expect(item.occurrenceCount).toBe(2);
    // freshness classification is asserted in Task 3 once buildAttentionQueue assigns it.
  });

  test("health draft without timestamps leaves detected fields null", () => {
    const q = buildAttentionQueue([healthDraft("needs_review", "high")], [], { includeRaw: true });
    const item = q.raw!.allItemsRanked[0];
    expect(item.source).toBe("health");
    expect(item.detectedAt).toBeNull();
    expect(item.lastDetectedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: FAIL — `toNextAction` does not yet read or emit `detectedAt` / `lastDetectedAt` / `occurrenceCount`, so `item.detectedAt` is `undefined` (not the seeded timestamp).

- [ ] **Step 3: Extend `DiscoveryCandidateSource` and thread metadata in builders**

In `src/core/maintenance/action-candidates.ts`, extend the `DiscoveryCandidateSource` interface (add two optional fields — runtime already carries `detected_at` from `getUnseenDiscoveries`; this is the shared type plumbing #315 explicitly allows):

```ts
export interface DiscoveryCandidateSource {
  id: number;
  type: string;
  entities: string;
  score: number;
  actionable: string;
  proposed_actions?: string | null;
  auto_applicable?: number;
  metadata?: string | null;
  occurrence_count?: number;
  dedup_key?: string | null;
  detected_at?: string;
  last_detected_at?: string | null;
}
```

In `reviewDiscoveryDraft`, add the two timestamps into the returned `metadata` block (after `occurrence_count: occurrenceCount,`):

```ts
    metadata: {
      source: "discovery",
      source_type: row.type,
      source_ref: ref,
      occurrence_count: occurrenceCount,
      detected_at: row.detected_at,
      last_detected_at: row.last_detected_at ?? null,
      evidence: [{ source: "discovery", ref, kind: row.type }],
      source_metadata: metadata,
    },
```

In `persistedCandidateRowToDraft`, add the three fields into the returned `metadata` block. The `row` argument is the full `getDiscoveryById` return (it carries `detected_at`, `last_detected_at`, `occurrence_count`). Replace the existing `metadata: { ... }` block with:

```ts
    metadata: {
      source,
      repair_group: row.type === "action_repair_preview" ? "auto_repairable" : "needs_review",
      source_type: source === "discovery" ? String(meta.source_type ?? row.type) : undefined,
      dimension: source === "health" ? String(meta.dimension ?? "dim") : undefined,
      repair_kind: source === "health" ? ((meta.repair_kind as string | null | undefined) ?? null) : undefined,
      detected_at: row.detected_at,
      last_detected_at: row.last_detected_at ?? null,
      occurrence_count: row.occurrence_count,
    },
```

- [ ] **Step 4: Read freshness fields in `toNextAction`**

In `src/core/maintenance/attention-queue.ts`, add two small meta-readers near the other private helpers (before `toNextAction`):

```ts
function readMetaString(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function readMetaNumber(meta: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
```

Replace the body of `toNextAction` so it carries the freshness fields onto the returned `NextAction`:

```ts
function toNextAction(draft: ActionCandidateDraft): NextAction {
  const source = draftSource(draft);
  const groupKey = source === "health" ? healthGroupKey(draft) : discoveryGroupKey(draft);
  const detectedAt = readMetaString(draft.metadata, "detected_at", "detectedAt");
  const lastDetectedAt = readMetaString(draft.metadata, "last_detected_at", "lastDetectedAt");
  const occurrenceCount = readMetaNumber(draft.metadata, "occurrence_count", "occurrenceCount");
  return {
    severity: draftSeverity(draft),
    source,
    title: draft.displayTitle,
    reason: draft.displayReason,
    suggestion: draft.suggestedAction,
    evidenceCount: 1,
    groupKey,
    sourceRefs: draft.entities.slice(),
    detectedAt,
    lastDetectedAt,
    occurrenceCount,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: PASS — both wiring tests green (timestamp + occurrence fields carried through); all #309 tests still green. This is a clean green commit: Task 2 asserts ONLY metadata wiring, never `freshness` (classification + `freshness` assignment land in Task 3).

- [ ] **Step 6: Commit (draft→NextAction wiring; freshness assignment still pending Task 3)**

```bash
git add src/core/maintenance/action-candidates.ts src/core/maintenance/attention-queue.ts tests/core/attention-queue.test.ts
git commit -m "feat(attention): thread freshness metadata into NextAction (#315)"
```

---

## Task 3: Stale gate inside `buildAttentionQueue`

**Files:**
- Modify: `src/core/maintenance/attention-queue.ts` (`AttentionQueueSummary`, `AttentionQueueRaw`, `BuildAttentionQueueOptions`, `dedupAndMerge`, `buildAttentionQueue`)
- Test: `tests/core/attention-queue.test.ts` (new stale-gate describe block)

- [ ] **Step 1: Write failing stale-gate tests**

Append to `tests/core/attention-queue.test.ts`:

```ts
describe("buildAttentionQueue stale gate (#315)", () => {
  const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);
  const OLD = "2026-05-01 00:00:00"; // well outside FRESH_DAYS
  const RECENT = "2026-07-05 00:00:00";

  test("stale low-evidence discovery is hidden by default and counted in hiddenStale", () => {
    const q = buildAttentionQueue(
      [],
      [discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD })],
      { now: NOW },
    );
    expect(q.items).toHaveLength(0);
    expect(q.summary.hiddenStale).toBe(1);
  });

  test("stale discovery with occurrence_count >= 3 (recurring) stays visible", () => {
    const q = buildAttentionQueue(
      [],
      [discoveryDraft("high", "similar_entity", 3, { detectedAt: OLD, lastDetectedAt: OLD })],
      { now: NOW },
    );
    expect(q.items).toHaveLength(1);
    expect(q.summary.hiddenStale).toBe(0);
    expect(q.items[0].freshness).toBe("recurring");
  });

  test("old blocked / auto_repairable health items stay visible and classified fresh (immune)", () => {
    const blocked = { ...healthDraftAt("blocked", "high", "d"), metadata: { ...healthDraftAt("blocked", "high", "d").metadata, detected_at: OLD, last_detected_at: OLD } };
    const auto = { ...healthDraftAt("auto_repairable", "medium", "d2"), metadata: { ...healthDraftAt("auto_repairable", "medium", "d2").metadata, detected_at: OLD, last_detected_at: OLD } };
    const q = buildAttentionQueue([blocked, auto], [], { now: NOW });
    expect(q.items.map((i) => i.severity)).toEqual(["blocked", "auto_repairable"]);
    expect(q.items.every((i) => i.freshness === "fresh")).toBe(true);
    expect(q.summary.hiddenStale).toBe(0);
  });

  test("stale gate does NOT bypass the top-3 cap (slot released to fresh item)", () => {
    // 1 stale + 3 fresh actionable discovery items, cap=3 -> shown=3 (not 4), stale hidden separately.
    const stale = discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD });
    const fresh = (dim: string) => discoveryDraft("high", `similar_entity_${dim}`, 1, { detectedAt: RECENT, lastDetectedAt: RECENT });
    const q = buildAttentionQueue([], [stale, fresh("a"), fresh("b"), fresh("c")], { now: NOW });
    expect(q.items).toHaveLength(3);
    expect(q.summary.hiddenStale).toBe(1);
    expect(q.summary.shownCount).toBeLessThanOrEqual(3);
  });

  test("include_raw exposes staleItems audit list and hiddenStale count", () => {
    const q = buildAttentionQueue(
      [],
      [discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD })],
      { includeRaw: true, now: NOW },
    );
    expect(q.items).toHaveLength(0);
    expect(q.summary.hiddenStale).toBe(1);
    expect(q.raw).not.toBeNull();
    expect(q.raw!.staleItems).toHaveLength(1);
    expect(q.raw!.staleItems[0].freshness).toBe("stale");
  });

  test("missing timestamp fails open: discovery draft without timestamps stays visible", () => {
    const q = buildAttentionQueue([], [discoveryDraft("high")], { now: NOW });
    expect(q.items).toHaveLength(1);
    expect(q.summary.hiddenStale).toBe(0);
  });

  test("merged discovery group keeps the most favorable freshness (not hidden)", () => {
    // one stale peer + one fresh peer, same source_type -> merged group is fresh
    const stalePeer = discoveryDraft("high", "similar_entity", 1, { detectedAt: OLD, lastDetectedAt: OLD });
    const freshPeer = discoveryDraft("high", "similar_entity", 1, { detectedAt: RECENT, lastDetectedAt: RECENT });
    const q = buildAttentionQueue([], [stalePeer, freshPeer], { now: NOW });
    expect(q.items).toHaveLength(1);
    expect(q.summary.hiddenStale).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: FAIL — `summary.hiddenStale` undefined; `raw.staleItems` undefined; `now` option rejected; stale items still shown.

- [ ] **Step 3: Extend summary/raw/options types**

In `src/core/maintenance/attention-queue.ts`:

```ts
export interface AttentionQueueSummary {
  totalInput: number;
  shownCount: number;
  hiddenObserveOnly: number;
  suppressedBeyondTop3: number;
  /** Stale low-evidence items hidden from default output (#315). */
  hiddenStale: number;
}

export interface AttentionQueueRaw {
  observeOnlyItems: NextAction[];
  allItemsRanked: NextAction[];
  /** Stale low-evidence items hidden by default; auditable under include_raw (#315). */
  staleItems: NextAction[];
}

export interface BuildAttentionQueueOptions {
  includeRaw?: boolean;
  /** Default 3; clamped to 3 — display output never exceeds 3. */
  cap?: number;
  /** Deterministic clock for the stale gate (#315). Defaults to Date.now(). */
  now?: number;
}
```

- [ ] **Step 4: Merge freshness favorably in `dedupAndMerge`**

Add a `newerTimestamp` helper next to the other private helpers (before `dedupAndMerge`), then replace the `dedupAndMerge` function body so merged peers keep the newest timestamps and max occurrence count:

```ts
/** Return whichever of two timestamp strings parses as newer; null if both unparseable. #315 */
function newerTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = parseDetectedAt(a);
  const tb = parseDetectedAt(b);
  if (ta === null) return b ?? null;
  if (tb === null) return a ?? null;
  return ta >= tb ? (a ?? null) : (b ?? null);
}

/** Merge same-groupKey items: sum evidence, union sourceRefs, keep most-favorable freshness. Stable first-seen order. */
function dedupAndMerge(actions: NextAction[]): NextAction[] {
  const map = new Map<string, NextAction>();
  for (const a of actions) {
    const prev = map.get(a.groupKey);
    if (!prev) {
      map.set(a.groupKey, { ...a, sourceRefs: a.sourceRefs.slice() });
    } else {
      prev.evidenceCount += a.evidenceCount;
      for (const ref of a.sourceRefs) if (!prev.sourceRefs.includes(ref)) prev.sourceRefs.push(ref);
      // Favor eligibility: newest last/first-seen + max occurrence so a merge never
      // hides a group when any peer would individually stay visible. #315
      prev.detectedAt = newerTimestamp(prev.detectedAt, a.detectedAt);
      prev.lastDetectedAt = newerTimestamp(prev.lastDetectedAt, a.lastDetectedAt);
      prev.occurrenceCount = Math.max(prev.occurrenceCount ?? 0, a.occurrenceCount ?? 0);
    }
  }
  return [...map.values()];
}
```

- [ ] **Step 5: Apply the stale gate in `buildAttentionQueue`**

Replace the body of `buildAttentionQueue` with the version that classifies freshness, partitions stale items out BEFORE the cap slice, and reports `hiddenStale`:

```ts
export function buildAttentionQueue(
  healthDrafts: ActionCandidateDraft[],
  discoveryDrafts: ActionCandidateDraft[],
  options?: BuildAttentionQueueOptions,
): AttentionQueue {
  // Clamp BOTH bounds: negative cap would hit `slice(0, cap)` counting from the tail
  // and bypass the ≤3 ceiling. NaN/Infinity fall back to default. #309 adversarial fix.
  const requested = options?.cap;
  const cap = typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(0, Math.min(requested, DEFAULT_CAP))
    : DEFAULT_CAP;
  const includeRaw = options?.includeRaw === true;
  const now = typeof options?.now === "number" && Number.isFinite(options?.now) ? options!.now : Date.now();

  const all = dedupAndMerge([
    ...healthDrafts.map(toNextAction),
    ...discoveryDrafts.map(toNextAction),
  ]);
  // Classify AFTER merge so occurrence_count/timestamps reflect the merged group.
  for (const a of all) {
    a.freshness = classifyFreshness({
      source: a.source,
      severity: a.severity,
      detectedAt: a.detectedAt,
      lastDetectedAt: a.lastDetectedAt,
      occurrenceCount: a.occurrenceCount,
      now,
    });
  }
  all.sort(rankCompare);

  const observeOnly = all.filter((a) => a.severity === "observe_only");
  const actionable = all.filter((a) => a.severity !== "observe_only");

  // Stale gate runs BEFORE the cap slice: hidden stale items release their budget to
  // fresher items. Health is immune (classifyFreshness), so only discovery/action-review
  // items can land here. The slice still enforces the hard ≤3 ceiling. #315
  const eligible = actionable.filter((a) => a.freshness !== "stale");
  const staleHidden = actionable.filter((a) => a.freshness === "stale");

  const shown = eligible.slice(0, cap);
  const suppressed = eligible.length - shown.length;

  return {
    items: shown,
    summary: {
      totalInput: healthDrafts.length + discoveryDrafts.length,
      shownCount: shown.length,
      hiddenObserveOnly: observeOnly.length,
      suppressedBeyondTop3: suppressed,
      hiddenStale: staleHidden.length,
    },
    raw: includeRaw
      ? { observeOnlyItems: observeOnly, allItemsRanked: all, staleItems: staleHidden }
      : null,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/core/attention-queue.test.ts`
Expected: PASS — all stale-gate tests green; Task 2's pending `freshness` assertions now green; all #309 tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/core/maintenance/attention-queue.ts tests/core/attention-queue.test.ts
git commit -m "feat(attention): hide stale low-evidence items in buildAttentionQueue (#315)"
```

---

## Task 4: Wire `next_actions` MCP + display hint

**Files:**
- Modify: `src/mcp/tools/next-actions.ts` (plain-discovery `map`, `renderDisplay`)
- Test: `tests/mcp/next-actions.test.ts` (new stale tests)

- [ ] **Step 1: Write failing MCP tests**

Append to `tests/mcp/next-actions.test.ts` (inside the existing top-level `describe`):

```ts
test("stale low-occurrence discovery is hidden by default; hiddenStale counted (#315)", async () => {
  const { id } = db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
  // Backdate the row well past FRESH_DAYS, occurrence_count stays 1.
  (db as unknown as { rawDb: { prepare: (q: string) => { run: (p: Record<string, unknown>) => void } } })
    .rawDb.prepare("UPDATE discoveries SET detected_at = datetime('now','-30 days'), last_detected_at = datetime('now','-30 days') WHERE id = $id")
    .run({ $id: id });
  const server = createServer(deps);
  const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
  const payload = JSON.parse(res.content[0].text);
  expect(payload.items).toHaveLength(0);
  expect(payload.summary.hiddenStale).toBe(1);
  expect(payload.display).toContain("无需");
});

test("stale discovery with occurrence_count >= 3 stays visible (#315)", async () => {
  const { id } = db.upsertDiscovery("similar_entity", ["entity/c", "entity/d"], 0.9, undefined, undefined, "high", false, {});
  (db as unknown as { rawDb: { prepare: (q: string) => { run: (p: Record<string, unknown>) => void } } })
    .rawDb.prepare("UPDATE discoveries SET detected_at = datetime('now','-30 days'), last_detected_at = datetime('now','-30 days'), occurrence_count = 3 WHERE id = $id")
    .run({ $id: id });
  const server = createServer(deps);
  const res = await getTools(server).next_actions.handler({ sources: ["discovery"] }) as ToolResponse;
  const payload = JSON.parse(res.content[0].text);
  expect(payload.items).toHaveLength(1);
  expect(payload.summary.hiddenStale).toBe(0);
});

test("include_raw exposes stale audit but display/items leak nothing (#315)", async () => {
  const { id } = db.upsertDiscovery("similar_entity", ["entity/private-a", "entity/private-b"], 0.9, undefined, undefined, "high", false, {});
  (db as unknown as { rawDb: { prepare: (q: string) => { run: (p: Record<string, unknown>) => void } } })
    .rawDb.prepare("UPDATE discoveries SET detected_at = datetime('now','-30 days'), last_detected_at = datetime('now','-30 days') WHERE id = $id")
    .run({ $id: id });
  const server = createServer(deps);
  const res = await getTools(server).next_actions.handler({ sources: ["discovery"], include_raw: true }) as ToolResponse;
  const payload = JSON.parse(res.content[0].text);
  expect(payload.summary.hiddenStale).toBe(1);
  expect(payload.raw.staleItems).toBeInstanceOf(Array);
  expect(payload.raw.staleItems.length).toBe(1);
  // display + items[] must not leak internal identifiers
  expect(payload.display).not.toContain("entity/");
  expect(payload.display).not.toContain("/Users/");
  expect(payload.display).not.toMatch(/\bscore\b/i);
  expect(payload.display).not.toContain("dedup_key");
  for (const it of payload.items) {
    expect(JSON.stringify(it)).not.toContain("entity/");
    expect(JSON.stringify(it)).not.toContain("dedup_key");
  }
});

test("next_actions stays read-only even with a stale candidate present (#315)", async () => {
  const { id } = db.upsertDiscovery("similar_entity", ["entity/a", "entity/b"], 0.9, undefined, undefined, "high", false, {});
  (db as unknown as { rawDb: { prepare: (q: string) => { run: (p: Record<string, unknown>) => void } } })
    .rawDb.prepare("UPDATE discoveries SET detected_at = datetime('now','-30 days') WHERE id = $id")
    .run({ $id: id });
  const beforePending = db.getUnseenDiscoveries(50).length;
  const server = createServer(deps);
  await getTools(server).next_actions.handler({});
  expect(db.getUnseenDiscoveries(50).length).toBe(beforePending);
  // no HealthChecker.checkAll -> no health FS dir
  expect(existsSync(join(deps.runtimePath, "health"))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp/next-actions.test.ts`
Expected: FAIL — first test expects 0 items / `hiddenStale === 1` but currently the item shows and `hiddenStale` is absent.

- [ ] **Step 3: Carry `last_detected_at` in the plain-discovery map**

In `src/mcp/tools/next-actions.ts`, extend the plain-discovery `map` (the block reading `getUnseenDiscoveries`) so rows also carry `last_detected_at`. Replace the existing `const rows = ctx.db.getUnseenDiscoveries(50).map(...)` block with:

```ts
      const rows = ctx.db.getUnseenDiscoveries(50).map((row) => {
        const full = ctx.db.getDiscoveryById(row.id);
        return {
          ...row,
          occurrence_count: full?.occurrence_count,
          dedup_key: full?.dedup_key,
          detected_at: row.detected_at,
          last_detected_at: full?.last_detected_at ?? null,
        };
      });
```

- [ ] **Step 4: Add a `hiddenStale` hint to `renderDisplay`**

In `src/mcp/tools/next-actions.ts`, inside `renderDisplay`, add a branch to the `tail` array (after the `suppressedBeyondTop3` branch):

```ts
  if (summary.hiddenStale > 0) {
    tail.push(`另有 ${summary.hiddenStale} 条长期未变动的低优先级发现已隐藏，可用 include_raw 查看。`);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/mcp/next-actions.test.ts`
Expected: PASS — all four new tests green; existing #309 MCP tests still green (their `summary` assertions use single-field access; the new `hiddenStale: 0` on fresh items is additive).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/next-actions.ts tests/mcp/next-actions.test.ts
git commit -m "feat(attention): next_actions hides stale candidates + audit hint (#315)"
```

---

## Task 5: Adversarial review + full verification

**Files:** none (verification + reporting only).

- [ ] **Step 1: Run the targeted suites**

```bash
bun test tests/core/attention-queue.test.ts tests/mcp/next-actions.test.ts tests/mcp/action-candidates.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Run the static gate + full check**

```bash
bun run lint
bun run check
```
Expected: both PASS (`tsc --noEmit` + biome lint; `bun test` full suite green — confirms no #309 regression).

- [ ] **Step 3: Walk the #315 adversarial checklist and record results**

For each item, verify by code path + test, then record PASS/FAIL in the commit/PR note:
1. **Stale gate cannot hide blocked / auto_repairable.** `classifyFreshness` returns `"fresh"` for `source === "health"` (covers both). Covered by Task 3 "old blocked / auto_repairable health items stay visible".
2. **Stale gate cannot bypass top-3 cap.** Gate runs before `eligible.slice(0, cap)`. Covered by Task 3 "stale gate does NOT bypass the top-3 cap".
3. **Stale raw audit does not leak into display/items.** `NextAction` freshness fields are never added to the `items[]` mapping in `next-actions.ts`; `renderDisplay` only renders `title`/`reason`/`suggestion`. Covered by Task 4 "include_raw exposes stale audit but display/items leak nothing".
4. **next_actions performs no writes / no `HealthChecker.checkAll`.** No new DB writes introduced; handler still only calls `getDiscoveriesByType` / `getDiscoveryById` / `getUnseenDiscoveries`. Covered by Task 4 "next_actions stays read-only".
5. **Malformed / missing fields fail open.** `parseDetectedAt` returns null → `classifyFreshness` returns `"fresh"`. Covered by Task 1 "missing/malformed timestamp fails OPEN" + Task 3 "missing timestamp fails open".
6. **#309 behavior intact + `bun run check` passes.** Step 2 confirms.

- [ ] **Step 4: Do NOT push, do NOT close #315.** Leave the branch with independent commits for Codex review, per issue instructions.

---

## Self-review notes

- **Spec coverage:** freshness metadata (Task 1+2), `fresh`/`recurring`/`stale` classification (Task 1), default hides stale (Task 3+4), `summary.hiddenStale` (Task 3), `include_raw` exposes stale audit (Task 3+4), recurring stays eligible (Task 1+3), blocked/auto_repairable immune (Task 1+3), fail-open (Task 1+3), read-only (Task 4), #309 intact (Task 5). All #315 acceptance criteria covered.
- **No schema/SELECT changes** — confirmed `getDiscoveryById` already returns `detected_at` / `last_detected_at` / `occurrence_count`; `next_actions` already calls it. `sqlite.ts` untouched.
- **No placeholders** — every code step shows full code.
- **Type consistency** — `Freshness`, `hiddenStale`, `staleItems`, `now` used consistently across Tasks 1–4. `DiscoveryCandidateSource` new fields match what `reviewDiscoveryDraft` / `persistedCandidateRowToDraft` write and `toNextAction` reads.
