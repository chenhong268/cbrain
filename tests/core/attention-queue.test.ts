import { describe, expect, test } from "bun:test";
import {
  buildAttentionQueue,
  parseDetectedAt,
  classifyFreshness,
  FRESH_DAYS,
  RECURRING_MIN_OCCURRENCES,
} from "../../src/core/maintenance/attention-queue.js";
import type { ActionCandidateDraft } from "../../src/core/maintenance/action-candidates.js";

// ─── Synthetic draft helpers (sentinel-only fixtures) ──────────────────────
// Real drafts are produced by buildActionCandidatesFromHealthPlan / fromDiscoveries.
// Here we synthesize drafts directly so the queue's ranking/cap/observe logic can be
// exercised in isolation. No real slugs, names, or paths anywhere.

function healthDraft(
  group: "auto_repairable" | "needs_review" | "observe_only" | "blocked",
  severity: "high" | "medium" | "low",
): ActionCandidateDraft {
  return healthDraftAt(group, severity, "dim");
}

function healthDraftAt(
  group: "auto_repairable" | "needs_review" | "observe_only" | "blocked",
  severity: "high" | "medium" | "low",
  dimension: string,
): ActionCandidateDraft {
  return {
    type: group === "auto_repairable" ? "action_repair_preview" : "action_health_review",
    entities: [`health:${dimension}:${group}:entity/a`],
    score: severity === "high" ? 0.9 : severity === "medium" ? 0.6 : 0.3,
    actionable: severity,
    displayTitle: "sentinel title",
    displayReason: "sentinel reason",
    suggestedAction: "sentinel suggestion",
    evidence: [{ source: "health", ref: `health:${dimension}:${group}:entity/a`, kind: group }],
    proposedActions: [{ type: "review", target: `health:${dimension}:${group}:entity/a`, reason: "sentinel" }],
    metadata: {
      source: "health",
      source_ref: `health:${dimension}:${group}:entity/a`,
      dimension,
      repair_group: group,
      repair_kind: null,
      severity,
    },
  };
}

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

describe("buildAttentionQueue empty / shape (#309)", () => {
  test("empty inputs produce zero items and zero observe-only", () => {
    const q = buildAttentionQueue([], []);
    expect(q.items).toEqual([]);
    expect(q.summary.shownCount).toBe(0);
    expect(q.summary.hiddenObserveOnly).toBe(0);
    expect(q.summary.suppressedBeyondTop3).toBe(0);
    expect(q.raw).toBe(null);
  });

  test("raw is null without includeRaw", () => {
    const q = buildAttentionQueue([healthDraft("needs_review", "high")], []);
    expect(q.raw).toBe(null);
  });

  test("includeRaw exposes observe-only audit list even when default items empty", () => {
    const observe = healthDraft("observe_only", "low");
    const q = buildAttentionQueue([observe], [], { includeRaw: true });
    expect(q.items).toEqual([]);
    expect(q.summary.hiddenObserveOnly).toBe(1);
    expect(q.raw?.observeOnlyItems).toHaveLength(1);
  });
});

describe("buildAttentionQueue ranking (#309)", () => {
  test("blocked sorts before auto_repairable before needs_review", () => {
    const needs = healthDraftAt("needs_review", "high", "d-needs");
    const auto = healthDraftAt("auto_repairable", "medium", "d-auto");
    const blocked = healthDraftAt("blocked", "high", "d-blocked");
    const q = buildAttentionQueue([needs, auto, blocked], []);
    expect(q.items.map((i) => i.severity)).toEqual(["blocked", "auto_repairable", "needs_review"]);
  });

  test("cap=3 truncates within non-observe groups; surplus counted", () => {
    const drafts = [1, 2, 3, 4, 5].map((i) => healthDraftAt("needs_review", "medium", `d${i}`));
    const q = buildAttentionQueue(drafts, []);
    expect(q.items).toHaveLength(3);
    expect(q.summary.suppressedBeyondTop3).toBe(2);
  });

  test("same dimension+group merges into one item with summed evidence", () => {
    const low = healthDraftAt("needs_review", "low", "dim");
    const high = healthDraftAt("needs_review", "high", "dim");
    const q = buildAttentionQueue([low, high], []);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].evidenceCount).toBe(2);
  });

  test("different dimensions stay separate; rank by severity then groupKey", () => {
    const a = healthDraftAt("needs_review", "high", "dimB");
    const b = healthDraftAt("needs_review", "high", "dimA");
    const q = buildAttentionQueue([a, b], []);
    expect(q.items).toHaveLength(2);
    expect(q.items[0].groupKey).toBe("health:needs_review:dimA:needs_review");
    expect(q.items[1].groupKey).toBe("health:needs_review:dimB:needs_review");
  });

  test("health auto_repairable outranks discovery needs_review across sources", () => {
    const q = buildAttentionQueue(
      [healthDraftAt("auto_repairable", "medium", "d-auto")],
      [discoveryDraft("high")],
    );
    expect(q.items[0].severity).toBe("auto_repairable");
    expect(q.items[0].source).toBe("health");
    expect(q.items[1].severity).toBe("needs_review");
    expect(q.items[1].source).toBe("discovery");
  });
});

