import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_PATH = join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml");
const WORKFLOW = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf-8") : "";

describe(".github/workflows/ci.yml contract", () => {
  test("file exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  test("triggers on pull_request", () => {
    expect(WORKFLOW).toMatch(/pull_request:/);
  });

  test("triggers on push to main", () => {
    expect(WORKFLOW).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  test("uses oven-sh/setup-bun@v2", () => {
    expect(WORKFLOW).toContain("oven-sh/setup-bun@v2");
  });

  test("installs with frozen lockfile", () => {
    expect(WORKFLOW).toContain("bun install --frozen-lockfile");
  });

  test("runs the ci script", () => {
    expect(WORKFLOW).toContain("bun run check:ci");
  });

  test("declares least-privilege contents:read permission", () => {
    expect(WORKFLOW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  test("does not require secrets", () => {
    expect(WORKFLOW).not.toContain("secrets.");
  });

  test("does not reference private/local paths", () => {
    expect(WORKFLOW).not.toMatch(/\/Users\/|\/Volumes\/|\\Users\\/);
  });

  test("does not depend on Hermes / LLM / provider env vars", () => {
    // Matches env-var-style identifiers (FOO_KEY, BAR_TOKEN), not prose mentions.
    expect(WORKFLOW).not.toMatch(/\b(HERMES|LLM|OPENAI|DEEPSEEK|ZHIPU|ANTHROPIC)_[A-Z]/);
  });
});
