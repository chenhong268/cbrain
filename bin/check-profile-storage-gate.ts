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
// NOT auto-discover cbrain.json by walking up from cwd.
//
// Read-only (#384 review P1-2): the live SQLite is opened ONLY through the
// stable read-snapshot path (readSnapshot: true). The live main DB, WAL, and
// SHM files are never opened through SQLite.
//
// Config shape (#384 review P1-3 + rev3 P2): dbPath, vaultPath, AND
// lancePath must all be non-empty strings AFTER trimming. Whitespace-only
// values are rejected. The vault boundary is constructed via
// resolveTrustedVaultBoundary and passed into fsck.
//
// Process model (#384 review rev3 P2): emit() sets process.exitCode and
// returns; it NEVER calls process.exit() inside a try block with a pending
// finally. The DB close runs in `finally` before the process terminates.

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

function buildFatalReport(
	status: Exclude<ProfileStatus, "profile_checked">,
	started: number,
): ProfileStorageGateReport {
	return {
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
}

function emitEarly(report: ProfileStorageGateReport, exitCode: 0 | 1 | 2): never {
	// Only for paths with NO pending finally blocks (before DB is opened).
	console.log(JSON.stringify(report, null, 2));
	process.exit(exitCode);
}

type ConfigArgState =
	| { kind: "absent" }
	| { kind: "valid"; path: string }
	| { kind: "invalid" };

/** Parse `--config <path>` from argv. Distinguishes absent vs invalid (present
 * but missing value) so an invalid CLI argument is never silently masked by a
 * CBRAIN_CONFIG fallback. */
function parseConfigArg(argv: readonly string[]): ConfigArgState {
	const idx = argv.indexOf("--config");
	if (idx === -1) return { kind: "absent" };
	const next = argv[idx + 1];
	if (typeof next === "string" && next.trim().length > 0) {
		return { kind: "valid", path: next };
	}
	return { kind: "invalid" };
}

type ExplicitTarget =
	| { kind: "path"; path: string }
	| { kind: "missing" }
	| { kind: "invalid" };

function resolveExplicitConfigTarget(): ExplicitTarget {
	const argState = parseConfigArg(process.argv.slice(2));
	if (argState.kind === "invalid") return { kind: "invalid" };

	const fromArg = argState.kind === "valid" ? argState.path : null;
	const fromEnv = process.env.CBRAIN_CONFIG;

	// --config takes precedence; only fall back to CBRAIN_CONFIG when the
	// flag was truly absent (not present-but-valueless).
	const raw = fromArg ?? fromEnv;
	if (typeof raw !== "string" || raw.trim().length === 0) return { kind: "missing" };
	return { kind: "path", path: raw };
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
	// #384 rev3 P2: all three paths must be non-empty strings AFTER trimming.
	// Whitespace-only values like "   " must be rejected.
	if (
		typeof dbPathRaw !== "string" || dbPathRaw.trim().length === 0 ||
		typeof vaultPathRaw !== "string" || vaultPathRaw.trim().length === 0 ||
		typeof lancePathRaw !== "string" || lancePathRaw.trim().length === 0
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
	if (target.kind === "invalid") {
		emitEarly(buildFatalReport("profile_target_invalid", started), 2);
		return;
	}
	if (target.kind === "missing") {
		emitEarly(buildFatalReport("profile_target_missing", started), 2);
		return;
	}
	if (!existsSync(target.path)) {
		emitEarly(buildFatalReport("profile_target_missing", started), 2);
		return;
	}

	// ── fail-closed #2 (P1-3 + rev3 P2): shape + parse validation. ────────
	const parsed = parseAndValidateConfig(target.path);
	if (parsed === "invalid") {
		emitEarly(buildFatalReport("profile_target_invalid", started), 2);
		return;
	}

	// ── fail-closed #3: DB file must exist. ──────────────────────────────
	if (!existsSync(parsed.dbPath)) {
		emitEarly(buildFatalReport("profile_db_missing", started), 2);
		return;
	}

	// ── fail-closed #4 (P1-2): open READ-ONLY via stable snapshot. ───────
	let db: CBrainDB;
	try {
		db = new CBrainDB(parsed.dbPath, { readSnapshot: true, skipMigrate: true });
	} catch {
		emitEarly(buildFatalReport("profile_snapshot_unavailable", started), 2);
		return;
	}

	// ── Profile check: route through canonical fsck → repair-plan → gate. ─
	// #384 rev3 P2: we accumulate the report + exit code and print AFTER
	// db.close() in finally, so process.exit never skips cleanup.
	let finalReport: ProfileStorageGateReport;
	let finalExit: 0 | 1 | 2;
	try {
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

		// Fatal check (#384 rev5 P1): runFsck captures probe exceptions and
		// returns them via fsckReport.fatalError without throwing. A fatal
		// must route to profile_check_failed / exit 2 — NOT be treated as a
		// normal hard-finding failure with profile_checked / exit 1.
		const fatal = !!fsckReport.fatalError;
		const passed = result.passed && !fatal;
		finalReport = {
			gate: "profile-storage-consistency",
			mode: "operator-profile",
			version: "1",
			timestamp: new Date().toISOString(),
			passed,
			status: fatal ? "profile_check_failed" : "profile_checked",
			hard: result.hard,
			warnings: result.warnings,
			lanceState: result.lanceState,
			repairPlanStatus: result.repairPlanStatus,
			next_action: fatal
				? NEXT_ACTIONS.profile_check_failed
				: !passed
					? "Fix hard no-go failures (see hard[]), then rerun `bun run gate:profile-storage`."
					: result.warnings.length > 0
						? "Optional: review warnings[]."
						: "Profile storage is consistent.",
			duration_ms: Math.round(performance.now() - started),
		};
		finalExit = fatal ? 2 : passed ? 0 : 1;
	} catch {
		finalReport = buildFatalReport("profile_check_failed", started);
		finalExit = 2;
	} finally {
		db.close();
	}

	console.log(JSON.stringify(finalReport, null, 2));
	process.exitCode = finalExit;
}

await main();
