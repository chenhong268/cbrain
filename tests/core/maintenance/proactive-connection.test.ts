import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import {
  detectProactiveConnections,
  pairKey,
  produceProactiveConnectionCandidates,
  scoreProactiveConnectionCandidate,
  acceptedEntityBoost,
  FEEDBACK_BOOST,
} from "../../../src/core/maintenance/proactive-connection.js";

const testDir = "/tmp/cbrain-test-proactive-connection";
const dbPath = join(testDir, "test.sqlite");

function seedPage(
  db: CBrainDB,
  slug: string,
  title: string,
  type = "entity/person",
  mentionCount = 0,
): void {
  db.rawDb
    .prepare(
      "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count, hotness_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, datetime('now'), datetime('now'))",
    )
    .run(slug, type, title, `${slug}.md`, null, mentionCount);
}

function seedLink(db: CBrainDB, from: string, to: string, relation = "mentions"): void {
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
    .run(from, to, relation);
}

function seedQueryLog(db: CBrainDB, sessionId: string, resultSlugs: string[]): void {
  db.rawDb
    .prepare(
      "INSERT INTO query_log (tool, query, result_slugs, result_count, session_id) VALUES ('recall', 'q', ?, ?, ?)",
    )
    .run(JSON.stringify(resultSlugs), resultSlugs.length, sessionId);
}

function seedTimeline(db: CBrainDB, slug: string, eventDate: string, summary = "e"): void {
  db.rawDb
    .prepare("INSERT INTO timeline (page_slug, event_date, summary) VALUES (?, ?, ?)")
    .run(slug, eventDate, summary);
}

/** entity-alpha and entity-beta share 2 neighbors (project-gamma, concept-delta), unlinked. */
function seedSharedPair(
  db: CBrainDB,
  opts: { sessions?: boolean; timeline?: boolean } = {},
): void {
  seedPage(db, "entity-alpha", "Alpha");
  seedPage(db, "entity-beta", "Beta");
  for (const s of ["project-gamma", "concept-delta"]) {
    seedPage(db, s, s, "entity/project");
    seedLink(db, "entity-alpha", s);
    seedLink(db, "entity-beta", s);
  }
  if (opts.sessions) {
    seedQueryLog(db, "s1", ["entity-alpha", "entity-beta"]);
    seedQueryLog(db, "s2", ["entity-alpha", "entity-beta"]);
  }
  if (opts.timeline) {
    seedTimeline(db, "entity-alpha", "2026-06-01");
    seedTimeline(db, "entity-beta", "2026-06-10"); // 9 days apart
  }
}

function findPair(
  candidates: ReturnType<typeof detectProactiveConnections>,
  a: string,
  b: string,
) {
  const key = pairKey(a, b);
  return candidates.find((c) => pairKey(c.a, c.b) === key);
}

let db: CBrainDB;

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  db = new CBrainDB(dbPath);
});

