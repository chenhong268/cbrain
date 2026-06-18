import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const GATE_SCRIPT = join(PROJECT_DIR, "bin", "check-v2-hermes-gate.ts");

interface HermesJourney {
  id: string;
  status: "pass" | "fail";
  duration_ms: number;
  query_count: number;
  query_budget: number;
  degraded: boolean;
  privacy_passed: boolean;
  failure_reason: string | null;
}

interface HermesReport {
  gate: string;
  version: string;
  verdict: "go" | "no-go";
  journeys: HermesJourney[];
  privacy: { passed: boolean };
  failed_stage: string | null;
  cleanup: { verified: boolean; path: string };
}

function runHermesGate(extraEnv: Record<string, string> = {}): { report: HermesReport; stdout: string; exitCode: number } {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "BUN_INSTALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, extraEnv);
  try {
    const stdout = execSync(`bun "${GATE_SCRIPT}"`, {
      encoding: "utf-8",
      cwd: PROJECT_DIR,
      timeout: 90_000,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { report: JSON.parse(stdout), stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { report: JSON.parse(err.stdout ?? "{}"), stdout: err.stdout ?? "", exitCode: err.status ?? 1 };
  }
}

const REQUIRED_JOURNEYS = [
  "first-memory-recall",
  "forgotten-person-by-context",
  "relationship-traversal",
  "grounded-answer",
  "safe-capture-routing",
  "failure-degraded",
];

describe("v2-hermes dialogue gate (#193)", () => {
  const { report, stdout, exitCode } = runHermesGate();

  test("emits a v2-hermes report with a go verdict on the anonymous fixture", () => {
    expect(exitCode).toBe(0);
    expect(report.gate).toBe("v2-hermes");
    expect(report.verdict).toBe("go");
  });

  test("all six required journeys ran and passed", () => {
    const ids = report.journeys.map((j) => j.id);
    for (const id of REQUIRED_JOURNEYS) expect(ids).toContain(id);
    expect(report.journeys.length).toBeGreaterThanOrEqual(6);
    for (const j of report.journeys) expect(j.status).toBe("pass");
  });

  test("every journey carries the required acceptance fields", () => {
    for (const j of report.journeys) {
      for (const key of ["id", "status", "duration_ms", "query_count", "degraded", "privacy_passed", "failure_reason"] as const) {
        expect(j).toHaveProperty(key);
      }
      expect(typeof j.query_count).toBe("number");
      expect(j.query_count).toBeLessThanOrEqual(j.query_budget);
      expect(j.privacy_passed).toBe(true);
    }
  });

  test("privacy + cleanup are clean", () => {
    expect(report.privacy.passed).toBe(true);
    expect(report.cleanup.verified).toBe(true);
    expect(report.failed_stage).toBeNull();
  });

  test("report leaks no real identifiers, paths, vectors, or credentials", () => {
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/tmp\/cbrain/i);
    expect(stdout).not.toMatch(/sk-[a-f0-9]{8,}/i);
    expect(stdout).not.toMatch(/(-?\d+\.\d{4},){8}/); // raw vector array
  });

  test("failure-degraded journey is explicitly degraded (graceful, not a crash)", () => {
    const f = report.journeys.find((j) => j.id === "failure-degraded");
    expect(f).toBeDefined();
    expect(f!.degraded).toBe(true);
    expect(f!.status).toBe("pass"); // graceful degradation is a pass
  });
});

describe("v2-hermes fault injection -> no-go (#193 review)", () => {
  test("HERMES_FAULT_RETRIEVAL -> a must-recall journey misses -> no-go", () => {
    const { report, exitCode } = runHermesGate({ HERMES_FAULT_RETRIEVAL: "1" });
    expect(exitCode).not.toBe(0);
    expect(report.verdict).toBe("no-go");
    expect(report.failed_stage).toBeTruthy();
    expect(report.cleanup.verified).toBe(true); // temp state cleaned even on failure
  });

  test("HERMES_FAULT_PRIVACY_LEAK -> privacy scan fails -> no-go", () => {
    const { report, exitCode } = runHermesGate({ HERMES_FAULT_PRIVACY_LEAK: "1" });
    expect(exitCode).not.toBe(0);
    expect(report.verdict).toBe("no-go");
    expect(report.privacy.passed).toBe(false); // the leak was caught
    expect(report.cleanup.verified).toBe(true);
  });

  test("HERMES_FAULT_QUERY_BUDGET -> operation budget exceeded -> no-go", () => {
    const { report, exitCode } = runHermesGate({ HERMES_FAULT_QUERY_BUDGET: "1" });
    expect(exitCode).not.toBe(0);
    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);
  });

  test("HERMES_FAULT_HANG -> handler timeout -> no-go", () => {
    const { report, exitCode } = runHermesGate({ HERMES_FAULT_HANG: "1" });
    expect(exitCode).not.toBe(0);
    expect(report.verdict).toBe("no-go");
    expect(report.failed_stage).toBeTruthy();
    expect(report.cleanup.verified).toBe(true);
  }, 30_000); // the hang fault waits the 8s ceiling — allow the subprocess to complete
});
