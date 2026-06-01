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
    db.rawDb.prepare(
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
    db.rawDb.prepare("INSERT OR IGNORE INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)")
      .run(from, to, relation);
  }

  describe("checkAll", () => {
    test("returns pass status with sufficient well-connected data", async () => {
      for (let i = 0; i < 15; i++) {
        insertPage(`entities/e${i}`, `Entity${i}`, "entity/person", { mention_count: 2, tier: 3 });
      }
      insertPage("concepts/c1", "Concept1", "concept/concept", { mention_count: 2, tier: 3 });
      insertPage("records/r1", "Record1", "record");
      // Link them so no orphans
      for (let i = 1; i < 15; i++) {
        insertLink(`entities/e${i - 1}`, `entities/e${i}`);
      }

      const report = await checker.checkAll();
      expect(report.overallStatus).toBe("pass");
      expect(report.metrics.totalPages).toBe(17);
      expect(report.dimensions.length).toBe(12);
    });

    test("fails on insufficient data", async () => {
      insertPage("entities/e1", "E1", "entity/person");

      const report = await checker.checkAll();
      expect(report.overallStatus).toBe("warn");
      expect(report.timestamp).toBeDefined();
    });

    test("detects semantic duplicates", async () => {
      insertPage("entities/zhangsan", "张 三", "entity/person");
      insertPage("entities/zhangsan2", "张三", "entity/person");

      const report = await checker.checkAll();
      const dedupDim = report.dimensions.find(d => d.name === "语义去重");
      expect(dedupDim).toBeDefined();
      expect(dedupDim!.status).toBe("warn");
      expect(dedupDim!.issues.length).toBeGreaterThanOrEqual(1);
    });

    test("detects near-duplicate titles", async () => {
      insertPage("entities/foo", "Foo-Bar", "entity/person");
      insertPage("entities/foobar", "Foo Bar", "entity/person");

      const report = await checker.checkAll();
      const dedupDim = report.dimensions.find(d => d.name === "语义去重");
      expect(dedupDim).toBeDefined();
      const nearDupe = dedupDim!.issues.find(i => i.severity === "medium");
      expect(nearDupe).toBeDefined();
    });

    test("detects non-standard relation types", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/e2", "E2", "entity/person");
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
      insertPage("entities/alone", "Alone", "entity/person");
      insertPage("entities/connected", "Connected", "entity/person");
      insertPage("entities/friend", "Friend", "entity/person");
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
        insertPage(`concepts/c${i}`, `Concept${i}`, "concept/concept");
      }

      const report = await checker.checkAll();
      const suggestionDim = report.dimensions.find(d => d.name === "新增建议");
      expect(suggestionDim).toBeDefined();
      // ratio = 20 concepts / 1 record = 20, severity "high" → status "warn"
      expect(suggestionDim!.status).toBe("warn");
      expect(suggestionDim!.issues.length).toBeGreaterThanOrEqual(1);
    });

    test("writes three-layer output files", async () => {
      insertPage("entities/e1", "E1", "entity/person");

      const report = await checker.checkAll();
      const healthDir = join(testDir, "outputs", "health");
      expect(existsSync(join(healthDir, "summary-2026-01-01.md")) || report.reportPaths?.summary).toBeDefined();
      expect(report.reportPaths).toBeDefined();
      expect(report.reportPaths!.summary).toContain("summary-");
      expect(report.reportPaths!.actions).toContain("actions-");
      expect(report.reportPaths!.detail).toContain("detail-");
      // Verify files exist
      expect(existsSync(report.reportPaths!.summary)).toBe(true);
      expect(existsSync(report.reportPaths!.actions)).toBe(true);
      expect(existsSync(report.reportPaths!.detail)).toBe(true);
    });
  });

  describe("delta calculation", () => {
    test("first run has no previous state — all issues are new", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/alone", "Alone", "entity/person");

      const report = await checker.checkAll();
      expect(report.delta).toBeDefined();
      expect(report.delta!.previousTimestamp).toBe("");
      expect(report.delta!.totalNew).toBeGreaterThan(0);
      expect(report.delta!.totalResolved).toBe(0);
      expect(report.delta!.totalChronic).toBe(0);
    });

    test("second run with same data shows no new issues", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/e2", "E2", "entity/person");
      insertLink("entities/e1", "entities/e2");

      await checker.checkAll();
      const report2 = await checker.checkAll();
      expect(report2.delta!.previousTimestamp).toBeTruthy();
      expect(report2.delta!.totalNew).toBe(0);
      expect(report2.delta!.totalResolved).toBe(0);
    });

    test("resolves issue when data is fixed between runs", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/alone", "Alone", "entity/person");

      await checker.checkAll();

      // Fix the island by linking it
      insertLink("entities/e1", "entities/alone");
      const report2 = await checker.checkAll();
      expect(report2.delta!.totalResolved).toBeGreaterThan(0);
    });

    test("new issue appears when new problem is introduced", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertLink("entities/e1", "entities/e1");

      await checker.checkAll();

      // Add an island
      insertPage("entities/alone", "Alone", "entity/person");
      const report2 = await checker.checkAll();
      expect(report2.delta!.totalNew).toBeGreaterThan(0);
    });
  });

  describe("state persistence", () => {
    test("writes state.json after checkAll", async () => {
      insertPage("entities/e1", "E1", "entity/person");

      await checker.checkAll();
      const statePath = join(testDir, "outputs", "health", "state.json");
      expect(existsSync(statePath)).toBe(true);
    });

    test("state.json accumulates slugRunCounts across runs", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/alone", "Alone", "entity/person");

      await checker.checkAll();
      await checker.checkAll();
      await checker.checkAll();

      const { readFileSync } = await import("node:fs");
      const state = JSON.parse(readFileSync(join(testDir, "outputs", "health", "state.json"), "utf-8"));
      // After 3 runs, islands slugs should have count >= 3
      const islandSlugs = Object.entries(state.slugRunCounts)
        .filter(([, count]: [string, unknown]) => (count as number) >= 3);
      expect(islandSlugs.length).toBeGreaterThan(0);
    });
  });

  describe("chronic tracking", () => {
    test("issues appearing 3+ consecutive runs are flagged as chronic", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/alone", "Alone", "entity/person");

      // Run 1: count→1, Run 2: count→2, Run 3: count→3 (read as 2 < threshold),
      // Run 4: reads count=3 >= CHRONIC_THRESHOLD
      await checker.checkAll();
      await checker.checkAll();
      await checker.checkAll();
      const report4 = await checker.checkAll();
      expect(report4.delta!.totalChronic).toBeGreaterThan(0);
    });
  });

  describe("rolling cleanup", () => {
    test("removes files older than 7 days", async () => {
      const healthDir = join(testDir, "outputs", "health");
      mkdirSync(healthDir, { recursive: true });

      // Create an old file (backdate mtime)
      const { writeFileSync, utimesSync } = await import("node:fs");
      const oldFile = join(healthDir, "summary-2026-01-01.md");
      writeFileSync(oldFile, "old report", "utf-8");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      utimesSync(oldFile, new Date(eightDaysAgo), new Date(eightDaysAgo));

      insertPage("entities/e1", "E1", "entity/person");
      await checker.checkAll();

      expect(existsSync(oldFile)).toBe(false);
      // Current report should still exist
      expect(existsSync(join(healthDir, "state.json"))).toBe(true);
    });
  });

  describe("writeFullReport", () => {
    test("produces full Markdown with all issues", async () => {
      insertPage("entities/e1", "E1", "entity/person");
      insertPage("entities/alone", "Alone", "entity/person");

      const report = await checker.checkAll();
      const full = checker.writeFullReport(report);
      expect(full).toContain("健康检查（完整）");
      expect(full).toContain("entities/e1");
      expect(full).toContain("指标总览");
    });
  });
});
