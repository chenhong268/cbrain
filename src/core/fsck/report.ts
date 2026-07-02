import type {
	FsckFinding,
	FsckLanceState,
	FsckOverallStatus,
	FsckReport,
	FsckSeverity,
} from "./types.js";

const RANK: Record<FsckSeverity, number> = {
	critical: 3,
	error: 2,
	warning: 1,
	info: 0,
};

export function severityToStatus(severities: FsckSeverity[]): FsckOverallStatus {
	let max = -1;
	for (const s of severities) max = Math.max(max, RANK[s]);
	if (max >= 2) return "fail";
	if (max === 1) return "warn";
	return "pass";
}

export function anonymizeSlugs(slugs: string[], max = 5): string[] {
	// 稳定匿名 token：丢弃真实 slug（CBrain slug 可能含人名/公司/概念名），
	// 只保留序号反映规模。原 slug 仅未来 --debug/--unsafe-raw 可见，本期默认匿名。
	return slugs.slice(0, max).map((_, i) => `item_${i + 1}`);
}

export function buildReport(
	findings: FsckFinding[],
	lanceState: FsckLanceState,
	timestamp: string,
	fatalError?: string,
): FsckReport {
	const counts = { critical: 0, error: 0, warning: 0, info: 0 };
	for (const f of findings) counts[f.severity]++;
	const overallStatus: FsckOverallStatus = fatalError
		? "fail"
		: severityToStatus(findings.map((f) => f.severity));
	const report: FsckReport = {
		version: 1,
		timestamp,
		overallStatus,
		counts,
		lanceState,
		findings,
	};
	if (fatalError) report.fatalError = fatalError;
	return report;
}

export function reportToMarkdown(report: FsckReport): string {
	const lines: string[] = [];
	lines.push(`# fsck report\n`);
	lines.push(`- overall: **${report.overallStatus}**  •  lance: ${report.lanceState}`);
	lines.push(
		`- counts: critical=${report.counts.critical} error=${report.counts.error} warning=${report.counts.warning} info=${report.counts.info}\n`,
	);
	if (report.fatalError) lines.push(`> ⚠ fatalError: ${report.fatalError}\n`);
	const byLayer = new Map<string, FsckFinding[]>();
	for (const f of report.findings) {
		if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
		byLayer.get(f.layer)!.push(f);
	}
	for (const [layer, fs] of byLayer) {
		lines.push(`## ${layer}`);
		for (const f of fs) {
			lines.push(`- [${f.severity}] ${f.check}: ${f.detail} (${f.count})`);
			if (f.sampleSlugs.length) lines.push(`  sample: ${f.sampleSlugs.join(", ")}`);
			if (f.suggestedCommand) lines.push(`  → \`${f.suggestedCommand}\`（仅建议，不执行）`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
