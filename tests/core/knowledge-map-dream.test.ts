import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runDream } from "../../src/core/dream.js";
import {
  runKnowledgeMapStage,
  shouldRunKnowledgeMap,
  KM_ENABLED_KEY,
  KM_LAST_RUN_KEY,
} from "../../src/core/knowledge-map/schedule.js";
import type { SyncManager } from "../../src/core/sync.js";
import type { EnrichManager } from "../../src/core/enrich.js";
import type { HealthChecker } from "../../src/core/health.js";
import type { Logger } from "../../src/core/logger.js";

const MS_PER_DAY = 86_400_000;
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

function mockSync(): SyncManager {
  return {
    syncAll: async () => ({ synced: 0, skipped: 0, errors: 0 }),
    removeOrphans: async () => [],
    cleanStaleStubs: async () => [],
    cleanLanceOrphans: async () => [],
  } as unknown as SyncManager;
}
function mockEnrich(): EnrichManager {
  return { enrichAll: () => [] } as unknown as EnrichManager;
}
function mockHealth(): HealthChecker {
  return {
    checkAll: async () => ({ timestamp: new Date().toISOString(), overallStatus: "pass", dimensions: [], reportPaths: {} }),
  } as unknown as HealthChecker;
}

/** Seed an anonymous 2-entity graph (one tiny structure, not a main domain). */
function seedGraph(db: CBrainDB): void {
  const ins = db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  ins.run("entity/a", "entity/person", "实体A", "a.md", "h1", 1, 1);
  ins.run("entity/b", "entity/person", "实体B", "b.md", "h2", 1, 1);
  db.rawDb
    .prepare("INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)")
    .run("entity/a", "entity/b", "mentions", "wikilink");
}

