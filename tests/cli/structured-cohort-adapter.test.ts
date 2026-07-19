import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionRollbackDeps } from "../../src/cli/commands/structured-cohort.js";
import {
  COHORT_ID,
  ROLLBACK_COMMAND_ID,
  STRUCTURED_COHORT_LABEL,
  deploymentDigest,
} from "../../src/core/release/structured-cohort-rollback.js";

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cbrain-cohort-rollback-"));
  roots.add(root);
  const home = join(root, "home");
  const runtimePath = join(root, "runtime");
  const rollout = join(runtimePath, "rollout");
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(rollout, { recursive: true });
  mkdirSync(agents, { recursive: true });
  const args = ["/fixture/bin/cbrain-serve-http.sh", "serve", "--http", "--port", "3401"];
  const plistPath = join(agents, "ai.cbrain.structured-cohort-v1.plist");
  writeFileSync(plistPath, JSON.stringify({
    Label: STRUCTURED_COHORT_LABEL,
    ProgramArguments: args,
    EnvironmentVariables: { CBRAIN_OUTPUT_BOUNDARY: "structured", UNRELATED: "preserve" },
  }));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
  chmodSync(plistPath, 0o600);
  const receiptPath = join(rollout, "structured-cohort-v1.json");
  writeFileSync(receiptPath, JSON.stringify({
    schema_version: 1,
    command_id: ROLLBACK_COMMAND_ID,
    cohort_id: COHORT_ID,
    health_port: 3401,
    deployment_digest: deploymentDigest({ label: STRUCTURED_COHORT_LABEL, programArguments: args, healthPort: 3401 }),
  }));
  chmodSync(receiptPath, 0o600);
  return { home, runtimePath, plistPath, receiptPath };
}

describe("structured cohort production adapter", () => {
  test("atomically changes only the fixed plist mode and preserves unrelated fields", () => {
    const f = fixture();
    const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath });
    const release = deps.acquireLock();
    expect(release).toBeFunction();
    expect(deps.loadTarget().mode).toBe("structured");
    deps.writeLegacy();
    release?.();

    const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.plistPath], { encoding: "utf8" });
    const plist = JSON.parse(json);
    expect(plist.EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY).toBe("legacy");
    expect(plist.EnvironmentVariables.UNRELATED).toBe("preserve");
    expect(plist.Label).toBe(STRUCTURED_COHORT_LABEL);
  });

  test("rejects permissive or symlinked receipts before target loading", () => {
    for (const mutation of ["permissions", "symlink"] as const) {
      const f = fixture();
      if (mutation === "permissions") chmodSync(f.receiptPath, 0o644);
      if (mutation === "symlink") {
        const bytes = readFileSync(f.receiptPath);
        rmSync(f.receiptPath);
        const source = `${f.receiptPath}.source`;
        writeFileSync(source, bytes);
        symlinkSync(source, f.receiptPath);
      }
      const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath });
      const release = deps.acquireLock();
      expect(() => deps.loadTarget()).toThrow();
      release?.();
    }
  });
});
