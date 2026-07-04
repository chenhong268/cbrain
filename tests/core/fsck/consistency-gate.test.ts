import { describe, test, expect } from "bun:test";
import { evaluateConsistencyGate } from "../../../src/core/fsck/consistency-gate.js";
import type { FsckLayer, FsckReport } from "../../../src/core/fsck/types.js";

const baseReport = (overrides: Partial<FsckReport> = {}): FsckReport => ({
	version: 1,
	timestamp: "2026-07-04T00:00:00.000Z",
	overallStatus: "pass",
	counts: { critical: 0, error: 0, warning: 0, info: 0 },
	lanceState: "ok",
	findings: [],
	...overrides,
});

const finding = (check: string, layer: FsckLayer, severity: "error" | "warning" | "info" = "error") => ({
	check,
	layer,
	severity,
	count: 1,
	sampleSlugs: ["item_1"],
	detail: "test",
	suggestedCommand: "cbrain test",
});

describe("evaluateConsistencyGate (#279)", () => {
	test("clean report → passed:true", () => {
		const r = evaluateConsistencyGate(baseReport(), false);
		expect(r.passed).toBe(true);
		expect(r.hard).toHaveLength(0);
	});

	test("sqlite.page_without_chunks → hard, passed:false", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.page_without_chunks", "sqlite")] }), true);
		expect(r.passed).toBe(false);
		expect(r.hard[0].check).toBe("sqlite.page_without_chunks");
	});

	test("fts.stale_rows / fts.coverage_gap / hierarchy.frontmatter_graph_mismatch / hierarchy.malformed_reports_to / lance.vector_coverage_gap → hard", () => {
		for (const check of ["fts.stale_rows", "fts.coverage_gap", "hierarchy.frontmatter_graph_mismatch", "hierarchy.malformed_reports_to", "lance.vector_coverage_gap"]) {
			const r = evaluateConsistencyGate(baseReport({ findings: [finding(check, "sqlite")] }), true);
			expect(r.passed).toBe(false);
			expect(r.hard[0].check).toBe(check);
		}
	});

	test("sqlite.orphan_chunks (dangling FK) → hard", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.orphan_chunks", "sqlite")] }), true);
		expect(r.passed).toBe(false);
	});

	test("lanceState corrupt → hard with synthetic finding (Agent-routable, not opaque)", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "corrupt" }), true);
		expect(r.passed).toBe(false);
		expect(r.lanceState).toBe("corrupt");
		expect(r.hard[0].check).toBe("lance.state_corrupt");
		expect(r.hard[0].layer).toBe("lance");
	});

	test("lanceState missing + hasChunks → hard with synthetic finding", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "missing" }), true);
		expect(r.passed).toBe(false);
		expect(r.hard[0].check).toBe("lance.state_missing_with_chunks");
	});

	test("lanceState missing + empty DB (no chunks) → warning, passed:true", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "missing" }), false);
		expect(r.passed).toBe(true);
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	test("#279 review: lanceState unchecked + hasChunks → hard with synthetic finding (deleting LanceDB dir must not flip hard→pass)", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "unchecked" }), true);
		expect(r.passed).toBe(false);
		expect(r.hard[0].check).toBe("lance.state_unchecked_with_chunks");
	});

	test("#279 review: lanceState unchecked + empty DB → warning, passed:true", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "unchecked" }), false);
		expect(r.passed).toBe(true);
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	test("sqlite.title_collision → warning, passed:true", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.title_collision", "sqlite", "warning")] }), true);
		expect(r.passed).toBe(true);
		expect(r.warnings[0].check).toBe("sqlite.title_collision");
	});

	test("fatalError → passed:false", () => {
		const r = evaluateConsistencyGate(baseReport({ fatalError: "fsck probe failed: boom" }), true);
		expect(r.passed).toBe(false);
	});
});
