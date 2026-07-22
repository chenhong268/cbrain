#!/usr/bin/env bun
// check-consistency-gate.ts — repository-owned storage consistency release gate.
//
// After #379: this gate is a REPOSITORY release check. It runs from a clean
// checkout with no operator cbrain.json and uses anonymous in-process fixture
// DBs + anonymous LanceDB indices to prove the shared
// fsck → repair-plan → evaluateConsistencyGate path still:
//   (a) classifies a HEALTHY non-empty fixture (page + chunk + vector) as
//       `passed`;
//   (b) detects an INTENTIONAL hard no-go (page without chunks) in a
//       negative canary.
//
// It does NOT discover, read, or open any operator vault, SQLite database,
// LanceDB directory, or credential-bearing configuration.
//
// Authority (#384 review rev3 P1-1): hard-check classification routes
// through the CANONICAL `buildRepairPlan` + `evaluateConsistencyGate`. No
// local copy of the hard-check set exists in this file.
//
// Fatal safety (#384 review rev3 P1-2): any `report.fatalError` from either
// fixture forces NO-GO regardless of whether findings were emitted.
//
// Status (#384 review rev3 P1-3): a healthy fixture that produces a hard
// finding uses the explicit `healthy_fixture_failed` status with a fixed
// failure action — never the success copy.
//
// Process model (#384 review P1-4): success/no-go paths set
// process.exitCode; cleanup runs in `finally`.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";
import { LanceDBManager, type ChunkData } from "../src/storage/lancedb.js";
import type { ConsistencyGateResult, GateFinding } from "../src/core/fsck/consistency-gate.js";
import type { FsckReport, FsckLanceState } from "../src/core/fsck/types.js";
import type { RepairPlanStatus } from "../src/core/fsck/repair-plan.js";

type ConsistencyStatus =
	| "healthy_fixture_checked"
	| "healthy_fixture_failed"
	| "negative_canary_detected"
	| "negative_canary_regression"
	| "negative_canary_unexpected_hard"
	| "fixture_setup_failed";

interface ConsistencyGateReport {
	gate: "consistency";
	mode: "repository-fixture";
	version: string;
	timestamp: string;
	passed: boolean;
	status: ConsistencyStatus;
	hard: GateFinding[];
	warnings: GateFinding[];
	lanceState: FsckLanceState | string;
	repairPlanStatus: RepairPlanStatus | string | null;
	canary: {
		expected_hard_check: string;
		detected: boolean;
		unexpected_hard_checks: string[];
	};
	next_action: string;
	duration_ms: number;
}
const CANARY_EXPECTED_HARD_CHECK = "sqlite.page_without_chunks";

// Hard findings that the canary fixture (page without chunks, no LanceDB
// vector) is EXPECTED to produce. Any finding outside this set is a
// regression signal — the gate goes NO-GO so the extra error is never
// silently swallowed.
const CANARY_ALLOWED_HARD_CHECKS: Record<string, true> = {
	"sqlite.page_without_chunks": true,
};

const NEXT_ACTIONS: Record<ConsistencyStatus, string> = {
	healthy_fixture_checked: "All consistency checks passed.",
	healthy_fixture_failed:
		"Healthy fixture produced an unexpected hard finding. Inspect fsck/repair-plan output and re-run `bun run gate:consistency`.",
	negative_canary_detected: "Negative canary produced the expected hard finding.",
	negative_canary_regression: `Negative canary did not produce expected hard finding (${CANARY_EXPECTED_HARD_CHECK}). Inspect fsck probes — a detector may have silently regressed.`,
	negative_canary_unexpected_hard:
		"Negative canary produced unexpected hard findings outside the allowed set. Inspect fsck probes — a detector may be over-firing.",
	fixture_setup_failed:
		"Repository consistency fixture could not be built. Rerun `bun run gate:consistency`; if it persists, inspect fsck/repair-plan for a regression.",
};

interface FixtureDirs {
	root: string;
	vaultPath: string;
	lancePath: string;
	dbPath: string;
}

interface FixtureGateOutcome {
	report: FsckReport;
	result: ConsistencyGateResult;
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
		db.ftsInsert("entities/fixture-anon", "fixture body");
	} finally {
		db.close();
	}
}

function seedNegativeCanaryFixture(f: FixtureDirs): void {
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
	} finally {
		db.close();
	}
}

async function seedHealthyLance(f: FixtureDirs): Promise<void> {
	const lance = new LanceDBManager();
	await lance.connect(f.lancePath);
	try {
		const chunks: ChunkData[] = [
			{
				pageSlug: "entities/fixture-anon",
				chunkIndex: 0,
				content: "fixture body",
				vector: new Float32Array(1024),
			},
		];
		await lance.addChunks(chunks);
	} finally {
		await lance.close();
	}
}

