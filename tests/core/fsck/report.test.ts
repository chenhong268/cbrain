import { test, expect } from "bun:test";
import { buildReport, anonymizeSlugs, severityToStatus, reportToMarkdown } from "../../../src/core/fsck/report.js";
import type { FsckFinding } from "../../../src/core/fsck/types.js";

const f = (severity: FsckFinding["severity"]): FsckFinding => ({
	check: "x", layer: "sqlite", severity, count: 1, sampleSlugs: ["a"], detail: "d", suggestedCommand: "c",
});

test("severityToStatus: critical/error → fail, warning → warn, info/pass → pass", () => {
	expect(severityToStatus(["critical"])).toBe("fail");
	expect(severityToStatus(["error"])).toBe("fail");
	expect(severityToStatus(["warning"])).toBe("warn");
	expect(severityToStatus(["info"])).toBe("pass");
	expect(severityToStatus([])).toBe("pass");
});

test("buildReport aggregates counts + status; fatalError forces fail", () => {
	const r = buildReport([f("warning"), f("info")], "ok", "2026-07-01T00:00:00Z");
	expect(r.overallStatus).toBe("warn");
	expect(r.counts).toEqual({ critical: 0, error: 0, warning: 1, info: 1 });
	const failed = buildReport([f("info")], "ok", "t", "DB unreadable");
	expect(failed.overallStatus).toBe("fail");
	expect(failed.fatalError).toBe("DB unreadable");
});

test("anonymizeSlugs truncates to 5 + caps long slug length", () => {
	const many = Array.from({ length: 10 }, (_, i) => `slug-${i}`.repeat(8));
	const out = anonymizeSlugs(many);
	expect(out).toHaveLength(5);
	for (const s of out) expect(s.length).toBeLessThanOrEqual(40);
});

test("reportToMarkdown groups by layer and lists suggestedCommand", () => {
	const r = buildReport([f("warning")], "ok", "t");
	const md = reportToMarkdown(r);
	expect(md).toContain("sqlite");
	expect(md).toContain("c");
	expect(md).not.toContain("/Users/");
});
