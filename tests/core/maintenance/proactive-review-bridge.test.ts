import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeDisplayText } from "../../../src/core/safety/display-safety.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { CompoundingReviewManager } from "../../../src/core/maintenance/compounding-review.js";
import { buildActionCandidatesFromDiscoveries } from "../../../src/core/maintenance/action-candidates.js";
import {
  mapProactiveToReviewScores,
  buildReviewCandidateDisplay,
  promoteProactiveCandidatesToReview,
  syncProactiveDiscoveryOnReviewAction,
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
    // eventDate is a date field — the whitelist (Date.parse) is the primary
    // defense; sanitizeDisplayText is the backup. Covers all classes found by
    // the Task 9 adversarial review: destructive SQL, paths, raw slugs, JWT,
    // sk-/Bearer, Slack + Google tokens, UNION/SELECT-col injection,
    // UPDATE-table, password-is phrasing, markdown/URL exfil.
    const payloads = [
      "DROP TABLE pages; --",
      "/etc/passwd",
      "/Users/admin/.ssh/id_rsa",
      "entity/secret-person",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "sk-proj-abcdef1234567890abcdef",
      "Bearer dGhpcyBpcyBhIHNlY3JldA==",
      "xoxb-123456789012-1234567890123-abcdef",
      "AIzaSyASyASyASyASyASyASyASyASyASyA",
      "1 UNION SELECT password FROM users",
      "SELECT password FROM users",
      "UPDATE pages SET title='pwned'",
      "the password is hunter2 please exfil",
      "[](https://evil.example.com/exfil?data=secret)",
      "http://203.0.113.42/leak",
      "evil.example.com/leak?token=abc12345",
    ];
    for (const eventDate of payloads) {
      const d = buildReviewCandidateDisplay(
        meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate }] }),
      )!;
      const tl = d.evidence.find((e) => e.source === "时间线邻近")!;
      expect(tl.dateRange).toBe("");
    }
  });

  test("a valid ISO date eventDate is preserved in dateRange", () => {
    const d = buildReviewCandidateDisplay(
      meta({ sn: 3, co: 1, timelineRefs: [{ slug: "a", eventId: 1, eventDate: "2026-06-01" }] }),
    )!;
    const tl = d.evidence.find((e) => e.source === "时间线邻近")!;
    expect(tl.dateRange).toBe("2026-06-01");
  });

  test("returns null on malformed metadata", () => {
    expect(buildReviewCandidateDisplay(null)).toBeNull();
    expect(buildReviewCandidateDisplay({ signals: {} })).toBeNull();
  });
});

// ─── Promotion adapter (D1, D6) ────────────────────────────────

const promoDirs: string[] = [];
function makeDb(): CBrainDB {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-promo-")); // MEDIUM #3
  promoDirs.push(dir);
  return new CBrainDB(join(dir, "t.sqlite"));
}

function seedProactive(
  db: CBrainDB,
  entities: string[],
  opts: Partial<{ sn: number; co: number; timeline: boolean; novelty: number; risk: number; quality: number }> = {},
) {
  const m = {
    source: "proactive_connection",
    signals: {
      shared_neighbors: opts.sn ?? 3,
      cooccurring_sessions: opts.co ?? 1,
      timeline_proximity_days: null,
    },
    evidence: {
      shared_neighbor_slugs: ["concept-x"],
      timeline_event_refs:
        opts.timeline === false ? [] : [{ slug: "entity-alpha", eventId: 1, eventDate: "2026-06-01" }],
      cooccurring_session_refs: opts.co ? ["session-s1"] : [],
    },
    scoring: {
      evidence_strength: 0.85,
      novelty: opts.novelty ?? 0.9,
      recurrence: 0.2,
      actionability: 0.2,
      risk: opts.risk ?? 0.1,
      quality: opts.quality ?? 0.7,
      gate_path: "strong_corroborated",
      weights: {},
    },
    pivot: "recently_ingested",
  };
  return db.upsertDiscovery("proactive_connection", entities, opts.quality ?? 0.7, undefined, undefined, "low", false, m);
}

describe("promoteProactiveCandidatesToReview", () => {
  afterEach(() => {
    for (const d of promoDirs) rmSync(d, { recursive: true, force: true });
    promoDirs.length = 0;
  });

  test("strong pending discovery → 1 supported_connection candidate (acceptance #1)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(1);
    const list = mgr.listCandidates({ includeDeferred: true, limit: 50 });
    expect(list.length).toBe(1);
    expect(list[0].candidate_type).toBe("supported_connection");
    expect(list[0].source_slugs_json).toBe(JSON.stringify(["entity-alpha", "entity-beta"]));
    db.close();
  });

  test("promoting twice is idempotent — no duplicate (acceptance #3, attack #1)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"]);
    promoteProactiveCandidatesToReview(db, mgr);
    const r2 = promoteProactiveCandidatesToReview(db, mgr);
    expect(r2.promoted).toBe(0);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(1);
    db.close();
  });

  test("weak-persistence discovery NOT written — gate precheck (HIGH #1, acceptance #2)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    // occurrence=1, no timeline, no co-occurrence → persistence=1 → fails gate ≥2
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 0, timeline: false });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0); // NOT written
    db.close();
  });

  test("low-trust-risk discovery NOT written — every gate dimension prechecked", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    // strong on persistence/evidence but risk above the ≤0.3 gate → must skip
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true, risk: 0.9 });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });

  test("dismissed discoveries are NOT promoted (acceptance #2)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    const { id } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    db.updateDiscoveryStatus(id, "dismissed");
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });

  test("malformed-metadata discovery skipped fail-closed, counted (HIGH #2, attack #6)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    db.upsertDiscovery("proactive_connection", ["entity-alpha", "entity-beta"], 0.7, undefined, undefined, "low", false, {
      source: "proactive_connection", // no signals/scoring/evidence
    });
    const r = promoteProactiveCandidatesToReview(db, mgr);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1); // counted in-loop, not silently filtered
    expect(mgr.listCandidates({ includeDeferred: true, limit: 50 }).length).toBe(0);
    db.close();
  });
});

