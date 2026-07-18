import { describe, test, expect, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const GATE_SCRIPT = join(PROJECT_DIR, "bin", "check-v2-rc-gate.ts");

// ── Types (mirror the gate's GateReport shape) ──

interface AssertionResult {
  check: string;
  passed: boolean;
  actual: string;
  expected: string;
}

interface JourneyResult {
  id: string;
  tool: string;
  passed: boolean;
  duration_ms: number;
  query_count: number;
  query_budget: number;
  display_chars: number;
  timed_out: boolean;
  assertions: AssertionResult[];
  failed_reason: string | null;
}

interface GateReport {
  gate: string;
  version: string;
  timestamp: string;
  verdict: "go" | "no-go";
  journeys: JourneyResult[];
  privacy: { passed: boolean; assertions: AssertionResult[] };
  budgets: {
    baselines: Record<string, number>;
    headroom_mult: number;
    hang_ceiling_ms: number;
    display_chars: number;
  };
  slowest_journey: { id: string; duration_ms: number } | null;
  failed_stage: string | null;
  reason: string | null;
  next_action: string | null;
  cleanup: { verified: boolean; path: string };
  duration_ms: number;
}

// ── Helpers ──

function runGate(extraEnv: Record<string, string> = {}, args = ""): { stdout: string; exitCode: number; wallMs: number } {
  const env: Record<string, string> = {};
  // Inherit only safe vars; never inherit operator secrets into the gate subprocess.
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "BUN_INSTALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, extraEnv);

  const start = performance.now();
  try {
    const stdout = execSync(`bun "${GATE_SCRIPT}"${args ? " " + args : ""}`, {
      encoding: "utf-8",
      cwd: PROJECT_DIR,
      timeout: 60_000,
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { stdout, exitCode: 0, wallMs: performance.now() - start };
  } catch (e: unknown) {
    // Gate exits 1 for no-go (and 2 for fatal) — stdout still carries the JSON report.
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", exitCode: err.status ?? 1, wallMs: performance.now() - start };
  }
}

function parseReport(stdout: string): GateReport {
  return JSON.parse(stdout);
}

function gitStatus(): string {
  return execSync("git --no-optional-locks status --porcelain", { encoding: "utf-8", cwd: PROJECT_DIR });
}

function assertionOf(j: JourneyResult | undefined, check: string): AssertionResult {
  const a = j?.assertions.find((x) => x.check === check);
  if (!a) throw new Error(`assertion '${check}' missing on journey '${j?.id}'`);
  return a;
}

const REQUIRED_JOURNEYS = [
  "exact-recall",
  "topic-recall",
  "grounded-recall",
  "relationship-lookup",
  "episodic-person",
  "version-history",
  "degraded-search",
  "empty-search",
];

// ── Success path ──

describe("v2-rc release gate — success path", () => {
  let report: GateReport;
  let stdout: string;

  beforeAll(() => {
    const result = runGate();
    stdout = result.stdout;
    report = parseReport(stdout);
  }, 60_000);

  test("gate is the v2-rc gate with a go verdict", () => {
    expect(report.gate).toBe("v2-rc");
    expect(report.verdict).toBe("go");
  });

  test("every required journey ran and passed", () => {
    const ids = report.journeys.map((j) => j.id);
    for (const id of REQUIRED_JOURNEYS) {
      expect(ids).toContain(id);
    }
    for (const j of report.journeys) {
      expect(j.passed).toBe(true);
      expect(j.timed_out).toBe(false);
      expect(j.assertions.length).toBeGreaterThan(0);
      for (const a of j.assertions) {
        expect(a.passed).toBe(true);
      }
    }
  });

  test("degraded-search exercises real degradation (not just an empty result)", () => {
    const deg = report.journeys.find((j) => j.id === "degraded-search");
    expect(deg).toBeDefined();
    // The envelope must report a degraded status (vector-error fallback), surface
    // a degraded reason in the structured layer, keep a useful FTS-fallback result,
    // set search_meta.degraded, and stay user-safe — never an error.
    expect(assertionOf(deg, "degraded status reported").actual).toBe("degraded");
    expect(assertionOf(deg, "degraded reason surfaced (raw only)").actual).toBe("present");
    expect(assertionOf(deg, "not flagged as error").actual).toBe("ok");
    expect(assertionOf(deg, "search_meta.degraded set").actual).toBe("true");
    const fallback = assertionOf(deg, "FTS fallback kept a useful result");
    // actual is shaped "<n> entities" — assert at least one FTS-fallback entity.
    expect(fallback.actual).toMatch(/^[1-9]\d* entities$/);
  });

  test("topic-recall is a HEALTHY, non-degraded recall via the non-title path", () => {
    const topic = report.journeys.find((j) => j.id === "topic-recall");
    expect(topic).toBeDefined();
    expect(assertionOf(topic, "topic phrase recalled via normal (non-title) path").actual).toBe("method-alpha found");
    // A NORMAL (non-exact) recall must be healthy. The offline vector mock
    // returns a real cosine hit for this phrase and the core concept carries
    // activity/hotness weight, so the score clears the low-score threshold.
    // Degraded is the degraded-search journey's exclusive job — it must never
    // be the normal success path.
    expect(assertionOf(topic, "summary status ok").actual).toBe("ok");
    expect(assertionOf(topic, "not degraded").actual).toBe("ok");
    expect(assertionOf(topic, "no degradation reason code").actual).toBe("none");
  });

  test("episodic recall selects the expected person with time/topic/context clues", () => {
    const epi = report.journeys.find((j) => j.id === "episodic-person");
    expect(epi).toBeDefined();
    expect(assertionOf(epi, "expected person is the top candidate").actual).toBe("联系人甲");
    expect(assertionOf(epi, "matched time clue").actual).toBe("time");
    expect(assertionOf(epi, "matched topic clue").actual).toBe("topic");
    expect(assertionOf(epi, "matched context clue").actual).toBe("context");
  });

  test("scale-sensitive journeys stay O(1) as anonymous pages grow (no N+1)", () => {
    // 60 anonymous persons are seeded alongside the core pages. A correct
    // episodic recall is O(1) (the batch DB methods are true IN-clause batches),
    // so its query count is a small constant and must NOT scale with the person
    // count. A per-person N+1 regression would be 60+ and trip no-go.
    const epi = report.journeys.find((j) => j.id === "episodic-person");
    expect(epi).toBeDefined();
    expect(epi!.query_count).toBeLessThan(15); // measured 6 over 62 persons
  });

  test("operation/query-count budgets are bounded per journey", () => {
    for (const j of report.journeys) {
      expect(j.query_count).toBeLessThanOrEqual(j.query_budget);
    }
  });

  test("every baseline is documented with headroom", () => {
    expect(report.budgets.headroom_mult).toBeGreaterThan(1);
    for (const id of REQUIRED_JOURNEYS) {
      expect(report.budgets.baselines[id]).toBeDefined();
      expect(report.budgets.baselines[id]).toBeGreaterThan(0);
    }
  });

  test("each first response is compact", () => {
    for (const j of report.journeys) {
      expect(j.display_chars).toBeLessThanOrEqual(report.budgets.display_chars);
      expect(j.display_chars).toBeGreaterThan(0);
    }
  });

  test("slowest journey is reported", () => {
    expect(report.slowest_journey).not.toBeNull();
    const slowest = report.slowest_journey!.id;
    const ids = report.journeys.map((j) => j.id);
    expect(ids).toContain(slowest);
  });

  test("report schema is complete", () => {
    expect(typeof report.version).toBe("string");
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof report.timestamp).toBe("string");
    expect(typeof report.duration_ms).toBe("number");
    expect(report.duration_ms).toBeGreaterThan(0);
    expect(report.privacy.passed).toBe(true);
    expect(report.cleanup.verified).toBe(true);
    expect(report.failed_stage).toBeNull();
    for (const j of report.journeys) {
      expect(typeof j.id).toBe("string");
      expect(typeof j.tool).toBe("string");
      expect(typeof j.duration_ms).toBe("number");
      expect(typeof j.query_count).toBe("number");
      expect(typeof j.query_budget).toBe("number");
    }
  });

  test("report contains no real paths, credentials, or vectors", () => {
    expect(stdout).not.toContain("/Users/");
    expect(stdout).not.toContain("Projects/cbrain");
    expect(stdout).not.toMatch(/sk-[a-f0-9]{8,}/i);
    expect(stdout).not.toMatch(/"(?:-?\d+\.\d{4},){8}/);
  });

  test("fixture is anonymous (synthetic tokens, no real identifiers)", () => {
    // Synthetic knowledge set tokens must appear in journey outputs (proves the
    // real handler path returned the synthetic fixture, not the operator's vault).
    expect(stdout).toContain("方法Alpha");
    // No real PII patterns (phone/email) — fixture is synthetic only.
    expect(stdout).not.toMatch(/1[3-9]\d{9}/);
    expect(stdout).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  test("checkout state is unchanged after the gate", () => {
    // The gate must write nothing into the checkout — only stdout.
    const before = gitStatus();
    const version = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
    runGate();
    const after = gitStatus();
    expect(after).toBe(before);
    // No report artifact, no tarball-like leftovers.
    expect(existsSync(join(PROJECT_DIR, `cbrain-${version}.tgz`))).toBe(false);
    expect(existsSync(join(PROJECT_DIR, "v2-rc-report.json"))).toBe(false);
    expect(existsSync(join(PROJECT_DIR, "node_modules"))).toBe(true);
  });
});

// ── Fault injection (real subprocess, deterministic) ──

describe("v2-rc gate — fault injection produces no-go", () => {
  test("RC_FAULT_RETRIEVAL → recall misses the must-hit entity → no-go", () => {
    const { stdout } = runGate({ RC_FAULT_RETRIEVAL: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    const recall = report.journeys.find((j) => j.id === "exact-recall");
    expect(recall).toBeDefined();
    expect(recall!.passed).toBe(false);
    expect(report.failed_stage).toBe("exact-recall");
    expect(report.reason).toContain("exact entity recalled");
    expect(report.next_action).toBeTruthy();
  }, 60_000);

  test("RC_FAULT_PRIVACY_LEAK → display leak → no-go, and no internal detail is echoed", () => {
    const { stdout } = runGate({ RC_FAULT_PRIVACY_LEAK: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.privacy.passed).toBe(false);
    expect(report.cleanup.verified).toBe(true);

    // The injected banned token must be detected but never echoed in the report.
    expect(stdout).not.toContain("sk-deadbeef");
    expect(stdout).not.toContain("leaked-slug");
    expect(stdout).not.toContain("cbrain-leak");
  }, 60_000);

  test("RC_FAULT_QUERY_BUDGET → query explosion → no-go at the first journey", () => {
    const { stdout } = runGate({ RC_FAULT_QUERY_BUDGET: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    const exact = report.journeys.find((j) => j.id === "exact-recall");
    expect(exact).toBeDefined();
    // The inflated counter must breach THIS journey's per-journey budget.
    expect(exact!.query_count).toBeGreaterThan(exact!.query_budget);
    expect(report.failed_stage).toBe("exact-recall");
    expect(report.reason).toContain("query budget");
    expect(report.next_action).toBeTruthy();
  }, 60_000);

  test("RC_FAULT_HANG → handler hang caught by ceiling → no-go", () => {
    const start = performance.now();
    const { stdout, wallMs } = runGate({ RC_FAULT_HANG: "1" });
    const elapsed = performance.now() - start;
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    const exact = report.journeys.find((j) => j.id === "exact-recall");
    expect(exact).toBeDefined();
    expect(exact!.timed_out).toBe(true);
    expect(report.failed_stage).toBe("exact-recall");
    // The ceiling must catch the hang promptly — not run away.
    expect(elapsed).toBeLessThan(15_000);
    expect(wallMs).toBeLessThan(15_000);
  }, 60_000);

  test("every fault path cleans up temporary state", () => {
    const faultEnvs: Record<string, string>[] = [
      { RC_FAULT_RETRIEVAL: "1" },
      { RC_FAULT_PRIVACY_LEAK: "1" },
      { RC_FAULT_QUERY_BUDGET: "1" },
      { RC_FAULT_HANG: "1" },
    ];
    for (const faultEnv of faultEnvs) {
      const { stdout } = runGate(faultEnv);
      const report = parseReport(stdout);
      expect(report.cleanup.verified).toBe(true);
      expect(report.cleanup.path).toBe("<cleaned>");
    }
  }, 120_000);
});

// ── Performance report (--perf mode, #188) ──

interface PerfJourney {
  id: string;
  duration_ms: number;
  query_count: number;
  query_budget: number;
  query_budget_utilization: number;
  display_chars: number;
  passed: boolean;
  timed_out: boolean;
}

interface PerfReport {
  gate: string;
  version: string;
  timestamp: string;
  verdict: "go" | "no-go";
  journeys: PerfJourney[];
  slowest_journey: { id: string; duration_ms: number } | null;
  highest_query_utilization_journey: { id: string; utilization: number } | null;
  total_duration_ms: number;
  warnings: string[];
  thresholds: { warn_budget_pct: number; warn_hang_pct: number; hang_ceiling_ms: number };
  cleanup: { verified: boolean; path: string };
  duration_ms: number;
}

describe("v2-perf report (--perf mode, #188)", () => {
  const result = runGate({}, "--perf");
  const report = JSON.parse(result.stdout) as PerfReport;

  test("emits a v2-perf report with a go verdict on the clean fixture", () => {
    expect(result.exitCode).toBe(0);
    expect(report.gate).toBe("v2-perf");
    expect(report.verdict).toBe("go");
  });

  test("report schema is complete and stable", () => {
    for (const key of [
      "gate", "version", "timestamp", "verdict", "journeys",
      "slowest_journey", "highest_query_utilization_journey", "total_duration_ms",
      "warnings", "thresholds", "cleanup", "duration_ms",
    ] as const) {
      expect(report).toHaveProperty(key);
    }
    expect(report.journeys.length).toBeGreaterThanOrEqual(8);
  });

  test("every journey carries exactly the perf fields incl. utilization", () => {
    const allowed = new Set([
      "id", "duration_ms", "query_count", "query_budget", "query_budget_utilization",
      "display_chars", "passed", "timed_out",
    ]);
    for (const j of report.journeys) {
      expect(Object.keys(j).sort()).toEqual([...allowed].sort());
      expect(j.query_budget).toBeGreaterThan(0);
      expect(j.query_budget_utilization).toBeGreaterThanOrEqual(0);
      expect(j.query_budget_utilization).toBeLessThan(1); // clean fixture: well within budget
    }
  });

  test("slowest + highest-utilization are derived consistently from journeys", () => {
    expect(report.slowest_journey).not.toBeNull();
    const maxDur = Math.max(...report.journeys.map((j) => j.duration_ms));
    expect(report.slowest_journey!.duration_ms).toBe(maxDur);

    expect(report.highest_query_utilization_journey).not.toBeNull();
    const maxUtil = Math.max(...report.journeys.map((j) => j.query_budget_utilization));
    expect(report.highest_query_utilization_journey!.utilization).toBeCloseTo(maxUtil, 5);

    expect(report.total_duration_ms).toBe(report.journeys.reduce((s, j) => s + j.duration_ms, 0));
  });

  test("warnings present and sanitized (no paths/credentials/content)", () => {
    expect(Array.isArray(report.warnings)).toBe(true);
    const text = report.warnings.join(" ");
    expect(text).not.toMatch(/\/Users|\/tmp|\.md\b|secret|sk-[a-f0-9]/i);
  });

  test("thresholds expose the warning knobs", () => {
    expect(report.thresholds.warn_budget_pct).toBeGreaterThan(0);
    expect(report.thresholds.warn_hang_pct).toBeGreaterThan(0);
    expect(report.thresholds.hang_ceiling_ms).toBeGreaterThan(0);
  });
});
