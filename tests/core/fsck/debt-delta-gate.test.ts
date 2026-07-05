import { describe, expect, test } from "bun:test";
import { evaluateDebtDeltaGate } from "../../../src/core/fsck/debt-delta-gate.js";

const report = (overrides: Partial<Parameters<typeof evaluateDebtDeltaGate>[0]> = {}): Parameters<typeof evaluateDebtDeltaGate>[0] => ({
	gate: "consistency",
	version: "1",
	timestamp: "2026-07-05T00:00:00.000Z",
	passed: true,
	hard: [],
	warnings: [],
	lanceState: "ok",
	repairPlanStatus: "clean",
	next_action: "ok",
	duration_ms: 1,
	...overrides,
});

const finding = (check: string, layer = "sqlite", count = 1, samples: string[] = ["item_1"]) => ({
	check,
	layer,
	count,
	samples,
});

describe("evaluateDebtDeltaGate (#295)", () => {
	test("clean baseline and clean current passes", () => {
		const result = evaluateDebtDeltaGate(report(), report(), "2026-07-05T00:00:00.000Z");
		expect(result.gate).toBe("health-debt-delta");
		expect(result.passed).toBe(true);
		expect(result.status).toBe("pass");
		expect(result.new_hard).toEqual([]);
		expect(result.warning_deltas).toEqual([]);
	});

	test("new hard finding fails with delta count", () => {
		const result = evaluateDebtDeltaGate(
			report(),
			report({ hard: [finding("sqlite.page_without_chunks", "sqlite", 2)] }),
			"2026-07-05T00:00:00.000Z",
		);
		expect(result.passed).toBe(false);
		expect(result.status).toBe("fail");
		expect(result.new_hard).toEqual([
			{
				check: "sqlite.page_without_chunks",
				layer: "sqlite",
				baseline_count: 0,
				current_count: 2,
				delta: 2,
				samples: ["item_1"],
			},
		]);
	});

	test("unchanged historical hard debt does not fail the delta gate", () => {
		const baseline = report({ hard: [finding("fts.stale_rows", "fts", 3)] });
		const current = report({ hard: [finding("fts.stale_rows", "fts", 3)] });
		const result = evaluateDebtDeltaGate(baseline, current, "2026-07-05T00:00:00.000Z");
		expect(result.passed).toBe(true);
		expect(result.status).toBe("pass");
		expect(result.new_hard).toEqual([]);
	});

	test("reduced hard debt passes", () => {
		const baseline = report({ hard: [finding("lance.vector_coverage_gap", "lance", 5)] });
		const current = report({ hard: [finding("lance.vector_coverage_gap", "lance", 2)] });
		const result = evaluateDebtDeltaGate(baseline, current, "2026-07-05T00:00:00.000Z");
		expect(result.passed).toBe(true);
		expect(result.status).toBe("pass");
		expect(result.baseline.hard_count).toBe(5);
		expect(result.current.hard_count).toBe(2);
	});

	test("warning increase warns but does not fail", () => {
		const baseline = report({ warnings: [finding("sqlite.title_collision", "sqlite", 1)] });
		const current = report({ warnings: [finding("sqlite.title_collision", "sqlite", 4)] });
		const result = evaluateDebtDeltaGate(baseline, current, "2026-07-05T00:00:00.000Z");
		expect(result.passed).toBe(true);
		expect(result.status).toBe("warn");
		expect(result.warning_deltas).toEqual([
			{
				check: "sqlite.title_collision",
				layer: "sqlite",
				baseline_count: 1,
				current_count: 4,
				delta: 3,
				samples: ["item_1"],
			},
		]);
	});

	test("output preserves only already-anonymized samples", () => {
		const result = evaluateDebtDeltaGate(
			report(),
			report({ hard: [finding("fts.coverage_gap", "fts", 1, ["item_7"])] }),
			"2026-07-05T00:00:00.000Z",
		);
		const serialized = JSON.stringify(result);
		expect(serialized).toContain("item_7");
		expect(serialized).not.toContain("records/private-slug");
		expect(serialized).not.toContain("/Users/");
	});
});
