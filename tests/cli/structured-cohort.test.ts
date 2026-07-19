import { describe, expect, test } from "bun:test";
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
});
