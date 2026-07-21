#!/usr/bin/env bun
// check-profile-storage-gate.ts — operator profile storage-health gate (#379).
//
// This gate verifies a CONFIGURED operator profile (vault + SQLite + FTS +
// LanceDB) using the same fsck → repair-plan → evaluateConsistencyGate path
// as the repository release gate, but against real profile state.
//
// It is INTENTIONALLY separate from `gate:consistency` (which is now a
// repository fixture gate). The repository release gate must pass from a
// clean checkout with no operator config; this gate requires an EXPLICIT
// operator configuration target and FAILS CLOSED (sanitized, no path leak)
// when one is absent, invalid, malformed, or points at a non-existent DB.
//
// Authorization (#384 review P1-1): the target MUST be explicit — either a
// non-empty CBRAIN_CONFIG env var or a `--config <path>` CLI argument. We do
// NOT auto-discover cbrain.json by walking up from cwd; running this gate
// from a repository that happens to contain an operator config must never
// silently inspect private state.
//
// Read-only (#384 review P1-2): the live SQLite is opened ONLY through the
// stable read-snapshot path (readSnapshot: true). The live main DB, WAL, and
// SHM files are never opened through SQLite, so their bytes and mtimes are
// guaranteed unchanged. If a stable snapshot cannot be created, the gate
// fails closed with `profile_check_failed`.
//
// Config shape (#384 review P1-3): dbPath, vaultPath, AND lancePath must all
// be non-empty strings; any missing/blank field yields
// `profile_target_invalid`. The vault boundary is constructed via
// `resolveTrustedVaultBoundary` and passed into fsck so misplaced-artifact
// detection is not silently skipped.
//
// Output: one stable JSON report with a DISTINCT gate id
// `profile-storage-consistency` and `mode: "operator-profile"`. Exit 0 on
// passed, 1 on hard finding, 2 on missing/invalid target or fatal error.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";
import { resolveTrustedVaultBoundary } from "../src/core/maintenance/misplaced-vault-artifacts.js";
import type { ConsistencyGateResult, GateFinding } from "../src/core/fsck/consistency-gate.js";
import type { FsckLanceState } from "../src/core/fsck/types.js";
import type { RepairPlanStatus } from "../src/core/fsck/repair-plan.js";
import type { TrustedVaultBoundary } from "../src/core/maintenance/misplaced-vault-artifacts.js";

type ProfileStatus =
	| "profile_target_missing"
	| "profile_target_invalid"
	| "profile_db_missing"
	| "profile_snapshot_unavailable"
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
		"Provide an explicit operator profile target: pass `--config <path>` or set CBRAIN_CONFIG to a cbrain.json path. Auto-discovery is intentionally disabled.",
	profile_target_invalid:
		"Operator profile configuration is malformed or incomplete (dbPath, vaultPath, and lancePath must all be non-empty strings). Fix the referenced cbrain.json, then rerun `bun run gate:profile-storage`.",
	profile_db_missing:
		"Configured DB file is missing. Initialize the profile (e.g. `cbrain init`) or point the explicit config at an existing profile, then rerun `bun run gate:profile-storage`.",
	profile_snapshot_unavailable:
		"Could not build a stable read-only snapshot of the live DB. Ensure the profile is idle (no concurrent writer) and rerun `bun run gate:profile-storage`.",
	profile_check_failed:
		"Profile storage check failed unexpectedly. Rerun `bun run gate:profile-storage`; if it persists, inspect fsck directly for diagnostics.",
	profile_checked: "Profile storage consistency check completed.",
};

function emit(report: ProfileStorageGateReport, exitCode: 0 | 1 | 2): never {
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = exitCode;
	// Use process.exit ONLY at the top level after the report is printed; no
	// pending finally blocks need to run beyond this point.
	process.exit(exitCode);
}

function emitFatal(
	status: Exclude<ProfileStatus, "profile_checked">,
	started: number,
): never {
	const report: ProfileStorageGateReport = {
		gate: "profile-storage-consistency",
		mode: "operator-profile",
		version: "1",
		timestamp: new Date().toISOString(),
		passed: false,
		status,
		hard: [],
		warnings: [],
		lanceState: "unchecked",
		repairPlanStatus: null,
		next_action: NEXT_ACTIONS[status],
		duration_ms: Math.round(performance.now() - started),
	};
	// 2 = fail-closed (missing/invalid target or fatal); never emit raw paths.
	return emit(report, 2);
}

