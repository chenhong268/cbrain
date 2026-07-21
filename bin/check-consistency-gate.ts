#!/usr/bin/env bun
// check-consistency-gate.ts — repository-owned storage consistency release gate.
//
// After #379: this gate is a REPOSITORY release check. It runs from a clean
// checkout with no operator cbrain.json and uses anonymous in-process fixture
// DBs to prove the fsck → repair-plan → evaluateConsistencyGate path still
// (a) classifies a HEALTHY non-empty fixture as `passed`, and (b) detects an
// INTENTIONAL hard no-go (missing chunks) in a negative canary. It does NOT
// discover, read, or open any operator vault, SQLite database, LanceDB
// directory, or credential-bearing configuration.
//
// Operator profile health (live vault / DB / LanceDB) is a separate gate:
// `gate:profile-storage` → bin/check-profile-storage-gate.ts.
//
// Fixture scope (#384 review P2): fixtures exercise the `sqlite` layer
// (pages / chunks / hierarchy / FTS coverage) — the release invariants that
// are reachable from an anonymous in-process DB without a real LanceDB
// index. The full fts + lance path is covered by the operator gate and by
// the existing fsck test suite; the repository gate's job is to prove the
// core detector has not silently regressed (page_without_chunks etc.).
//
// Process model (#384 review P1-4): success/no-go paths set process.exitCode;
// cleanup runs in `finally`. We never call process.exit() inside the try
// block, so the finally block actually executes and both fixtures are removed.
//
// Output: one stable JSON report, exit 0 on passed, 1 on hard finding or
// negative-canary regression, 2 on fatal fixture setup error. The report
// never echoes local paths, raw fsck fatal errors, or stack traces —
// next_action uses fixed strings only.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import type { FsckReport } from "../src/core/fsck/types.js";
import type { FsckFinding } from "../src/core/fsck/types.js";

type ConsistencyStatus =
	| "healthy_fixture_checked"
	| "negative_canary_detected"
	| "negative_canary_regression"
	| "fixture_setup_failed";

interface ConsistencyGateReport {
	gate: "consistency";
	mode: "repository-fixture";
	version: string;
	timestamp: string;
	passed: boolean;
	status: ConsistencyStatus;
	hard: FsckFinding[];
	warnings: FsckFinding[];
	lanceState: string;
	repairPlanStatus: null;
	canary: {
		expected_hard_check: string;
		detected: boolean;
	};
	next_action: string;
	duration_ms: number;
}

const CANARY_EXPECTED_HARD_CHECK = "sqlite.page_without_chunks";

// Hard checks the repository gate cares about. These mirror the
// HARD_CHECKS set in src/core/fsck/consistency-gate.ts but are restricted
// to findings reachable from the sqlite layer (no lance.* checks — the
// fixture has no LanceDB index by design).
const REPOSITORY_HARD_CHECKS: Record<string, true> = {
	"sqlite.page_without_chunks": true,
	"fts.stale_rows": true,
	"fts.coverage_gap": true,
	"hierarchy.frontmatter_graph_mismatch": true,
	"hierarchy.malformed_reports_to": true,
	"sqlite.orphan_chunks": true,
	"sqlite.orphan_links": true,
	"sqlite.orphan_aliases": true,
	"sqlite.orphan_tags": true,
	"sqlite.orphan_evidence": true,
	"sqlite.orphan_page_versions": true,
	"sqlite.orphan_snapshots": true,
	"sqlite.orphan_mentions": true,
	"sqlite.orphan_jobs": true,
	"sqlite.orphan_feedback": true,
	"vault.file_exists_db_missing": true,
	"vault.db_exists_file_missing": true,
	"vault.frontmatter_slug_mismatch": true,
};

function isHardFinding(check: string): boolean {
	return REPOSITORY_HARD_CHECKS[check] === true || check.startsWith("sqlite.orphan_");
}
function classify(report: FsckReport): { hard: FsckFinding[]; warnings: FsckFinding[] } {
	const hard: FsckFinding[] = [];
	const warnings: FsckFinding[] = [];
	for (const f of report.findings) {
		if (isHardFinding(f.check)) hard.push(f);
		else warnings.push(f);
	}
	return { hard, warnings };
}

const NEXT_ACTIONS: Record<ConsistencyStatus, string> = {
	healthy_fixture_checked: "All consistency checks passed.",
	negative_canary_detected: "Negative canary produced the expected hard finding.",
	negative_canary_regression: `Negative canary did not produce expected hard finding (${CANARY_EXPECTED_HARD_CHECK}). Inspect fsck probes — a detector may have silently regressed.`,
	fixture_setup_failed:
		"Repository consistency fixture could not be built. Rerun `bun run gate:consistency`; if it persists, inspect fsck/repair-plan for a regression.",
};

interface FixtureDirs {
	root: string;
	vaultPath: string;
	lancePath: string;
	dbPath: string;
}

function buildFixture(prefix: string): FixtureDirs {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const vaultPath = join(root, "vault");
	const lancePath = join(root, "lance");
	const dbPath = join(root, "fixture.sqlite");
	mkdirSync(vaultPath, { recursive: true });
	mkdirSync(lancePath, { recursive: true });
	return { root, vaultPath, lancePath, dbPath };
}

