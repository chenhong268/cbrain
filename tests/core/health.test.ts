import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HealthChecker } from "../../src/core/health.js";

describe("HealthChecker", () => {
  const testDir = "/tmp/cbrain-test-health";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let checker: HealthChecker;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    checker = new HealthChecker(db, join(testDir, "outputs"));
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function insertPage(slug: string, title: string, type: string, overrides: Record<string, unknown> = {}) {
    db.prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      slug, type, title,
      (overrides.file_path as string) ?? `${slug.replace("/", "-")}.md`,
      (overrides.content_hash as string) ?? "h1",
      (overrides.mention_count as number) ?? 0,
      (overrides.tier as number) ?? 3,
    );
  }

  function insertLink(from: string, to: string, relation = "提及") {
    db.prepare("INSERT OR IGNORE INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run(from, to, relation);
  }

  describe("checkAll", () => {
    test("returns pass status with sufficient well-connected data", async () => {
      for (let i = 0; i < 15; i++) {
        insertPage(`entities/e${i}`, `Entity${i}`, "entity", { mention_count: 2, tier: 3 });
      }
      insertPage("concepts/c1", "Concept1", "concept", { mention_count: 2, tier: 3 });
      insertPage("records/r1", "Record1", "record");
      // Link them so no orphans
      for (let i = 1; i < 15; i++) {
        insertLink(`entities/e${i - 1}`, `entities/e${i}`);
      }

      const report = await checker.checkAll();
      expect(report.overallStatus).toBe("pass");
      expect(report.metrics.totalPages).toBe(17);
      expect(report.dimensions.length).toBe(10);
    });

    test("fails on insufficient data", async () => {
      insertPage("entities/e1", "E1", "entity");

      const report = await checker.checkAll();
      expect(report.overallStatus).toBe("fail");
      expect(report.timestamp).toBeDefined();
    });

    test("detects semantic duplicates", async () => {
      insertPage("entities/zhangsan", "张三", "entity");
      insertPage("entities/zhangsan2", "张三", "entity");

      const report = await checker.checkAll();
      const dedupDim = report.dimensions.find(d => d.name === "语义去重");
      expect(dedupDim).toBeDefined();
      expect(dedupDim!.status).toBe("fail");
      expect(dedupDim!.issues.length).toBeGreaterThanOrEqual(1);
    });

    test("detects near-duplicate titles", async () => {
      insertPage("entities/foo", "Foo-Bar", "entity");
      insertPage("entities/foobar", "Foo Bar", "entity");

      const report = await checker.checkAll();
      const dedupDim = report.dimensions.find(d => d.name === "语义去重");
      expect(dedupDim).toBeDefined();
      const nearDupe = dedupDim!.issues.find(i => i.severity === "medium");
      expect(nearDupe).toBeDefined();
    });

    test("detects non-standard relation types", async () => {
      insertPage("entities/e1", "E1", "entity");
      insertPage("entities/e2", "E2", "entity");
      insertLink("entities/e1", "entities/e2", "bogus_relation_type");

      const report = await checker.checkAll();
      const consistencyDim = report.dimensions.find(d => d.name === "一致性");
      expect(consistencyDim).toBeDefined();
      expect(consistencyDim!.issues.length).toBeGreaterThanOrEqual(1);
      const relIssue = consistencyDim!.issues.find(i =>
        i.description.includes("non-standard relation types")
      );
      expect(relIssue).toBeDefined();
    });

    test("detects islands (disconnected pages)", async () => {
      insertPage("entities/alone", "Alone", "entity");
      insertPage("entities/connected", "Connected", "entity");
      insertPage("entities/friend", "Friend", "entity");
      insertLink("entities/connected", "entities/friend");

      const report = await checker.checkAll();
      const islandDim = report.dimensions.find(d => d.name === "孤岛检测");
      expect(islandDim).toBeDefined();
      expect(islandDim!.issues.length).toBe(1);
      expect(islandDim!.issues[0].slug).toBe("entities/alone");
    });

    test("detects concept inflation", async () => {
      insertPage("records/r1", "R1", "record");
      for (let i = 0; i < 20; i++) {
        insertPage(`concepts/c${i}`, `Concept${i}`, "concept");
      }

      const report = await checker.checkAll();
      const suggestionDim = report.dimensions.find(d => d.name === "新增建议");
      expect(suggestionDim).toBeDefined();
      // ratio = 20 concepts / 1 record = 20, severity "high" → status "warn"
      expect(suggestionDim!.status).toBe("warn");
      expect(suggestionDim!.issues.length).toBeGreaterThanOrEqual(1);
    });

    test("writes health report to disk", async () => {
      insertPage("entities/e1", "E1", "entity");

      const report = await checker.checkAll();
      const healthDir = join(testDir, "outputs", "health");
      expect(existsSync(healthDir)).toBe(true);
      expect(report).toBeDefined();
    });
  });
});
