import type { FsckFinding, FsckReport, FsckSeverity } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export type RepairBucket = "auto_repairable" | "needs_review" | "blocked" | "observe_only";
export type RepairPlanStatus = "clean" | "actionable" | "blocked";

export interface RepairPlanItem {
	id: string;
	bucket: RepairBucket;
	check: string;
	layer: string;
	severity: FsckSeverity;
	count: number;
	samples: string[];
	canExecute: boolean;
	prerequisite: string;
	dryRunSummary: string;
	suggestedCommand: string;
	executeCommand?: string;
	verifyCommand: string;
}

export interface RepairPlan {
	version: 1;
	timestamp: string;
	overallStatus: RepairPlanStatus;
	counts: Record<RepairBucket, number>;
	items: RepairPlanItem[];
	execution?: {
		mode: "dry_run" | "execute" | "verify";
		executed: string[];
		skipped: string[];
		verificationCommand: string;
	};
}

interface Rule {
	bucket: RepairBucket;
	canExecute: boolean;
	prerequisite: string;
	dryRunSummary: string;
	executeCommand?: string;
	suggestedCommand?: string;
	verifyCommand: string;
}

const DEFAULT_RULE: Rule = {
	bucket: "needs_review",
	canExecute: false,
	prerequisite: "review the finding before mutation",
	dryRunSummary: "Review the anonymized finding and choose a targeted repair.",
	verifyCommand: "cbrain fsck --json",
};

const RULES: Record<string, Rule> = {
	"fts.stale_rows": {
		bucket: "auto_repairable",
		canExecute: true,
		prerequisite: "no writer shutdown required; this deletes only FTS rows with no chunks",
		dryRunSummary: "Delete stale FTS rows, then verify the FTS layer.",
		suggestedCommand: "cbrain fsck --repair-stale-fts",
		executeCommand: "cbrain fsck --repair-stale-fts",
		verifyCommand: "cbrain fsck --json --layer fts",
	},
	"fts.coverage_gap": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "rebuild affected page indexes from current Markdown content",
		dryRunSummary: "Rebuild missing FTS rows from the authoritative page content.",
		verifyCommand: "cbrain fsck --json --layer fts",
	},
	"sqlite.page_without_chunks": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "rebuild derived indexes from current Markdown content",
		dryRunSummary: "Run targeted sync to rebuild derived indexes without changing facts.",
		verifyCommand: "cbrain fsck --json --layer sqlite",
	},
	"lance.vector_coverage_gap": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "stop active writers before rebuilding vectors",
		dryRunSummary: "Rebuild missing vectors from SQLite chunks after writer shutdown.",
		verifyCommand: "cbrain fsck --json --layer lance",
	},
	"sqlite.title_collision": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "human review required before renaming or merging content",
		dryRunSummary: "Inspect title collision candidates; do not auto-merge.",
		verifyCommand: "cbrain fsck --json --layer sqlite",
	},
	"vault.frontmatter_slug_mismatch": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "human review required because vault frontmatter is user-owned",
		dryRunSummary: "Review the mismatch and decide whether the file or DB slug is authoritative.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"vault.file_exists_db_missing": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "sync Markdown file into SQLite and derived indexes",
		dryRunSummary: "Sync current Markdown files so missing DB rows are recreated.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"vault.db_exists_file_missing": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "review required before deleting DB rows or restoring vault files",
		dryRunSummary: "Decide whether to restore the Markdown file or remove the DB row.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"sqlite.fk_orphan": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "backup recommended before deleting orphan derived rows",
		dryRunSummary: "Run FK repair in dry-run first, then execute only after reviewing counts.",
		verifyCommand: "cbrain repair-fk",
	},
};

function ruleFor(finding: FsckFinding): Rule {
	if (finding.check.includes("quarantine")) {
		return {
			bucket: "observe_only",
			canExecute: false,
			prerequisite: "observe current quarantine state before manual release",
			dryRunSummary: "No storage repair is planned for this signal.",
			verifyCommand: "cbrain fsck --json",
		};
	}
	return RULES[finding.check] ?? DEFAULT_RULE;
}

function statusFor(items: RepairPlanItem[]): RepairPlanStatus {
	if (items.some((item) => item.bucket === "blocked")) return "blocked";
	if (items.length === 0) return "clean";
	return "actionable";
}

export function buildRepairPlan(report: FsckReport): RepairPlan {
	const items: RepairPlanItem[] = [];
	if (report.fatalError) {
		items.push({
			id: "repair_1",
			bucket: "blocked",
			check: "fsck.fatal",
			layer: "system",
			severity: "critical",
			count: 1,
			samples: [],
			canExecute: false,
			prerequisite: "fsck must run successfully before repair planning",
			dryRunSummary: "Resolve the fsck fatal error, then rerun repair-plan.",
			suggestedCommand: "cbrain fsck --json",
			verifyCommand: "cbrain fsck --json",
		});
	}

	for (const finding of report.findings) {
		const rule = ruleFor(finding);
		items.push({
			id: `repair_${items.length + 1}`,
			bucket: rule.bucket,
			check: finding.check,
			layer: finding.layer,
			severity: finding.severity,
			count: finding.count,
			samples: anonymizeSlugs(finding.sampleSlugs),
			canExecute: rule.canExecute,
			prerequisite: rule.prerequisite,
			dryRunSummary: rule.dryRunSummary,
			suggestedCommand: rule.suggestedCommand ?? finding.suggestedCommand ?? rule.verifyCommand,
			executeCommand: rule.executeCommand,
			verifyCommand: rule.verifyCommand,
		});
	}

	const counts: Record<RepairBucket, number> = {
		auto_repairable: 0,
		needs_review: 0,
		blocked: 0,
		observe_only: 0,
	};
	for (const item of items) counts[item.bucket]++;
	return {
		version: 1,
		timestamp: report.timestamp,
		overallStatus: statusFor(items),
		counts,
		items,
	};
}

const BUCKET_LABEL: Record<RepairBucket, string> = {
	auto_repairable: "auto-repair",
	needs_review: "needs review",
	blocked: "blocked",
	observe_only: "observe only",
};

export function formatRepairPlanMarkdown(plan: RepairPlan): string {
	const lines: string[] = [];
	lines.push("# State repair plan\n");
	lines.push(`- overall: **${plan.overallStatus}**`);
	lines.push(
		`- counts: auto=${plan.counts.auto_repairable} review=${plan.counts.needs_review} blocked=${plan.counts.blocked} observe=${plan.counts.observe_only}\n`,
	);
	if (plan.items.length === 0) {
		lines.push("No repair actions are needed.");
		return lines.join("\n");
	}
	for (const item of plan.items) {
		lines.push(`## ${item.id}: ${BUCKET_LABEL[item.bucket]} — ${item.check}`);
		lines.push(`- affected: ${item.count}`);
		if (item.samples.length) lines.push(`- sample: ${item.samples.join(", ")}`);
		lines.push(`- prerequisite: ${item.prerequisite}`);
		lines.push(`- dry-run: ${item.dryRunSummary}`);
		if (item.canExecute && item.executeCommand) lines.push(`- execute: \`${item.executeCommand}\``);
		else lines.push("- execute: not available in this phase");
		lines.push(`- verify: \`${item.verifyCommand}\`\n`);
	}
	return lines.join("\n");
}
