import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB, openReadSnapshotWithHookForTest } from "../../src/storage/sqlite.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function liveSnapshot(dbPath: string): string {
	return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) =>
		existsSync(path) ? `${path.slice(dbPath.length)}:${hash(path)}` : `${path.slice(dbPath.length)}:missing`
	).join("|");
}

function snapshotTempDirs(): string[] {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("cbrain-read-snapshot-")).sort();
}

test("read snapshot preserves a native DELETE-mode database and rejects writes", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-readonly-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const native = new Database(dbPath);
	native.exec("CREATE TABLE anonymous_record (id INTEGER PRIMARY KEY, value TEXT); PRAGMA journal_mode = DELETE;");
	native.close();
	const before = hash(dbPath);

	const db = new CBrainDB(dbPath, { readSnapshot: true });
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

test("read snapshot never creates a missing parent or accepts explicit migration", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-readonly-missing-"));
	roots.push(root);
	const missingPath = join(root, "missing", "fixture.sqlite");
	expect(() => new CBrainDB(missingPath, { readSnapshot: true })).toThrow();
	expect(existsSync(join(root, "missing"))).toBe(false);

	mkdirSync(join(root, "present"));
	const presentPath = join(root, "present", "fixture.sqlite");
	const native = new Database(presentPath);
	native.close();
	expect(() => new CBrainDB(presentPath, { readSnapshot: true, skipMigrate: false })).toThrow(/snapshot.*skipMigrate/i);
});

test("read snapshot opens a WAL-header database after restore removed every sidecar", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-wal-header-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const native = new Database(dbPath);
	native.exec("PRAGMA journal_mode=WAL; CREATE TABLE anonymous_record(value TEXT); INSERT INTO anonymous_record VALUES ('committed'); PRAGMA wal_checkpoint(TRUNCATE)");
	native.close();
	rmSync(`${dbPath}-wal`, { force: true });
	rmSync(`${dbPath}-shm`, { force: true });
	expect(readFileSync(dbPath)[18]).toBe(2);
	const before = liveSnapshot(dbPath);

	const db = new CBrainDB(dbPath, { readSnapshot: true });
	expect(db.rawDb.prepare("SELECT value FROM anonymous_record").get()).toEqual({ value: "committed" });
	db.close();

	expect(liveSnapshot(dbPath)).toBe(before);
});

test("read snapshot includes the latest committed WAL row without touching live main/wal/shm", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-active-wal-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const writer = new Database(dbPath);
	writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE anonymous_record(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO anonymous_record VALUES ('latest-in-wal')");
	expect(existsSync(`${dbPath}-wal`)).toBe(true);
	expect(existsSync(`${dbPath}-shm`)).toBe(true);
	const before = liveSnapshot(dbPath);

	try {
		const db = new CBrainDB(dbPath, { readSnapshot: true });
		try {
			expect(db.rawDb.prepare("SELECT value FROM anonymous_record").get()).toEqual({ value: "latest-in-wal" });
		} finally {
			db.close();
		}
		expect(liveSnapshot(dbPath)).toBe(before);
	} finally {
		writer.close();
	}
});

test("read snapshot removes its temp directory on close and construction failure", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-snapshot-cleanup-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const native = new Database(dbPath);
	native.exec("CREATE TABLE anonymous_record(value TEXT)");
	native.close();
	const before = snapshotTempDirs();

	const db = new CBrainDB(dbPath, { readSnapshot: true });
	const during = snapshotTempDirs();
	expect(during.length).toBe(before.length + 1);
	db.close();
	expect(snapshotTempDirs()).toEqual(before);

	mkdirSync(`${dbPath}-wal`);
	writeFileSync(join(`${dbPath}-wal`, "not-a-wal"), "invalid");
	expect(() => new CBrainDB(dbPath, { readSnapshot: true })).toThrow();
	expect(snapshotTempDirs()).toEqual(before);
});

test("read snapshot retries a changing source three times then fails closed without temp residue", () => {
	const root = mkdtempSync(join(tmpdir(), "cbrain-sqlite-snapshot-changing-"));
	roots.push(root);
	const dbPath = join(root, "fixture.sqlite");
	const native = new Database(dbPath);
	native.exec("CREATE TABLE anonymous_record(value TEXT)");
	native.close();
	const before = snapshotTempDirs();
	const attempts: number[] = [];

	expect(() => openReadSnapshotWithHookForTest(dbPath, (attempt) => {
		attempts.push(attempt);
		const shifted = new Date(Date.now() + (attempt + 1) * 10_000);
		utimesSync(dbPath, shifted, shifted);
	})).toThrow(/stable read snapshot/i);
	expect(attempts).toEqual([0, 1, 2]);
	expect(snapshotTempDirs()).toEqual(before);
});
