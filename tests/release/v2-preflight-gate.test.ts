import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFLIGHT_CHECKS,
  runPreflight,
  type CommandRunner,
  type PreflightCheckSpec,
} from "../../bin/check-v2-preflight";

function fakeRunner(failId?: string): CommandRunner {
  return async (spec: PreflightCheckSpec) => ({
    exitCode: spec.id === failId ? 1 : 0,
    stdout: spec.id === failId ? "no-go details" : `ok ${spec.id}`,
    stderr: spec.id === failId ? "failure details" : "",
    durationMs: 5,
  });
}

describe("v2 preflight aggregate gate", () => {
  test("runs the expected existing gates in release order", () => {
    expect(DEFAULT_PREFLIGHT_CHECKS.map((c) => c.id)).toEqual([
      "offline-first-recall",
      "rc-journeys",
      "hermes-dialogue",
      "performance",
      "docs-consistency",
      "resolver-pilot",
      "storage-consistency",
      "recall-quality-matrix",
    ]);
    for (const check of DEFAULT_PREFLIGHT_CHECKS) {
      expect(check.required).toBe(true);
      expect(check.command.length).toBeGreaterThan(0);
      expect(check.timeoutMs).toBeGreaterThan(0);
    }
  });

  test("reports go when every owned gate passes", async () => {
    const report = await runPreflight(DEFAULT_PREFLIGHT_CHECKS, fakeRunner());
    expect(report.gate).toBe("v2-preflight");
    expect(report.verdict).toBe("go");
    expect(report.failed_stage).toBeNull();
    expect(report.reason).toBeNull();
    expect(report.next_action).toBeNull();
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  test("reports no-go with the first failing required stage", async () => {
    const report = await runPreflight(DEFAULT_PREFLIGHT_CHECKS, fakeRunner("hermes-dialogue"));
    expect(report.verdict).toBe("no-go");
    expect(report.failed_stage).toBe("hermes-dialogue");
    expect(report.reason).toContain("Hermes natural-dialogue gate");
    expect(report.next_action).toContain("bun run gate:v2-preflight");
    const failed = report.checks.find((c) => c.id === "hermes-dialogue");
    expect(failed?.status).toBe("fail");
    expect(failed?.stdout_tail).toContain("no-go details");
    expect(failed?.stderr_tail).toContain("failure details");
  });
});
