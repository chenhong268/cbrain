import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  statSync,
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
  const scriptPath = join(root, "fixture", "bin", "cbrain-serve-http.sh");
  mkdirSync(join(root, "fixture", "bin"), { recursive: true });
  writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const args = [scriptPath, "serve", "--http", "--port", "3401"];
  const digest = deploymentDigest({ label: STRUCTURED_COHORT_LABEL, programArguments: args, healthPort: 3401 });
  const plistPath = join(agents, "ai.cbrain.structured-cohort-v1.plist");
  writeFileSync(plistPath, JSON.stringify({
    Label: STRUCTURED_COHORT_LABEL,
    ProgramArguments: args,
    EnvironmentVariables: {
      CBRAIN_OUTPUT_BOUNDARY: "structured",
      CBRAIN_ROLLOUT_COHORT_ID: COHORT_ID,
      CBRAIN_ROLLOUT_DEPLOYMENT_DIGEST: digest,
    },
    ProcessType: "Background",
  }));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
  chmodSync(plistPath, 0o600);
  const receiptPath = join(rollout, "structured-cohort-v1.json");
  writeFileSync(receiptPath, JSON.stringify({
    schema_version: 1,
    command_id: ROLLBACK_COMMAND_ID,
    cohort_id: COHORT_ID,
    health_port: 3401,
    deployment_digest: digest,
  }));
  chmodSync(receiptPath, 0o600);
  return { home, runtimePath, plistPath, receiptPath, scriptPath, root, digest };
}