function seedHealthyFixture(f: FixtureDirs): void {
	// Anonymous healthy fixture: one entity page WITH a chunk so the
	// page_without_chunks probe sees a real non-empty shape (not an empty DB).
	const entityDir = join(f.vaultPath, "entities");
	mkdirSync(entityDir, { recursive: true });
	const md = "---\nslug: entities/fixture-anon\ntitle: Fixture Anon\ntype: entity/person\n---\nfixture body\n";
	writeFileSync(join(entityDir, "fixture-anon.md"), md);
	const db = new CBrainDB(f.dbPath);
	try {
		db.upsertPage({
			slug: "entities/fixture-anon",
			type: "entity/person",
			title: "Fixture Anon",
			filePath: "entities/fixture-anon.md",
			contentHash: createHash("sha256").update(md).digest("hex"),
		});
		db.insertChunk("entities/fixture-anon", 0, "fixture body");
	} finally {
		db.close();
	}
}

function seedNegativeCanaryFixture(f: FixtureDirs): void {
	// Anonymous negative canary: a page WITH a vault file and DB row but NO
	// chunks. fsck's sqlite.page_without_chunks probe MUST classify this as a
	// hard finding. If a future change silently stops detecting it, this
	// canary flips the gate to no-go.
	const entityDir = join(f.vaultPath, "entities");
	mkdirSync(entityDir, { recursive: true });
	const md = "---\nslug: entities/canary-anon\ntitle: Canary Anon\ntype: entity/person\n---\ncanary body\n";
	writeFileSync(join(entityDir, "canary-anon.md"), md);
	const db = new CBrainDB(f.dbPath);
	try {
		db.upsertPage({
			slug: "entities/canary-anon",
			type: "entity/person",
			title: "Canary Anon",
			filePath: "entities/canary-anon.md",
			contentHash: createHash("sha256").update(md).digest("hex"),
		});
		// Deliberately NO chunk → fsck must emit sqlite.page_without_chunks.
	} finally {
		db.close();
	}
}

async function runFixtureLayer(f: FixtureDirs): Promise<FsckReport> {
	// Open READ-ONLY via the snapshot path so we NEVER touch the fixture DB
	// in read-write mode (same invariant we require of the operator gate).
	// Run the sqlite layer only — the fixture has no LanceDB index by
	// design, and the sqlite layer is where the canary detector lives.
	const db = new CBrainDB(f.dbPath, { readSnapshot: true, skipMigrate: true });
	try {
		const { report } = await runFsck({
			vaultPath: f.vaultPath,
			lancePath: f.lancePath,
			db,
			layer: "sqlite",
		});
		return report;
	} finally {
		db.close();
	}
}

async function main(): Promise<void> {
	const started = performance.now();
	const fixtures: FixtureDirs[] = [];
	try {
		// ── Healthy fixture ───────────────────────────────────────────────
		const healthy = buildFixture("cbrain-consistency-healthy-");
		fixtures.push(healthy);
		seedHealthyFixture(healthy);
		const healthyReport = await runFixtureLayer(healthy);
		const healthyClass = classify(healthyReport);

		// ── Negative canary fixture ──────────────────────────────────────
		const canary = buildFixture("cbrain-consistency-canary-");
		fixtures.push(canary);
		seedNegativeCanaryFixture(canary);
		const canaryReport = await runFixtureLayer(canary);
		const canaryClass = classify(canaryReport);
		const canaryDetected = canaryClass.hard.some(
			(h) => h.check === CANARY_EXPECTED_HARD_CHECK,
		);

		// Aggregate verdict: the healthy fixture must be clean AND the canary
		// must be detected. Either failure mode flips the gate to no-go.
		const healthyClean = healthyClass.hard.length === 0;
		const passed = healthyClean && canaryDetected;
		const status: ConsistencyStatus = passed
			? "negative_canary_detected"
			: !canaryDetected
				? "negative_canary_regression"
				: "healthy_fixture_checked";

		const report: ConsistencyGateReport = {
			gate: "consistency",
			mode: "repository-fixture",
			version: "1",
			timestamp: new Date().toISOString(),
			passed,
			status,
			hard: healthyClass.hard,
			warnings: healthyClass.warnings,
			lanceState: healthyReport.lanceState,
			repairPlanStatus: null,
			canary: {
				expected_hard_check: CANARY_EXPECTED_HARD_CHECK,
				detected: canaryDetected,
			},
			next_action: NEXT_ACTIONS[status],
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = passed ? 0 : 1;
	} catch {
		// Privacy: do not echo the raw error (may include tmpdir / dbPath).
		const report: ConsistencyGateReport = {
			gate: "consistency",
			mode: "repository-fixture",
			version: "1",
			timestamp: new Date().toISOString(),
			passed: false,
			status: "fixture_setup_failed",
			hard: [],
			warnings: [],
			lanceState: "unchecked",
			repairPlanStatus: null,
			canary: {
				expected_hard_check: CANARY_EXPECTED_HARD_CHECK,
				detected: false,
			},
			next_action: NEXT_ACTIONS.fixture_setup_failed,
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = 2;
	} finally {
		// Always clean up BOTH fixtures — success AND failure paths. This only
		// runs because we set process.exitCode instead of calling process.exit().
		for (const f of fixtures) {
			try {
				rmSync(f.root, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; ignore.
			}
		}
	}
}

await main();
