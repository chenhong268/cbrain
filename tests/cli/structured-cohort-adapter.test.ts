import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  linkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createProductionRollbackDeps } from "../../src/cli/commands/structured-cohort.js";
import { performInit } from "../../src/cli/commands/brain.js";
import {
  COHORT_ID,
  ROLLBACK_COMMAND_ID,
  STRUCTURED_COHORT_LABEL,
  deploymentDigest,
  rollbackStructuredCohort,
} from "../../src/core/release/structured-cohort-rollback.js";

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cbrain-cohort-rollback-")));
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
  const configIdentity = "c".repeat(64);
  const configPath = join(root, "active-cbrain.json");
  // `cbrain init` historically creates 0644 configs; rollback must accept the
  // supported owned/non-writable profile shape without changing live mode.
  const configBytes = Buffer.from("{}");
  writeFileSync(configPath, configBytes, { mode: 0o644 });
  const configAttestation = createHmac("sha256", configIdentity).update(configBytes).digest("hex");
  const plistPath = join(agents, "ai.cbrain.structured-cohort-v1.plist");
  writeFileSync(plistPath, JSON.stringify({
    Label: STRUCTURED_COHORT_LABEL,
    ProgramArguments: args,
    EnvironmentVariables: {
      CBRAIN_OUTPUT_BOUNDARY: "structured",
      CBRAIN_CONFIG: configPath,
      CBRAIN_ROLLOUT_COHORT_ID: COHORT_ID,
      CBRAIN_ROLLOUT_CONFIG_IDENTITY: configIdentity,
      CBRAIN_ROLLOUT_DEPLOYMENT_DIGEST: digest,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    ThrottleInterval: 10,
  }));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
  chmodSync(plistPath, 0o600);
  const receiptPath = join(rollout, "structured-cohort-v1.json");
  writeFileSync(receiptPath, JSON.stringify({
    schema_version: 1,
    command_id: ROLLBACK_COMMAND_ID,
    cohort_id: COHORT_ID,
    config_identity: configIdentity,
    config_attestation: configAttestation,
    health_port: 3401,
    deployment_digest: digest,
  }));
  chmodSync(receiptPath, 0o600);
  return { home, runtimePath, plistPath, receiptPath, scriptPath, configPath, root, digest };
}

const describeDarwin = process.platform === "darwin" ? describe : describe.skip;

