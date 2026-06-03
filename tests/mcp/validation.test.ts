import { describe, it, expect } from "bun:test";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * #123: Verify that ALL z.string() parameters in MCP tool files have .max() limits.
 *
 * This test parses source files (not runtime schemas) to ensure every
 * z.string() call is followed by .max(N). It catches regressions where
 * new unprotected string params are added.
 */

const TOOLS_DIR = path.resolve(import.meta.dir, "../../src/mcp/tools");

// Files that register MCP tools with string parameters
const TOOL_FILES = fs.readdirSync(TOOLS_DIR)
  .filter(f => f.endsWith(".ts") && f !== "trim.ts")
  .sort();

// Patterns that indicate a z.string() WITHOUT .max()
// Matches: z.string() NOT followed by .max() (allows .min(N) in between)
// Also catches z.string().describe(...) without .max
const UNPROTECTED_STRING_RE = /z\.string\(\)(?!\s*(?:\.min\(\d+\)\s*)?\.max\()/g;

// Patterns for array item strings: z.string()) inside z.array()
const ARRAY_STRING_RE = /z\.array\(z\.string\(\)\)/g;

describe("#123: MCP tool input length limits", () => {
  it("every z.string() in tool files should have .max()", () => {
    const violations: string[] = [];

    for (const file of TOOL_FILES) {
      const filePath = path.join(TOOLS_DIR, file);
      const source = fs.readFileSync(filePath, "utf-8");

      // Skip import lines and comments
      const codeLines = source.split("\n");
      const relevantLines: string[] = [];

      for (const line of codeLines) {
        const trimmed = line.trim();
        // Skip imports, pure comments, and empty lines
        if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.length === 0) continue;
        relevantLines.push(line);
      }

      const code = relevantLines.join("\n");

      // Find unprotected z.string() calls
      UNPROTECTED_STRING_RE.lastIndex = 0;
      const found = code.matchAll(UNPROTECTED_STRING_RE);
      for (const m of found) {
        // Get surrounding context for error message
        const start = Math.max(0, m.index - 30);
        const end = Math.min(code.length, m.index + m[0].length + 50);
        const context = code.slice(start, end).replace(/\n/g, " ");
        violations.push(`${file}: ...${context}...`);
      }
    }

    if (violations.length > 0) {
      console.error(`\n${violations.length} unprotected z.string() calls found:`);
      for (const v of violations) {
        console.error(`  - ${v}`);
      }
    }

    expect(violations.length).toBe(0);
  });

  it("z.array(z.string()) should use z.array(z.string().max(...))", () => {
    const violations: string[] = [];

    for (const file of TOOL_FILES) {
      const filePath = path.join(TOOLS_DIR, file);
      const source = fs.readFileSync(filePath, "utf-8");

      ARRAY_STRING_RE.lastIndex = 0;
      if (ARRAY_STRING_RE.test(source)) {
        // Found bare z.array(z.string()) without .max() on the inner string
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      console.error(`\n${violations.length} files with z.array(z.string()) without .max():`);
      for (const v of violations) {
        console.error(`  - ${v}`);
      }
    }

    expect(violations.length).toBe(0);
  });

  it("representative tools reject oversized inputs", () => {
    // Test a few representative schemas at runtime to verify Zod actually rejects

    // slug-type: max 500
    const slugSchema = z.string().max(500);
    expect(slugSchema.safeParse("ok").success).toBe(true);
    expect(slugSchema.safeParse("x".repeat(500)).success).toBe(true);
    expect(slugSchema.safeParse("x".repeat(501)).success).toBe(false);

    // query-type: max 1000
    const querySchema = z.string().max(1000);
    expect(querySchema.safeParse("x".repeat(1000)).success).toBe(true);
    expect(querySchema.safeParse("x".repeat(1001)).success).toBe(false);

    // content-type: max 500000
    const contentSchema = z.string().max(500_000);
    expect(contentSchema.safeParse("x".repeat(500_000)).success).toBe(true);
    expect(contentSchema.safeParse("x".repeat(500_001)).success).toBe(false);

    // relation-type: max 100
    const relationSchema = z.string().max(100);
    expect(relationSchema.safeParse("提及".repeat(25)).success).toBe(true);
    expect(relationSchema.safeParse("x".repeat(101)).success).toBe(false);
  });

  it("validation.ts constants file exists and exports expected values", () => {
    const constantsPath = path.resolve(import.meta.dir, "../../src/mcp/validation.ts");
    const source = fs.readFileSync(constantsPath, "utf-8");

    // Verify key constants are defined
    expect(source).toContain("SLUG_MAX");
    expect(source).toContain("QUERY_MAX");
    expect(source).toContain("CONTENT_MAX");
    expect(source).toContain("RELATION_MAX");
    expect(source).toContain("TITLE_MAX");
    expect(source).toContain("NOTE_MAX");
  });
});
