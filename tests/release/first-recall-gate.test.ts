import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_DIR = join(import.meta.dir, "..", "..");
const GATE_SCRIPT = join(PROJECT_DIR, "bin", "check-first-recall-gate.ts");

// ── Types ──

interface AssertionResult {
  check: string;
  passed: boolean;
  actual: string;
  expected: string;
}

interface StageResult {
  id: string;
  command: string;
  exitCode: number;
  duration_ms: number;
  passed: boolean;
  assertions: AssertionResult[];
}

interface GateReport {
  gate: string;
  version: string;
  timestamp: string;
  verdict: "go" | "no-go";
  stages: StageResult[];
  cleanup: { verified: boolean; path: string };
  duration_ms: number;
}

// ── Helpers ──

function runGate(extraEnv: Record<string, string> = {}): { stdout: string; wallMs: number } {
  const env: Record<string, string> = {};
  // Inherit safe vars only
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "BUN_INSTALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, extraEnv);

  const start = performance.now();
  try {
    const stdout = execSync(`bun "${GATE_SCRIPT}"`, {
      encoding: "utf-8",
      cwd: PROJECT_DIR,
      timeout: 180_000,
      env,
    });
    return { stdout, wallMs: performance.now() - start };
  } catch (e: any) {
    // Gate exits 1 for no-go — extract stdout from error
    const stdout = e.stdout ?? "";
    return { stdout, wallMs: performance.now() - start };
  }
}

function parseReport(stdout: string): GateReport {
  return JSON.parse(stdout);
}

/** Create a shadow project dir for isolated tests.
 *  Copies source files (bun pm pack doesn't follow directory symlinks)
 *  and symlinks node_modules (for offline dep resolution). */
function createShadowProject(sentinelTarball = false): string {
  const version = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
  const shadow = mkdtempSync(join(tmpdir(), "cbrain-shadow-"));

  // Copy package.json (real file — gate reads it for version)
  copyFileSync(join(PROJECT_DIR, "package.json"), join(shadow, "package.json"));

  // Copy source dirs (bun pm pack needs real files, not symlinks)
  for (const dir of ["src", "skills", "bin"]) {
    execSync(`cp -a "${join(PROJECT_DIR, dir)}" "${shadow}/"`, { encoding: "utf-8" });
  }

  // Copy static files
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) {
    const src = join(PROJECT_DIR, file);
    if (existsSync(src)) copyFileSync(src, join(shadow, file));
  }

  // Symlink node_modules (offline gate needs full tree — no network)
  symlinkSync(join(PROJECT_DIR, "node_modules"), join(shadow, "node_modules"));

  // Optionally create a sentinel tarball to test same-version handling
  if (sentinelTarball) {
    const tarballName = `cbrain-${version}.tgz`;
    writeFileSync(join(shadow, tarballName), `gate-sentinel-${Date.now()}`);
  }

  return shadow;
}

// ── Success path (shared gate run) ──

describe("first-recall-v2 release gate — success path", () => {
  let report: GateReport;
  let stdout: string;
  let wallMs: number;

  beforeAll(() => {
    const result = runGate();
    stdout = result.stdout;
    wallMs = result.wallMs;
    report = parseReport(stdout);
  }, 180_000);

  test("gate passes with go verdict", () => {
    expect(report.gate).toBe("first-recall-v2");
    expect(report.verdict).toBe("go");
    expect(report.cleanup.verified).toBe(true);
  });

  test("all stages pass", () => {
    const requiredStages = ["init", "doctor", "mcp-config", "skill-pack", "ingest", "query", "migration", "artifacts"];
    const stageIds = report.stages.map((s) => s.id);
    for (const id of requiredStages) {
      expect(stageIds).toContain(id);
    }
    for (const stage of report.stages) {
      expect(stage.passed).toBe(true);
      expect(stage.assertions.length).toBeGreaterThan(0);
      // Every assertion must pass
      for (const a of stage.assertions) {
        expect(a.passed).toBe(true);
      }
    }
  });

  test("report has correct schema", () => {
    expect(typeof report.version).toBe("string");
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof report.timestamp).toBe("string");
    expect(typeof report.duration_ms).toBe("number");
    expect(report.duration_ms).toBeGreaterThan(0);

    for (const stage of report.stages) {
      expect(typeof stage.id).toBe("string");
      expect(typeof stage.command).toBe("string");
      expect(typeof stage.exitCode).toBe("number");
      expect(typeof stage.duration_ms).toBe("number");
      expect(typeof stage.passed).toBe("boolean");
      expect(Array.isArray(stage.assertions)).toBe(true);
      for (const a of stage.assertions) {
        expect(typeof a.check).toBe("string");
        expect(typeof a.passed).toBe("boolean");
        expect(typeof a.actual).toBe("string");
        expect(typeof a.expected).toBe("string");
      }
    }
  });

  test("report contains no real paths or credentials", () => {
    expect(stdout).not.toContain("/Users/");
    expect(stdout).not.toContain("Projects/cbrain");
    expect(stdout).not.toMatch(/sk-[a-f0-9]{8,}/i);
    expect(stdout).not.toMatch(/"(0\.\d{4},){10}/);
  });

  test("wall-clock duration matches report (catches timer leaks)", () => {
    // Regression: report.duration_ms must be within 2x of real wall-clock time.
    // If a timer leaks, the subprocess stays alive much longer than reported.
    const reportedMs = report.duration_ms;
    const tolerance = Math.max(reportedMs * 2, 5000); // at least 5s slack for startup
    expect(wallMs).toBeLessThan(reportedMs + tolerance);
    // Wall clock should also be reasonable overall
    expect(wallMs).toBeLessThan(60_000); // 60s generous upper bound
  });

  test("checkout state unchanged after gate", () => {
    const version = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
    // No tarball artifacts in checkout
    expect(existsSync(join(PROJECT_DIR, `cbrain-${version}.tgz`))).toBe(false);
    expect(existsSync(join(PROJECT_DIR, `cbrain-${version}.tgz.gate-backup`))).toBe(false);
    // node_modules still intact
    expect(existsSync(join(PROJECT_DIR, "node_modules"))).toBe(true);
  });
});