describeDarwin("structured cohort production adapter", () => {
  test("atomically changes only the fixed plist mode and preserves unrelated fields", () => {
    const f = fixture();
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
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
      const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath, expectedScriptPath: f.scriptPath, activeConfigPath: f.configPath });
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
    let deps = createProductionRollbackDeps({ home: duplicate.home, runtimePath: duplicate.runtimePath, expectedScriptPath: duplicate.scriptPath, activeConfigPath: duplicate.configPath });
    let release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const drift = fixture();
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", drift.plistPath], { encoding: "utf8" }));
    plist.ProgramArguments[plist.ProgramArguments.length - 1] = "9999";
    writeFileSync(drift.plistPath, JSON.stringify(plist));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", drift.plistPath]);
    chmodSync(drift.plistPath, 0o600);
    deps = createProductionRollbackDeps({ home: drift.home, runtimePath: drift.runtimePath, expectedScriptPath: drift.scriptPath, activeConfigPath: drift.configPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();
  });

  test("rejects backup links, hardlinked inputs, and symlinked managed directories without touching unrelated files", () => {
    const backup = fixture();
    const victim = join(backup.root, "victim");
    writeFileSync(victim, "unrelated", { mode: 0o644 });
    symlinkSync(victim, join(backup.runtimePath, "rollout", "structured-cohort-v1.pre-rollback.plist"));
    let deps = createProductionRollbackDeps({ home: backup.home, runtimePath: backup.runtimePath, expectedScriptPath: backup.scriptPath, activeConfigPath: backup.configPath });
    let release = deps.acquireLock();
    deps.loadTarget();
    expect(() => deps.writeLegacy()).toThrow();
    release?.();
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(readFileSync(victim, "utf8")).toBe("unrelated");

    const hardlink = fixture();
    linkSync(hardlink.receiptPath, `${hardlink.receiptPath}.alias`);
    deps = createProductionRollbackDeps({ home: hardlink.home, runtimePath: hardlink.runtimePath, expectedScriptPath: hardlink.scriptPath, activeConfigPath: hardlink.configPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const linkedParent = fixture();
    const realAgents = join(linkedParent.root, "other-agents");
    mkdirSync(realAgents);
    rmSync(join(linkedParent.home, "Library", "LaunchAgents"), { recursive: true });
    symlinkSync(realAgents, join(linkedParent.home, "Library", "LaunchAgents"));
    deps = createProductionRollbackDeps({ home: linkedParent.home, runtimePath: linkedParent.runtimePath, expectedScriptPath: linkedParent.scriptPath, activeConfigPath: linkedParent.configPath });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();
  });

  test("uses a crash-safe kernel lock with deterministic contention and reuse", () => {
    const f = fixture();
    const lockPath = join(f.runtimePath, "rollout", ".structured-cohort-rollback.lock");
    const first = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
    });
    const second = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
    });
    const releaseFirst = first.acquireLock();
    expect(releaseFirst).toBeFunction();
    expect(second.acquireLock()).toBeNull();
    releaseFirst?.();
    const releaseSecond = second.acquireLock();
    expect(releaseSecond).toBeFunction();
    releaseSecond?.();
    expect(statSync(lockPath).isFile()).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
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
      activeConfigPath: f.configPath,
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
      activeConfigPath: deniedFixture.configPath,
      launchctl: () => ({ status: 77, stdout: "" }),
    });
    const deniedRelease = denied.acquireLock();
    denied.loadTarget();
    denied.writeLegacy();
    expect(denied.restart()).rejects.toThrow();
    deniedRelease?.();
  });

  test("polls the named job after bootstrap until launchd publishes its pid", async () => {
    const f = fixture();
    let postBootstrapPrints = 0;
    let bootstrapped = false;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      launchctl: (args) => {
        if (args[0] === "print" && !bootstrapped) return { status: 113, stdout: "" };
        if (args[0] === "bootstrap") {
          bootstrapped = true;
          return { status: 0, stdout: "" };
        }
        postBootstrapPrints += 1;
        return postBootstrapPrints < 3
          ? { status: 113, stdout: "" }
          : { status: 0, stdout: "\tpid = 9123\n" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    expect(await deps.restart()).toBe(9123);
    expect(postBootstrapPrints).toBe(3);
    release?.();
  });

  test("stops the exact named job when bootstrap succeeds but pid publication never verifies", async () => {
    const f = fixture();
    const uid = process.getuid?.() as number;
    const service = `gui/${uid}/${STRUCTURED_COHORT_LABEL}`;
    const domain = `gui/${uid}`;
    const calls: string[][] = [];
    let loaded = true;
    let bootstrapped = false;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      launchctl: (args) => {
        calls.push([...args]);
        if (args[0] === "print" && args[1] === service) {
          if (!loaded) return { status: 113, stdout: "" };
          return bootstrapped ? { status: 0, stdout: "state = running\n" } : { status: 0, stdout: "\tpid = 7001\n" };
        }
        if (args[0] === "bootout" && args[1] === service) {
          loaded = false;
          return { status: 0, stdout: "" };
        }
        if (args[0] === "bootstrap" && args[1] === domain && args[2] === f.plistPath) {
          loaded = true;
          bootstrapped = true;
          return { status: 0, stdout: "" };
        }
        return { status: 64, stdout: "" };
      },
    });
    expect(await rollbackStructuredCohort(deps)).toEqual({
      schema_version: 1,
      status: "failed",
      code: "RESTART_FAILED",
    });
    expect(loaded).toBe(false);
    expect(calls.slice(-3)).toEqual([
      ["print", service],
      ["bootout", service],
      ["print", service],
    ]);
    expect(calls.some((call) => call.join(" ").includes("unrelated"))).toBe(false);
  });

  test("stops the exact named job even when managed inputs drift after bootstrap", async () => {
    const f = fixture();
    const uid = process.getuid?.() as number;
    const service = `gui/${uid}/${STRUCTURED_COHORT_LABEL}`;
    const calls: string[][] = [];
    let loaded = true;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      launchctl: (args) => {
        calls.push([...args]);
        if (args[0] === "print" && args[1] === service) {
          return loaded ? { status: 0, stdout: "\tpid = 7002\n" } : { status: 113, stdout: "" };
        }
        if (args[0] === "bootout" && args[1] === service) {
          loaded = false;
          return { status: 0, stdout: "" };
        }
        return { status: 64, stdout: "" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    writeFileSync(f.configPath, '{"profile":"drifted"}', { mode: 0o644 });
    await expect(deps.stop()).resolves.toBeUndefined();
    expect(loaded).toBe(false);
    expect(calls).toEqual([
      ["print", service],
      ["bootout", service],
      ["print", service],
    ]);
    release?.();
  });

  test("cleans up the bootstrapped job after health-time config or plist drift", async () => {
    for (const mutation of ["config", "plist"] as const) {
      const f = fixture();
      const uid = process.getuid?.() as number;
      const service = `gui/${uid}/${STRUCTURED_COHORT_LABEL}`;
      const domain = `gui/${uid}`;
      const originalStructuredPlist = readFileSync(f.plistPath);
      const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
      const calls: string[][] = [];
      let loaded = true;
      let servicePid = 7001;
      const deps = createProductionRollbackDeps({
        home: f.home,
        runtimePath: f.runtimePath,
        expectedScriptPath: f.scriptPath,
        activeConfigPath: f.configPath,
        launchctl: (args) => {
          calls.push([...args]);
          if (args[0] === "print" && args[1] === service) {
            return loaded ? { status: 0, stdout: `\tpid = ${servicePid}\n` } : { status: 113, stdout: "" };
          }
          if (args[0] === "bootout" && args[1] === service) {
            loaded = false;
            return { status: 0, stdout: "" };
          }
          if (args[0] === "bootstrap" && args[1] === domain && args[2] === f.plistPath) {
            loaded = true;
            servicePid = 7002;
            return { status: 0, stdout: "" };
          }
          return { status: 64, stdout: "" };
        },
        healthRequest: async () => {
          if (mutation === "config") writeFileSync(f.configPath, '{"profile":"drifted"}', { mode: 0o644 });
          else {
            writeFileSync(f.plistPath, originalStructuredPlist, { mode: 0o600 });
            chmodSync(f.plistPath, 0o600);
          }
          return {
            status: 200,
            redirected: false,
            body: JSON.stringify({
              ok: true,
              output_boundary: "legacy",
              cohort_id: COHORT_ID,
              config_attestation: receipt.config_attestation,
              deployment_digest: f.digest,
              process_id: servicePid,
            }),
          };
        },
      });
      expect(await rollbackStructuredCohort(deps)).toEqual({
        schema_version: 1,
        status: "failed",
        code: "HEALTH_NOT_VERIFIED",
      });
      expect(loaded).toBe(false);
      expect(calls.slice(-3)).toEqual([
        ["print", service],
        ["bootout", service],
        ["print", service],
      ]);
      expect(calls.every((call) => call[1] === service || call[1] === domain)).toBe(true);
    }
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
      const deps = createProductionRollbackDeps({ home: f.home, runtimePath: f.runtimePath, expectedScriptPath: f.scriptPath, activeConfigPath: f.configPath });
      const release = deps.acquireLock();
      expect(() => deps.loadTarget()).toThrow();
      release?.();
    }
  });

  test("rejects profile drift, duplicate plist keys, and canonical-path aliases", () => {
    const profile = fixture();
    const otherConfig = join(profile.root, "other-cbrain.json");
    writeFileSync(otherConfig, "{}", { mode: 0o600 });
    let deps = createProductionRollbackDeps({
      home: profile.home,
      runtimePath: profile.runtimePath,
      expectedScriptPath: profile.scriptPath,
      activeConfigPath: otherConfig,
    });
    let release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const unsafeConfig = fixture();
    chmodSync(unsafeConfig.configPath, 0o666);
    deps = createProductionRollbackDeps({
      home: unsafeConfig.home,
      runtimePath: unsafeConfig.runtimePath,
      expectedScriptPath: unsafeConfig.scriptPath,
      activeConfigPath: unsafeConfig.configPath,
    });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const duplicate = fixture();
    const xml = readFileSync(duplicate.plistPath, "utf8");
    writeFileSync(duplicate.plistPath, xml.replace("</dict>", "<key>CBRAIN_OUTPUT_BOUNDARY</key><string>legacy</string></dict>"));
    chmodSync(duplicate.plistPath, 0o600);
    deps = createProductionRollbackDeps({
      home: duplicate.home,
      runtimePath: duplicate.runtimePath,
      expectedScriptPath: duplicate.scriptPath,
      activeConfigPath: duplicate.configPath,
    });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const cdata = fixture();
    const cdataXml = readFileSync(cdata.plistPath, "utf8");
    writeFileSync(cdata.plistPath, cdataXml.replace("</dict>", "<key><![CDATA[CBRAIN_OUTPUT_BOUNDARY]]></key><string>legacy</string></dict>"));
    chmodSync(cdata.plistPath, 0o600);
    deps = createProductionRollbackDeps({
      home: cdata.home,
      runtimePath: cdata.runtimePath,
      expectedScriptPath: cdata.scriptPath,
      activeConfigPath: cdata.configPath,
    });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const whitespaceKey = fixture();
    const whitespaceKeyXml = readFileSync(whitespaceKey.plistPath, "utf8");
    const outerDictEnd = whitespaceKeyXml.lastIndexOf("</dict>");
    writeFileSync(
      whitespaceKey.plistPath,
      `${whitespaceKeyXml.slice(0, outerDictEnd)}<key >Label</key>` +
        `<string>${STRUCTURED_COHORT_LABEL}</string>${whitespaceKeyXml.slice(outerDictEnd)}`,
    );
    chmodSync(whitespaceKey.plistPath, 0o600);
    deps = createProductionRollbackDeps({
      home: whitespaceKey.home,
      runtimePath: whitespaceKey.runtimePath,
      expectedScriptPath: whitespaceKey.scriptPath,
      activeConfigPath: whitespaceKey.configPath,
    });
    release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();

    const aliased = fixture();
    const aliasRoot = join(dirname(aliased.root), `${basename(aliased.root)}-alias`);
    symlinkSync(aliased.root, aliasRoot);
    roots.add(aliasRoot);
    deps = createProductionRollbackDeps({
      home: join(aliasRoot, "home"),
      runtimePath: join(aliasRoot, "runtime"),
      expectedScriptPath: aliased.scriptPath,
      activeConfigPath: aliased.configPath,
    });
    expect(deps.acquireLock()).toBeNull();
  });

  test("accepts the owned non-writable config shape produced by cbrain init", () => {
    const f = fixture();
    const initialized = performInit(join(f.root, "initialized-profile"), false);
    expect(initialized.status).toBe("ok");
    const configPath = realpathSync(initialized.configPath);
    expect(statSync(configPath).mode & 0o022).toBe(0);
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.plistPath], { encoding: "utf8" }));
    plist.EnvironmentVariables.CBRAIN_CONFIG = configPath;
    writeFileSync(f.plistPath, JSON.stringify(plist));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", f.plistPath]);
    chmodSync(f.plistPath, 0o600);
    const receipt = JSON.parse(readFileSync(f.receiptPath, "utf8"));
    receipt.config_attestation = createHmac("sha256", receipt.config_identity)
      .update(readFileSync(configPath)).digest("hex");
    writeFileSync(f.receiptPath, JSON.stringify(receipt));
    chmodSync(f.receiptPath, 0o600);
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: configPath,
    });
    const release = deps.acquireLock();
    expect(deps.loadTarget().mode).toBe("structured");
    release?.();
  });

  test("bounds health by bytes and rejects redirects", async () => {
    for (const response of [
      { status: 200, redirected: false, body: JSON.stringify({ ok: true, padding: "界".repeat(2000) }) },
      { status: 200, redirected: true, body: "{}" },
    ]) {
      const f = fixture();
      const deps = createProductionRollbackDeps({
        home: f.home,
        runtimePath: f.runtimePath,
        expectedScriptPath: f.scriptPath,
        activeConfigPath: f.configPath,
        healthRequest: async () => response,
      });
      const release = deps.acquireLock();
      deps.loadTarget();
      deps.writeLegacy();
      expect(await deps.readHealth()).toEqual({ ok: false });
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
      activeConfigPath: f.configPath,
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

  test("rejects active config byte drift before restart and health", async () => {
    const f = fixture();
    let launchctlCalled = false;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      launchctl: () => {
        launchctlCalled = true;
        return { status: 0, stdout: "\tpid = 1\n" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    writeFileSync(f.configPath, '{"profile":"changed"}', { mode: 0o644 });
    expect(deps.restart()).rejects.toThrow();
    expect(deps.readHealth()).rejects.toThrow();
    expect(launchctlCalled).toBe(false);
    release?.();
  });

  test("rejects active config byte drift that predates target loading", () => {
    const f = fixture();
    writeFileSync(f.configPath, '{"profile":"replacement"}', { mode: 0o644 });
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
    });
    const release = deps.acquireLock();
    expect(() => deps.loadTarget()).toThrow();
    release?.();
  });

  test("revalidates active config after the health request resolves", async () => {
    const f = fixture();
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      healthRequest: async () => {
        writeFileSync(f.configPath, '{"profile":"during-health"}', { mode: 0o644 });
        return { status: 200, redirected: false, body: JSON.stringify({ ok: true }) };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    expect(deps.readHealth()).rejects.toThrow();
    release?.();
  });

  test("revalidates the approved legacy plist after the health request resolves", async () => {
    const f = fixture();
    const originalStructuredPlist = readFileSync(f.plistPath);
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      healthRequest: async () => {
        writeFileSync(f.plistPath, originalStructuredPlist, { mode: 0o600 });
        chmodSync(f.plistPath, 0o600);
        return { status: 200, redirected: false, body: JSON.stringify({ ok: true }) };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    expect(deps.readHealth()).rejects.toThrow();
    release?.();
  });

  test("revalidates again after print and bootout immediately before bootstrap", async () => {
    const f = fixture();
    let bootstrapCalled = false;
    let first = true;
    const deps = createProductionRollbackDeps({
      home: f.home,
      runtimePath: f.runtimePath,
      expectedScriptPath: f.scriptPath,
      activeConfigPath: f.configPath,
      launchctl: (args) => {
        if (args[0] === "print" && first) {
          first = false;
          const semanticallyEquivalent = readFileSync(f.plistPath, "utf8").replace("</plist>", "\n</plist>");
          writeFileSync(f.plistPath, semanticallyEquivalent);
          chmodSync(f.plistPath, 0o600);
          return { status: 0, stdout: "\tpid = 7001\n" };
        }
        if (args[0] === "bootout") return { status: 0, stdout: "" };
        if (args[0] === "bootstrap") bootstrapCalled = true;
        return { status: 0, stdout: "\tpid = 7002\n" };
      },
    });
    const release = deps.acquireLock();
    deps.loadTarget();
    deps.writeLegacy();
    expect(deps.restart()).rejects.toThrow();
    expect(bootstrapCalled).toBe(false);
    release?.();
  });
});