/** Parse `--config <path>` from argv. Returns null if absent. */
function parseConfigArg(argv: readonly string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--config") {
			const next = argv[i + 1];
			if (typeof next === "string" && next.length > 0) return next;
		}
	}
	return null;
}

/** Resolve the explicit config target. Returns null if none was provided. */
function resolveExplicitConfigTarget(): { path: string } | null {
	const fromArg = parseConfigArg(process.argv.slice(2));
	const fromEnv = process.env.CBRAIN_CONFIG;
	const raw = fromArg ?? fromEnv;
	if (typeof raw !== "string" || raw.length === 0) return null;
	return { path: raw };
}

interface ParsedProfileConfig {
	dbPath: string;
	vaultPath: string;
	lancePath: string;
	configRoot: string;
}

function parseAndValidateConfig(configPath: string): ParsedProfileConfig | "invalid" {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return "invalid";
	}
	if (typeof parsed !== "object" || parsed === null) return "invalid";
	const obj = parsed as Record<string, unknown>;
	const dbPathRaw = obj.dbPath;
	const vaultPathRaw = obj.vaultPath;
	const lancePathRaw = obj.lancePath;
	// #384 P1-3: all three paths must be non-empty strings. Blank vault/lance
	// would otherwise let a misconfigured profile pass with empty paths.
	if (
		typeof dbPathRaw !== "string" || dbPathRaw.length === 0 ||
		typeof vaultPathRaw !== "string" || vaultPathRaw.length === 0 ||
		typeof lancePathRaw !== "string" || lancePathRaw.length === 0
	) {
		return "invalid";
	}
	const configRoot = dirname(resolve(configPath));
	return {
		dbPath: resolve(configRoot, dbPathRaw),
		vaultPath: resolve(configRoot, vaultPathRaw),
		lancePath: resolve(configRoot, lancePathRaw),
		configRoot,
	};
}

async function main(): Promise<void> {
	const started = performance.now();

	// ── fail-closed #1 (P1-1): explicit target required. ──────────────────
	const target = resolveExplicitConfigTarget();
	if (!target) {
		emitFatal("profile_target_missing", started);
		return;
	}
	if (!existsSync(target.path)) {
		// Explicit target given but file not found → still "missing" code.
		emitFatal("profile_target_missing", started);
		return;
	}

	// ── fail-closed #2 (P1-3): shape + parse validation. ──────────────────
	const parsed = parseAndValidateConfig(target.path);
	if (parsed === "invalid") {
		emitFatal("profile_target_invalid", started);
		return;
	}

	// ── fail-closed #3: DB file must exist. ──────────────────────────────
	if (!existsSync(parsed.dbPath)) {
		emitFatal("profile_db_missing", started);
		return;
	}

	// ── fail-closed #4 (P1-2): open READ-ONLY via stable snapshot. ───────
	let db: CBrainDB;
	try {
		db = new CBrainDB(parsed.dbPath, { readSnapshot: true, skipMigrate: true });
	} catch {
		// Cannot build a stable snapshot (WAL corrupt, parent missing, etc.).
		// Privacy: do not echo the raw sqlite error.
		emitFatal("profile_snapshot_unavailable", started);
		return;
	}

	try {
		// Construct the trusted vault boundary exactly like the canonical fsck
		// CLI (src/cli/commands/fsck.ts). Without it, misplaced-artifact
		// detection is silently skipped (#384 review P1-3).
		const vaultBoundary: TrustedVaultBoundary | undefined = resolveTrustedVaultBoundary({
			configRoot: parsed.configRoot,
			vaultPath: parsed.vaultPath,
		});

		const { report: fsckReport } = await runFsck({
			vaultPath: parsed.vaultPath,
			lancePath: parsed.lancePath,
			db,
			vaultBoundary,
		});
		const plan = buildRepairPlan(fsckReport);
		const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
		const result: ConsistencyGateResult = evaluateConsistencyGate(
			fsckReport,
			hasChunks,
			plan.overallStatus,
		);

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
		emitFatal("profile_check_failed", started);
	} finally {
		db.close();
	}
}

await main();