afterEach(() => {
  db.close();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("scoreProactiveConnectionCandidate (#311)", () => {
  const inBounds = (n: number) => n >= 0.01 && n <= 1;

  it("strong + corroborated: sn=3, B+C → strong_corroborated, dimension values match spec D1", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 3, signalB: true, signalC: true, occurrenceCount: 0 });
    expect(s.gate_path).toBe("strong_corroborated");
    expect(s.evidence_strength).toBeCloseTo(0.85, 5); // 0.40 + 0.15·1 + 0.15 + 0.15
    expect(s.novelty).toBe(1);
    expect(s.recurrence).toBe(0.01); // clamp01(0/5)
    expect(s.actionability).toBe(0.20);
    expect(s.risk).toBeCloseTo(0.10, 5); // 0.60 − 0.20 − 0.20 − 0.10·1
    expect(s.quality).toBeCloseTo(0.6495, 3); // weighted sum
    for (const v of [s.evidence_strength, s.novelty, s.recurrence, s.actionability, s.risk, s.quality]) {
      expect(inBounds(v)).toBe(true);
    }
  });

  it("multi-independent: sn=2, B+C → multi_independent (path 2)", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 2, signalB: true, signalC: true, occurrenceCount: 0 });
    expect(s.gate_path).toBe("multi_independent");
    expect(s.evidence_strength).toBeCloseTo(0.70, 5); // 0.40 + 0 + 0.15 + 0.15
    expect(s.risk).toBeCloseTo(0.20, 5); // 0.60 − 0.20 − 0.20 − 0
    // sn=2 < STRONG_SHARED(3) so path 1 is not taken even with both signals.
  });

  it("Phase 0 case sn=2 + only B is now REJECTED (strengthened gate)", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 2, signalB: true, signalC: false, occurrenceCount: 0 });
    expect(s.gate_path).toBe("rejected");
    // dimensions still computed (for debug/_debug only)
    expect(s.evidence_strength).toBeCloseTo(0.55, 5);
  });

  it("sn=2 + no supporting → rejected", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 2, signalB: false, signalC: false, occurrenceCount: 0 });
    expect(s.gate_path).toBe("rejected");
  });

  it("strong path needs only one supporting: sn=3 + B only → strong_corroborated", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 3, signalB: true, signalC: false, occurrenceCount: 0 });
    expect(s.gate_path).toBe("strong_corroborated");
    expect(s.evidence_strength).toBeCloseTo(0.70, 5); // 0.40 + 0.15·1 + 0.15 + 0
  });

  it("recurrence: occurrenceCount flows into novelty (decay) and recurrence (growth)", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 3, signalB: true, signalC: true, occurrenceCount: 2 });
    expect(s.novelty).toBeCloseTo(0.5, 5); // 1/(1+0.5·2)
    expect(s.recurrence).toBeCloseTo(0.4, 5); // 2/5
    expect(s.gate_path).toBe("strong_corroborated");
  });

  it("recurrence clamps at 1 for high occurrence; novelty keeps decaying", () => {
    const s = scoreProactiveConnectionCandidate({ sharedNeighbors: 3, signalB: true, signalC: true, occurrenceCount: 10 });
    expect(s.recurrence).toBe(1); // clamp01(10/5)
    expect(s.novelty).toBeCloseTo(1 / 6, 5); // 1/(1+0.5·10)
    expect(s.novelty).toBeGreaterThanOrEqual(0.01);
  });

  it("quality stays in (0.01, 1] across boundary inputs", () => {
    for (const occ of [0, 1, 5, 50]) {
      for (const sn of [2, 3, 8]) {
        const s = scoreProactiveConnectionCandidate({ sharedNeighbors: sn, signalB: true, signalC: true, occurrenceCount: occ });
        expect(inBounds(s.quality)).toBe(true);
      }
    }
  });
});

describe("acceptedEntityBoost (#314)", () => {
  it("0 hits → 0 boost", () => {
    expect(acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set())).toBe(0);
  });
  it("1 hit → FEEDBACK_BOOST", () => {
    expect(acceptedEntityBoost(["entity-alpha", "entity-gamma"], new Set(["entity-alpha"]))).toBe(FEEDBACK_BOOST);
  });
  it("2 hits → 2 * FEEDBACK_BOOST (both entities accepted)", () => {
    expect(
      acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set(["entity-alpha", "entity-beta"])),
    ).toBe(2 * FEEDBACK_BOOST);
  });
  it("never exceeds 2 * FEEDBACK_BOOST (a candidate has only 2 entities)", () => {
    expect(
      acceptedEntityBoost(["entity-alpha", "entity-beta"], new Set(["entity-alpha", "entity-beta", "entity-gamma"])),
    ).toBe(2 * FEEDBACK_BOOST);
  });
});

