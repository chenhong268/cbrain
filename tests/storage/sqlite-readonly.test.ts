import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("readonly CBrainDB preserves a native DELETE-mode database and rejects writes", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-readonly-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const native = new Database(dbPath);
	native.exec("CREATE TABLE anonymous_record (id INTEGER PRIMARY KEY, value TEXT); PRAGMA journal_mode = DELETE;");
	native.close();
	const before = hash(dbPath);

	const db = new CBrainDB(dbPath, { readonly: true });
	expect(() => db.rawDb.exec("INSERT INTO anonymous_record(value) VALUES ('x')")).toThrow();
	db.close();

	const verify = new Database(dbPath, { readonly: true });
	const mode = verify.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
	verify.close();
	expect(mode.journal_mode).toBe("delete");
	expect(hash(dbPath)).toBe(before);
	expect(existsSync(`${dbPath}-wal`)).toBe(false);
	expect(existsSync(`${dbPath}-shm`)).toBe(false);
});

test("readonly CBrainDB never creates a missing parent or accepts explicit migration", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-readonly-missing-"));
	roots.push(root);
	const missingPath = join(root, "missing", "fixture.sqlite");
	expect(() => new CBrainDB(missingPath, { readonly: true })).toThrow();
	expect(existsSync(join(root, "missing"))).toBe(false);

	mkdirSync(join(root, "present"));
	const presentPath = join(root, "present", "fixture.sqlite");
	const native = new Database(presentPath);
	native.close();
	expect(() => new CBrainDB(presentPath, { readonly: true, skipMigrate: false })).toThrow(/readonly.*skipMigrate/i);
});