describe("buildAttentionQueue discovery + observe (#309)", () => {
  test("discovery maps to needs_review, never blocker", () => {
    const q = buildAttentionQueue([], [discoveryDraft("high")]);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].severity).toBe("needs_review");
    expect(q.items[0].source).toBe("discovery");
  });

  test("observe-only health draft hidden by default; counted", () => {
    const q = buildAttentionQueue([healthDraft("observe_only", "low")], []);
    expect(q.items).toEqual([]);
    expect(q.summary.hiddenObserveOnly).toBe(1);
  });

  test("observe-only does not consume the top-3 budget", () => {
    const q = buildAttentionQueue([
      healthDraftAt("needs_review", "high", "d1"),
      healthDraftAt("needs_review", "high", "d2"),
      healthDraftAt("needs_review", "high", "d3"),
      healthDraft("observe_only", "low"),
    ], []);
    expect(q.items).toHaveLength(3);
    expect(q.summary.hiddenObserveOnly).toBe(1);
  });

  test("discovery dedups by source_type into one merged item", () => {
    const q = buildAttentionQueue([], [
      discoveryDraft("high"),
      discoveryDraft("high"),
      discoveryDraft("medium"),
    ]);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].evidenceCount).toBe(3);
  });
});

describe("buildAttentionQueue include_raw (#309)", () => {
  test("raw ranks observe-only below actionable and preserves order", () => {
    const q = buildAttentionQueue(
      [healthDraft("observe_only", "low"), healthDraftAt("needs_review", "high", "d1")],
      [],
      { includeRaw: true },
    );
    expect(q.items).toHaveLength(1);
    expect(q.items[0].severity).toBe("needs_review");
    expect(q.raw).not.toBeNull();
    expect(q.raw!.allItemsRanked).toHaveLength(2);
    expect(q.raw!.allItemsRanked[1].severity).toBe("observe_only");
    expect(q.raw!.observeOnlyItems.map((i) => i.severity)).toEqual(["observe_only"]);
  });

  test("cap cannot be raised beyond 3 via options for display items", () => {
    const drafts = [1, 2, 3, 4, 5].map((i) => healthDraftAt("needs_review", "high", `d${i}`));
    const q = buildAttentionQueue(drafts, [], { cap: 10 });
    expect(q.items).toHaveLength(3);
    expect(q.summary.suppressedBeyondTop3).toBe(2);
  });

  test("raw includes all ranked items regardless of cap", () => {
    const drafts = [1, 2, 3, 4, 5].map((i) => healthDraftAt("needs_review", "high", `d${i}`));
    const q = buildAttentionQueue(drafts, [], { cap: 10, includeRaw: true });
    expect(q.raw!.allItemsRanked).toHaveLength(5);
  });
});

describe("buildAttentionQueue cap safety (#309)", () => {
  const five = () => [1, 2, 3, 4, 5].map((i) => healthDraftAt("needs_review", "high", `d${i}`));

  test("negative cap clamps to 0 (no tail-slice bypass)", () => {
    const q = buildAttentionQueue(five(), [], { cap: -1 });
    expect(q.items).toHaveLength(0);
    expect(q.summary.suppressedBeyondTop3).toBe(5);
  });

  test("cap -5 still clamps to 0, not 95", () => {
    const q = buildAttentionQueue(five(), [], { cap: -5 });
    expect(q.items).toHaveLength(0);
  });

  test("NaN cap falls back to default 3", () => {
    const q = buildAttentionQueue(five(), [], { cap: NaN });
    expect(q.items).toHaveLength(3);
  });

  test("Infinity cap clamps to default 3", () => {
    const q = buildAttentionQueue(five(), [], { cap: Infinity });
    expect(q.items).toHaveLength(3);
  });
});

describe("buildAttentionQueue privacy (#309)", () => {
  test("sourceRefs carry internal refs but never bleed into display-text fields", () => {
    const d = discoveryDraft("high");
    const q = buildAttentionQueue([], [d]);
    expect(q.items).toHaveLength(1);
    const item = q.items[0];
    for (const field of [item.title, item.reason, item.suggestion]) {
      expect(field).not.toContain("entity/");
      expect(field).not.toContain("/Users/");
      expect(field).not.toMatch(/\bscore\b/i);
      expect(field).not.toContain("discovery:");
    }
    // sourceRefs are the audit channel — internal refs live here, never in display.
    expect(item.sourceRefs[0]).toContain("discovery:");
  });
});

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