describe("detectProactiveConnections", () => {
  it("returns no candidates on an empty graph", () => {
    expect(detectProactiveConnections(db, { since: "1970-01-01" })).toEqual([]);
  });

  it("Signal A: shared >=2 neighbors and unlinked → candidate", () => {
    seedSharedPair(db);
    const c = findPair(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 }), "entity-alpha", "entity-beta");
    expect(c).toBeDefined();
    expect(c!.signalA).toBe(true);
    expect(c!.sharedNeighbors).toBe(2);
  });

  it("Signal A: directly linked pair → no candidate", () => {
    seedSharedPair(db);
    seedLink(db, "entity-alpha", "entity-beta"); // now directly connected
    const c = findPair(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 }), "entity-alpha", "entity-beta");
    expect(c).toBeUndefined();
  });

  it("Signal A: shared < minShared → no candidate", () => {
    seedPage(db, "entity-alpha", "Alpha");
    seedPage(db, "entity-beta", "Beta");
    seedPage(db, "project-gamma", "Gamma", "entity/project");
    seedLink(db, "entity-alpha", "project-gamma");
    seedLink(db, "entity-beta", "project-gamma"); // only 1 shared
    expect(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 })).toEqual([]);
  });

  it("#311 hub filter: a shared neighbor above HUB_DEGREE_MAX is excluded from Signal A + evidence", () => {
    seedPage(db, "entity-alpha", "Alpha");
    seedPage(db, "entity-beta", "Beta");
    seedPage(db, "concept-hub", "Hub", "concept/concept");
    seedPage(db, "concept-delta", "Delta", "concept/concept");
    seedLink(db, "entity-alpha", "concept-hub");
    seedLink(db, "entity-alpha", "concept-delta");
    seedLink(db, "entity-beta", "concept-hub");
    seedLink(db, "entity-beta", "concept-delta");
    // Pump concept-hub global degree above HUB_DEGREE_MAX(=20) with synthetic leaves
    // so it is a generic-hub neighbor, not evidence of a real alpha↔beta connection.
    for (let i = 0; i < 21; i++) {
      const leaf = `entity-leaf-${i}`;
      seedPage(db, leaf, leaf, "entity/project");
      seedLink(db, leaf, "concept-hub");
    }
    // alpha↔beta share {concept-hub, concept-delta}; hub filtered → only delta (1) < minShared → no candidate.
    const c = findPair(
      detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 }),
      "entity-alpha",
      "entity-beta",
    );
    expect(c).toBeUndefined();
  });

  it("#311 hub filter: low-degree shared neighbors still count (no over-filtering)", () => {
    seedSharedPair(db, { sessions: true }); // project-gamma + concept-delta, both degree 2
    const c = findPair(
      detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 }),
      "entity-alpha",
      "entity-beta",
    );
    expect(c).toBeDefined();
    expect(c!.sharedNeighbors).toBe(2);
    expect(c!.sharedNeighborSlugs).toEqual(expect.arrayContaining(["project-gamma", "concept-delta"]));
  });

  it("Signal B: counts distinct co-occurring sessions", () => {
    seedSharedPair(db, { sessions: true });
    const c = findPair(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2, minSessions: 2 }), "entity-alpha", "entity-beta");
    expect(c).toBeDefined();
    expect(c!.coOccurringSessions).toBe(2);
    expect(c!.signalB).toBe(true);
  });

  it("Signal C: timeline proximity within maxDays", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    const c = findPair(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2, maxTimelineDays: 14 }), "entity-alpha", "entity-beta");
    expect(c).toBeDefined();
    expect(c!.signalC).toBe(true);
    expect(c!.timelineProximityDays).toBeGreaterThanOrEqual(8);
    expect(c!.timelineProximityDays).toBeLessThanOrEqual(10);
  });

  it("Signal C: events far apart → not flagged", () => {
    seedSharedPair(db, { sessions: true });
    seedTimeline(db, "entity-alpha", "2026-01-01");
    seedTimeline(db, "entity-beta", "2026-06-01"); // update alpha/beta latest events
    // Overwrite: the seedSharedPair didn't add timeline; add far-apart ones.
    const c = findPair(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2, maxTimelineDays: 14 }), "entity-alpha", "entity-beta");
    expect(c).toBeDefined();
    expect(c!.signalC).toBe(false);
    expect(c!.timelineProximityDays).toBeNull();
  });

  it("generic name similarity without shared neighbors → no candidate (no embedding noise)", () => {
    seedPage(db, "entity-alpha", "Alpha One");
    seedPage(db, "entity-alphy", "Alpha Two"); // name-similar but no shared neighbors
    expect(detectProactiveConnections(db, { since: "1970-01-01", minShared: 2 })).toEqual([]);
  });

  it("respects the cap", () => {
    for (let i = 0; i < 5; i++) {
      const a = `entity-alpha-${i}`;
      const b = `entity-beta-${i}`;
      seedPage(db, a, a);
      seedPage(db, b, b);
      for (const shared of [`g-${i}-1`, `g-${i}-2`]) {
        seedPage(db, shared, shared, "entity/project");
        seedLink(db, a, shared);
        seedLink(db, b, shared);
      }
      seedQueryLog(db, `s-${i}-1`, [a, b]);
      seedQueryLog(db, `s-${i}-2`, [a, b]);
    }
    const result = detectProactiveConnections(db, { since: "1970-01-01", minShared: 2, minSessions: 2, cap: 3 });
    expect(result.length).toBe(3);
  });

  it("candidates carry bounded concrete evidence refs", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    const c = findPair(
      detectProactiveConnections(db, { since: "1970-01-01", minShared: 2, minSessions: 2 }),
      "entity-alpha",
      "entity-beta",
    );
    expect(c).toBeDefined();
    expect(c!.sharedNeighborSlugs).toEqual(expect.arrayContaining(["project-gamma", "concept-delta"]));
    expect(c!.sharedNeighborSlugs.length).toBeLessThanOrEqual(3);
    expect(c!.timelineEventRefs).toHaveLength(2);
    expect(c!.timelineEventRefs[0]).toHaveProperty("eventId");
    expect(c!.timelineEventRefs[0]).toHaveProperty("eventDate");
    expect(c!.coOccurringSessionRefs).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(c!.coOccurringSessionRefs.length).toBeLessThanOrEqual(3);
  });
});

