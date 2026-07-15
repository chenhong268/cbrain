import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runFsck } from "../../src/cli/commands/fsck.js";
import type { FsckLayer } from "../../src/core/fsck/types.js";
import { resolveTrustedVaultBoundary } from "../../src/core/maintenance/misplaced-vault-artifacts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let vaultPath: string;
let lancePath: string;

function freshDb(): CBrainDB {
	return new CBrainDB(dbPath);
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cbrain-fsck-test-"));
	dbPath = join(tmpDir, "cbrain.db");
	vaultPath = join(tmpDir, "vault");
	lancePath = join(tmpDir, "lance");
	mkdirSync(vaultPath);
	// Initialize a clean DB (runs migrations so the schema is real)
	const db = freshDb();
	db.close();
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Clean brain → exit 0, overallStatus "pass"
// ---------------------------------------------------------------------------

describe("runFsck — clean brain", () => {
	it("returns exitCode 0 and overallStatus pass on a pristine DB", async () => {
		const db = freshDb();
		try {
			const result = await runFsck({
				vaultPath,
				lancePath,
				db,
			});
			expect(result.exitCode).toBe(0);
			expect(result.localDetails).toBeUndefined();
			expect(result.report.overallStatus).toBe("pass");
			expect(result.report.fatalError).toBeUndefined();
			// lance dir doesn't exist → unchecked
			expect(result.report.lanceState).toBe("unchecked");
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// (b) Title collision → exit 1, overallStatus at least "warn"
// ---------------------------------------------------------------------------

describe("runFsck — data inconsistency", () => {
	it("returns exitCode 1 when there are warning/error findings", async () => {
		const db = freshDb();
		try {
			// Seed a page without chunks to trigger sqlite.page_without_chunks probe
			db.rawDb
				.prepare("INSERT INTO pages (slug, type, title, file_path) VALUES (?, ?, ?, ?)")
				.run("orphan-page", "entity", "Orphan Page", "orphan.md");

			const result = await runFsck({
				vaultPath,
				lancePath,
				db,
			});
			expect(result.exitCode).toBe(1);
			expect(result.report.overallStatus).not.toBe("pass");
			// Should have at least one finding about page without chunks
			const chunkFindings = result.report.findings.filter((f) =>
				f.check.includes("page_without_chunks"),
			);
			expect(chunkFindings.length).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// (c) Probe throws → exit 2 + fatalError
// ---------------------------------------------------------------------------

describe("runFsck — probe crash", () => {
	it("returns exitCode 2 with fatalError when a probe throws", async () => {
		const db = freshDb();
		// Close the DB before passing it — sqlite queries will throw
		db.close();

		const result = await runFsck({
			vaultPath,
			lancePath,
			db,
		});
		expect(result.exitCode).toBe(2);
		expect(result.report.fatalError).toBeDefined();
		expect(result.report.fatalError).toContain("fsck probe failed");
	});
});

// ---------------------------------------------------------------------------
// (d) --layer filter: only runs specified layer
// ---------------------------------------------------------------------------

describe("runFsck --layer filter", () => {
	it("runs only the sqlite layer when layer is specified", async () => {
		const db = freshDb();
		try {
			const result = await runFsck({
				vaultPath,
				lancePath,
				db,
				layer: "sqlite" as FsckLayer,
			});
			// All findings should be from sqlite layer (or none)
			for (const f of result.report.findings) {
				expect(f.layer).toBe("sqlite");
			}
			// lance should be unchecked since we skipped it
			expect(result.report.lanceState).toBe("unchecked");
		} finally {
			db.close();
		}
	});
});

describe("runFsck — misplaced artifact projection", () => {
	it("returns findings and local details from the same vault inspection", async () => {
		mkdirSync(join(tmpDir, ".obsidian"), { recursive: true });
		writeFileSync(join(tmpDir, "anonymous-empty.md"), "");
		const boundary = resolveTrustedVaultBoundary({ configRoot: tmpDir, vaultPath });
		expect(boundary).toBeDefined();
		const db = freshDb();
		try {
			const result = await runFsck({
				vaultPath,
				lancePath,
				db,
				layer: "vault",
				vaultBoundary: boundary,
				includeLocalDetails: true,
			});
			expect(result.exitCode).toBe(1);
			expect(result.report.findings).toContainEqual(expect.objectContaining({
				check: "vault.misplaced_zero_byte_markdown",
				count: 1,
			}));
			expect(result.localDetails).toEqual([
				{ relativePath: "anonymous-empty.md", classification: "zero_byte_markdown" },
			]);
		} finally {
			db.close();
			rmSync(join(tmpDir, "anonymous-empty.md"), { force: true });
			rmSync(join(tmpDir, ".obsidian"), { recursive: true, force: true });
		}
	});
});
