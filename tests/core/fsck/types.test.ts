import { test, expect } from "bun:test";
import {
	FsckReportSchema,
	FsckSeveritySchema,
} from "../../../src/core/fsck/types.js";

test("FsckSeveritySchema accepts 4 levels", () => {
	for (const s of ["critical", "error", "warning", "info"] as const) {
		expect(FsckSeveritySchema.safeParse(s).success).toBe(true);
	}
	expect(FsckSeveritySchema.safeParse("high").success).toBe(false);
});

test("FsckReportSchema parses a clean report", () => {
	const r = {
		version: 1,
		timestamp: "2026-07-01T00:00:00.000Z",
		overallStatus: "pass",
		counts: { critical: 0, error: 0, warning: 0, info: 0 },
		lanceState: "ok",
		findings: [],
	};
	expect(FsckReportSchema.safeParse(r).success).toBe(true);
});

test("FsckReportSchema rejects unknown severity in findings", () => {
	const r = {
		version: 1,
		timestamp: "t",
		overallStatus: "pass",
		counts: { critical: 0, error: 0, warning: 0, info: 0 },
		lanceState: "ok",
		findings: [
			{
				check: "x",
				layer: "sqlite",
				severity: "HIGH",
				count: 1,
				sampleSlugs: [],
				detail: "d",
				suggestedCommand: "",
			},
		],
	};
	expect(FsckReportSchema.safeParse(r).success).toBe(false);
});
