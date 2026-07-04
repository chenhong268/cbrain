import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeHierarchy } from "../../../src/core/fsck/hierarchy-probe.js";

// Anonymous sentinel slugs only.
const SEED = "entities/seed";
const MGR = "entities/mgr";

describe("probeHierarchy (#279 split-brain)", () => {
	let testDir: string;
	let dbPath: string;
	let vaultPath: string;
	let db: CBrainDB;

	beforeEach(() => {
		// #279 review: independent temp dir per test (mkdtempSync) — fixed /tmp path
		// caused concurrent-test pollution in #278.
		testDir = mkdtempSync(join(tmpdir(), "cbrain-hierarchy-probe-"));
		dbPath = join(testDir, "test.sqlite");
		vaultPath = join(testDir, "vault");
		mkdirSync(vaultPath, { recursive: true });
		db = new CBrainDB(dbPath);
	});
	afterEach(() => {
		db.close();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	const seedPlainPage = (slug: string, vault: string = vaultPath) => {
		db.upsertPage({ slug, type: "entity/person", title: slug, filePath: `${slug}.md`, contentHash: `h-${slug}` });
		mkdirSync(join(vault, ...slug.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(vault, `${slug}.md`), `---\ntitle: "${slug}"\ntype: entity/person\nslug: ${slug}\n---\n`);
	};
	const seedPageWithReportsTo = (slug: string, reportsTo: string) => {
		seedPlainPage(reportsTo); // FK target for the reports_to edge
		db.upsertPage({ slug, type: "entity/person", title: slug, filePath: `${slug}.md`, contentHash: `h-${slug}` });
		mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${slug}"\ntype: entity/person\nslug: ${slug}\nreports_to: ${reportsTo}\n---\n`);
	};

	test("frontmatter reports_to + no graph edge → mismatch finding (layer=sqlite)", () => {
		seedPageWithReportsTo(SEED, MGR);
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("hierarchy.frontmatter_graph_mismatch");
		expect(findings[0].layer).toBe("sqlite");
		expect(findings[0].severity).toBe("error");
		expect(findings[0].count).toBe(1);
		expect(findings[0].sampleSlugs).not.toContain(SEED); // anonymized
	});

	test("frontmatter reports_to + active graph edge → no finding", () => {
		seedPageWithReportsTo(SEED, MGR);
		db.upsertActiveReportsTo(SEED, MGR, "agent", 0.95);
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(0);
	});

	test("superseded edge (non-current) → still mismatch finding (#233 current-fact)", () => {
		seedPageWithReportsTo(SEED, MGR);
		db.upsertActiveReportsTo(SEED, MGR, "agent", 0.95);
		db.supersedeReportsTo(SEED);
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(1);
	});

	test("#279 review: malformed reports_to (no slash) → hierarchy.malformed_reports_to finding, NOT mismatch", () => {
		// reports_to value without "/" (not entity/xxx) — Hermes feedback: real
		// broken-link class. Must surface as a distinct malformed finding, not be
		// silently skipped and not be counted as a graph-edge mismatch.
		seedPageWithReportsTo(SEED, "not-a-full-slug");
		const findings = probeHierarchy(vaultPath, db);
		const mismatch = findings.find((f) => f.check === "hierarchy.frontmatter_graph_mismatch");
		expect(mismatch).toBeUndefined();
		const malformed = findings.find((f) => f.check === "hierarchy.malformed_reports_to");
		expect(malformed).toBeDefined();
		expect(malformed!.severity).toBe("error");
		expect(malformed!.count).toBe(1);
	});

	test("no reports_to frontmatter → no finding", () => {
		seedPlainPage(SEED);
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(0);
	});

	test("#279 review: scans ALL pages (no silent 10000 cap)", () => {
		// Seed > 10000 pages would be slow; instead assert the probe reads pages
		// via a path that has no limit (the SQL is `WHERE file_path IS NOT NULL`
		// with no LIMIT). A page with a malformed reports_to seeded at a high slug
		// still gets found — proves no early-termination cap.
		seedPageWithReportsTo("entities/z-last", "not-a-full-slug");
		const findings = probeHierarchy(vaultPath, db);
		expect(findings.find((f) => f.check === "hierarchy.malformed_reports_to")).toBeDefined();
	});
});
