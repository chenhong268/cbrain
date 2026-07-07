import { describe, test, expect } from "bun:test";
import { sanitizeDisplayText } from "../../../src/core/safety/display-safety.js";
import {
  mapProactiveToReviewScores,
  buildReviewCandidateDisplay,
  REVIEW_ACTION_VALUE,
  PROACTIVE_REVIEW_TITLE,
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

// ─── Display builder (D5) ──────────────────────────────────────

describe("buildReviewCandidateDisplay", () => {
  test("fixed anonymous title; count-templated summary; labeled evidence", () => {
    const d = buildReviewCandidateDisplay(
      meta({ sn: 3, co: 2, timelineRefs: [{ slug: "entity-alpha", eventId: 7, eventDate: "2026-06-01" }] }),
    )!;
    expect(d.title).toBe(PROACTIVE_REVIEW_TITLE);
    expect(d.summary).toContain("3");
    expect(d.summary).toContain("2");
    expect(d.evidence.length).toBe(3);
    const sources = d.evidence.map((e) => e.source);
    expect(sources).toContain("共同上下文");
    expect(sources).toContain("共现会话");
    expect(sources).toContain("时间线邻近");
  });

  test("no raw slugs / event ids / session refs / scores leak into display", () => {
    const d = buildReviewCandidateDisplay(
      meta({ sn: 3, co: 1, timelineRefs: [{ slug: "entity-alpha", eventId: 99, eventDate: "2026-06-01" }] }),
    )!;
    const blob = JSON.stringify(d);
    expect(blob).not.toContain("entity-alpha");
    expect(blob).not.toContain("concept-x");
    expect(blob).not.toContain("session-s1");
    expect(blob).not.toContain("eventId");
    expect(blob).not.toContain("score");
    expect(blob).not.toContain("dedup_key");
  });

  test("hostile eventDate is sanitized to empty dateRange (privacy attack #4)", () => {
    // Representative payloads the current DISPLAY_UNSAFE_PATTERNS catches
    // (destructive SQL, paths, raw slugs, JWT, sk-, Bearer). Wider secret-class
    // coverage is added by the Task 9 adversarial review.
    const payloads = [
      "DROP TABLE pages; --",
      "/etc/passwd",
      "/Users/admin/.ssh/id_rsa",
      "entity/secret-person",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "sk-proj-abcdef1234567890abcdef",
      "Bearer dGhpcyBpcyBhIHNlY3JldA==",
    ];
    for (const eventDate of payloads) {
      const d = buildReviewCandidateDisplay(
        meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate }] }),
      )!;
      const tl = d.evidence.find((e) => e.source === "时间线邻近")!;
      expect(tl.dateRange).toBe("");
    }
  });

  test("returns null on malformed metadata", () => {
    expect(buildReviewCandidateDisplay(null)).toBeNull();
    expect(buildReviewCandidateDisplay({ signals: {} })).toBeNull();
  });
});
