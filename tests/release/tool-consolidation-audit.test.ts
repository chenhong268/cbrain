import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRegisteredToolNames } from "../helpers/mcp-inventory";

const AUDIT = join(process.cwd(), "docs", "mcp-tool-consolidation-audit.md");

describe("tool consolidation audit (#251)", () => {
  test("doc exists", () => {
    expect(() => readFileSync(AUDIT, "utf-8")).not.toThrow();
  });

  test("has required sections", () => {
    const src = readFileSync(AUDIT, "utf-8");
    for (const heading of [
      "# MCP Tool Consolidation Audit",
      "## Summary",
      "## Merge candidates",
      "## Keep separate",
      "## Recommended sequencing",
    ]) {
      expect(src, `missing heading ${heading}`).toContain(heading);
    }
  });

  test("every underscore tool name referenced exists in the real inventory", () => {
    const src = readFileSync(AUDIT, "utf-8");
    const inventory = new Set(collectRegisteredToolNames());
    // Backtick-quoted snake_case tokens (contain "_"). Wilcards like `job_*` don't
    // match (the `*` breaks the regex), so only concrete tool names are checked.
    const refs = [...src.matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1]);
    const unknown = refs.filter((r) => r.includes("_") && !inventory.has(r));
    expect(unknown, `audit references unknown tools: ${unknown.join(", ")}`).toEqual([]);
  });
});
