#!/usr/bin/env bun
// check-consistency-gate.ts — storage consistency release gate (#279)
//
// Imports src functions (no shell, no PATH cbrain dependency). Runs fsck +
// repair-plan + consistency-gate, emits one stable JSON report, exits 0/1.
// Does NOT emit raw fatalError/probe internals — next_action uses fixed strings
// only (privacy: no local path leak from SqliteError/IO error messages).

import { existsSync } from "node:fs";
import { loadConfig } from "../src/cli/context.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";

interface ConsistencyGateReport {
	gate: "consistency";
	version: string;
	timestamp: string;
	passed: boolean;
	hard: ReturnType<typeof evaluateConsistencyGate>["hard"];
	warnings: ReturnType<typeof evaluateConsistencyGate>["warnings"];
	lanceState: string;
	repairPlanStatus: string | null;
	next_action: string;
	duration_ms: number;
}

async function main(): Promise<void> {
	const started = performance.now();
	const config = loadConfig();

	if (!existsSync(config.dbPath)) {
		const report: ConsistencyGateReport = {
			gate: "consistency",
			version: "1",
			timestamp: new Date().toISOString(),
			passed: false,
			hard: [],
			warnings: [],
			lanceState: "unchecked",
			repairPlanStatus: null,
			next_action: "DB file not found at the configured dbPath — initialize the vault/DB before running the consistency gate.",
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(report, null, 2));
		process.exit(2);
	}

	const db = new CBrainDB(config.dbPath, { skipMigrate: true });
	try {
		const { report: fsckReport } = await runFsck({
			vaultPath: config.vaultPath,
			lancePath: config.lancePath,
			db,
		});
		const plan = buildRepairPlan(fsckReport);
		const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
		const result = evaluateConsistencyGate(fsckReport, hasChunks, plan.overallStatus);

		const gateReport: ConsistencyGateReport = {
			gate: "consistency",
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
}

await main();
