import { describe, test, expect } from "bun:test";
import { resolveOutputMode, OUTPUT_MODE_ENV, type OutputMode } from "../../src/mcp/output-mode.js";

describe("resolveOutputMode (#327)", () => {
  test("'structured' wins, case-insensitive", () => {
    expect(resolveOutputMode("structured")).toBe("structured");
    expect(resolveOutputMode("  STRUCTURED ")).toBe("structured");
  });
  test("'legacy' is honored", () => {
    expect(resolveOutputMode("legacy")).toBe("legacy");
  });
  test("defaults to 'legacy' (rollout default) on unset/empty/invalid (spec §5.2)", () => {
    expect(resolveOutputMode(undefined)).toBe("legacy");
    expect(resolveOutputMode("")).toBe("legacy");
    expect(resolveOutputMode("yes")).toBe("legacy");
  });
  test("OUTPUT_MODE_ENV is the documented flag name", () => {
    expect(OUTPUT_MODE_ENV).toBe("CBRAIN_OUTPUT_BOUNDARY");
    const _m: OutputMode = "legacy";
    const _n: OutputMode = "structured";
    void _m; void _n;
  });
});
