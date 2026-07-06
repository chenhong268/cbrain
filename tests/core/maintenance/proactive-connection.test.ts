import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import {
  detectProactiveConnections,
  pairKey,
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
});
