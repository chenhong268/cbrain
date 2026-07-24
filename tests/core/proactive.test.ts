import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { generateProactiveHints } from "../../src/core/retrieval/proactive.js";

function makeCtx(db: CBrainDB) {
  return { db } as any;
}

describe("generateProactiveHints", () => {
  const testDir = "/tmp/cbrain-test-proactive";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);

    // Seed pages
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("entities/a", "entity/person", "EntityA", "a.md", "h1", 1, 3);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("entities/b", "entity/person", "EntityB", "b.md", "h2", 1, 3);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("entities/c", "entity/person", "EntityC", "c.md", "h3", 1, 3);
    db.rawDb.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("entities/exp", "entity/person", "ExpiringOne", "exp.md", "h4", 1, 3, "2020-01-01");
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("network_timeline: surfaces recent events from neighbors", async () => {
    const ctx = makeCtx(db);

    // Link A -> B, A -> C
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run("entities/a", "entities/b", "提及");
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run("entities/a", "entities/c", "提及");

    // B has a recent timeline event
    const recentDate = new Date().toISOString().slice(0, 10);
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, ?)")
      .run("entities/b", "升职为总监", recentDate, "test");

    const hints = await generateProactiveHints(ctx, {
      resultSlugs: ["entities/a"],
      maxHints: 3,
    });

    const tl = hints.find(h => h.rule === "network_timeline");
    expect(tl).toBeDefined();
    expect(tl!.text).toContain("EntityB");
    expect(tl!.text).toContain("升职为总监");
  });

  test("network_timeline: future event score is clamped to [0, 1] (#388)", async () => {
    const ctx = makeCtx(db);

    // Link A -> B
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run("entities/a", "entities/b", "提及");

    // B carries a FUTURE timeline event (e.g. a scheduled meeting). This is
    // legitimate timeline data, not stale evidence.
    const futureDate = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    db.rawDb.prepare("INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, ?)")
      .run("entities/b", "预定未来会议", futureDate, "test");

    const hints = await generateProactiveHints(ctx, {
      resultSlugs: ["entities/a"],
      maxHints: 3,
    });

    const tl = hints.find(h => h.rule === "network_timeline");
    expect(tl).toBeDefined();
    // Before #388 the unclamped score was 1.0 - (-60)/180 ≈ 1.33, which outranks
    // an expiry_alert (fixed at 1.0). The score must stay within [0, 1].
    expect(tl!.score).toBeLessThanOrEqual(1.0);
    expect(tl!.score).toBeGreaterThanOrEqual(0);
    // A future event keeps a negative age_days (not abs'd) — see #388.
    expect(tl!.age_days).toBeLessThan(0);
  });

  test("shared_connection: finds common neighbor across results", async () => {
    const ctx = makeCtx(db);

    // A and B both link to C
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run("entities/a", "entities/c", "提及");
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run("entities/b", "entities/c", "提及");

    // Provide linksBySlug directly (no DB call needed for this rule)
    const linksMap = db.batchGetLinksForSlugs(["entities/a", "entities/b"]);

    const hints = await generateProactiveHints(ctx, {
      resultSlugs: ["entities/a", "entities/b"],
      linksBySlug: linksMap,
      maxHints: 3,
    });

    const shared = hints.find(h => h.rule === "shared_connection");
    expect(shared).toBeDefined();
    expect(shared!.text).toContain("EntityC");
  });

  test("shared_connection excludes candidate reports_to from current-fact hints", async () => {
    const ctx = makeCtx(db);

    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'ner')")
      .run("entities/a", "entities/c");
    db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'ner')")
      .run("entities/b", "entities/c");

    const hints = await generateProactiveHints(ctx, {
      resultSlugs: ["entities/a", "entities/b"],
      maxHints: 3,
    });

    expect(hints.find(h => h.rule === "shared_connection")).toBeUndefined();
  });

  test("expiry_alert: flags expired entities", async () => {
    const ctx = makeCtx(db);

    const hints = await generateProactiveHints(ctx, {
      resultSlugs: ["entities/exp"],
      maxHints: 3,
    });

    const expiry = hints.find(h => h.rule === "expiry_alert");
    expect(expiry).toBeDefined();
    expect(expiry!.text).toContain("ExpiringOne");
    expect(expiry!.text).toContain("已过期");
  });

  test("error isolation: returns empty array on failure", async () => {
    const badCtx = { db: null } as any;
    const hints = await generateProactiveHints(badCtx, {
      resultSlugs: ["entities/a"],
      maxHints: 3,
    });
    expect(hints).toEqual([]);
  });
});