describe("produceProactiveConnectionCandidates", () => {
  it("emits + persists one row for a qualifying pair (multi_independent: sn=2 + B + C)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res.inserted).toBe(1);
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].entities).sort()).toEqual(["entity-alpha", "entity-beta"]);
    expect(rows[0].actionable).toBe("low");
    expect(rows[0].auto_applicable).toBe(0);
  });

  it("does NOT persist Signal A alone (no supporting) — acceptance #2", () => {
    seedSharedPair(db); // shared neighbors only, no sessions/timeline
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res.inserted).toBe(0);
    expect(db.getDiscoveriesByType("proactive_connection", 10)).toEqual([]);
  });

  it("repeated runs bump occurrence, no duplicate — acceptance #5", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const res2 = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res2.inserted).toBe(0); // recurrence, not new insert
    expect(db.getDiscoveriesByType("proactive_connection", 10).length).toBe(1);
  });

  it("dismissed row is not resurrected on re-run — acceptance #4", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "dismissed");
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(db.getDiscoveriesByType("proactive_connection", 10)).toEqual([]);
  });

  it("resolved row is not resurrected on re-run — acceptance #4", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "resolved");
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(db.getDiscoveriesByType("proactive_connection", 10)).toEqual([]);
  });

  it("shadow verifier runs and does not block persistence — acceptance #8", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    // Persistence happened despite the shadow verifier running before each upsert.
    expect(db.getDiscoveriesByType("proactive_connection", 10).length).toBe(1);
    const logs = db.rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM ingest_log WHERE source_type='verifier' AND action='discovery_shadow_verifier'",
      )
      .get() as { c: number };
    expect(logs.c).toBeGreaterThanOrEqual(1);
  });

  it("metadata carries bounded evidence refs for audit; no query text (#3)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    const meta = JSON.parse(row.metadata ?? "{}");
    // counts drive ranking/sort
    expect(meta.signals.shared_neighbors).toBe(2);
    expect(meta.signals.cooccurring_sessions).toBe(2);
    // bounded concrete evidence refs present for audit
    expect(meta.evidence.shared_neighbor_slugs).toEqual(expect.arrayContaining(["project-gamma", "concept-delta"]));
    expect(meta.evidence.shared_neighbor_slugs.length).toBeLessThanOrEqual(3);
    expect(meta.evidence.timeline_event_refs).toHaveLength(2);
    expect(meta.evidence.timeline_event_refs[0]).toHaveProperty("eventId");
    expect(meta.evidence.timeline_event_refs[0]).toHaveProperty("eventDate");
    expect(meta.evidence.cooccurring_session_refs).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(meta.evidence.cooccurring_session_refs.length).toBeLessThanOrEqual(3);
    // query TEXT is never stored (only opaque session ids)
    const blob = JSON.stringify(meta);
    expect(blob).not.toMatch(/query/i);
  });

  it("hostile page titles never enter metadata — refs are slug/id/session, not title text (#3)", () => {
    seedPage(db, "entity-hostile-a", "Bearer SENTINEL_TOKEN");
    seedPage(db, "entity-hostile-b", "sk-SENTINEL-KEY");
    for (const s of ["project-gamma", "concept-delta"]) {
      seedPage(db, s, s, "entity/project");
      seedLink(db, "entity-hostile-a", s);
      seedLink(db, "entity-hostile-b", s);
    }
    seedQueryLog(db, "s1", ["entity-hostile-a", "entity-hostile-b"]);
    seedQueryLog(db, "s2", ["entity-hostile-a", "entity-hostile-b"]);
    seedTimeline(db, "entity-hostile-a", "2026-06-01");
    seedTimeline(db, "entity-hostile-b", "2026-06-10");
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    const meta = JSON.parse(row.metadata ?? "{}");
    const blob = JSON.stringify(meta);
    expect(blob).not.toContain("SENTINEL");
    expect(blob).not.toContain("Bearer");
    expect(blob).not.toContain("sk-SENTINEL");
  });

  it("#311 strengthened gate: sn=2 + B only (no C) is now REJECTED", () => {
    seedSharedPair(db, { sessions: true }); // sn=2, B, no C — Phase 0 accepted, Phase 1 rejects
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res.inserted).toBe(0);
    expect(db.getDiscoveriesByType("proactive_connection", 10)).toEqual([]);
  });

  it("#311 strong path: sn=3 + B → persists with gate_path=strong_corroborated", () => {
    seedPage(db, "entity-alpha", "Alpha");
    seedPage(db, "entity-beta", "Beta");
    for (const s of ["project-cfg", "concept-delta", "concept-eps"]) {
      seedPage(db, s, s, "entity/project");
      seedLink(db, "entity-alpha", s);
      seedLink(db, "entity-beta", s);
    }
    seedQueryLog(db, "s1", ["entity-alpha", "entity-beta"]);
    seedQueryLog(db, "s2", ["entity-alpha", "entity-beta"]);
    const res = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res.inserted).toBe(1);
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.scoring.gate_path).toBe("strong_corroborated");
  });

  it("#311 cooldown: dismissed exact pair is skipped — occurrence_count frozen (not bumped)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "dismissed");
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    // Producer skipped the upsert for the dismissed dedup_key → occurrence frozen at 1
    // (Phase 0 upserted anyway and bumped occurrence_count on a dead row; Phase 1 does not).
    const dismissed = db.getDiscoveryLifecycleIndex("proactive_connection", 10).find(
      (r) => r.status === "dismissed",
    );
    expect(dismissed?.occurrence_count).toBe(1);
  });

  it("#311 cooldown: evidence-identical equivalent candidate is suppressed (acceptance #5)", () => {
    // Round 1: alpha↔beta shares {project-gamma, concept-delta}; persist + dismiss.
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "dismissed");

    // Round 2: introduce epsilon that ALSO shares {project-gamma, concept-delta} with alpha.
    seedPage(db, "entity-epsilon", "Epsilon");
    for (const s of ["project-gamma", "concept-delta"]) {
      seedLink(db, "entity-epsilon", s);
    }
    seedQueryLog(db, "s3", ["entity-alpha", "entity-epsilon"]);
    seedQueryLog(db, "s4", ["entity-alpha", "entity-epsilon"]);
    seedTimeline(db, "entity-epsilon", "2026-06-15");
    const res2 = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    // {alpha,epsilon} would qualify on its own, but its evidence set {gamma,delta} equals
    // the dismissed {alpha,beta}'s, and they share entity alpha → suppressed.
    expect(res2.inserted).toBe(0);
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.some((r) => JSON.parse(r.entities).includes("entity-epsilon"))).toBe(false);
  });

  it("#311 cooldown: partial evidence overlap is NOT suppressed (legitimate new connection)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "dismissed");

    // zeta shares only ONE dismissed-evidence neighbor + a fresh one → evidence set differs.
    seedPage(db, "entity-zeta", "Zeta");
    seedPage(db, "concept-fresh", "Fresh", "concept/concept");
    seedLink(db, "entity-zeta", "project-gamma"); // overlaps dismissed evidence
    seedLink(db, "entity-zeta", "concept-fresh"); // but adds a different neighbor
    seedLink(db, "entity-alpha", "concept-fresh");
    seedQueryLog(db, "s5", ["entity-alpha", "entity-zeta"]);
    seedQueryLog(db, "s6", ["entity-alpha", "entity-zeta"]);
    seedTimeline(db, "entity-zeta", "2026-06-08"); // within 14d of alpha so signalC holds
    const res2 = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res2.inserted).toBe(1); // evidence set {gamma, fresh} ≠ dismissed {gamma, delta}
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.some((r) => JSON.parse(r.entities).includes("entity-zeta"))).toBe(true);
  });

  it("#311 metadata.scoring carries dimensions + quality + gate_path; discoveries.score == quality", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.scoring).toBeDefined();
    for (const k of ["evidence_strength", "novelty", "recurrence", "actionability", "risk", "quality", "gate_path"]) {
      expect(meta.scoring).toHaveProperty(k);
    }
    expect(meta.scoring.gate_path).toBe("multi_independent");
    expect(row.score).toBeCloseTo(meta.scoring.quality, 5);
    expect(meta.scoring.weights).toBeDefined(); // audit trail of the weight vector
  });

  it("#311 adversarial fix: evidence-identical check uses FULL neighbor count, not the truncated slug list", () => {
    // Dismissed pair shares 4 neighbors → stored evidence truncates to 3 (MAX_REFS).
    // A new candidate sharing exactly those 3 (distinct from the real 4) must NOT be
    // suppressed. Without the count gate, set-equality on truncated slugs would false-match.
    seedPage(db, "entity-alpha", "Alpha");
    seedPage(db, "entity-beta", "Beta");
    for (const s of ["g1", "g2", "g3", "g4"]) {
      seedPage(db, s, s, "entity/project");
      seedLink(db, "entity-alpha", s);
      seedLink(db, "entity-beta", s);
    }
    seedQueryLog(db, "s1", ["entity-alpha", "entity-beta"]);
    seedQueryLog(db, "s2", ["entity-alpha", "entity-beta"]);
    seedTimeline(db, "entity-alpha", "2026-06-01");
    seedTimeline(db, "entity-beta", "2026-06-10");
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    expect(JSON.parse(row.metadata ?? "{}").signals.shared_neighbors).toBe(4); // full count
    db.updateDiscoveryStatus(row.id, "dismissed");

    // epsilon shares only 3 of the 4 → genuinely distinct neighborhood → not equivalent.
    seedPage(db, "entity-epsilon", "Epsilon");
    for (const s of ["g1", "g2", "g3"]) seedLink(db, "entity-epsilon", s);
    seedQueryLog(db, "s3", ["entity-alpha", "entity-epsilon"]);
    seedQueryLog(db, "s4", ["entity-alpha", "entity-epsilon"]);
    seedTimeline(db, "entity-epsilon", "2026-06-08");
    const res2 = produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    expect(res2.inserted).toBeGreaterThanOrEqual(1); // NOT suppressed
    const rows = db.getDiscoveriesByType("proactive_connection", 10);
    expect(rows.some((r) => JSON.parse(r.entities).includes("entity-epsilon"))).toBe(true);
  });

  it("#311 adversarial fix: status='seen' row is skipped (no resurrection / occurrence bump)", () => {
    seedSharedPair(db, { sessions: true, timeline: true });
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    const [row] = db.getDiscoveriesByType("proactive_connection", 10);
    db.updateDiscoveryStatus(row.id, "seen"); // user acknowledged, not dismissed
    produceProactiveConnectionCandidates(db, { since: "1970-01-01" });
    // 'seen' is non-pending → producer must skip → occurrence frozen at 1.
    const seen = db
      .getDiscoveryLifecycleIndex("proactive_connection", 10)
      .find((r) => r.status === "seen");
    expect(seen?.occurrence_count).toBe(1);
  });
});

