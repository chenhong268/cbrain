import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CONTRIBUTING = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
const COLLABORATION = readFileSync(join(ROOT, "docs", "agent-collaboration.md"), "utf8");
const PR_TEMPLATE = readFileSync(join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8");

describe("mainline issue-closure contract (#426)", () => {
  test("code issues close through a PR targeting main", () => {
    expect(CONTRIBUTING).toMatch(/Closes #<issue-number>/);
    expect(CONTRIBUTING).toMatch(/PR.*main/i);
    expect(COLLABORATION).toMatch(/Closes #<issue-number>/);
    expect(COLLABORATION).not.toMatch(/直接 push main\s*\+\s*关闭 issue/);
  });

  test("manual closure requires deterministic main ancestry evidence", () => {
    const command = "git merge-base --is-ancestor <fix-commit> origin/main";
    expect(CONTRIBUTING).toContain(command);
    expect(COLLABORATION).toContain(command);
    expect(PR_TEMPLATE).toContain(command);
  });

  test("the PR template records the closing issue relationship", () => {
    expect(PR_TEMPLATE).toMatch(/Closes #<issue-number>/);
    expect(PR_TEMPLATE).toMatch(/target.*main/i);
  });
});
