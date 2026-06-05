import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { WakeupDiff } from "../../src/core/wakeup.js";

describe("WakeupDiff", () => {
  const testDir = "/tmp/cbrain-test-wakeup";
  const dbPath = join(testDir, "test.sqlite");
  const outputsDir = join(testDir, "runtime");
  let db: CBrainDB;
  let diff: WakeupDiff;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });
    db = new CBrainDB(dbPath);
    // Clean any snapshots from prior test runs in the same DB
    for (const id of db.getSnapshotIds()) {
      db.deleteSnapshot(id);
    }
    diff = new WakeupDiff(db, outputsDir);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function insertPage(slug: string, title: string, type: string, overrides: Record<string, unknown> = {}) {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier, confidence_decay) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      slug, type, title,
      (overrides.file_path as string) ?? `${slug.replace(/\//g, "_")}.md`,
      (overrides.content_hash as string) ?? "hash1",
      (overrides.mention_count as number) ?? 0,
      (overrides.tier as number) ?? 3,
      (overrides.confidence_decay as number) ?? 1.0,
    );
  }

  function insertLink(from: string, to: string) {
    db.rawDb.prepare("INSERT OR IGNORE INTO links (from_slug, to_slug, relation) VALUES (?, ?, '提及')")
      .run(from, to);
  }

  test("first run creates baseline, no changes reported", async () => {
    insertPage("entities/a", "Alice", "entity/person");

    const result = await diff.run();

    expect(result.baselineCreated).toBe(true);
    expect(result.previousSnapshotId).toBeNull();
    expect(result.snapshotId).toBeTruthy();
    expect(result.changes.contentUpdated).toHaveLength(0);
    expect(result.changes.tierChanged).toHaveLength(0);
    expect(result.newItems).toHaveLength(0);
    expect(result.stats.totalPages).toBe(1);
  });

  test("no changes produces empty diff", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    await diff.run(); // baseline

    const result = await diff.run();
    expect(result.baselineCreated).toBe(false);
    expect(result.changes.contentUpdated).toHaveLength(0);
    expect(result.changes.tierChanged).toHaveLength(0);
    expect(result.changes.removed).toHaveLength(0);
    expect(result.newItems).toHaveLength(0);
  });

  test("detects new items", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    await diff.run(); // baseline

    insertPage("entities/b", "Bob", "entity/person");
    insertPage("concepts/c1", "Concept1", "concept/concept");

    const result = await diff.run();
    expect(result.newItems).toHaveLength(2);
    const slugs = result.newItems.map(i => i.slug).sort();
    expect(slugs).toEqual(["concepts/c1", "entities/b"]);
    expect(result.newItems[0].title).toBeTruthy();
  });

  test("detects content hash changes", async () => {
    insertPage("entities/a", "Alice", "entity/person", { content_hash: "hash1" });
    await diff.run();

    db.rawDb.prepare("UPDATE pages SET content_hash = ? WHERE slug = ?").run("hash2", "entities/a");

    const result = await diff.run();
    expect(result.changes.contentUpdated).toHaveLength(1);
    expect(result.changes.contentUpdated[0].slug).toBe("entities/a");
    expect(result.changes.contentUpdated[0].title).toBe("Alice");
  });

  test("detects tier changes with direction", async () => {
    insertPage("entities/a", "Alice", "entity/person", { tier: 3 });
    await diff.run();

    db.rawDb.prepare("UPDATE pages SET tier = ? WHERE slug = ?").run(1, "entities/a");

    const result = await diff.run();
    expect(result.changes.tierChanged).toHaveLength(1);
    expect(result.changes.tierChanged[0].oldTier).toBe(3);
    expect(result.changes.tierChanged[0].newTier).toBe(1);
  });

  test("detects link count delta", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    insertPage("entities/b", "Bob", "entity/person");
    insertPage("entities/c", "Carol", "entity/person");
    await diff.run();

    insertLink("entities/a", "entities/b");
    insertLink("entities/a", "entities/c");

    const result = await diff.run();
    expect(result.changes.linkCountChanged.length).toBeGreaterThanOrEqual(1);
    const aliceChange = result.changes.linkCountChanged.find(c => c.slug === "entities/a");
    expect(aliceChange).toBeDefined();
    expect(aliceChange!.diff).toBe(2);
  });

  test("detects confidence decay > 0.1", async () => {
    insertPage("entities/a", "Alice", "entity/person", { confidence_decay: 1.0 });
    await diff.run();

    db.rawDb.prepare("UPDATE pages SET confidence_decay = ? WHERE slug = ?").run(0.8, "entities/a");

    const result = await diff.run();
    expect(result.changes.confidenceDecayed).toHaveLength(1);
    expect(result.changes.confidenceDecayed[0].oldValue).toBe(1.0);
    expect(result.changes.confidenceDecayed[0].newValue).toBe(0.8);
  });

  test("ignores confidence decay <= 0.1", async () => {
    insertPage("entities/a", "Alice", "entity/person", { confidence_decay: 1.0 });
    await diff.run();

    db.rawDb.prepare("UPDATE pages SET confidence_decay = ? WHERE slug = ?").run(0.95, "entities/a");

    const result = await diff.run();
    expect(result.changes.confidenceDecayed).toHaveLength(0);
  });

  test("detects removed pages with title from old snapshot", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    insertPage("entities/b", "Bob", "entity/person");
    await diff.run();

    db.rawDb.prepare("DELETE FROM pages WHERE slug = ?").run("entities/b");

    const result = await diff.run();
    expect(result.changes.removed).toHaveLength(1);
    expect(result.changes.removed[0].slug).toBe("entities/b");
    expect(result.changes.removed[0].title).toBe("Bob");
  });

  test("truncates output when changes exceed 20 lines", async () => {
    // Create 30 pages, establish baseline
    for (let i = 0; i < 30; i++) {
      insertPage(`entities/e${i}`, `Entity${i}`, "entity/person");
    }
    await diff.run();

    // Change content hash on all 30
    for (let i = 0; i < 30; i++) {
      db.rawDb.prepare("UPDATE pages SET content_hash = ? WHERE slug = ?").run("new_hash", `entities/e${i}`);
    }

    const result = await diff.run();
    expect(result.changes.contentUpdated).toHaveLength(30);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBeTruthy();
  });

  test("snapshot is atomic — header and items written together", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    insertPage("entities/b", "Bob", "entity/person");

    await diff.run();

    // Verify both snapshot header and items exist
    const snapshot = db.getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    const items = db.getSnapshotItems(snapshot!.id);
    expect(items).toHaveLength(2);
    const slugs = items.map(i => i.slug).sort();
    expect(slugs).toEqual(["entities/a", "entities/b"]);
  });

  test("same-second consecutive runs produce stable diff baseline", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    // First run creates baseline
    await diff.run();
    // Immediately change content hash
    db.rawDb.prepare("UPDATE pages SET content_hash = ? WHERE slug = ?").run("hash2", "entities/a");
    // Second run in same second — must detect the change, not compare against itself
    const result = await diff.run();
    expect(result.baselineCreated).toBe(false);
    expect(result.changes.contentUpdated).toHaveLength(1);
    expect(result.changes.contentUpdated[0].slug).toBe("entities/a");
  });

  test("cleans up old snapshots keeping only 7", async () => {
    insertPage("entities/a", "Alice", "entity/person");

    // Run 9 times
    for (let i = 0; i < 9; i++) {
      await diff.run();
    }

    const ids = db.getSnapshotIds();
    expect(ids.length).toBeLessThanOrEqual(7);
  });

  test("baseline run writes latest.md/json with baseline message", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    const result = await diff.run();

    expect(result.baselineCreated).toBe(true);
    expect(result.reportPath).toBeTruthy();

    const latestMd = join(outputsDir, "wakeup", "latest.md");
    const latestJson = join(outputsDir, "wakeup", "latest.json");
    expect(existsSync(latestMd)).toBe(true);
    expect(existsSync(latestJson)).toBe(true);

    const { readFileSync } = await import("node:fs");
    const mdContent = readFileSync(latestMd, "utf-8");
    expect(mdContent).toContain("已建立基线，暂无变化摘要");
  });

  test("writes report files to runtime/wakeup", async () => {
    insertPage("entities/a", "Alice", "entity/person");
    await diff.run();

    insertPage("entities/b", "Bob", "entity/person");
    db.rawDb.prepare("UPDATE pages SET content_hash = ? WHERE slug = ?").run("new_hash", "entities/a");

    const result = await diff.run();
    expect(result.reportPath).toBeTruthy();

    const date = result.date;
    const mdPath = join(outputsDir, "wakeup", `wakeup-${date}.md`);
    const jsonPath = join(outputsDir, "wakeup", `wakeup-${date}.json`);
    const latestMd = join(outputsDir, "wakeup", "latest.md");
    const latestJson = join(outputsDir, "wakeup", "latest.json");

    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(latestMd)).toBe(true);
    expect(existsSync(latestJson)).toBe(true);
  });
});
