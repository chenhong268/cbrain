import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../src/cli/index.ts");

function runCli(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describe("CLI ontology-missing safety (#220)", () => {
  test("--version does not crash (does not trigger ontology load)", () => {
    const r = runCli("--version");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test("--help does not crash (does not trigger ontology load)", () => {
    const r = runCli("--help");
    expect(r.status).toBe(0);
  });

  test("serve --help does not crash", () => {
    const r = runCli("serve", "--help");
    expect(r.status).toBe(0);
  });
});
