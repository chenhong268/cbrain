import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeSqlite } from "../../../src/core/fsck/sqlite-probe.js";

let dir: string;
let db: CBrainDB;

function freshDb(): CBrainDB {
	dir = mkdtempSync(join(tmpdir(), "cbrain-test-"));
	return new CBrainDB(join(dir, "test.sqlite"));
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("clean db → empty findings", () => {
	db = freshDb();
	expect(probeSqlite(db)).toEqual([]);
});

test("title collision → error finding", () => {
	db = freshDb();
	// idx_pages_title_uniq blocks duplicate titles at INSERT/UPDATE time.
	// Drop it, create collision, probe detects it. Index is not the probe's concern.
	db.insertPage({ slug: "test-entity-a", type: "entity/person", title: "TitleA", filePath: "a.md", contentHash: "h1" });
	db.insertPage({ slug: "test-entity-b", type: "entity/person", title: "TitleB", filePath: "b.md", contentHash: "h2" });
	db.rawDb.prepare("DROP INDEX IF EXISTS idx_pages_title_uniq").run();
	db.rawDb.prepare("UPDATE pages SET title = 'Dup'").run();

	const findings = probeSqlite(db);
	const dup = findings.find((f) => f.check === "sqlite.title_collision");
	expect(dup).toBeDefined();
	expect(dup!.severity).toBe("error");
	expect(dup!.count).toBe(2);
	expect(dup!.sampleSlugs.length).toBeGreaterThan(0);
	expect(dup!.suggestedCommand).toBe("cbrain doctor");
});

test("page without chunks → warning finding", () => {
	db = freshDb();
	db.insertPage({ slug: "test-no-chunks", type: "record", title: "NoChunks", filePath: "nc.md", contentHash: "h" });
	// Do NOT insert any chunks

	const findings = probeSqlite(db);
	const nc = findings.find((f) => f.check === "sqlite.page_without_chunks");
	expect(nc).toBeDefined();
	expect(nc!.severity).toBe("warning");
	expect(nc!.count).toBe(1);
	expect(nc!.sampleSlugs).toContain("test-no-chunks");
	expect(nc!.suggestedCommand).toContain("cbrain sync");
});

test("page with chunks → no page_without_chunks finding", () => {
	db = freshDb();
	db.insertPage({ slug: "test-has-chunks", type: "record", title: "HasChunks", filePath: "hc.md", contentHash: "h" });
	db.insertChunk("test-has-chunks", 0, "hello world");

	const findings = probeSqlite(db);
	expect(findings.find((f) => f.check === "sqlite.page_without_chunks")).toBeUndefined();
});

test("FK orphan via PRAGMA OFF → warning per table", () => {
	db = freshDb();
	db.insertPage({ slug: "test-parent", type: "record", title: "Parent", filePath: "p.md", contentHash: "h" });

	// Insert a link row pointing at a non-existent slug with FK enforcement OFF
	db.rawDb.prepare("PRAGMA foreign_keys=OFF").run();
	db.rawDb.prepare(
		"INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)",
	).run("test-parent", "ghost-slug", "related_to");
	db.rawDb.prepare("PRAGMA foreign_keys=ON").run();

	const findings = probeSqlite(db);
	const orphan = findings.find((f) => f.check === "sqlite.orphan_links");
	expect(orphan).toBeDefined();
	expect(orphan!.severity).toBe("warning");
	expect(orphan!.count).toBe(1);
	expect(orphan!.suggestedCommand).toBe("cbrain repair-fk --execute");
});

test("quarantine context → info finding with count + sample slugs", () => {
	db = freshDb();
	const quarantineList = [
		{ slug: "test-q-a", reason: "bad frontmatter" },
		{ slug: "test-q-b", reason: "parse error" },
	];
	db.setConfig("watcher.quarantine", JSON.stringify(quarantineList));

	const findings = probeSqlite(db);
	const q = findings.find((f) => f.check === "sqlite.quarantine_context");
	expect(q).toBeDefined();
	expect(q!.severity).toBe("info");
	expect(q!.count).toBe(2);
	expect(q!.sampleSlugs).toContain("test-q-a");
	expect(q!.sampleSlugs).toContain("test-q-b");
	// info severity — suggestedCommand is empty (not a failure)
	expect(q!.suggestedCommand).toBe("");
});

test("quarantine with corrupt JSON → no finding (silently skipped)", () => {
	db = freshDb();
	db.setConfig("watcher.quarantine", "not-valid-json{{");

	const findings = probeSqlite(db);
	expect(findings.find((f) => f.check === "sqlite.quarantine_context")).toBeUndefined();
});

test("no quarantine key → no quarantine finding", () => {
	db = freshDb();
	const findings = probeSqlite(db);
	expect(findings.find((f) => f.check === "sqlite.quarantine_context")).toBeUndefined();
});

test("all probes fire together", () => {
	db = freshDb();

	// Title collision (drop unique index to allow collision)
	db.insertPage({ slug: "test-all-a", type: "entity/person", title: "Collide-A", filePath: "a.md", contentHash: "h1" });
	db.insertPage({ slug: "test-all-b", type: "entity/person", title: "Collide-B", filePath: "b.md", contentHash: "h2" });
	db.rawDb.prepare("DROP INDEX IF EXISTS idx_pages_title_uniq").run();
	db.rawDb.prepare("UPDATE pages SET title = 'Same'").run();

	// Page without chunks (test-all-a has no chunks)
	// test-all-b also has no chunks

	// FK orphan: alias pointing at a page that doesn't exist
	db.rawDb.prepare("PRAGMA foreign_keys=OFF").run();
	db.rawDb.prepare(
		"INSERT INTO aliases (page_slug, alias, source) VALUES (?, ?, ?)",
	).run("ghost-page-no-exist", "some-alias", "test");
	db.rawDb.prepare("PRAGMA foreign_keys=ON").run();

	// Quarantine
	db.setConfig("watcher.quarantine", JSON.stringify([{ slug: "test-q-c" }]));

	const findings = probeSqlite(db);
	const checks = new Set(findings.map((f) => f.check));
	expect(checks.has("sqlite.title_collision")).toBe(true);
	expect(checks.has("sqlite.page_without_chunks")).toBe(true);
	expect(checks.has("sqlite.orphan_aliases")).toBe(true);
	expect(checks.has("sqlite.quarantine_context")).toBe(true);
});
