import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VERIFY_OPTIONS,
  verifyLiveRelease,
  type LiveReleaseDeps,
  type ProcessIdentity,
  type ServiceEvidence,
  type TargetResult,
} from "../../bin/lib/live-release-verify.js";
import { buildRealDeps } from "../../bin/lib/live-release-deps.js";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// ── Anonymous synthetic fixtures (no real paths, no credentials) ──

const ACTIVE_ROOT = "/anonymous/active-root";
const STALE_CWD = "/anonymous/stale-checkout";
const ROLLBACK_ROOT = "/anonymous/rollback-root";
const SERVICE_PID = 69967;
const SERVICE_LABEL = "ai.cbrain.serve";

const happyEvidence = (overrides: Partial<ServiceEvidence> = {}): ServiceEvidence => ({
  label: SERVICE_LABEL,
  pid: SERVICE_PID,
  program: "/anonymous/bun",
  programArguments: ["bun", "run", "src/cli/index.ts", "serve"],
  workingDirectory: ACTIVE_ROOT,
  lastExitStatus: null,
  ...overrides,
});

interface FakeShape {
  owners: readonly string[];
  evidenceByLabel: Record<string, ServiceEvidence>;
  identityByPid: Record<number, ProcessIdentity>;
  cwdByPid: Record<number, string | null>;
  listenerByPort: Record<number, { pid: number; count: number }>;
  callerCwd: string;
  healthByVersion: string | { code: "HTTP_UNAVAILABLE" | "HTTP_RESPONSE_INVALID" };
  packageByRoot: Record<string, string | "fail">;
  manifestByRoot: Record<string, { version: string; files: readonly string[] } | "fail">;
  targetByPath: Record<string, TargetResult["status"]>;
  ownVerifierPath: string;
  sequences?: {
    evidence?: ServiceEvidence[];
    identity?: (ProcessIdentity | null)[];
    cwd?: (string | null)[];
    listener?: { pid: number; count: number }[];
  };
}

const baseShape = (): FakeShape => ({
  owners: [SERVICE_LABEL],
  evidenceByLabel: { [SERVICE_LABEL]: happyEvidence() },
  identityByPid: { [SERVICE_PID]: { pid: SERVICE_PID, startUsec: "birth-stable-001" } },
  cwdByPid: { [SERVICE_PID]: ACTIVE_ROOT },
  listenerByPort: { 3399: { pid: SERVICE_PID, count: 1 } },
  callerCwd: STALE_CWD,
  healthByVersion: "2.0.8",
  packageByRoot: { [ACTIVE_ROOT]: "2.0.8" },
  manifestByRoot: {
    [ACTIVE_ROOT]: { version: "2.0.8", files: ["SKILL.md", "MANIFEST.json"] },
  },
  targetByPath: {},
  ownVerifierPath: `${ACTIVE_ROOT}/bin/lib/live-release-verify.ts`,
});

function fakeDeps(shape: FakeShape): LiveReleaseDeps {
  let ev = 0, id = 0, cwd = 0, lis = 0;
  return {
    ownVerifierPath: shape.ownVerifierPath,
    listCbrainServiceOwners: () => shape.owners,
    readServiceEvidence: (label) => shape.sequences?.evidence?.[ev++] ?? shape.evidenceByLabel[label],
    readProcessIdentity: (pid) => shape.sequences?.identity?.[id++] ?? shape.identityByPid[pid] ?? null,
    readProcessCwd: (pid) => shape.sequences?.cwd?.[cwd++] ?? shape.cwdByPid[pid] ?? null,
    readListenerOwner: (port) => shape.sequences?.listener?.[lis++] ?? shape.listenerByPort[port] ?? { pid: 0, count: 0 },
    readCallerCwd: () => shape.callerCwd,
    fetchHealthVersion: () =>
      typeof shape.healthByVersion === "string"
        ? { ok: true as const, version: shape.healthByVersion }
        : { ok: false as const, code: shape.healthByVersion.code },
    readPackageVersion: (root) => {
      const v = shape.packageByRoot[root];
      return v === undefined || v === "fail"
        ? { ok: false as const }
        : { ok: true as const, version: v };
    },
    readManifestVersion: (root) => {
      const m = shape.manifestByRoot[root];
      return m === undefined || m === "fail"
        ? { ok: false as const }
        : { ok: true as const, version: m.version, files: m.files };
    },
    verifySkillTarget: (_root, targetDir) => {
      const status = shape.targetByPath[targetDir] ?? "current";
      return { path: targetDir, status };
    },
  };
}