// ── Gate fault injection via real subprocess ──
// Each test sets GATE_FAULT_* env vars and runs the real gate,
// asserting that it produces no-go with the expected stage failure.

describe("gate fault injection (real subprocess)", () => {
  const tmpRoot = "/tmp/cbrain-gate-fault";

  function cleanup(): void {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  }

  beforeEach(cleanup);
  afterEach(cleanup);

  test("GATE_FAULT_PROVIDER → ingest fails → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_PROVIDER: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Ingest or query stage must have failed
    const ingestStage = report.stages.find((s) => s.id === "ingest");
    const queryStage = report.stages.find((s) => s.id === "query");
    const failedStage = ingestStage?.passed === false ? ingestStage : queryStage;
    expect(failedStage).toBeDefined();
    expect(failedStage!.passed).toBe(false);
  }, 180_000);

  test("GATE_FAULT_SKIP_INGEST → empty brain query → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_SKIP_INGEST: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Query stage must have failed (no content to recall)
    const queryStage = report.stages.find((s) => s.id === "query");
    expect(queryStage).toBeDefined();
    expect(queryStage!.passed).toBe(false);
  }, 180_000);

  test("GATE_FAULT_SKILL → skill-pack fails → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_SKILL: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // skill-pack stage must have failed
    const skillStage = report.stages.find((s) => s.id === "skill-pack");
    expect(skillStage).toBeDefined();
    expect(skillStage!.passed).toBe(false);
  }, 180_000);

  test("GATE_FAULT_INIT → init fails → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_INIT: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Init stage must have failed
    const initStage = report.stages.find((s) => s.id === "init");
    expect(initStage).toBeDefined();
    expect(initStage!.passed).toBe(false);
    // No subsequent stages should have run (init is gate for later stages)
    const postInitStages = report.stages.filter(
      (s) => ["doctor", "mcp-config", "ingest", "query"].includes(s.id),
    );
    expect(postInitStages.length).toBe(0);
  }, 180_000);

  test("GATE_FAULT_VAULT_NESTED → artifacts stage fails → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_VAULT_NESTED: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Artifacts stage must detect runtime inside vault
    const artifactsStage = report.stages.find((s) => s.id === "artifacts");
    expect(artifactsStage).toBeDefined();
    expect(artifactsStage!.passed).toBe(false);
    const runtimeAssertion = artifactsStage!.assertions.find((a) => a.check.includes("runtime"));
    expect(runtimeAssertion).toBeDefined();
    expect(runtimeAssertion!.passed).toBe(false);
  }, 180_000);

  test("GATE_FAULT_MIGRATION_CORRUPT → migration fails → no-go", () => {
    const { stdout } = runGate({ GATE_FAULT_MIGRATION_CORRUPT: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Migration stage must fail — integrity checks catch corrupted DB
    const migrationStage = report.stages.find((s) => s.id === "migration");
    expect(migrationStage).toBeDefined();
    expect(migrationStage!.passed).toBe(false);
    // Must detect integrity failure
    const integrityAssertion = migrationStage!.assertions.find((a) =>
      a.check.includes("integrity_check"),
    );
    expect(integrityAssertion).toBeDefined();
    expect(integrityAssertion!.passed).toBe(false);
  }, 180_000);

  test("GATE_FAULT_MCP_CRED_LEAK → privacy catches credential → no-go, output redacted", () => {
    const { stdout } = runGate({ GATE_FAULT_MCP_CRED_LEAK: "1" });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("no-go");
    expect(report.cleanup.verified).toBe(true);

    // Privacy stage must exist and have detected the credential leak
    const privacyStage = report.stages.find((s) => s.id === "privacy");
    expect(privacyStage).toBeDefined();
    expect(privacyStage!.passed).toBe(false);
    const credAssertion = privacyStage!.assertions.find((a) =>
      a.check.includes("credential"),
    );
    expect(credAssertion).toBeDefined();
    expect(credAssertion!.passed).toBe(false);

    // CRITICAL: output must NOT contain the injected credential — only <REDACTED>
    expect(stdout).not.toContain("sk-abcdef1234567890abcdef1234567890");
    expect(stdout).toContain("<REDACTED>");
  }, 180_000);
});

