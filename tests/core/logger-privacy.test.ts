import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/core/logger.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("Logger failure privacy boundary", () => {
  test("reports a stable failure marker without the filesystem error message", () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-logger-privacy-"));
    roots.add(root);
    const logger = new Logger(root);
    rmSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs"), "not-a-directory", "utf8");

    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      logger.warn("mcp", "MCP_INPUT_INVALID");
    } finally {
      console.error = original;
    }

    const output = JSON.stringify(calls);
    expect(output).toContain("LOGGER_WRITE_FAILED");
    expect(output).not.toContain(root);
    expect(output).not.toContain("ENOTDIR");
    expect(output).not.toContain("not a directory");
  });
});
