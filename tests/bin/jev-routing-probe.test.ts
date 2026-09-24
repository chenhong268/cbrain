import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "../../scripts/jev-routing-probe.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(rows: Array<Record<string, unknown>>): string {
	const dir = mkdtempSync(join(tmpdir(), "cbrain-routing-probe-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "sample.routing-eval.jsonl"),
		rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
	);
	return dir;
}

test("routing probe scores only daily initial tool cases", () => {
	const dir = fixture([
		{ input: "匿名请求A", expected_tool: "cbrain_recall" },
		{
			intent: "匿名请求B",
			expected_tool: "deep_recall",
			route_phase: "fallback",
		},
		{ intent: "匿名请求C", expected_tool: "query", required_profile: "debug" },
		{ intent: "匿名请求D", expected_skill: "review.md" },
		{ intent: "匿名请求E", expected_tool: "FORBIDDEN" },
		{
			intent: "匿名请求F",
			expected_tool: "cbrain_recall",
			category: "anti_pattern",
		},
	]);
	expect(loadCases(dir).map((c) => [c.input, c.expected])).toEqual([
		["匿名请求A", "cbrain_recall"],
	]);
});

test("routing probe fails when daily initial gold is absent from the real agent menu", () => {
	const dir = fixture([{ intent: "匿名请求A", expected_tool: "query" }]);
	expect(() => loadCases(dir)).toThrow(
		"daily initial gold query is absent from agent tool menu",
	);
});

test("organization review and tree lookup remain distinct scored cases", () => {
	const cases = loadCases();
	expect(cases.find((c) => c.input === "梳理一下组织架构")?.expected).toBe(
		"cbrain_recall",
	);
	expect(
		cases.find((c) => c.input === "梳理一下组织C的组织架构")?.expected,
	).toBe("cbrain_recall");
	expect(cases.find((c) => c.input === "查看组织C的组织架构树")?.expected).toBe(
		"get_org_tree",
	);
});