describe("proactive_connection — structural isolation (#310 adversarial)", () => {
  it("no proactive_connection wiring leaks into recall/search/ingest paths", () => {
    const cwd = process.cwd();
    const forbidden = [
      "src/mcp/tools/recall.ts",
      "src/mcp/tools/search.ts",
      "src/core/ingestion/pipeline.ts",
    ];
    for (const p of forbidden) {
      const src = readFileSync(resolve(cwd, p), "utf8");
      expect(src).not.toContain("proactive_connection");
    }
  });

  it("proactive_connection appears only in the allowed source files", () => {
    const out = execSync("git grep -l proactive_connection -- src/", { encoding: "utf8" });
    const files = out.trim().split("\n").filter(Boolean).sort();
    // The producer lane is confined to the first 4 files. #312 adds the deliberate
    // opt-in promotion surface: proactive-review-bridge (the adapter) + the
    // compounding-review MCP tool (its only trigger). Neither writes to the
    // producer lane; both are the sanctioned bridge from discovery → review.
    const allowed = [
      "src/core/maintenance/action-candidates.ts",
      "src/core/maintenance/discovery-digest.ts",
      "src/core/maintenance/proactive-connection.ts",
      "src/core/maintenance/proactive-review-bridge.ts",
      "src/mcp/tools/compounding-review.ts",
      "src/mcp/tools/discoveries.ts",
    ].sort();
    expect(files).toEqual(allowed);
  });
});
