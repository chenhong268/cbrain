import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { checkLanceIntegrity } from "../../src/core/lance-integrity.js";

const TEST_DIR = "/tmp/cbrain-test-lance-integrity";

function makeDb(dbPath: string): CBrainDB {
  return new CBrainDB(dbPath);
}

function seedChunks(db: CBrainDB, slugs: string[]): void {
  for (const slug of slugs) {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
    ).run(slug, slug.replace(/.*\//, ""), `${slug}.md`, "h1");
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
    ).run(slug, `content for ${slug}`);
  }
}

function deleteChunksTable(db: CBrainDB): void {
  db.rawDb.prepare("DELETE FROM chunks").run();
}

describe("LanceDB integrity probe", () => {
  const dbPath = join(TEST_DIR, "test.sqlite");
  const lancePath = join(TEST_DIR, "lance");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = makeDb(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("new install: no SQLite chunks, no LanceDB → pass", async () => {
    deleteChunksTable(db);
    const report = await checkLanceIntegrity(lancePath, db);
    expect(report.overallStatus).toBe("pass");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].id).toBe("lance:path");
    expect(report.checks[0].message).toContain("新安装");
  });

  test("SQLite has chunks, LanceDB path missing → fail with safe recovery hint", async () => {
    seedChunks(db, ["entities/a", "entities/b"]);
    const report = await checkLanceIntegrity(lancePath, db);
    expect(report.overallStatus).toBe("fail");
    const pathCheck = report.checks.find(c => c.id === "lance:path");
    expect(pathCheck?.status).toBe("fail");
    // Recovery must recommend --reindex-vectors, no rm-rf, no SQL
    expect(pathCheck?.action).toContain("--reindex-vectors");
    expect(pathCheck?.action).not.toContain("rm -rf");
    expect(pathCheck?.action).not.toContain("content_hash");
    expect(pathCheck?.action).not.toContain("sqlite3");
  });

  test("SQLite has chunks, LanceDB path exists, connect works → checks tables", async () => {
    seedChunks(db, ["entities/a"]);
    mkdirSync(lancePath, { recursive: true });
    const { LanceDBManager } = await import("../../src/storage/lancedb.js");
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "test", vector: new Float32Array(2048) }]);
    await lance.close();

    const report = await checkLanceIntegrity(lancePath, db);
    expect(report.overallStatus).toBe("pass");
    const readCheck = report.checks.find(c => c.id === "lance:read");
    expect(readCheck?.status).toBe("pass");
  });

  test("corrupted LanceDB → fail with safe recovery hint (no rm-rf)", async () => {
    seedChunks(db, ["entities/a"]);
    mkdirSync(lancePath, { recursive: true });
    writeFileSync(join(lancePath, "chunks.lance"), "not real lance data");
    mkdirSync(join(lancePath, "chunks"), { recursive: true });
    writeFileSync(join(lancePath, "chunks", "data.invalid"), "garbage");

    const report = await checkLanceIntegrity(lancePath, db);
    expect(report.overallStatus).toBe("fail");
    const failCheck = report.checks.find(c => c.status === "fail");
    expect(failCheck).toBeDefined();
    expect(failCheck!.action).toContain("--reindex-vectors");
    expect(failCheck!.action).not.toContain("rm -rf");
    expect(failCheck!.action).not.toContain("content_hash");
  });

  test("coverage gap → warn with reindex hint (no rm-rf, no 停止)", async () => {
    const allSlugs = Array.from({ length: 20 }, (_, i) => `entities/page-${i}`);
    seedChunks(db, allSlugs);
    mkdirSync(lancePath, { recursive: true });

    const { LanceDBManager } = await import("../../src/storage/lancedb.js");
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    for (const slug of allSlugs.slice(0, 5)) {
      await lance.addChunks([{ pageSlug: slug, chunkIndex: 0, content: "test", vector: new Float32Array(2048) }]);
    }
    await lance.close();

    const report = await checkLanceIntegrity(lancePath, db);
    const coverageCheck = report.checks.find(c => c.id === "lance:coverage");
    expect(coverageCheck?.status).toBe("warn");
    expect(coverageCheck?.action).toContain("--reindex-vectors");
    expect(coverageCheck?.action).not.toContain("rm -rf");
    expect(coverageCheck?.action).not.toContain("停止");
  });

  test("orphan vectors → warn with dream cleanup hint (not full rebuild)", async () => {
    seedChunks(db, ["entities/a"]);
    mkdirSync(lancePath, { recursive: true });

    const { LanceDBManager } = await import("../../src/storage/lancedb.js");
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "test", vector: new Float32Array(2048) }]);
    await lance.addChunks([{ pageSlug: "entities/orphan-ghost", chunkIndex: 0, content: "test", vector: new Float32Array(2048) }]);
    await lance.close();

    const report = await checkLanceIntegrity(lancePath, db);
    const orphanCheck = report.checks.find(c => c.id === "lance:orphans");
    expect(orphanCheck?.status).toBe("warn");
    expect(orphanCheck?.action).toContain("cbrain dream");
    expect(orphanCheck?.action).not.toContain("--reindex-vectors");
  });

  test("oversized directory: exceeds threshold → warn about compact", async () => {
    seedChunks(db, ["entities/a"]);
    mkdirSync(lancePath, { recursive: true });

    const { LanceDBManager } = await import("../../src/storage/lancedb.js");
    const lance = new LanceDBManager();
    await lance.connect(lancePath);
    await lance.addChunks([{ pageSlug: "entities/a", chunkIndex: 0, content: "test", vector: new Float32Array(2048) }]);
    await lance.close();

    writeFileSync(join(lancePath, "big_dummy.bin"), "x".repeat(1024));
    const report = await checkLanceIntegrity(lancePath, db, { sizeWarnBytes: 512 });

    const sizeCheck = report.checks.find(c => c.id === "lance:size");
    expect(sizeCheck?.status).toBe("warn");
    expect(sizeCheck?.action).toContain("cbrain compact");
  });

  test("full rebuild action mentions 停止 and backup for total corruption", async () => {
    seedChunks(db, ["entities/a"]);
    const report = await checkLanceIntegrity(lancePath, db);
    const pathCheck = report.checks.find(c => c.id === "lance:path");
    expect(pathCheck?.action).toContain("--reindex-vectors");
    expect(pathCheck?.action).toContain("停止");
    expect(pathCheck?.action).toContain("backup");
    expect(pathCheck?.action).not.toContain("rm -rf");
  });
});

describe("LanceDB probe caller error paths", () => {
  const dbPath = join(TEST_DIR, "caller-test.sqlite");
  const lancePath = join(TEST_DIR, "lance-caller");

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("SQLite query failure propagates (not swallowed)", async () => {
    const db = makeDb(dbPath);
    db.rawDb.prepare("DROP TABLE IF EXISTS chunks").run();

    expect(checkLanceIntegrity(lancePath, db)).rejects.toThrow();
    db.close();
  });

  test("probe does not close caller's DB handle", async () => {
    const db = makeDb(dbPath);
    const report = await checkLanceIntegrity(lancePath, db);
    expect(report.overallStatus).toBe("pass");

    // DB still usable — caller owns it
    const count = db.getPageCount();
    expect(count).toBeGreaterThanOrEqual(0);
    db.close();
  });
});
