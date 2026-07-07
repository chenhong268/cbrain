import { describe, test, expect } from "bun:test";
import { sanitizeDisplayText } from "../../../src/core/safety/display-safety.js";
import {
  mapProactiveToReviewScores,
  REVIEW_ACTION_VALUE,
} from "../../../src/core/maintenance/proactive-review-bridge.js";

describe("sanitizeDisplayText", () => {
  test("returns text when safe", () => {
    expect(sanitizeDisplayText("2026-06-01", "")).toBe("2026-06-01");
    expect(sanitizeDisplayText("正常文本", "fallback")).toBe("正常文本");
  });
  test("returns fallback when a hostile pattern matches", () => {
    expect(sanitizeDisplayText("DROP TABLE pages; --", "X")).toBe("X");
    expect(sanitizeDisplayText("/etc/passwd", "X")).toBe("X");
    expect(sanitizeDisplayText("score: 0.9 dedup_key", "X")).toBe("X");
  });
});

// ─── Score mapping (D4) ────────────────────────────────────────

function meta(opts: Partial<{
  sn: number;
  co: number;
  timelineRefs: unknown[];
  novelty: number;
  risk: number;
}> = {}) {
  return {
    source: "proactive_connection",
    signals: {
      shared_neighbors: opts.sn ?? 3,
      cooccurring_sessions: opts.co ?? 1,
      timeline_proximity_days: null,
    },
    evidence: {
      shared_neighbor_slugs: ["concept-x"],
      timeline_event_refs:
        opts.timelineRefs ?? [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }],
      cooccurring_session_refs: ["session-s1"],
    },
    scoring: {
      evidence_strength: 0.85,
      novelty: opts.novelty ?? 0.9,
      recurrence: 0.2,
      actionability: 0.2,
      risk: opts.risk ?? 0.1,
      quality: 0.7,
      gate_path: "strong_corroborated",
      weights: {},
    },
    pivot: "recently_ingested",
  };
}

describe("mapProactiveToReviewScores", () => {
  test("strong pair + both supporting signals → evidence/persistence pass all gates", () => {
    const s = mapProactiveToReviewScores(
      meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "2026-06-01" }] }),
      1,
    )!;
    expect(s).not.toBeNull();
    expect(s.evidence).toBeGreaterThanOrEqual(3);
    expect(s.persistence).toBeGreaterThanOrEqual(2);
    expect(s.novelty).toBe(0.9);
    expect(s.action_value).toBe(REVIEW_ACTION_VALUE);
    expect(s.trust_risk).toBe(0.1);
  });

  test("one-shot detection without dual corroboration → persistence FAILS gate", () => {
    const s = mapProactiveToReviewScores(
      meta({ sn: 3, co: 0, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "2026-06-01" }] }),
      1,
    )!;
    expect(s.persistence).toBe(1); // fails ≥2 (the tightness lever)
    expect(s.evidence).toBeGreaterThanOrEqual(3);
  });

  test("recurrence alone (occurrence≥2, no dual) → persistence passes", () => {
    const s = mapProactiveToReviewScores(meta({ sn: 3, co: 0, timelineRefs: [] }), 2)!;
    expect(s.persistence).toBe(2);
  });

  test("returns null when signals missing (fail-closed)", () => {
    expect(mapProactiveToReviewScores({ source: "proactive_connection" }, 1)).toBeNull();
    expect(mapProactiveToReviewScores(null, 1)).toBeNull();
  });

  test("returns null when scoring.novelty/risk missing (fail-closed)", () => {
    const m = meta();
    delete (m.scoring as Record<string, unknown>).novelty;
    expect(mapProactiveToReviewScores(m, 1)).toBeNull();
  });

  test("returns null when metadata is malformed (gate attack #6)", () => {
    expect(mapProactiveToReviewScores("not-an-object", 1)).toBeNull();
    expect(mapProactiveToReviewScores({ signals: "nope" }, 1)).toBeNull();
  });
});
