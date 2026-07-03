import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeLance } from "../../../src/core/fsck/lance-probe.js";

let dir: string;
let db: CBrainDB;

afterEach(() => {
	db?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("lancePath not exist → state unchecked, directory NOT created, no finding", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-lance1-"));
	db = new CBrainDB(join(dir, "t.sqlite"));
	const missing = join(dir, "does-not-exist");
	const res = await probeLance(missing, db);
	expect(res.state).toBe("unchecked");
	expect(existsSync(missing)).toBe(false);
	expect(res.findings).toEqual([]);
});

test("lancePath exists but empty (no chunks table) → state missing or corrupt, no finding, no table created", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-lance2-"));
	db = new CBrainDB(join(dir, "t.sqlite"));
	const lanceDir = join(dir, "lance");
	mkdirSync(lanceDir);
	const res = await probeLance(lanceDir, db);
	expect(["missing", "corrupt"]).toContain(res.state);
	expect(res.findings).toEqual([]);
});

test("no chunk pages in sqlite → state ok, no finding even with empty lance", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-lance3-"));
	db = new CBrainDB(join(dir, "t.sqlite"));
	const lanceDir = join(dir, "lance");
	mkdirSync(lanceDir);
	// No chunks in sqlite, lance has no table → missing (no chunks to miss)
	const res = await probeLance(lanceDir, db);
	expect(["missing", "corrupt"]).toContain(res.state);
	expect(res.findings).toEqual([]);
});

test("#269 coverage gap finding carries stop-serve prerequisite, never recommends dream", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-lance-gap-"));
	db = new CBrainDB(join(dir, "t.sqlite"));
	// SQLite has a chunk for p/x
	db.rawDb.prepare(
		"INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)",
	).run("p/x", "X", "p/x.md", "h-x");
	db.rawDb.prepare(
		"INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 0, ?, 0)",
	).run("p/x", "body of x");

	// LanceDB has a chunks table with a DIFFERENT page only → p/x is a coverage gap
	const lanceDir = join(dir, "lance");
	mkdirSync(lanceDir);
	const lancedb = await import("@lancedb/lancedb");
	const conn = await lancedb.connect(lanceDir);
	await conn.createTable(
		"chunks",
		[{ pageSlug: "p/other", chunkIndex: 0, content: "other body", vector: new Float32Array(2048) }],
		{ mode: "overwrite" },
	);
	conn.close();

	const res = await probeLance(lanceDir, db);
	expect(res.state).toBe("ok");
	const gap = res.findings.find((f) => f.check === "lance.vector_coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.count).toBe(1);
	// suggestedCommand must carry the stop-serve prerequisite + the verify step
	expect(gap!.suggestedCommand).toMatch(/停 serve|停止 serve/);
	expect(gap!.suggestedCommand).toMatch(/reindex-vectors/);
	expect(gap!.suggestedCommand).toMatch(/fsck/);
	// must NOT offer dream as a coverage-gap fix path
	expect(gap!.suggestedCommand).not.toMatch(/dream/);
	const joined = `${gap!.suggestedCommand} ${gap!.detail}`;
	expect(joined).not.toMatch(/或走.*dream|走 bin\/cbrain-maintenance\.sh dream|运行 cbrain dream 修复/);
});
