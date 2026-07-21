#!/usr/bin/env bun
// check-consistency-gate.ts — repository-owned storage consistency release gate.
//
// After #379: this gate is a REPOSITORY release check. It runs from a clean
// checkout with no operator cbrain.json and uses an anonymous in-process
// fixture DB to prove the fsck → repair-plan → evaluateConsistencyGate path
// still classifies a minimal healthy profile as `passed`. It does NOT discover,
// read, or open any operator vault, SQLite database, LanceDB directory, or
// credential-bearing configuration.
//
// Operator profile health (live vault / DB / LanceDB) is a separate gate:
// `gate:profile-storage` → bin/check-profile-storage-gate.ts.
//
// Output: one stable JSON report, exit 0 on passed, 1 on hard finding, 2 on
// fatal fixture setup error. The report never echoes local paths, raw fsck
// fatal errors, or stack traces — next_action uses fixed strings only.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";
import type { ConsistencyGateResult, GateFinding } from "../src/core/fsck/consistency-gate.js";
import type { FsckLanceState } from "../src/core/fsck/types.js";
import type { RepairPlanStatus } from "../src/core/fsck/repair-plan.js";

interface ConsistencyGateReport {
	gate: "consistency";
	mode: "repository-fixture";
	version: string;
	timestamp: string;
	passed: boolean;
	hard: GateFinding[];
	warnings: GateFinding[];
	lanceState: FsckLanceState | string;
	repairPlanStatus: RepairPlanStatus | string | null;
	next_action: string;
	duration_ms: number;
}

function fatalReport(reason: "fixture_setup_failed", durationMs: number): ConsistencyGateReport {
	return {
		gate: "consistency",
		mode: "repository-fixture",
		version: "1",
		timestamp: new Date().toISOString(),
		passed: false,
		hard: [],
		warnings: [],
		lanceState: "unchecked",
		repairPlanStatus: null,
		next_action:
			reason === "fixture_setup_failed"
				? "Repository consistency fixture could not be built. Rerun `bun run gate:consistency`; if it persists, inspect fsck/repair-plan for a regression."
				: "Repository consistency gate failed. Rerun `bun run gate:consistency`.",
		duration_ms: durationMs,
	};
}

async function main(): Promise<void> {
	const started = performance.now();
	let fixtureDir: string | null = null;
	try {
		// Anonymous fixture: empty vault + empty lance dir + freshly migrated
		// SQLite DB. This proves the release invariant — the gate classifies a
		// minimal healthy profile as `passed`, and any regression in fsck /
		// repair-plan / evaluateConsistencyGate surfaces as a non-pass verdict
		// or a fatal exit.
		fixtureDir = mkdtempSync(join(tmpdir(), "cbrain-consistency-fixture-"));
		const vaultPath = join(fixtureDir, "vault");
		const lancePath = join(fixtureDir, "lance");
		const dbPath = join(fixtureDir, "fixture.sqlite");
		mkdirSync(vaultPath, { recursive: true });
		mkdirSync(lancePath, { recursive: true });

		const db = new CBrainDB(dbPath);
		try {
			const { report: fsckReport } = await runFsck({ vaultPath, lancePath, db });
			const plan = buildRepairPlan(fsckReport);
			const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
			const result: ConsistencyGateResult = evaluateConsistencyGate(fsckReport, hasChunks, plan.overallStatus);

			const gateReport: ConsistencyGateReport = {
				gate: "consistency",
				mode: "repository-fixture",
				version: "1",
				timestamp: new Date().toISOString(),
				passed: result.passed,
				hard: result.hard,
				warnings: result.warnings,
				lanceState: result.lanceState,
				repairPlanStatus: result.repairPlanStatus,
				next_action: result.nextAction,
				duration_ms: Math.round(performance.now() - started),
			};
			console.log(JSON.stringify(gateReport, null, 2));
			process.exit(result.passed ? 0 : 1);
		} finally {
			db.close();
		}
	} catch {
		// Privacy: do not echo the raw error (may include tmpdir / dbPath).
		// A fatal here means the fixture itself could not be built or fsck
		// threw — both indicate a repository-owned regression.
		const report = fatalReport("fixture_setup_failed", Math.round(performance.now() - started));
		console.log(JSON.stringify(report, null, 2));
		process.exit(2);
	} finally {
		// Always clean up the fixture so the gate never leaves artifacts in
		// the system temp directory or the caller's cwd.
		if (fixtureDir) {
			try {
				rmSync(fixtureDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; ignore.
			}
		}
	}
}

await main();
