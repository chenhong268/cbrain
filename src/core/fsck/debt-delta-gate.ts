type GateStatus = "pass" | "warn" | "fail";

export interface ConsistencyLikeFinding {
	check: string;
	layer: string;
	count: number;
	samples: string[];
}

export interface ConsistencyLikeReport {
	gate: "consistency";
	version: string;
	timestamp: string;
	passed: boolean;
	hard: ConsistencyLikeFinding[];
	warnings: ConsistencyLikeFinding[];
	lanceState: string;
	repairPlanStatus: string | null;
	next_action: string;
	duration_ms: number;
}

export interface DebtSummary {
	hard_count: number;
	warning_count: number;
	hard_checks: number;
	warning_checks: number;
}

export interface DebtDeltaFinding {
	check: string;
	layer: string;
	baseline_count: number;
	current_count: number;
	delta: number;
	samples: string[];
}

export interface DebtDeltaGateReport {
	gate: "health-debt-delta";
	version: "1";
	timestamp: string;
	passed: boolean;
	status: GateStatus;
	baseline: DebtSummary;
	current: DebtSummary;
	new_hard: DebtDeltaFinding[];
	warning_deltas: DebtDeltaFinding[];
	next_action: string;
}

interface CountedFinding {
	check: string;
	layer: string;
	count: number;
	samples: string[];
}

function keyFor(f: Pick<ConsistencyLikeFinding, "layer" | "check">): string {
	return `${f.layer}:${f.check}`;
}

function summarize(findings: ConsistencyLikeFinding[]): Map<string, CountedFinding> {
	const map = new Map<string, CountedFinding>();
	for (const finding of findings) {
		const key = keyFor(finding);
		const existing = map.get(key);
		if (!existing) {
			map.set(key, {
				check: finding.check,
				layer: finding.layer,
				count: finding.count,
				samples: finding.samples.slice(0, 5),
			});
			continue;
		}
		map.set(key, {
			...existing,
			count: existing.count + finding.count,
			samples: [...existing.samples, ...finding.samples].slice(0, 5),
		});
	}
	return map;
}

function delta(current: Map<string, CountedFinding>, baseline: Map<string, CountedFinding>): DebtDeltaFinding[] {
	const rows: DebtDeltaFinding[] = [];
	for (const [key, currentFinding] of current.entries()) {
		const baselineCount = baseline.get(key)?.count ?? 0;
		if (currentFinding.count <= baselineCount) continue;
		rows.push({
			check: currentFinding.check,
			layer: currentFinding.layer,
			baseline_count: baselineCount,
			current_count: currentFinding.count,
			delta: currentFinding.count - baselineCount,
			samples: currentFinding.samples,
		});
	}
	return rows.sort((a, b) => b.delta - a.delta || a.layer.localeCompare(b.layer) || a.check.localeCompare(b.check));
}

function totalCount(findings: ConsistencyLikeFinding[]): number {
	return findings.reduce((sum, f) => sum + f.count, 0);
}

function summary(report: ConsistencyLikeReport): DebtSummary {
	return {
		hard_count: totalCount(report.hard),
		warning_count: totalCount(report.warnings),
		hard_checks: summarize(report.hard).size,
		warning_checks: summarize(report.warnings).size,
	};
}

function nextAction(status: GateStatus): string {
	if (status === "fail") return "New hard consistency debt detected — fix new_hard[] or refresh baseline only after explicit review.";
	if (status === "warn") return "No new hard debt. Review warning_deltas[] before release if relevant.";
	return "No health debt increase compared with baseline.";
}

export function evaluateDebtDeltaGate(
	baseline: ConsistencyLikeReport,
	current: ConsistencyLikeReport,
	timestamp = new Date().toISOString(),
): DebtDeltaGateReport {
	const newHard = delta(summarize(current.hard), summarize(baseline.hard));
	const warningDeltas = delta(summarize(current.warnings), summarize(baseline.warnings));
	const status: GateStatus = newHard.length > 0 ? "fail" : warningDeltas.length > 0 ? "warn" : "pass";

	return {
		gate: "health-debt-delta",
		version: "1",
		timestamp,
		passed: status !== "fail",
		status,
		baseline: summary(baseline),
		current: summary(current),
		new_hard: newHard,
		warning_deltas: warningDeltas,
		next_action: nextAction(status),
	};
}
