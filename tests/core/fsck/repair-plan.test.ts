import { describe, expect, test } from "bun:test";
import type { FsckFinding, FsckReport } from "../../../src/core/fsck/types.js";
import { buildRepairPlan, formatRepairPlanMarkdown } from "../../../src/core/fsck/repair-plan.js";

function finding(partial: Partial<FsckFinding> & Pick<FsckFinding, "check">): FsckFinding {
	return {
		check: partial.check,
		layer: partial.layer ?? "fts",
		severity: partial.severity ?? "warning",
		count: partial.count ?? 1,
		sampleSlugs: partial.sampleSlugs ?? ["private/slug-a"],
		detail: partial.detail ?? "synthetic detail with private/slug-a",
		suggestedCommand: partial.suggestedCommand ?? "cbrain fsck --repair-stale-fts",
	};
}

function report(findings: FsckFinding[]): FsckReport {
	return {
		version: 1,
		timestamp: "2026-07-04T00:00:00.000Z",
		overallStatus: findings.length ? "warn" : "pass",
		counts: { critical: 0, error: 0, warning: findings.length, info: 0 },
		lanceState: "unchecked",
		findings,
	};
}

describe("buildRepairPlan (#278)", () => {
	test("classifies stale FTS as auto_repairable with explicit execute and verify commands", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows", count: 7 })]));

		expect(plan.overallStatus).toBe("actionable");
		expect(plan.counts.auto_repairable).toBe(1);
		expect(plan.items[0]).toMatchObject({
			id: "repair_1",
			bucket: "auto_repairable",
			check: "fts.stale_rows",
			canExecute: true,
			executeCommand: "cbrain fsck --repair-stale-fts",
			verifyCommand: "cbrain fsck --json --layer fts",
		});
	});

	test("classifies missing chunks as auto_repairable but not directly executable in Phase 1", () => {
		const plan = buildRepairPlan(report([finding({ check: "sqlite.page_without_chunks", layer: "sqlite", count: 9 })]));

		expect(plan.items[0]).toMatchObject({
			bucket: "auto_repairable",
			canExecute: false,
			verifyCommand: "cbrain fsck --json --layer sqlite",
		});
		expect(plan.items[0].dryRunSummary).toContain("rebuild derived indexes");
	});

	test("classifies title collisions as needs_review", () => {
		const plan = buildRepairPlan(report([finding({ check: "sqlite.title_collision", layer: "sqlite", severity: "error" })]));

		expect(plan.items[0]).toMatchObject({
			bucket: "needs_review",
			canExecute: false,
		});
	});

	test("classifies fatal fsck reports as blocked", () => {
		const r = report([]);
		r.fatalError = "DB file not found";
		r.overallStatus = "fail";

		const plan = buildRepairPlan(r);

		expect(plan.overallStatus).toBe("blocked");
		expect(plan.items[0]).toMatchObject({
			bucket: "blocked",
			check: "fsck.fatal",
			canExecute: false,
		});
	});

	test("default JSON shape never exposes sample slugs or raw details", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows" })]));
		const json = JSON.stringify(plan);

		expect(json).not.toContain("private/slug-a");
		expect(json).not.toContain("synthetic detail");
		expect(plan.items[0].samples).toEqual(["item_1"]);
	});

	test("Markdown is compact and privacy-safe", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows", count: 3 })]));
		const md = formatRepairPlanMarkdown(plan);

		expect(md).toContain("State repair plan");
		expect(md).toContain("auto-repair");
		expect(md).not.toContain("private/slug-a");
		expect(md).not.toContain("synthetic detail");
	});

	test("#279 lance.vector_coverage_gap classified auto_repairable (rule key match)", () => {
		const plan = buildRepairPlan(report([finding({ check: "lance.vector_coverage_gap", layer: "lance", severity: "error", count: 3 })]));
		const item = plan.items.find((i) => i.check === "lance.vector_coverage_gap");
		expect(item).toBeDefined();
		expect(item!.bucket).toBe("auto_repairable");
	});
});