const HAPPY_TARGET = "/anonymous/hermes-skill-target";
const happyOpts = (overrides: Partial<Parameters<typeof verifyLiveRelease>[1]> = {}) => ({
  ...DEFAULT_VERIFY_OPTIONS,
  requiredTargets: [HAPPY_TARGET],
  ...overrides,
});

describe("live-release verifier — service & process evidence", () => {
  test("passes end-to-end when caller cwd is a stale checkout but active root is coherent", () => {
    const shape = baseShape();
    shape.callerCwd = STALE_CWD;
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.status).toBe("pass");
    expect(result.active?.version).toBe("2.0.8");
    expect(result.caller_cwd?.classification).toBe("inactive");
  });

  test("fails with SERVICE_NOT_FOUND when no cbrain service is loaded", () => {
    const shape = baseShape();
    shape.owners = [];
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.status).toBe("fail");
    expect(result.code).toBe("SERVICE_NOT_FOUND");
  });

  test("fails with MULTIPLE_SERVICE_OWNERS when more than one cbrain service is loaded", () => {
    const shape = baseShape();
    shape.owners = ["ai.cbrain.serve", "ai.cbrain.serve.secondary"];
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.status).toBe("fail");
    expect(result.code).toBe("MULTIPLE_SERVICE_OWNERS");
  });

  test("fails with LISTENER_COUNT_INVALID when the port has zero listeners", () => {
    const shape = baseShape();
    shape.listenerByPort = { 3399: { pid: SERVICE_PID, count: 0 } };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("LISTENER_COUNT_INVALID");
  });

  test("fails with LISTENER_COUNT_INVALID when the port has more than one listener", () => {
    const shape = baseShape();
    shape.listenerByPort = { 3399: { pid: SERVICE_PID, count: 2 } };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("LISTENER_COUNT_INVALID");
  });

  test("fails with LISTENER_OWNER_MISMATCH when listener PID differs from service PID", () => {
    const shape = baseShape();
    shape.listenerByPort = { 3399: { pid: 11111, count: 1 } };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("LISTENER_OWNER_MISMATCH");
  });

  test("fails with EXECUTABLE_ROOT_MISMATCH when process cwd differs from configured working directory", () => {
    const shape = baseShape();
    shape.cwdByPid = { [SERVICE_PID]: "/anonymous/different-cwd" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("EXECUTABLE_ROOT_MISMATCH");
  });

  test("fails with PROCESS_NOT_RUNNING when the service PID has exited", () => {
    const shape = baseShape();
    shape.identityByPid = {};
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("PROCESS_NOT_RUNNING");
  });

  test("fails with SERVICE_EVIDENCE_INVALID when working directory is empty", () => {
    const shape = baseShape();
    shape.evidenceByLabel = { [SERVICE_LABEL]: happyEvidence({ workingDirectory: "" }) };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("SERVICE_EVIDENCE_INVALID");
  });

  test("fails with SERVICE_EVIDENCE_INVALID when program is missing", () => {
    const shape = baseShape();
    shape.evidenceByLabel = { [SERVICE_LABEL]: happyEvidence({ program: "" }) };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("SERVICE_EVIDENCE_INVALID");
  });

  test("fails with PROCESS_GENERATION_CHANGED when birth identity drifts across all retries", () => {
    const shape = baseShape();
    shape.sequences = {
      identity: [
        { pid: SERVICE_PID, startUsec: "birth-A" },
        { pid: SERVICE_PID, startUsec: "birth-B" },
        { pid: SERVICE_PID, startUsec: "birth-C" },
      ],
    };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("PROCESS_GENERATION_CHANGED");
  });

  test("passes after one bounded retry when the second read re-stabilizes", () => {
    const shape = baseShape();
    shape.sequences = {
      identity: [
        { pid: SERVICE_PID, startUsec: "birth-A" },
        { pid: SERVICE_PID, startUsec: "birth-B" },
        { pid: SERVICE_PID, startUsec: "birth-B" },
      ],
    };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).status).toBe("pass");
  });

  test("re-anchors to the stable snapshot after drift, never the stale first generation", () => {
    const shape = baseShape();
    const ROOT_A = "/anonymous/root-a";
    const ROOT_B = "/anonymous/root-b";
    shape.sequences = {
      evidence: [
        happyEvidence({ workingDirectory: ROOT_A }),
        happyEvidence({ workingDirectory: ROOT_B }),
        happyEvidence({ workingDirectory: ROOT_B }),
      ],
      cwd: [ROOT_A, ROOT_B, ROOT_B],
      identity: [
        { pid: SERVICE_PID, startUsec: "birth-A" },
        { pid: SERVICE_PID, startUsec: "birth-B" },
        { pid: SERVICE_PID, startUsec: "birth-B" },
      ],
    };
    shape.healthByVersion = "2.0.9";
    shape.packageByRoot = { [ROOT_B]: "2.0.9" };
    shape.manifestByRoot = { [ROOT_B]: { version: "2.0.9", files: ["SKILL.md"] } };
    shape.ownVerifierPath = `${ROOT_B}/bin/lib/live-release-verify.ts`;
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.status).toBe("pass");
    expect(result.active?.root).toBe("root-b");
  });
});