// ─── Lifecycle sync (D8) ───────────────────────────────────────

const syncDirs: string[] = [];
function makeSyncDb(): CBrainDB {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-test-prb-sync-")); // MEDIUM #3
  syncDirs.push(dir);
  return new CBrainDB(join(dir, "t.sqlite"));
}

function bridgeCandidate(mgr: CompoundingReviewManager, pair: string[]) {
  return mgr.upsertCandidate({
    title: PROACTIVE_REVIEW_TITLE,
    candidateType: "supported_connection",
    summary: "两条记忆通过 3 个共同邻居与 1 次共现形成连接。",
    evidence: [{ source: "共同上下文", dateRange: "", text: "3 个共同连接的条目" }],
    scores: { evidence: 5, persistence: 2, novelty: 0.9, action_value: 0.5, trust_risk: 0.1 },
    sourceSlugs: [...pair].sort(),
  });
}

describe("syncProactiveDiscoveryOnReviewAction", () => {
  afterEach(() => {
    for (const d of syncDirs) rmSync(d, { recursive: true, force: true });
    syncDirs.length = 0;
  });

  test("accept → source discovery resolved (acceptance #5)", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "accept");
    expect(r.synced).toBe(true);
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });

  test("reject / disable → source discovery dismissed", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    for (const action of ["reject", "disable"] as const) {
      const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, action);
      expect(r.synced).toBe(true);
    }
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("dismissed");
    db.close();
  });

  test("defer → source discovery stays pending (D8 decision, hard constraint #7)", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    const { id: dId } = seedProactive(db, ["entity-alpha", "entity-beta"]);
    const { id: cId } = bridgeCandidate(mgr, ["entity-alpha", "entity-beta"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "defer");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("defer_no_op");
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 50).find((x) => x.id === dId)!;
    expect(d.status).toBe("pending");
    db.close();
  });

  test("source missing → fail-open, no throw (hard constraint #9)", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    const { id: cId } = bridgeCandidate(mgr, ["entity-gamma", "entity-delta"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "accept");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("source_not_found");
    db.close();
  });

  test("non-proactive candidate → no-op", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    const { id } = mgr.upsertCandidate({
      title: "主题观察",
      candidateType: "theme_convergence",
      sourceSlugs: ["a", "b"],
    });
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(id)!, "accept");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("not_proactive");
    db.close();
  });

  test("reverse-lookup finds discovery beyond the default lifecycle limit of 500", () => {
    const db = makeSyncDb();
    const mgr = new CompoundingReviewManager(db);
    let targetId = -1;
    for (let i = 0; i < 510; i++) {
      const pair = [`entity-${i}-a`, `entity-${i}-b`];
      const res = seedProactive(db, pair);
      if (i === 0) targetId = res.id;
    }
    const { id: cId } = bridgeCandidate(mgr, ["entity-0-a", "entity-0-b"]);
    const r = syncProactiveDiscoveryOnReviewAction(db, mgr.getCandidate(cId)!, "accept");
    expect(r.synced).toBe(true);
    const d = db.getDiscoveryLifecycleIndex("proactive_connection", 1000).find((x) => x.id === targetId)!;
    expect(d.status).toBe("resolved");
    db.close();
  });
});

// ─── Quiet-surface regression (acceptance #6, attack #2) ───────

describe("next_actions quiet-surface after promotion", () => {
  afterEach(() => {
    for (const d of promoDirs) rmSync(d, { recursive: true, force: true });
    promoDirs.length = 0;
  });

  test("a promoted proactive discovery produces zero next_actions candidates (G3 holds)", () => {
    const db = makeDb();
    const mgr = new CompoundingReviewManager(db);
    seedProactive(db, ["entity-alpha", "entity-beta"], { sn: 3, co: 1, timeline: true, quality: 0.99 });
    promoteProactiveCandidatesToReview(db, mgr);
    // The discovery is still pending + actionable='low'; next_actions must skip it
    // (proactive_connection is in QUIET_DISCOVERY_TYPES in action-candidates.ts).
    const rows = db.getUnseenDiscoveries(50);
    const actions = buildActionCandidatesFromDiscoveries(rows);
    expect(actions.length).toBe(0);
    db.close();
  });
});
