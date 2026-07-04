import type { FsckLanceState, FsckReport } from "./types.js";
import type { RepairPlanStatus } from "./repair-plan.js";

export interface GateFinding {
	check: string;
	layer: string;
	count: number;
	samples: string[];
}

export interface ConsistencyGateResult {
	passed: boolean;
	hard: GateFinding[];
	warnings: GateFinding[];
	lanceState: FsckLanceState;
	repairPlanStatus: RepairPlanStatus | null;
	nextAction: string;
}

/**
 * Hard no-go checks (gate fail). Independent of fsck severity — fsck marks
 * page_without_chunks etc. as `warning` (diagnostic), but the release gate
 * treats them as release-blocking (physical inconsistency).
 */
const HARD_CHECKS = new Set<string>([
	"sqlite.page_without_chunks",
	"fts.stale_rows",
	"fts.coverage_gap",
	"hierarchy.frontmatter_graph_mismatch",
	"hierarchy.malformed_reports_to",
	"lance.vector_coverage_gap",
	"vault.file_exists_db_missing",
	"vault.db_exists_file_missing",
	"vault.frontmatter_slug_mismatch",
]);

function isHard(check: string): boolean {
	return HARD_CHECKS.has(check) || check.startsWith("sqlite.orphan_");
}

/**
 * Evaluate a fsck report into a go/no-go gate result. Pure function — no DB,
 * no shell. `hasChunks` is required because probeLance emits no finding when
 * LanceDB is missing/corrupt (only sets lanceState); the gate must decide
 * whether `missing` is hard (DB has chunks → recall lost) or warning (empty
 * DB → nothing to index).
 */
export function evaluateConsistencyGate(
	report: FsckReport,
	hasChunks: boolean,
	repairPlanStatus?: RepairPlanStatus,
): ConsistencyGateResult {
	const hard: GateFinding[] = [];
	const warnings: GateFinding[] = [];

	for (const f of report.findings) {
		const item: GateFinding = { check: f.check, layer: f.layer, count: f.count, samples: f.sampleSlugs };
		if (isHard(f.check)) hard.push(item);
		else warnings.push(item);
	}

	// LanceDB lanceState — probeLance may emit NO finding on missing/corrupt;
	// gate must interpret lanceState independently.
	let lanceHard = false;
	if (report.lanceState === "corrupt") {
		lanceHard = true;
		hard.push({ check: "lance.state_corrupt", layer: "lance", count: 1, samples: [] });
	}
	// "unchecked" (lancePath absent — probeLance returns it when !existsSync) is
	// functionally identical to "missing" — no usable vector store. Treat
	// symmetrically: hard when DB has chunks (recall lost), warning when empty.
	// A deleted/misconfigured LanceDB dir must NOT silently pass a populated DB.
	// Push a synthetic hard finding so Agent/Hermes can route on hard[] (not just
	// an opaque passed:false with empty hard[]).
	if ((report.lanceState === "missing" || report.lanceState === "unchecked") && hasChunks) {
		lanceHard = true;
		hard.push({ check: `lance.state_${report.lanceState}_with_chunks`, layer: "lance", count: 1, samples: [] });
	}
	if ((report.lanceState === "missing" || report.lanceState === "unchecked") && !hasChunks) {
		warnings.push({ check: "lance.no_vector_store_empty_db", layer: "lance", count: 0, samples: [] });
	}

	const fatalError = report.fatalError;
	const passed = !fatalError && hard.length === 0 && !lanceHard;

	let nextAction: string;
	if (fatalError) nextAction = "fsck fatal error — rerun `bun run gate:consistency` or inspect fsck directly for diagnostics.";
	else if (!passed) nextAction = "Fix hard no-go failures (see hard[]), then rerun `bun run gate:consistency`.";
	else if (warnings.length > 0) nextAction = "Optional: review warnings[].";
	else nextAction = "All consistency checks passed.";

	return {
		passed,
		hard,
		warnings,
		lanceState: report.lanceState,
		repairPlanStatus: repairPlanStatus ?? null,
		nextAction,
	};
}
