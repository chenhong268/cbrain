import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { buildProgram } from "../../src/cli/program.js";

describe("structured-cohort CLI (#357)", () => {
  test("registers only the fixed rollback surface with no caller-selected target", () => {
    const parent = buildProgram().commands.find((command) => command.name() === "structured-cohort");
    expect(parent).toBeDefined();
    expect(parent?.commands.map((command) => command.name())).toEqual(["rollback"]);
    const rollback = parent?.commands[0];
    expect(rollback?.options.map((option) => option.long)).toEqual(["--json"]);
    expect(rollback?.options.map((option) => option.long)).not.toContain("--target");
    expect(rollback?.options.map((option) => option.long)).not.toContain("--label");
    expect(rollback?.options.map((option) => option.long)).not.toContain("--force");
  });

  test("missing private config returns only the closed JSON failure", () => {
    const secret = "/private/review357-secret-config";
    const child = spawnSync(process.execPath, [resolve("src/cli/index.ts"), "structured-cohort", "rollback", "--json"], {
      cwd: resolve("."),
      env: { ...process.env, CBRAIN_CONFIG: secret },
      encoding: "utf8",
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(child.stdout.trim()).toBe('{"schema_version":1,"status":"failed","code":"TARGET_INVALID"}');
    expect(`${child.stdout}${child.stderr}`).not.toContain(secret);
  });

  test("the canonical cohort wrapper preserves the default and forwards fixed cohort argv", () => {
    const wrapper = readFileSync(resolve("bin/cbrain-serve-http.sh"), "utf8");
    expect(wrapper).toContain('set -- serve --http --port 3399');
    expect(wrapper).toContain('"$@"');
    expect(spawnSync("/bin/bash", ["-n", resolve("bin/cbrain-serve-http.sh")]).status).toBe(0);
  });
});
