#!/usr/bin/env bun
// check-profile-storage-gate.ts — operator profile storage-health gate (#379).
//
// This gate verifies a CONFIGURED operator profile (vault + SQLite + FTS +
// LanceDB) using the same fsck → repair-plan → evaluateConsistencyGate path
// as the repository release gate, but against real profile state.
//
// It is INTENTIONALLY separate from `gate:consistency` (which is now a
// repository fixture gate). The repository release gate must pass from a
// clean checkout with no operator config; this gate requires an explicit
// operator configuration target and FAILS CLOSED (sanitized, no path leak)
// when one is absent, invalid, malformed, or points at a non-existent DB.
//
// Output: one stable JSON report with a DISTINCT gate id
// `profile-storage-consistency` and `mode: "operator-profile"`. Exit 0 on
// passed, 1 on hard finding, 2 on missing/invalid target or fatal error.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";
import type { ConsistencyGateResult, GateFinding } from "../src/core/fsck/consistency-gate.js";
import type { FsckLanceState } from "../src/core/fsck/types.js";
import type { RepairPlanStatus } from "../src/core/fsck/repair-plan.js";

type ProfileStatus =
	| "profile_target_missing"
	| "profile_target_invalid"
	| "profile_db_missing"
	| "profile_check_failed"
	| "profile_checked";

interface ProfileStorageGateReport {
	gate: "profile-storage-consistency";
	mode: "operator-profile";
	version: string;
	timestamp: string;
	passed: boolean;
	status: ProfileStatus;
	hard: GateFinding[];
	warnings: GateFinding[];
	lanceState: FsckLanceState | string;
	repairPlanStatus: RepairPlanStatus | string | null;
	next_action: string;
	duration_ms: number;
}

const NEXT_ACTIONS: Record<ProfileStatus, string> = {
	profile_target_missing:
		"Provide an operator profile: set CBRAIN_CONFIG to a cbrain.json path or run `cbrain init` before invoking `bun run gate:profile-storage`.",
	profile_target_invalid:
		"Operator profile configuration is malformed. Fix the cbrain.json referenced by CBRAIN_CONFIG, then rerun `bun run gate:profile-storage`.",
	profile_db_missing:
		"Configured DB file is missing. Initialize the profile (e.g. `cbrain init` or point CBRAIN_CONFIG at an existing profile), then rerun `bun run gate:profile-storage`.",
	profile_check_failed:
		"Profile storage check failed unexpectedly. Rerun `bun run gate:profile-storage`; if it persists, inspect fsck directly for diagnostics.",
	profile_checked: "Profile storage consistency check completed.",
};

function emit(report: ProfileStorageGateReport, exitCode: 0 | 1 | 2): never {
	console.log(JSON.stringify(report, null, 2));
	process.exit(exitCode);
}

function emitFatal(
	status: Exclude<ProfileStatus, "profile_checked">,
	started: number,
	verdict: { hard: GateFinding[]; warnings: GateFinding[]; lanceState: FsckLanceState | string },
): never {
	const report: ProfileStorageGateReport = {
		gate: "profile-storage-consistency",
		mode: "operator-profile",
		version: "1",
		timestamp: new Date().toISOString(),
		passed: false,
		status,
		hard: verdict.hard,
		warnings: verdict.warnings,
		lanceState: verdict.lanceState,
		repairPlanStatus: null,
		next_action: NEXT_ACTIONS[status],
		duration_ms: Math.round(performance.now() - started),
	};
	// 2 = fail-closed (missing/invalid target or fatal); never emit raw paths.
	emit(report, 2);
}

async function main(): Promise<void> {
	const started = performance.now();

	// fail-closed #1: locate the operator config target. We deliberately do
	// NOT use loadConfigSafe() because it swallows malformed-JSON errors as
	// "not found", which collapses missing vs invalid into one code.
	const explicitPath = process.env.CBRAIN_CONFIG;
	let configPath: string | null = null;
	if (explicitPath && explicitPath.length > 0) {
		// Explicit target must exist; absence here is "missing".
		configPath = existsSync(explicitPath) ? resolve(explicitPath) : null;
	} else {
		// Walk upward from cwd looking for cbrain.json.
		let current = resolve(process.cwd());
		while (true) {
			const candidate = join(current, "cbrain.json");
			if (existsSync(candidate)) {
				configPath = candidate;
				break;
			}
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
	}
	if (!configPath) {
		emitFatal("profile_target_missing", started, { hard: [], warnings: [], lanceState: "unchecked" });
		return;
	}
	const configRoot = dirname(configPath);

	// fail-closed #2: malformed config JSON. We swallow the raw SyntaxError
	// message (may contain path fragments) and emit a fixed status code.
	let parsed: { dbPath?: unknown; vaultPath?: unknown; lancePath?: unknown };
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
			dbPath?: unknown;
			vaultPath?: unknown;
			lancePath?: unknown;
		};
	} catch {
		emitFatal("profile_target_invalid", started, { hard: [], warnings: [], lanceState: "unchecked" });
		return;
	}
	// Shape check: dbPath must be a non-empty string. Other fields default.
	if (typeof parsed.dbPath !== "string" || parsed.dbPath.length === 0) {
		emitFatal("profile_target_invalid", started, { hard: [], warnings: [], lanceState: "unchecked" });
		return;
	}

	const dbPath = resolve(configRoot, parsed.dbPath);
	const vaultPath = typeof parsed.vaultPath === "string" ? resolve(configRoot, parsed.vaultPath) : "";
	const lancePath = typeof parsed.lancePath === "string" ? resolve(configRoot, parsed.lancePath) : "";


	// fail-closed #3: target DB file does not exist.
	if (!existsSync(dbPath)) {
		emitFatal("profile_db_missing", started, { hard: [], warnings: [], lanceState: "unchecked" });
		return;
	}

	let db: CBrainDB;
	try {
		db = new CBrainDB(dbPath, { skipMigrate: true });
	} catch {
		// Privacy: do not echo raw sqlite/open error.
		emitFatal("profile_check_failed", started, { hard: [], warnings: [], lanceState: "unchecked" });
		return;
	}

	try {
		const { report: fsckReport } = await runFsck({ vaultPath, lancePath, db });
		const plan = buildRepairPlan(fsckReport);
		const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
		const result: ConsistencyGateResult = evaluateConsistencyGate(fsckReport, hasChunks, plan.overallStatus);

		const passed = result.passed;
		const nextAction = !passed
			? "Fix hard no-go failures (see hard[]), then rerun `bun run gate:profile-storage`."
			: result.warnings.length > 0
				? "Optional: review warnings[]."
				: "Profile storage is consistent.";

		const report: ProfileStorageGateReport = {
			gate: "profile-storage-consistency",
			mode: "operator-profile",
			version: "1",
			timestamp: new Date().toISOString(),
			passed,
			status: "profile_checked",
			hard: result.hard,
			warnings: result.warnings,
			lanceState: result.lanceState,
			repairPlanStatus: result.repairPlanStatus,
			next_action: nextAction,
			duration_ms: Math.round(performance.now() - started),
		};
		emit(report, passed ? 0 : 1);
	} catch {
		// Privacy: do not echo the raw error (may include dbPath / stack).
		emitFatal("profile_check_failed", started, { hard: [], warnings: [], lanceState: "unchecked" });
	} finally {
		db.close();
	}
}

await main();
