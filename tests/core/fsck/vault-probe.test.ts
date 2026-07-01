import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeVault } from "../../../src/core/fsck/vault-probe.js";

let dir: string;
let db: CBrainDB;
let vaultDir: string;

function freshEnv(): void {
	dir = mkdtempSync(join(tmpdir(), "cbrain-test-"));
	vaultDir = join(dir, "vault");
	mkdirSync(vaultDir);
	db = new CBrainDB(join(dir, "test.sqlite"));
}

function writeMd(relPath: string, content: string): void {
	const abs = join(vaultDir, relPath);
	const parentDir = join(abs, "..");
	mkdirSync(parentDir, { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("empty vault + empty db → no findings", () => {
	freshEnv();
	expect(probeVault(vaultDir, db)).toEqual([]);
});

test("md file in vault with slug, no DB page → file_exists_db_missing error", () => {
	freshEnv();
	writeMd("alpha.md", "---\ntitle: Alpha\ntype: record\nslug: test-vp-alpha\n---\nBody here.");

	const findings = probeVault(vaultDir, db);
	const f = findings.find((x) => x.check === "vault.file_exists_db_missing");
	expect(f).toBeDefined();
	expect(f!.severity).toBe("error");
	expect(f!.count).toBe(1);
	expect(f!.sampleSlugs).toContain("test-vp-alpha");
	expect(f!.suggestedCommand).toContain("cbrain sync");
	expect(f!.suggestedCommand).toContain("--reindex");
	expect(f!.layer).toBe("vault");
});

test("DB page with file_path, no file on disk → db_exists_file_missing error", () => {
	freshEnv();
	db.insertPage({
		slug: "test-vp-ghost",
		type: "record",
		title: "Ghost",
		filePath: "ghost.md",
		contentHash: "h",
	});
	// Do NOT write ghost.md to disk

	const findings = probeVault(vaultDir, db);
	const f = findings.find((x) => x.check === "vault.db_exists_file_missing");
	expect(f).toBeDefined();
	expect(f!.severity).toBe("error");
	expect(f!.count).toBe(1);
	expect(f!.sampleSlugs).toContain("test-vp-ghost");
	expect(f!.suggestedCommand).toContain("cbrain show");
	// Must NOT be a repair command — verify no --execute or --writeback
	expect(f!.suggestedCommand).not.toContain("--execute");
	expect(f!.layer).toBe("vault");
});

test("db_exists_file_missing detail mentions restore path", () => {
	freshEnv();
	db.insertPage({
		slug: "test-vp-missing-detail",
		type: "record",
		title: "MissingDetail",
		filePath: "missing-detail.md",
		contentHash: "h",
	});

	const findings = probeVault(vaultDir, db);
	const f = findings.find((x) => x.check === "vault.db_exists_file_missing");
	expect(f).toBeDefined();
	// Detail should explain restore path
	expect(f!.detail).toMatch(/backup|re-ingest|writeback/i);
});

test("frontmatter slug resolves to DB page at different file_path → frontmatter_slug_mismatch warning", () => {
	freshEnv();
	// DB has page with slug "test-vp-ok", file_path "sub/ok.md"
	db.insertPage({
		slug: "test-vp-ok",
		type: "record",
		title: "OK",
		filePath: "sub/ok.md",
		contentHash: "h",
	});
	// Vault file root/ok.md has the same slug but lives at a different path
	writeMd("ok.md", "---\ntitle: OK\ntype: record\nslug: test-vp-ok\n---\nBody.");

	const findings = probeVault(vaultDir, db);
	const f = findings.find((x) => x.check === "vault.frontmatter_slug_mismatch");
	expect(f).toBeDefined();
	expect(f!.severity).toBe("warning");
	expect(f!.count).toBe(1);
	expect(f!.sampleSlugs).toContain("test-vp-ok");
	expect(f!.suggestedCommand).toContain("cbrain sync");
	expect(f!.suggestedCommand).toContain("--reindex");
	expect(f!.layer).toBe("vault");
});

test("all three vault probes fire together", () => {
	freshEnv();

	// 1) file_exists_db_missing: md in vault with slug, no DB entry
	writeMd("orphan.md", "---\ntitle: Orphan\ntype: record\nslug: test-vp-orphan\n---\nBody.");

	// 2) db_exists_file_missing: DB page with file_path pointing to nonexistent file
	db.insertPage({
		slug: "test-vp-phantom",
		type: "record",
		title: "Phantom",
		filePath: "phantom.md",
		contentHash: "h",
	});

	// 3) frontmatter_slug_mismatch: frontmatter slug resolves to DB page at different path
	db.insertPage({
		slug: "test-vp-misaligned",
		type: "record",
		title: "Misaligned",
		filePath: "sub/aligned.md",
		contentHash: "h",
	});
	writeMd("aligned.md", "---\ntitle: Misaligned\ntype: record\nslug: test-vp-misaligned\n---\nBody.");

	const findings = probeVault(vaultDir, db);
	const checks = new Set(findings.map((f) => f.check));
	expect(checks.has("vault.file_exists_db_missing")).toBe(true);
	expect(checks.has("vault.db_exists_file_missing")).toBe(true);
	expect(checks.has("vault.frontmatter_slug_mismatch")).toBe(true);
});

test("md without slug frontmatter → skipped (no finding)", () => {
	freshEnv();
	writeMd("noslug.md", "---\ntitle: NoSlug\n---\nBody without slug.");

	const findings = probeVault(vaultDir, db);
	expect(findings).toEqual([]);
});

test("non-md files ignored", () => {
	freshEnv();
	writeMd("data.json", '{"key": "value"}');

	const findings = probeVault(vaultDir, db);
	expect(findings).toEqual([]);
});

test("nested md files scanned", () => {
	freshEnv();
	mkdirSync(join(vaultDir, "sub", "deep"), { recursive: true });
	writeMd("sub/deep/nested.md", "---\ntitle: Nested\ntype: record\nslug: test-vp-nested\n---\nDeep body.");

	const findings = probeVault(vaultDir, db);
	const f = findings.find((x) => x.check === "vault.file_exists_db_missing");
	expect(f).toBeDefined();
	expect(f!.sampleSlugs).toContain("test-vp-nested");
});