async function runCanonicalGate(f: FixtureDirs): Promise<FixtureGateOutcome> {
	const db = new CBrainDB(f.dbPath, { readSnapshot: true, skipMigrate: true });
	try {
		const { report: fsckReport } = await runFsck({
			vaultPath: f.vaultPath,
			lancePath: f.lancePath,
			db,
		});
		const plan = buildRepairPlan(fsckReport);
		const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
		const result = evaluateConsistencyGate(fsckReport, hasChunks, plan.overallStatus);
		return { report: fsckReport, result };
	} finally {
		db.close();
	}
}

export interface CanarySignals {
	healthyPassed: boolean;
	healthyFatal: boolean;
	canaryPassed: boolean;
	canaryFatal: boolean;
	expectedPresent: boolean;
	unexpectedHardChecks: string[];
}

export function resolveConsistencyVerdict(s: CanarySignals): {
	status: ConsistencyStatus;
	passed: boolean;
	exitCode: 0 | 1 | 2;
	canaryDetected: boolean;
} {
	const fatal = s.healthyFatal || s.canaryFatal;
	const healthyClean = s.healthyPassed && !s.healthyFatal;
	const canaryDetected = s.expectedPresent && s.unexpectedHardChecks.length === 0 && !s.canaryPassed;
	const passed = healthyClean && canaryDetected && !fatal;
	const status: ConsistencyStatus = fatal
		? "fixture_setup_failed"
		: !s.expectedPresent
			? "negative_canary_regression"
			: s.unexpectedHardChecks.length > 0
				? "negative_canary_unexpected_hard"
				: !canaryDetected
					? "negative_canary_regression"
					: !healthyClean
						? "healthy_fixture_failed"
						: "negative_canary_detected";
	const exitCode: 0 | 1 | 2 = fatal ? 2 : passed ? 0 : 1;
	return { status, passed, exitCode, canaryDetected };
}

async function main(): Promise<void> {
	const started = performance.now();
	const fixtures: FixtureDirs[] = [];
	try {
		const healthy = buildFixture("cbrain-consistency-healthy-");
		fixtures.push(healthy);
		seedHealthyFixture(healthy);
		await seedHealthyLance(healthy);
		const healthyOutcome = await runCanonicalGate(healthy);

		const canary = buildFixture("cbrain-consistency-canary-");
		fixtures.push(canary);
		seedNegativeCanaryFixture(canary);
		const canaryOutcome = await runCanonicalGate(canary);

		// Canary must be an explicit expected failure: the expected hard
		// check must appear, canary evaluator must report passed=false, and
		// ALL hard findings must belong to the explicit allowed set. Any
		// extra hard finding is surfaced in the report so it can never be
		// silently swallowed.
		const expectedPresent = canaryOutcome.result.hard.some(
			(h) => h.check === CANARY_EXPECTED_HARD_CHECK,
		);
		const unexpectedHard = canaryOutcome.result.hard
			.map((h) => h.check)
			.filter((check) => CANARY_ALLOWED_HARD_CHECKS[check] !== true);

		const verdict = resolveConsistencyVerdict({
			healthyPassed: healthyOutcome.result.passed,
			healthyFatal: !!healthyOutcome.report.fatalError,
			canaryPassed: canaryOutcome.result.passed,
			canaryFatal: !!canaryOutcome.report.fatalError,
			expectedPresent,
			unexpectedHardChecks: unexpectedHard,
		});
		const report: ConsistencyGateReport = {
			gate: "consistency",
			mode: "repository-fixture",
			version: "1",
			timestamp: new Date().toISOString(),
		passed: verdict.passed,
		status: verdict.status,
		hard: healthyOutcome.result.hard,
		warnings: healthyOutcome.result.warnings,
		lanceState: healthyOutcome.result.lanceState,
		repairPlanStatus: healthyOutcome.result.repairPlanStatus,
		canary: {
			expected_hard_check: CANARY_EXPECTED_HARD_CHECK,
			detected: verdict.canaryDetected,
			unexpected_hard_checks: unexpectedHard,
		},
		next_action: NEXT_ACTIONS[verdict.status],
		duration_ms: Math.round(performance.now() - started),
	};
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = verdict.exitCode;
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
				unexpected_hard_checks: [],
			},
			next_action: NEXT_ACTIONS.fixture_setup_failed,
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = 2;
	} finally {
		for (const f of fixtures) {
			try {
				rmSync(f.root, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}

if (import.meta.main) await main();
