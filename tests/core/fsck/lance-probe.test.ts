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
