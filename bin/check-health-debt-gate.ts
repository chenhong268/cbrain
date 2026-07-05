#!/usr/bin/env bun
// check-health-debt-gate.ts — compare current consistency debt against a saved baseline.
//
// Privacy contract: do not echo filesystem paths, raw fsck fatal errors, or raw
// baseline parse errors. The output is a stable JSON report for release/review
// automation.

import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/cli/context.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import {
	evaluateDebtDeltaGate,
	type ConsistencyLikeReport,
	type DebtDeltaGateReport,
} from "../src/core/fsck/debt-delta-gate.js";
import { CBrainDB } from "../src/storage/sqlite.js";

function parseBaselineArg(argv: string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--baseline") return argv[i + 1] ?? null;
	}
	return null;
}

function isFindingArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((item) => {
			if (!item || typeof item !== "object") return false;
			const f = item as Record<string, unknown>;
			return (
				typeof f.check === "string" &&
				typeof f.layer === "string" &&
				typeof f.count === "number" &&
				Number.isFinite(f.count) &&
				f.count >= 0 &&
				Array.isArray(f.samples) &&
				f.samples.every((sample) => typeof sample === "string")
			);
		})
	);
}

function isConsistencyReport(value: unknown): value is ConsistencyLikeReport {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.gate === "consistency" &&
		typeof v.version === "string" &&
		typeof v.timestamp === "string" &&
		typeof v.passed === "boolean" &&
		isFindingArray(v.hard) &&
		isFindingArray(v.warnings) &&
		typeof v.lanceState === "string" &&
		typeof v.next_action === "string" &&
		typeof v.duration_ms === "number"
	);
}

function fatalReport(
	reason: "missing_baseline_arg" | "invalid_baseline" | "missing_db" | "current_check_failed",
	timestamp = new Date().toISOString(),
): DebtDeltaGateReport {
	const nextAction: Record<typeof reason, string> = {
		missing_baseline_arg: "Missing baseline input — run with `--baseline <consistency-gate.json>`.",
		invalid_baseline: "baseline could not be read as a consistency gate JSON report.",
		missing_db: "DB file not found at the configured dbPath — initialize the vault/DB before running the health debt gate.",
		current_check_failed: "Current consistency check failed before producing a comparable report.",
	};
	return {
		gate: "health-debt-delta",
		version: "1",
		timestamp,
		passed: false,
		status: "fail",
		baseline: { hard_count: 0, warning_count: 0, hard_checks: 0, warning_checks: 0 },
		current: { hard_count: 0, warning_count: 0, hard_checks: 0, warning_checks: 0 },
		new_hard: [],
		warning_deltas: [],
		next_action: nextAction[reason],
	};
}

function readBaseline(path: string): ConsistencyLikeReport | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!isConsistencyReport(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function buildCurrentConsistencyReport(): Promise<ConsistencyLikeReport | "missing_db"> {
	const started = performance.now();
	const config = loadConfig();
	if (!existsSync(config.dbPath)) return "missing_db";

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
		return {
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
	} finally {
		db.close();
	}
}

function emit(report: DebtDeltaGateReport, exitCode: 0 | 1 | 2): never {
	console.log(JSON.stringify(report, null, 2));
	process.exit(exitCode);
}

async function main(): Promise<void> {
	const baselinePath = parseBaselineArg(process.argv.slice(2));
	if (!baselinePath) emit(fatalReport("missing_baseline_arg"), 2);

	const baseline = readBaseline(baselinePath);
	if (!baseline) emit(fatalReport("invalid_baseline"), 2);

	let current: ConsistencyLikeReport | "missing_db";
	try {
		current = await buildCurrentConsistencyReport();
	} catch {
		emit(fatalReport("current_check_failed"), 2);
	}
	if (current === "missing_db") emit(fatalReport("missing_db"), 2);

	const report = evaluateDebtDeltaGate(baseline, current);
	emit(report, report.passed ? 0 : 1);
}

await main();