describe("Knowledge Map Dream stage (#242)", () => {
  let testDir: string;
  let db: CBrainDB;
  let outputsDir: string;
  let vaultPath: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-km-dream-"));
    dbPath = join(testDir, "brain.sqlite");
    vaultPath = join(testDir, "vault");
    outputsDir = join(testDir, "runtime");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });
    db = new CBrainDB(dbPath);
    seedGraph(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ─── Schedule decision (pure, fast) ────────────────────────────────────

  describe("shouldRunKnowledgeMap", () => {
    test("first run (no last_run_at) → run", () => {
      const d = shouldRunKnowledgeMap(db);
      expect(d.run).toBe(true);
      expect(d.enabled).toBe(true);
      expect(d.lastRunAt).toBeNull();
    });

    test("inside interval → skip", () => {
      const now = Date.now();
      db.setConfig(KM_LAST_RUN_KEY, new Date(now).toISOString());
      const d = shouldRunKnowledgeMap(db, { now: now + MS_PER_DAY }); // 1 day < 7
      expect(d.run).toBe(false);
    });

    test("after interval → run", () => {
      const now = Date.now();
      db.setConfig(KM_LAST_RUN_KEY, new Date(now).toISOString());
      const d = shouldRunKnowledgeMap(db, { now: now + 8 * MS_PER_DAY });
      expect(d.run).toBe(true);
    });

    test("disabled → never run (covers both 'false' and '0')", () => {
      for (const v of ["false", "0"]) {
        db.setConfig(KM_ENABLED_KEY, v);
        expect(shouldRunKnowledgeMap(db).run).toBe(false);
        expect(shouldRunKnowledgeMap(db, { force: true }).run).toBe(false);
      }
    });
  });

  // ─── Stage execution ───────────────────────────────────────────────────

  test("first run generates a report and records last_run_at", async () => {
    const stage = await runKnowledgeMapStage(db, outputsDir, silentLogger);
    expect(stage.status).toBe("generated");
    expect(stage.reportPath).not.toBeNull();
    expect(existsSync(stage.reportPath as string)).toBe(true);
    expect(stage.lastRunAt).not.toBeNull();
    expect(db.getConfig(KM_LAST_RUN_KEY)).toBe(stage.lastRunAt);
    expect(stage.domains).toBe(0); // a–b is too small to be a main domain
    expect(stage.growing).toBe(1);
  });

  test("second run inside the interval skips and leaves last_run_at untouched", async () => {
    const prior = new Date(Date.now() - MS_PER_DAY).toISOString(); // 1 day ago < 7
    db.setConfig(KM_LAST_RUN_KEY, prior);

    const stage = await runKnowledgeMapStage(db, outputsDir, silentLogger);
    expect(stage.status).toBe("skipped");
    expect(stage.reportPath).toBeNull();
    expect(stage.lastRunAt).toBe(prior);
    expect(db.getConfig(KM_LAST_RUN_KEY)).toBe(prior); // unchanged
  });

  test("write failure is isolated: status=failed, last_run_at not advanced", async () => {
    const prior = new Date(Date.now() - MS_PER_DAY).toISOString();
    db.setConfig(KM_LAST_RUN_KEY, prior);
    // outputsDir under a file → mkdirSync throws ENOTDIR → caught.
    const blockFile = join(testDir, "blockfile");
    writeFileSync(blockFile, "x");

    // force bypasses the interval so the stage attempts the write and fails.
    const stage = await runKnowledgeMapStage(db, join(blockFile, "out"), silentLogger, { force: true });
    expect(stage.status).toBe("failed");
    expect(stage.warning).toBeDefined();
    expect(stage.reportPath).toBeNull();
    expect(db.getConfig(KM_LAST_RUN_KEY)).toBe(prior); // not advanced
  });

  test("failed-stage warning redacts absolute/temp paths (#242 privacy regression)", async () => {
    db.setConfig(KM_LAST_RUN_KEY, new Date(Date.now() - MS_PER_DAY).toISOString());
    const blockFile = join(testDir, "blockfile");
    writeFileSync(blockFile, "x");
    // Force a write failure whose raw error carries the absolute temp path; the
    // warning surfaces in dream_status.raw.progress, so it must not leak paths.
    const stage = await runKnowledgeMapStage(db, join(blockFile, "out"), silentLogger, { force: true });
    expect(stage.status).toBe("failed");
    expect(stage.warning).toBeDefined();
    expect(stage.warning).not.toContain(testDir);
    expect(stage.warning).not.toMatch(/\/tmp\//);
    expect(stage.warning).not.toContain("~/");
    expect(stage.warning).toContain("<path>"); // redaction ran
  });

  test("report is written under outputs/knowledge-map, never the vault", async () => {
    const stage = await runKnowledgeMapStage(db, outputsDir, silentLogger);
    const path = stage.reportPath as string;
    expect(path.startsWith(outputsDir)).toBe(true);
    expect(path).toContain("knowledge-map");
    expect(existsSync(join(vaultPath, "knowledge-map"))).toBe(false);
  });

  test("Dream KM stage feeds isolation/bridge signals into discoveries (#244)", async () => {
    // Add an isolated, high-mention node (实体F) on top of the seeded a–b edge.
    // f has degree 0 and mention_count 20 > graph mean → highMentionIsolate.
    db.rawDb
      .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/f", "entity/person", "实体F", "f.md", "h3", 1, 20);

    const stage = await runKnowledgeMapStage(db, outputsDir, silentLogger, { force: true });
    expect(stage.status).toBe("generated");
    expect(stage.discoveryCandidates).toBeGreaterThan(0);

    const kmRows =
      db.getDiscoveriesByType("knowledge_map_isolation", 10).length +
      db.getDiscoveriesByType("knowledge_map_bridge", 10).length;
    expect(kmRows).toBeGreaterThan(0);

    // producer must not touch the existing discovery ranking path
    expect(db.getDiscoveriesByType("bridge", 10)).toHaveLength(0);
    expect(db.getDiscoveriesByType("gap", 10)).toHaveLength(0);
  });

  // ─── Dream integration ─────────────────────────────────────────────────

  test("Dream brief includes the Knowledge Map line after a successful run", async () => {
    const report = await runDream(
      vaultPath, db, mockSync(), mockEnrich(), mockHealth(),
      outputsDir, silentLogger, undefined, dbPath,
    );
    expect(report.locked).toBe(false);
    expect(report.stages.knowledge_map.status).toBe("generated");
    expect(report.brief).toContain("Knowledge Map:");
    expect(report.brief).toContain("0 个主知识域");
    expect(report.brief).toContain("1 个偏松散结构");
  });

  test("Dream brief includes discovery signals when KM stage produced candidates (#244)", async () => {
    db.rawDb
      .prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/f", "entity/person", "实体F", "f.md", "h3", 1, 20);
    const report = await runDream(
      vaultPath, db, mockSync(), mockEnrich(), mockHealth(),
      outputsDir, silentLogger, undefined, dbPath,
    );
    expect(report.stages.knowledge_map.discoveryCandidates).toBeGreaterThan(0);
    expect(report.brief).toContain("发现信号");
  });

  test("locked Dream skip returns safe-default knowledge_map stage and generates nothing", async () => {
    db.setConfig("dream.lock", String(Date.now())); // hold the lock

    const report = await runDream(
      vaultPath, db, mockSync(), mockEnrich(), mockHealth(),
      outputsDir, silentLogger, undefined, dbPath,
    );
    expect(report.locked).toBe(true);
    expect(report.stages.knowledge_map.status).toBe("skipped");
    expect(report.stages.knowledge_map.reportPath).toBeNull();
    expect(existsSync(join(outputsDir, "knowledge-map"))).toBe(false);
    expect(db.getConfig(KM_LAST_RUN_KEY)).toBeNull(); // never advanced
  });
});
