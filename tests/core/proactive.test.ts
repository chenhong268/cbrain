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