describe("live-release verifier — version & target coherence", () => {
  test("fails with HTTP_UNAVAILABLE when the health endpoint times out or errors", () => {
    const shape = baseShape();
    shape.healthByVersion = { code: "HTTP_UNAVAILABLE" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("HTTP_UNAVAILABLE");
  });

  test("fails with HTTP_RESPONSE_INVALID when the health response lacks version", () => {
    const shape = baseShape();
    shape.healthByVersion = { code: "HTTP_RESPONSE_INVALID" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("HTTP_RESPONSE_INVALID");
  });

  test("fails with ACTIVE_PACKAGE_INVALID when package.json is missing or unreadable", () => {
    const shape = baseShape();
    shape.packageByRoot = { [ACTIVE_ROOT]: "fail" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("ACTIVE_PACKAGE_INVALID");
  });

  test("fails with ACTIVE_MANIFEST_INVALID when MANIFEST.json is missing or unreadable", () => {
    const shape = baseShape();
    shape.manifestByRoot = { [ACTIVE_ROOT]: "fail" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("ACTIVE_MANIFEST_INVALID");
  });

  test("fails with ACTIVE_VERSION_MISMATCH when http, package, and manifest disagree", () => {
    const shape = baseShape();
    shape.manifestByRoot = { [ACTIVE_ROOT]: { version: "2.0.7", files: ["SKILL.md"] } };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("ACTIVE_VERSION_MISMATCH");
  });

  test("fails with TARGET_SET_EMPTY when no required targets are configured", () => {
    const shape = baseShape();
    expect(verifyLiveRelease(fakeDeps(shape), { ...happyOpts(), requiredTargets: [] }).code).toBe("TARGET_SET_EMPTY");
  });

  test("fails with TARGET_VERIFICATION_FAILED when a required target is stale", () => {
    const shape = baseShape();
    shape.targetByPath = { [HAPPY_TARGET]: "stale" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("TARGET_VERIFICATION_FAILED");
  });

  test("fails with TARGET_VERIFICATION_FAILED when a required target is missing", () => {
    const shape = baseShape();
    shape.targetByPath = { [HAPPY_TARGET]: "missing" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("TARGET_VERIFICATION_FAILED");
  });

  test("fails with TARGET_VERIFICATION_FAILED when a required target is incompatible", () => {
    const shape = baseShape();
    shape.targetByPath = { [HAPPY_TARGET]: "incompatible" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("TARGET_VERIFICATION_FAILED");
  });

  test("fails with TARGET_VERIFICATION_FAILED when a required target is unverified", () => {
    const shape = baseShape();
    shape.targetByPath = { [HAPPY_TARGET]: "unverified" };
    expect(verifyLiveRelease(fakeDeps(shape), happyOpts()).code).toBe("TARGET_VERIFICATION_FAILED");
  });

  test("a rollback candidate with a different version never affects aggregate success", () => {
    const shape = baseShape();
    shape.packageByRoot = { [ACTIVE_ROOT]: "2.0.8", [ROLLBACK_ROOT]: "2.0.7" };
    const result = verifyLiveRelease(fakeDeps(shape), { ...happyOpts(), rollbackCandidate: ROLLBACK_ROOT });
    expect(result.status).toBe("pass");
    expect(result.rollback?.classification).toBe("inactive");
  });

  test("classifies caller cwd as active only when it equals the active root", () => {
    const shape = baseShape();
    shape.callerCwd = ACTIVE_ROOT;
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.status).toBe("pass");
    expect(result.caller_cwd?.classification).toBe("active");
  });

  test("emits all three matching versions and the active root marker on pass", () => {
    const shape = baseShape();
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    expect(result.versions).toEqual({ http: "2.0.8", package: "2.0.8", manifest: "2.0.8" });
    expect(result.active?.root).toBe("active-root");
    expect(result.active?.version).toBe("2.0.8");
  });
});

describe("live-release verifier — privacy & read-only source guarantees", () => {
  test("pass output exposes no absolute paths, credentials, or command text", () => {
    const shape = baseShape();
    shape.evidenceByLabel = {
      [SERVICE_LABEL]: happyEvidence({
        program: "/anonymous/secret-bun",
        programArguments: ["bun", "--token=sk-anonymous-secret", "serve"],
      }),
    };
    shape.callerCwd = "/anonymous/private-user-checkout";
    const result = verifyLiveRelease(
      fakeDeps(shape),
      happyOpts({ rollbackCandidate: "/anonymous/private-rollback" }),
    );
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("pass");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/anonymous/");
    expect(serialized).not.toContain("sk-anonymous-secret");
    expect(serialized).not.toContain("secret-bun");
    expect(serialized).not.toMatch(/Bearer\s|api[_-]?key/i);
  });

  test("fail output carries only the stable code and layer, no evidence fields", () => {
    const shape = baseShape();
    shape.listenerByPort = { 3399: { pid: 4242, count: 1 } };
    const result = verifyLiveRelease(fakeDeps(shape), happyOpts());
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("fail");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toMatch(/Bearer\s|api[_-]?key/i);
    expect(Object.keys(result).sort()).toEqual(["code", "layer", "schema_version", "status"]);
  });

  test("pure core source contains no write, mutate, or process-spawning APIs", () => {
    const src = readFileSync(join(import.meta.dir, "../../bin/lib/live-release-verify.ts"), "utf8");
    const banned = ["writeFileSync", "appendFileSync", "rmSync", "chmodSync", "mkdirSync", "spawnSync", "execSync", "Bun.spawn"];
    for (const token of banned) {
      expect(src, `source must not use ${token}`).not.toContain(token);
    }
  });
});

describe("live-release verifier — black-box read-only run", () => {
  function hashTree(root: string): string {
    const entries: string[] = [];
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isDirectory()) visit(p);
        else if (st.isFile()) {
          entries.push(`${relative(root, p)}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
        }
      }
    };
    visit(root);
    return createHash("sha256").update(entries.join("\n")).digest("hex");
  }

  test("running the real CLI leaves a fixture tree byte-identical and leaks no absolute paths", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cbrain-live-release-blackbox-"));
    try {
      mkdirSync(join(fixture, "sub"), { recursive: true });
      writeFileSync(join(fixture, "sub", "file.md"), "anonymous content\n", { mode: 0o600 });
      writeFileSync(join(fixture, "root.txt"), "root\n", { mode: 0o600 });
      const before = hashTree(fixture);
      const cli = join(import.meta.dir, "../../bin/live-release-verify.ts");
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, "--json"],
        cwd: fixture,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CBRAIN_REQUIRED_SKILL_TARGETS: "" },
      });
      const after = hashTree(fixture);
      expect(after, "fixture must be unchanged after verifier run").toEqual(before);
      const out = result.stdout.toString();
      expect(out).not.toContain("/Users/");
      expect(out).not.toMatch(/Bearer\s|api[_-]?key/i);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("live-release verifier — bootstrap launcher (cwd-independent)", () => {
  test("resolves the active root from launchd evidence regardless of caller cwd", () => {
    if (process.platform !== "darwin") return;
    const activeRoot = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-active-"));
    const fakeBin = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-path-"));
    const callerCwd = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-cwd-"));
    try {
      mkdirSync(join(activeRoot, "bin"), { recursive: true });
      const realBun = process.execPath;
      writeFileSync(
        join(activeRoot, "bin", "live-release-verify.ts"),
        'process.stdout.write(JSON.stringify({schema_version:1,status:"pass",spawned_from_bootstrap:true}));\nprocess.exit(0);\n',
      );
      writeFileSync(
        join(fakeBin, "launchctl"),
        `#!/bin/sh\ncase "$*" in\n  print*) printf '%s\\n' 'program = ${realBun}' 'working directory = ${activeRoot}' 'pid = 12345';;\n  list*) printf '%s\\t%s\\t%s\\n' 12345 0 ai.cbrain.serve;;\nesac\nexit 0\n`,
      );
      chmodSync(join(fakeBin, "launchctl"), 0o755);
      const bootstrap = join(import.meta.dir, "../../skills/release-verify-bootstrap.sh");
      const result = Bun.spawnSync({
        cmd: ["/bin/sh", bootstrap, "--json"],
        cwd: callerCwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" },
      });
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout.toString()) as { status: string; spawned_from_bootstrap?: boolean };
      expect(out.status).toBe("pass");
      expect(out.spawned_from_bootstrap).toBe(true);
    } finally {
      rmSync(activeRoot, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(callerCwd, { recursive: true, force: true });
    }
  });

  test("bootstrap fails closed when the active root has no verifier file", () => {
    if (process.platform !== "darwin") return;
    const activeRoot = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-noverify-"));
    const fakeBin = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-path2-"));
    const callerCwd = mkdtempSync(join(tmpdir(), "cbrain-bootstrap-cwd2-"));
    try {
      const realBun = process.execPath;
      writeFileSync(
        join(fakeBin, "launchctl"),
        `#!/bin/sh\ncase "$*" in\n  print*) printf '%s\\n' 'program = ${realBun}' 'working directory = ${activeRoot}' 'pid = 12345';;\nesac\nexit 0\n`,
      );
      chmodSync(join(fakeBin, "launchctl"), 0o755);
      const bootstrap = join(import.meta.dir, "../../skills/release-verify-bootstrap.sh");
      const result = Bun.spawnSync({
        cmd: ["/bin/sh", bootstrap, "--json"],
        cwd: callerCwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: process.env.HOME ?? "/tmp" },
      });
      expect(result.exitCode).toBe(1);
      const out = JSON.parse(result.stdout.toString()) as { status: string; code: string };
      expect(out.code).toBe("VERIFIER_ROOT_MISMATCH");
    } finally {
      rmSync(activeRoot, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(callerCwd, { recursive: true, force: true });
    }
  });
});

describe("live-release verifier — real deps construction (type-checked, no system calls)", () => {
  test("buildRealDeps constructs without invoking any system call and satisfies the interface", () => {
    const deps = buildRealDeps("/probe/verifier.ts");
    expect(deps.ownVerifierPath).toBe("/probe/verifier.ts");
    expect(typeof deps.listCbrainServiceOwners).toBe("function");
    expect(typeof deps.readServiceEvidence).toBe("function");
    expect(typeof deps.readProcessIdentity).toBe("function");
    expect(typeof deps.readProcessCwd).toBe("function");
    expect(typeof deps.readListenerOwner).toBe("function");
    expect(typeof deps.readCallerCwd).toBe("function");
    expect(typeof deps.fetchHealthVersion).toBe("function");
    expect(typeof deps.readPackageVersion).toBe("function");
    expect(typeof deps.readManifestVersion).toBe("function");
    expect(typeof deps.verifySkillTarget).toBe("function");
  });
});