describe("structured cohort production adapter", () => {
  test("atomically changes only the fixed plist mode and preserves unrelated fields", () => {
    const f = fixture();
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
    });
    const release = deps.acquireLock();
    expect(release).toBeFunction();
    expect(deps.loadTarget().mode).toBe("structured");
    deps.writeLegacy();
    release?.();

    const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.plistPath], { encoding: "utf8" });
    const plist = JSON.parse(json);
    expect(plist.EnvironmentVariables.CBRAIN_OUTPUT_BOUNDARY).toBe("legacy");
    expect(plist.ProcessType).toBe("Background");
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
      const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath, expectedScriptPath: f.scriptPath });
      const release = deps.acquireLock();
      expect(() => deps.loadTarget()).toThrow();
      release?.();
    }
  });

  test("rejects semantic duplicate receipt keys and port drift", () => {
    const duplicate = fixture();
    const original = JSON.parse(readFileSync(duplicate.receiptPath, "utf8"));
    writeFileSync(duplicate.receiptPath, JSON.stringify(original).replace('"health_port":3401', '"health_port":3401,"health_\\u0070ort":3401'));
    chmodSync(duplicate.receiptPath, 0o600);
    let deps = createProductionRollbackDeps({ home: duplicate.home, runtimePath: duplicate.runtimePath, expectedScriptPath: duplicate.scriptPath });
    let release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const drift = fixture();
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", drift.plistPath], { encoding: "utf8" }));
    plist.ProgramArguments[plist.ProgramArguments.length - 1] = "9999";
    writeFileSync(drift.plistPath, JSON.stringify(plist));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", drift.plistPath]);
    chmodSync(drift.plistPath, 0o600);
    deps = createProductionRollbackDeps({ home: drift.home, runtimePath: drift.runtimePath, expectedScriptPath: drift.scriptPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();
  });

  test("rejects backup links, hardlinked inputs, and symlinked managed directories without touching unrelated files", () => {
    const backup = fixture();
    const victim = join(backup.root, "victim");
    writeFileSync(victim, "unrelated", { mode: 0o644 });
    symlinkSync(victim, join(backup.runtimePath, "rollout", "structured-cohort-v1.pre-rollback.plist"));
    let deps = createProductionRollbackDeps({ home: backup.home, runtimePath: backup.runtimePath, expectedScriptPath: backup.scriptPath });
    let release = deps.acquireLock();
    deps.loadTarget();
    expect(() => deps.writeLegacy()).toThrow();
    release?.();
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(readFileSync(victim, "utf8")).toBe("unrelated");

    const hardlink = fixture();
    linkSync(hardlink.receiptPath, `${hardlink.receiptPath}.alias`);
    deps = createProductionRollbackDeps({ home: hardlink.home, runtimePath: hardlink.runtimePath, expectedScriptPath: hardlink.scriptPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const linkedParent = fixture();
    const realAgents = join(linkedParent.root, "other-agents");
    mkdirSync(realAgents);
    rmSync(join(linkedParent.home, "Library", "LaunchAgents"), { recursive: true });
    symlinkSync(realAgents, join(linkedParent.home, "Library", "LaunchAgents"));
    deps = createProductionRollbackDeps({ home: linkedParent.home, runtimePath: linkedParent.runtimePath, expectedScriptPath: linkedParent.scriptPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();
  });

  test("reclaims a dead owner lock, preserves a live lock, and never unlinks a replaced lock", () => {
    const f = fixture();
    const lockPath = join(f.runtimePath, "rollout", ".structured-cohort-rollback.lock");
    symlinkSync(`v1:999999:${"a".repeat(64)}`, lockPath);
    let deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      processIdentity: (pid) => pid === process.pid ? "current-birth" : null,
    });
    let release = deps.acquireLock();
    expect(release).toBeFunction();
    release?.();

    const liveIdentity = "other-live-birth";
    symlinkSync(`v1:7777:${createHash("sha256").update(liveIdentity).digest("hex")}`, lockPath);
    deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      processIdentity: (pid) => pid === process.pid ? "current-birth" : pid === 7777 ? liveIdentity : null,
    });
    expect(deps.acquireLock()).toBeNull();
    rmSync(lockPath);

    release = deps.acquireLock();
    expect(release).toBeFunction();
    rmSync(lockPath);
    symlinkSync("replacement", lockPath);
    expect(() => release?.()).toThrow();
    expect(readFileSync(f.receiptPath, "utf8")).toContain(ROLLBACK_COMMAND_ID);
  });

  test("accepts only expected launchctl not-loaded and exact named-job pid", async () => {
    const f = fixture();
    const uid = process.getuid?.() as number;
    const service = `gui/${uid}/${STRUCTURED_COHORT_LABEL}`;
    const domain = `gui/${uid}`;
    const calls: string[][] = [];
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      launchctl: (args) => {
        calls.push([...args]);
        if (args[0] === "print" && calls.length === 1) return { status: 113, stdout: "" };
        if (args[0] === "bootstrap") return { status: 0, stdout: "" };
        if (args[0] === "print") return { status: 0, stdout: "\tpid = 8123\n" };
        return { status: 99, stdout: "" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    expect(await deps.restart()).toBe(8123);
    expect(calls).toEqual([
      ["print", service],
      ["bootstrap", domain, f.plistPath],
      ["print", service],
    ]);
    release?.();

    const deniedFixture = fixture();
    const denied = createProductionRollbackDeps({
      home: deniedFixture.home,
      runtimePath: deniedFixture.runtimePath,
      expectedScriptPath: deniedFixture.scriptPath,
      launchctl: () => ({ status: 77, stdout: "" }),
    });
    const deniedRelease = denied.acquireLock();
    denied.loadTarget();
    denied.writeLegacy();
    expect(denied.restart()).rejects.toThrow();
    deniedRelease?.();
  });

  test("rejects non-canonical entrypoints, dangerous environment, and execution-affecting plist keys", () => {
    for (const mutation of ["entrypoint", "environment", "program"] as const) {
      const f = fixture();
      const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.plistPath], { encoding: "utf8" }));
      if (mutation === "entrypoint") {
        const attacker = join(f.root, "attacker", "bin", "cbrain-serve-http.sh");
        mkdirSync(join(f.root, "attacker", "bin"), { recursive: true });
        writeFileSync(attacker, "#!/bin/sh\n", { mode: 0o700 });
        plist.ProgramArguments[0] = attacker;
      }
      if (mutation === "environment") plist.EnvironmentVariables.BASH_ENV = join(f.root, "payload");
      if (mutation === "program") plist.Program = "/bin/sh";
      writeFileSync(f.plistPath, JSON.stringify(plist));
      execFileSync("/usr/bin/plutil", ["-convert", "xml1", f.plistPath]);
      chmodSync(f.plistPath, 0o600);
      const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath, expectedScriptPath: f.scriptPath });
      const release = deps.acquireLock();
      expect(() => deps.loadTarget()).toThrow();
      release?.();
    }
  });

  test("revalidates the exact plist after mutation before launchctl", async () => {
    const f = fixture();
    let launchctlCalled = false;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      launchctl: () => {
        launchctlCalled = true;
        return { status: 0, stdout: "\tpid = 1\n" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.plistPath], { encoding: "utf8" }));
    plist.Program = "/bin/sh";
    writeFileSync(f.plistPath, JSON.stringify(plist));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", f.plistPath]);
    chmodSync(f.plistPath, 0o600);
    expect(deps.restart()).rejects.toThrow();
    expect(launchctlCalled).toBe(false);
    release?.();
  });
});
