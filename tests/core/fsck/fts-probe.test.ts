import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeFts } from "../../../src/core/fsck/fts-probe.js";

let dir: string;
let db: CBrainDB;

function freshDb(): CBrainDB {
	dir = mkdtempSync(join(tmpdir(), "cbrain-test-"));
	return new CBrainDB(join(dir, "test.sqlite"));
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("clean db (no chunks) → empty findings", () => {
	db = freshDb();
	expect(probeFts(db)).toEqual([]);
});

test("page with chunk + fts synced → no fts.coverage_gap finding", () => {
	db = freshDb();
	db.insertPage({
		slug: "test-synced-page",
		type: "record",
		title: "SyncedPage",
		filePath: "sp.md",
		contentHash: "h1",
	});
	db.insertChunk("test-synced-page", 0, "hello world");
	db.ftsInsert("test-synced-page", "hello world");

	const findings = probeFts(db);
	expect(findings.find((f) => f.check === "fts.coverage_gap")).toBeUndefined();
});

test("page with chunk but no fts row → fts.coverage_gap warning", () => {
	db = freshDb();
	db.insertPage({
		slug: "test-no-fts-page",
		type: "record",
		title: "NoFtsPage",
		filePath: "nf.md",
		contentHash: "h2",
	});
	db.insertChunk("test-no-fts-page", 0, "chunk content here");
	// Do NOT call ftsInsert → simulates FTS gap

	const findings = probeFts(db);
	const gap = findings.find((f) => f.check === "fts.coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.severity).toBe("warning");
	expect(gap!.layer).toBe("fts");
	expect(gap!.count).toBe(1);
	expect(gap!.sampleSlugs).not.toContain("test-no-fts-page"); // 匿名
	expect(gap!.suggestedCommand).toContain("cbrain sync");
});

test("suggestedCommand never contains reindex-vectors", () => {
	db = freshDb();
	db.insertPage({
		slug: "test-no-vecs-page",
		type: "record",
		title: "NoVecsPage",
		filePath: "nv.md",
		contentHash: "h3",
	});
	db.insertChunk("test-no-vecs-page", 0, "content");
	// FTS gap: no ftsInsert called

	const findings = probeFts(db);
	const gap = findings.find((f) => f.check === "fts.coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.suggestedCommand).not.toContain("reindex-vectors");
});

test("≤5 gaps → per-slug sync command", () => {
	db = freshDb();
	for (let i = 0; i < 3; i++) {
		const slug = `test-gap-${i}`;
		db.insertPage({
			slug,
			type: "record",
			title: `GapPage${i}`,
			filePath: `${i}.md`,
			contentHash: `h${i}`,
		});
		db.insertChunk(slug, 0, `content ${i}`);
	}

	const findings = probeFts(db);
	const gap = findings.find((f) => f.check === "fts.coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.count).toBe(3);
	expect(gap!.suggestedCommand).toContain("cbrain sync --slug <slug> --reindex");
});

test(">5 gaps → cbrain doctor command", () => {
	db = freshDb();
	for (let i = 0; i < 8; i++) {
		const slug = `test-many-gap-${i}`;
		db.insertPage({
			slug,
			type: "record",
			title: `ManyGap${i}`,
			filePath: `m${i}.md`,
			contentHash: `mh${i}`,
		});
		db.insertChunk(slug, 0, `content ${i}`);
	}

	const findings = probeFts(db);
	const gap = findings.find((f) => f.check === "fts.coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.count).toBe(8);
	expect(gap!.suggestedCommand).toBe("cbrain doctor");
});

test("sampleSlugs capped at 5 even with many gaps", () => {
	db = freshDb();
	for (let i = 0; i < 10; i++) {
		const slug = `test-cap-gap-${i}`;
		db.insertPage({
			slug,
			type: "record",
			title: `CapGap${i}`,
			filePath: `c${i}.md`,
			contentHash: `ch${i}`,
		});
		db.insertChunk(slug, 0, `content ${i}`);
	}

	const findings = probeFts(db);
	const gap = findings.find((f) => f.check === "fts.coverage_gap");
	expect(gap).toBeDefined();
	expect(gap!.sampleSlugs.length).toBeLessThanOrEqual(5);
});

test("stale fts rows (chunk deleted, fts remains) → fts.stale_rows warning", () => {
	db = freshDb();
	db.insertPage({
		slug: "test-stale-page",
		type: "record",
		title: "Stale",
		filePath: "s.md",
		contentHash: "h",
	});
	db.insertChunk("test-stale-page", 0, "stale content");
	db.ftsInsert("test-stale-page", "stale content");
	// 删 chunk 但保留 fts row（绕过正常同步路径，制造残留）
	db.rawDb.prepare("DELETE FROM chunks WHERE page_slug = ?").run("test-stale-page");

	const findings = probeFts(db);
	const stale = findings.find((f) => f.check === "fts.stale_rows");
	expect(stale).toBeDefined();
	expect(stale!.severity).toBe("warning");
	expect(stale!.layer).toBe("fts");
	expect(stale!.count).toBe(1);
	expect(stale!.sampleSlugs).not.toContain("test-stale-page"); // 匿名
	expect(stale!.suggestedCommand).toContain("cbrain sync");
});