// ── Regression: same-version tarball + pack failure (shadow project, no checkout mutation) ──

describe("gate regression: tarball and cleanup (shadow project)", () => {
  test("same-version pre-existing tarball is preserved after gate run", () => {
    const version = JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf-8")).version;
    const tarballName = `cbrain-${version}.tgz`;
    const shadow = createShadowProject(true); // creates sentinel tarball
    const sentinelPath = join(shadow, tarballName);
    const sentinel = readFileSync(sentinelPath, "utf-8");

    try {
      const { stdout } = runGate({ GATE_PROJECT_DIR: shadow });
      const report = parseReport(stdout);
      expect(report.verdict).toBe("go");
      expect(report.cleanup.verified).toBe(true);

      // Sentinel tarball must be restored with original content
      expect(existsSync(sentinelPath)).toBe(true);
      expect(readFileSync(sentinelPath, "utf-8")).toBe(sentinel);
    } finally {
      rmSync(shadow, { recursive: true, force: true });
    }
  }, 180_000);

  test("pack failure (no node_modules) cleans up isolation dir", () => {
    // Shadow project WITHOUT node_modules → pack fails fast
    const shadow = mkdtempSync(join(tmpdir(), "cbrain-shadow-"));
    copyFileSync(join(PROJECT_DIR, "package.json"), join(shadow, "package.json"));
    // Deliberately NO node_modules symlink

    try {
      const { stdout } = runGate({ GATE_PROJECT_DIR: shadow });
      const report = parseReport(stdout);

      // Gate must report no-go (pack failure)
      expect(report.verdict).toBe("no-go");
      // Cleanup must succeed
      expect(report.cleanup.verified).toBe(true);
      // Must have a fatal stage (pack threw)
      const fatalStage = report.stages.find((s) => s.id === "fatal");
      expect(fatalStage).toBeDefined();
      expect(fatalStage!.passed).toBe(false);
    } finally {
      rmSync(shadow, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── Regression: offline proof — gate must pass with blocked registry ──

describe("gate regression: offline with blocked registry", () => {
  test("gate passes with unreachable registry (no network needed)", () => {
    // Block registry + clear any cache overrides — gate must still work
    // because it only uses checkout node_modules via symlink
    const { stdout } = runGate({
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:1",
    });
    const report = parseReport(stdout);

    expect(report.verdict).toBe("go");
    expect(report.cleanup.verified).toBe(true);
    for (const stage of report.stages) {
      expect(stage.passed).toBe(true);
    }
  }, 180_000);
});

// ── Regression: pre-isolation fatal error sanitization ──

describe("gate regression: pre-isolation fatal error sanitization", () => {
  test("fatal error report contains no real paths or stack traces", () => {
    // Use a non-existent GATE_PROJECT_DIR to trigger a fatal error
    // before isolation is set up (outer .catch path)
    const fakePrivatePath = "/Users/private-user/secret-project";
    const { stdout } = runGate({ GATE_PROJECT_DIR: fakePrivatePath });

    // Must be no-go or error
    expect(stdout).toContain("no-go");

    // CRITICAL: output must NOT leak real paths or credential patterns
    // (The fake path itself is a test probe — gate must sanitize it)
    // The outer catch sanitizes HOME-based paths, so check for no raw /Users/ in report body
    expect(stdout).not.toContain("secret-project");
    expect(stdout).not.toMatch(/sk-[a-f0-9]{8,}/i);
    // No stack traces (multi-line error details)
    expect(stdout).not.toContain("at ");
    expect(stdout).not.toContain("Error:");
  }, 30_000);
});
