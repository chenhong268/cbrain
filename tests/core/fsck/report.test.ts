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

test("anonymizeSlugs returns stable anonymous tokens, NEVER real slugs", () => {
	const real = ["zhang-san-person", "acme-corp", "a-very-long-real-slug-here"];
	const out = anonymizeSlugs(real);
	expect(out).toEqual(["item_1", "item_2", "item_3"]);
	// 真实 slug 不得出现在输出（可能含人名/公司名 — 隐私）
	const joined = out.join("|");
	for (const r of real) expect(joined).not.toContain(r);
});

test("anonymizeSlugs caps at 5 samples", () => {
	const many = Array.from({ length: 10 }, (_, i) => `real-slug-${i}`);
	const out = anonymizeSlugs(many);
	expect(out).toHaveLength(5);
	expect(out).toEqual(["item_1", "item_2", "item_3", "item_4", "item_5"]);
});

test("reportToMarkdown groups by layer and lists suggestedCommand", () => {
	const r = buildReport([f("warning")], "ok", "t");
	const md = reportToMarkdown(r);
	expect(md).toContain("sqlite");
	expect(md).toContain("c");
	expect(md).not.toContain("/Users/");
});
