import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { HealthChecker } from "../../src/core/maintenance/health.js";
import { Logger } from "../../src/core/logger.js";

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

  function insertHealthyFixture() {
    for (let i = 0; i < 15; i++) {
      insertPage(`entities/e${i}`, `Entity${i}`, "entity/person", { mention_count: 2, tier: 3 });
    }
    insertPage("concepts/c1", "Concept1", "concept/concept", { mention_count: 2, tier: 3 });
    insertPage("records/r1", "Record1", "record");
    for (let i = 1; i < 15; i++) {
      insertLink(`entities/e${i - 1}`, `entities/e${i}`);
    }
  }

  function writeSystemErrorLog(outputsDir: string, date: Date, module: string, message: string) {
    const isoDate = date.toISOString().slice(0, 10);
    const time = date.toISOString().slice(11, 19);
    const logDir = join(outputsDir, "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, `系统日志-${isoDate}.md`),
      `# 系统日志 — ${isoDate}\n\n| 时间 | 级别 | 模块 | 消息 | 详情 |\n|------|------|------|------|------|\n| ${time} | ❌ | ${module} | ${message} | - |\n`,
      "utf-8",
    );
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
      expect(report.dimensions.length).toBe(19); // +1: rich zero-link aggregate (#342)
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

    test("reports rich zero-link debt as one anonymous aggregate issue", async () => {
      insertPage("records/record-a", "RecordA", "record");
      db.insertChunk("records/record-a", 0, "first raw chunk");
      db.insertChunk("records/record-a", 1, "second raw chunk");

      const report = await checker.checkAll();
      const dimension = report.dimensions.find((item) => item.name === "富记录图谱覆盖");

      expect(dimension?.status).toBe("warn");
      expect(dimension?.issues).toHaveLength(1);
      expect(dimension?.issues[0]).toMatchObject({
        severity: "medium",
        slug: "system/zero-link-rich-records",
      });
      expect(dimension?.issues[0].description).toContain("total=1");
      expect(dimension?.issues[0].description).toContain("actionable=1");
      expect(dimension?.issues[0].description).not.toContain("records/record-a");
      expect(dimension?.issues[0].suggestion).toBe("cbrain zero-link-backfill --json");
    });

    test("warns on global commit-unknown even when rich zero-link total is zero", async () => {
      insertPage("records/record-a", "RecordA", "record");
      db.insertChunk("records/record-a", 0, "first raw chunk");
      db.insertChunk("records/record-a", 1, "second raw chunk");
      insertPage("entity/entity-a", "EntityA", "entity/person");
      insertLink("records/record-a", "entity/entity-a");
      const id = db.submitJob("ner-backfill", {
        slug: "records/record-a",
        kind: "ner",
        contentHash: "hash-record-a",
        sourceFingerprint: "page:hash-record-a",
      });
      db.rawDb.prepare("UPDATE jobs SET status='done', result=? WHERE id=?")
        .run(JSON.stringify({ outcome: "commit_unknown" }), id);

      const report = await checker.checkAll();
      const dimension = report.dimensions.find((item) => item.name === "富记录图谱覆盖");
      expect(dimension?.status).toBe("warn");
      expect(dimension?.issues).toHaveLength(1);
      expect(dimension?.issues[0].description).toContain("total=0");
      expect(dimension?.issues[0].description).toContain("commit_unknown=1");
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

    test("detects title collision quarantines", async () => {
      // Seed quarantine config with a title collision entry
      db.setConfig("watcher.quarantine", JSON.stringify({
        "records/renwu-a-note": {
          failCount: 3,
          lastError: 'Title collision: "人物A"',
          quarantinedAt: new Date().toISOString(),
          titleCollisionJson: {
            title: "人物A",
            incoming: { slug: "records/renwu-a-note", type: "record", filePath: "records/renwu-a-note.md" },
            existing: { slug: "brain/entities/person/renwu-a", type: "entity/person", filePath: "brain/entities/person/renwu-a.md" },
          },
        },
      }));

      const report = await checker.checkAll();
      const tcDim = report.dimensions.find(d => d.name === "标题冲突隔离");
      expect(tcDim).toBeDefined();
      expect(tcDim!.status).toBe("fail");
      expect(tcDim!.issues.length).toBe(1);
      expect(tcDim!.issues[0].slug).toBe("records/renwu-a-note");
      expect(tcDim!.issues[0].title).toBe("人物A");
      expect(tcDim!.issues[0].description).toContain("records/renwu-a-note");
      expect(tcDim!.issues[0].description).toContain("brain/entities/person/renwu-a");
      expect(tcDim!.issues[0].description).toContain("records/renwu-a-note.md");
      expect(tcDim!.issues[0].description).toContain("brain/entities/person/renwu-a.md");
      expect(tcDim!.issues[0].suggestion).toContain("merge_pages");
    });

    test("no title collision issues when quarantine is empty", async () => {
      for (let i = 0; i < 15; i++) {
        insertPage(`entities/e${i}`, `Entity${i}`, "entity/person", { mention_count: 2, tier: 3 });
      }
      insertPage("records/r1", "Record1", "record");
      for (let i = 1; i < 15; i++) {
        insertLink(`entities/e${i - 1}`, `entities/e${i}`);
      }

      const report = await checker.checkAll();
      const tcDim = report.dimensions.find(d => d.name === "标题冲突隔离");
      expect(tcDim).toBeDefined();
      expect(tcDim!.status).toBe("pass");
      expect(tcDim!.issues.length).toBe(0);
    });

    test("reports latency-only searches as warnings, not degraded search quality", async () => {
      for (let i = 0; i < 8; i++) {
        db.logSearch(`主题${i}`, "smart", 3500 + i, 5, i % 2 === 0, {
          reason_codes: ["latency_budget_exceeded"],
        });
      }
      db.logSearch("主题降级", "smart", 80, 0, true, {
        reason_codes: ["fts_empty"],
      });
      db.logSearch("主题正常", "smart", 30, 4, false, { reason_codes: [] });

      const report = await checker.checkAll();
      const searchDim = report.dimensions.find(d => d.name === "搜索质量");

      expect(searchDim).toBeDefined();
      expect(searchDim!.issues.some(i => i.title.includes("80% 搜索降级率"))).toBe(false);
      expect(searchDim!.issues.some(i => i.title === "频繁降级原因: latency_budget_exceeded")).toBe(false);
      expect(searchDim!.issues.some(i => i.title.includes("搜索慢查询提示"))).toBe(true);
      expect(searchDim!.issues.some(i => i.title === "频繁慢查询原因: latency_budget_exceeded")).toBe(true);
    });

    test("fails system error health when an error happened in the last 24 hours", async () => {
      insertHealthyFixture();
      const outputsDir = join(testDir, "outputs");
      const logger = new Logger(outputsDir);
      logger.error("sync", "recent failure");

      const report = await new HealthChecker(db, outputsDir, logger).checkAll();
      const dim = report.dimensions.find(d => d.name === "系统错误");

      expect(dim).toBeDefined();
      expect(dim!.status).toBe("fail");
      expect(dim!.issues[0].severity).toBe("high");
      expect(dim!.issues[0].description).toContain("最近 24 小时");
    });

    test("warns but does not fail on historical system errors older than 24 hours", async () => {
      insertHealthyFixture();
      const outputsDir = join(testDir, "outputs");
      const logger = new Logger(outputsDir);
      const olderErrorDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      writeSystemErrorLog(outputsDir, olderErrorDate, "research", "historical failure");

      const report = await new HealthChecker(db, outputsDir, logger).checkAll();
      const dim = report.dimensions.find(d => d.name === "系统错误");

      expect(dim).toBeDefined();
      expect(dim!.status).toBe("warn");
      expect(dim!.issues[0].severity).toBe("medium");
      expect(dim!.issues[0].description).toContain("最近 7 天");
      expect(report.overallStatus).not.toBe("fail");
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

  describe("classifyContextPair", () => {
    const { classifyContextPair } = require("../../src/core/maintenance/health.js") as typeof import("../../src/core/maintenance/health.js");

    test("complementary: low overlap (different topics)", () => {
      expect(classifyContextPair("负责区域A销售", "主导产品研发团队")).toBe("complementary");
    });

    test("complementary: high overlap (nearly identical)", () => {
      expect(classifyContextPair("担任技术部门总监", "任职技术部总监")).toBe("complementary");
    });

    test("conflict: negation asymmetry + shared content", () => {
      expect(classifyContextPair("目前在职负责项目A", "已不再负责项目A")).toBe("conflict");
    });

    test("conflict: negation word in one side only", () => {
      expect(classifyContextPair("该项目正在进行中", "该项目没有在进行")).toBe("conflict");
    });

    test("insufficient: too short", () => {
      expect(classifyContextPair("同事", "合作伙伴")).toBe("insufficient");
    });

    test("insufficient: one side too short", () => {
      expect(classifyContextPair("负责整个区域A销售业务", "同事")).toBe("insufficient");
    });

    test("complementary: medium overlap but no conflict signals", () => {
      expect(classifyContextPair("担任市场部总监负责品牌推广", "负责区域B业务拓展和市场运营")).toBe("complementary");
    });

    test("conflict: mutex states — 在职 vs 离职", () => {
      expect(classifyContextPair("目前在组织C任职", "已从组织C离职")).toBe("conflict");
    });

    test("conflict: mutex states — 负责 vs 不再负责", () => {
      expect(classifyContextPair("负责项目A推进", "已不再负责项目A")).toBe("conflict");
    });

    test("conflict: mutex states — 进行中 vs 已结束", () => {
      expect(classifyContextPair("项目A正在进行", "项目A已结束")).toBe("conflict");
    });

    test("complementary: different roles still pass", () => {
      expect(classifyContextPair("担任区域A销售负责人", "主导区域B产品研发")).toBe("complementary");
    });

    // Same negative state — must NOT be flagged as conflict
    test("complementary: both negative — 离职 vs 离职", () => {
      expect(classifyContextPair("已从组织C离职", "已从组织C离职")).toBe("complementary");
    });

    test("complementary: both negative — 不再负责 vs 不再负责", () => {
      expect(classifyContextPair("已不再负责项目A", "已不再负责项目A")).toBe("complementary");
    });

    test("complementary: both negative — 不属于 vs 不属于", () => {
      expect(classifyContextPair("不属于组织C", "不属于组织C")).toBe("complementary");
    });
  });

  describe("checkContradictions", () => {
    function insertLinkWithContext(from: string, to: string, context: string) {
      db.rawDb.prepare(
        "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context, weight, strength, source_type, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(from, to, "提及", context, 1.0, "strong", "wikilink", 1.0);
    }

    test("complementary contexts produce no issues", async () => {
      insertPage("entities/person-a", "人物A", "entity/person");
      insertPage("records/rec-1", "记录1", "record");
      insertPage("records/rec-2", "记录2", "record");
      insertLinkWithContext("records/rec-1", "entities/person-a", "负责区域A销售");
      insertLinkWithContext("records/rec-2", "entities/person-a", "主导产品研发团队");

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "矛盾检测");
      expect(dim?.status).toBe("pass");
      expect(dim?.issues.length).toBe(0);
    });

    test("conflicting contexts produce warn with issue", async () => {
      insertPage("entities/person-b", "人物B", "entity/person");
      insertPage("records/rec-3", "记录3", "record");
      insertPage("records/rec-4", "记录4", "record");
      insertLinkWithContext("records/rec-3", "entities/person-b", "目前在职负责项目A");
      insertLinkWithContext("records/rec-4", "entities/person-b", "已不再负责项目A");

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "矛盾检测");
      expect(dim?.status).toBe("warn");
      expect(dim?.issues.length).toBe(1);
      expect(dim!.issues[0].slug).toBe("entities/person-b");
      expect(dim!.issues[0].description).toContain("records/rec-3");
      expect(dim!.issues[0].description).toContain("records/rec-4");
    });

    test("mutex state conflict — 任职 vs 离职 produces warn", async () => {
      insertPage("entities/person-e", "人物E", "entity/person");
      insertPage("records/rec-10", "记录10", "record");
      insertPage("records/rec-11", "记录11", "record");
      insertLinkWithContext("records/rec-10", "entities/person-e", "目前在组织C任职");
      insertLinkWithContext("records/rec-11", "entities/person-e", "已从组织C离职");

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "矛盾检测");
      expect(dim?.status).toBe("warn");
      expect(dim!.issues.length).toBe(1);
    });

    test("insufficient contexts produce no issues", async () => {
      insertPage("entities/person-c", "人物C", "entity/person");
      insertPage("records/rec-5", "记录5", "record");
      insertPage("records/rec-6", "记录6", "record");
      insertLinkWithContext("records/rec-5", "entities/person-c", "同事");
      insertLinkWithContext("records/rec-6", "entities/person-c", "合作伙伴");

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "矛盾检测");
      expect(dim?.status).toBe("pass");
      expect(dim?.issues.length).toBe(0);
    });

    test("mixed: 3 sources with 1 conflict pair", async () => {
      insertPage("entities/person-d", "人物D", "entity/person");
      insertPage("records/rec-7", "记录7", "record");
      insertPage("records/rec-8", "记录8", "record");
      insertPage("records/rec-9", "记录9", "record");
      insertLinkWithContext("records/rec-7", "entities/person-d", "负责区域A销售业务");
      insertLinkWithContext("records/rec-8", "entities/person-d", "主导产品研发团队");
      insertLinkWithContext("records/rec-9", "entities/person-d", "不再负责区域A销售");

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "矛盾检测");
      expect(dim?.status).toBe("warn");
      expect(dim!.issues.length).toBeGreaterThanOrEqual(1);
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

  describe("结构一致性", () => {
    const vaultDir = join(testDir, "vault");

    beforeEach(() => {
      mkdirSync(vaultDir, { recursive: true });
    });

    function writeVaultFile(fileName: string, content: string) {
      writeFileSync(join(vaultDir, fileName), content, "utf-8");
    }

    test("检测图边未写入 Known Relations", async () => {
      insertPage("entity/a", "A", "entity/person", { file_path: "entity-a.md" });
      insertPage("entity/b", "B", "entity/person", { file_path: "entity-b.md" });
      insertLink("entity/a", "entity/b", "协作");

      writeVaultFile("entity-a.md", "---\ntitle: A\ntype: entity/person\nslug: entity/a\n---\nA 的内容\n");
      writeVaultFile("entity-b.md", "---\ntitle: B\ntype: entity/person\nslug: entity/b\n---\nB 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.length).toBeGreaterThanOrEqual(1);
      expect(dim!.issues.some(i => i.description.includes("出边未写入 Known Relations"))).toBe(true);
    });

    test("检测 Known Relations stale projection drift", async () => {
      insertPage("entity/a", "A", "entity/person", { file_path: "entity-a.md" });
      insertPage("entity/b", "B", "entity/person", { file_path: "entity-b.md" });
      insertPage("entity/old", "Old", "entity/person", { file_path: "entity-old.md" });
      insertLink("entity/a", "entity/b", "协作");

      writeVaultFile("entity-a.md", "---\ntitle: A\ntype: entity/person\nslug: entity/a\n---\nA 的内容\n\n## Known Relations\n\n- 协作 → [[entity/b]]\n- 协作 → [[entity/old]]\n");
      writeVaultFile("entity-b.md", "---\ntitle: B\ntype: entity/person\nslug: entity/b\n---\nB 的内容\n\n## Known Relations\n\n- ← 协作 from [[entity/a]]\n");
      writeVaultFile("entity-old.md", "---\ntitle: Old\ntype: entity/person\nslug: entity/old\n---\nOld 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i => i.slug === "entity/a" && i.description.includes("Known Relations projection drift"))).toBe(true);
    });

    test("candidate reports_to 不要求写入 Known Relations", async () => {
      insertPage("entity/staff-candidate", "StaffCandidate", "entity/person", { file_path: "entity-staff-candidate.md" });
      insertPage("entity/boss-candidate", "BossCandidate", "entity/person", { file_path: "entity-boss-candidate.md" });
      db.rawDb.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, trust_state, source_type) VALUES (?, ?, 'reports_to', 'candidate', 'ner')",
      ).run("entity/staff-candidate", "entity/boss-candidate");

      writeVaultFile("entity-staff-candidate.md", "---\ntitle: StaffCandidate\ntype: entity/person\nslug: entity/staff-candidate\n---\nStaffCandidate 的内容\n");
      writeVaultFile("entity-boss-candidate.md", "---\ntitle: BossCandidate\ntype: entity/person\nslug: entity/boss-candidate\n---\nBossCandidate 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i =>
        i.slug === "entity/staff-candidate" &&
        i.description.includes("出边未写入 Known Relations")
      )).toBe(false);
      expect(dim!.issues.some(i =>
        i.slug === "entity/boss-candidate" &&
        i.description.includes("入边未写入 Known Relations")
      )).toBe(false);
    });

    test("检测正文 wikilink 缺 links 表边", async () => {
      insertPage("entity/x", "人物甲", "entity/person", { file_path: "entity-x.md" });
      insertPage("entity/y", "人物乙", "entity/person", { file_path: "entity-y.md" });

      writeVaultFile("entity-x.md", "---\ntitle: 人物甲\ntype: entity/person\nslug: entity/x\n---\n提到了 [[人物乙]]。\n");
      writeVaultFile("entity-y.md", "---\ntitle: 人物乙\ntype: entity/person\nslug: entity/y\n---\n人物乙 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i => i.description.includes("links 表无边") && i.slug === "entity/x")).toBe(true);
    });

    test("检测 reports_to 使用非完整 slug", async () => {
      insertPage("entity/staff", "Staff", "entity/person", { file_path: "entity-staff.md" });
      insertPage("entity/boss", "Boss", "entity/person", { file_path: "entity-boss.md" });

      writeVaultFile("entity-staff.md", "---\ntitle: Staff\ntype: entity/person\nslug: entity/staff\nreports_to: boss\n---\nStaff 的内容\n");
      writeVaultFile("entity-boss.md", "---\ntitle: Boss\ntype: entity/person\nslug: entity/boss\n---\nBoss 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i => i.description.includes("不是完整 slug"))).toBe(true);
    });

    test("检测 reports_to 缺 graph edge", async () => {
      insertPage("entity/staff2", "Staff2", "entity/person", { file_path: "entity-staff2.md" });
      insertPage("entity/boss2", "Boss2", "entity/person", { file_path: "entity-boss2.md" });

      writeVaultFile("entity-staff2.md", "---\ntitle: Staff2\ntype: entity/person\nslug: entity/staff2\nreports_to: entity/boss2\n---\nStaff2 的内容\n");
      writeVaultFile("entity-boss2.md", "---\ntitle: Boss2\ntype: entity/person\nslug: entity/boss2\n---\nBoss2 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i => i.description.includes("缺少对应图边"))).toBe(true);
    });

    test("全部一致时返回 pass", async () => {
      insertPage("entity/p1", "P1", "entity/person", { file_path: "entity-p1.md" });
      insertPage("entity/p2", "P2", "entity/person", { file_path: "entity-p2.md" });
      insertLink("entity/p1", "entity/p2", "协作");

      writeVaultFile("entity-p1.md", "---\ntitle: P1\ntype: entity/person\nslug: entity/p1\n---\nP1 的内容\n\n## Known Relations\n\n- 协作 → [[entity/p2]]\n");
      writeVaultFile("entity-p2.md", "---\ntitle: P2\ntype: entity/person\nslug: entity/p2\n---\nP2 的内容\n\n## Known Relations\n\n- ← 协作 from [[entity/p1]]\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.status).toBe("pass");
      expect(dim!.issues.length).toBe(0);
    });

    test("正文 [[显示名]] 已有对应 slug link 时不报错", async () => {
      insertPage("entity/person-a", "人物A", "entity/person", { file_path: "entity-person-a.md" });
      insertPage("entity/other", "Other", "entity/person", { file_path: "entity-other.md" });
      // Link exists by slug in DB
      insertLink("entity/person-a", "entity/other", "提及");

      // Wikilink uses display name, not slug — should resolve and NOT flag
      writeVaultFile("entity-person-a.md", "---\ntitle: 人物A\ntype: entity/person\nslug: entity/person-a\n---\n提到了 [[Other]]。\n");
      writeVaultFile("entity-other.md", "---\ntitle: Other\ntype: entity/person\nslug: entity/other\n---\nOther 的内容\n");

      const vaultChecker = new HealthChecker(db, join(testDir, "outputs"), undefined, vaultDir);
      const report = await vaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.issues.some(i => i.description.includes("links 表无边") && i.slug === "entity/person-a")).toBe(false);
    });

    test("无 vaultPath 时跳过结构一致性检查", async () => {
      insertPage("entity/noVault", "NoVault", "entity/person");

      const noVaultChecker = new HealthChecker(db, join(testDir, "outputs"));
      const report = await noVaultChecker.checkAll();
      const dim = report.dimensions.find(d => d.name === "结构一致性");
      expect(dim).toBeDefined();
      expect(dim!.status).toBe("pass");
      expect(dim!.issues.length).toBe(0);
    });
  });

  describe("批量变更保护", () => {
    test("reports warn when bulk is paused", async () => {
      db.setConfig("watcher.bulk_pending", JSON.stringify({
        paused: true,
        pendingFiles: Array.from({ length: 60 }, (_, i) => ({
          slug: `bulk${i}`, fullPath: `/v/bulk${i}.md`, hash: `h${i}`, mtime: { mtime: 1, size: 1 },
        })),
        threshold: 50,
        pausedAt: "2026-06-05T10:00:00Z",
      }));

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "批量变更保护");
      expect(dim).toBeDefined();
      expect(dim!.status).toBe("warn");
      expect(dim!.issues.length).toBe(1);
      expect(dim!.issues[0].title).toBe("批量变更暂停");
      expect(dim!.issues[0].description).toContain("60");
      expect(dim!.issues[0].description).toContain("50");
      expect(dim!.issues[0].suggestion).toContain("bulk_resume");
    });

    test("reports pass when no bulk state", async () => {
      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "批量变更保护");
      expect(dim).toBeDefined();
      expect(dim!.status).toBe("pass");
      expect(dim!.issues.length).toBe(0);
    });

    test("reports pass when bulk state exists but not paused", async () => {
      db.setConfig("watcher.bulk_pending", JSON.stringify({
        paused: false,
        pendingFiles: [],
        threshold: 50,
        pausedAt: "2026-06-05T10:00:00Z",
      }));

      const report = await checker.checkAll();
      const dim = report.dimensions.find(d => d.name === "批量变更保护");
      expect(dim).toBeDefined();
      expect(dim!.status).toBe("pass");
    });
  });
});
