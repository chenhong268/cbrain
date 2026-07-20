/**
 * Live-release verifier — pure core (no system calls).
 *
 * Resolves the active CBrain deployment from injected service-manager evidence
 * (never caller cwd) and proves HTTP / package / manifest / skill-target version
 * coherence. All system access is behind {@link LiveReleaseDeps} so every
 * fail-closed matrix case is deterministic and unit-testable.
 *
 * Stability invariant: a single verification attempt is bracketed by a
 * before/after snapshot that covers the *entire* evidence window (service
 * identity, listener, writer, entrypoint, version, targets). Pass requires the
 * two snapshots to be byte-identical; otherwise the whole attempt is retried
 * once and, if still drifting, fails closed — evidence from two process
 * generations is never combined into one verdict.
 *
 * Read-only by construction: the dependency interface exposes only read
 * operations, and {@link verifyLiveRelease} performs no writes.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

// ── Fail codes (one per distinct failure layer — never collapse to generic) ──

export const FAIL_CODES = [
  "SERVICE_NOT_FOUND",
  "MULTIPLE_SERVICE_OWNERS",
  "SERVICE_EVIDENCE_INVALID",
  "PROCESS_NOT_RUNNING",
  "PROCESS_GENERATION_CHANGED",
  "ENTRYPOINT_ROOT_MISMATCH",
  "EXECUTABLE_ROOT_MISMATCH",
  "WRITER_COUNT_INVALID",
  "WRITER_OWNER_MISMATCH",
  "LISTENER_COUNT_INVALID",
  "LISTENER_OWNER_MISMATCH",
  "HTTP_UNAVAILABLE",
  "HTTP_RESPONSE_INVALID",
  "ACTIVE_PACKAGE_INVALID",
  "ACTIVE_MANIFEST_INVALID",
  "ACTIVE_VERSION_MISMATCH",
  "TARGET_SET_EMPTY",
  "TARGET_PATH_INVALID",
  "TARGET_VERIFICATION_FAILED",
  "VERIFIER_ROOT_MISMATCH",
] as const;

export type FailCode = (typeof FAIL_CODES)[number];

export type HttpFailCode = "HTTP_UNAVAILABLE" | "HTTP_RESPONSE_INVALID";

const FAIL_LAYER: Record<FailCode, string> = {
  SERVICE_NOT_FOUND: "service",
  MULTIPLE_SERVICE_OWNERS: "service",
  SERVICE_EVIDENCE_INVALID: "service",
  PROCESS_NOT_RUNNING: "process",
  PROCESS_GENERATION_CHANGED: "process",
  ENTRYPOINT_ROOT_MISMATCH: "process",
  EXECUTABLE_ROOT_MISMATCH: "process",
  WRITER_COUNT_INVALID: "writer",
  WRITER_OWNER_MISMATCH: "writer",
  LISTENER_COUNT_INVALID: "listener",
  LISTENER_OWNER_MISMATCH: "listener",
  HTTP_UNAVAILABLE: "http",
  HTTP_RESPONSE_INVALID: "http",
  ACTIVE_PACKAGE_INVALID: "version",
  ACTIVE_MANIFEST_INVALID: "version",
  ACTIVE_VERSION_MISMATCH: "version",
  TARGET_SET_EMPTY: "target",
  TARGET_PATH_INVALID: "target",
  TARGET_VERIFICATION_FAILED: "target",
  VERIFIER_ROOT_MISMATCH: "verifier",
};

// ── Dependency-injection seam ──

export interface ServiceEvidence {
  readonly label: string;
  readonly pid: number;
  readonly program: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly lastExitStatus: number | null;
}

export interface ProcessIdentity {
  readonly pid: number;
  /** libproc birth identity (start_sec*1e6+start_usec), stable across the run. */
  readonly startUsec: string;
}

export interface ListenerOwner {
  readonly pid: number;
  readonly count: number;
}

export interface WriterProcess {
  readonly pid: number;
}

export type TargetState = "current" | "stale" | "missing" | "incompatible" | "unverified";

export interface TargetResult {
  readonly path: string;
  readonly status: TargetState;
}

export interface HealthResult {
  readonly ok: true;
  readonly version: string;
}

export interface HealthFailure {
  readonly ok: false;
  readonly code: HttpFailCode;
}

export interface ReadVersion {
  readonly ok: true;
  readonly version: string;
}

export interface ReadVersionFailure {
  readonly ok: false;
}

export interface ReadManifest {
  readonly ok: true;
  readonly version: string;
  readonly files: readonly string[];
}

export type ReadManifestFailure = ReadVersionFailure;

export interface LiveReleaseDeps {
  /** Absolute path of the verifier implementation currently executing. */
  readonly ownVerifierPath: string;
  /** Loaded service labels that run the CBrain HTTP service (e.g. ai.cbrain.serve). */
  listCbrainServiceOwners(): readonly string[];
  /** Parse loaded service evidence from the service manager (launchctl print). */
  readServiceEvidence(label: string): ServiceEvidence;
  /** libproc birth identity for a PID, or null if the PID is gone. */
  readProcessIdentity(pid: number): ProcessIdentity | null;
  /** Real process cwd for a PID (lsof), or null if unreadable/gone. */
  readProcessCwd(pid: number): string | null;
  /** Owner PID + listener count for a TCP port (lsof). */
  readListenerOwner(port: number): ListenerOwner;
  /** PIDs of running `cbrain serve` writer processes (ps inventory). */
  listWriterProcesses(): readonly WriterProcess[];
  /** The caller's cwd — classified inactive unless it equals the active root. */
  readCallerCwd(): string;
  fetchHealthVersion(url: string, timeoutMs: number): HealthResult | HealthFailure;
  readPackageVersion(root: string): ReadVersion | ReadVersionFailure;
  readManifestVersion(root: string): ReadManifest | ReadManifestFailure;
  /** Compare a target skill dir against the active root skills dir. */
  verifySkillTarget(rootSkillsDir: string, targetDir: string): TargetResult;
}

// ── Options ──

export interface VerifyOptions {
  readonly serviceLabel: string;
  readonly port: number;
  readonly healthUrl: string;
  readonly httpTimeoutMs: number;
  readonly requiredTargets: readonly string[];
  readonly rollbackCandidate?: string;
}

export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = {
  serviceLabel: "ai.cbrain.serve",
  port: 3399,
  healthUrl: "http://127.0.0.1:3399/health",
  httpTimeoutMs: 3000,
  requiredTargets: [],
};

// ── Result (privacy-safe views) ──

export interface TargetView {
  readonly path: string;
  readonly status: TargetState;
}

export interface VerifyResult {
  readonly schema_version: 1;
  readonly status: "pass" | "fail";
  readonly code?: FailCode;
  readonly layer?: string;
  readonly service?: { readonly label: string; readonly pid_birth: string };
  readonly active?: { readonly root: string; readonly version: string };
  readonly versions?: { readonly http: string; readonly package: string; readonly manifest: string };
  readonly targets?: readonly TargetView[];
  readonly caller_cwd?: { readonly path: string; readonly classification: "active" | "inactive" };
  readonly rollback?: { readonly path: string; readonly classification: "inactive" };
}

function fail(code: FailCode): VerifyResult {
  return { schema_version: 1, status: "fail", code, layer: FAIL_LAYER[code] };
}

function hashBirth(startUsec: string): string {
  return createHash("sha256").update(startUsec).digest("hex").slice(0, 16);
}

/**
 * Resolve the actual CBrain entrypoint from ProgramArguments: the first token
 * that looks like a script file (`.ts`/`.js` with a path separator), resolved
 * against the configured working directory. Returns null if none is found.
 */
function resolveEntrypoint(programArguments: readonly string[], workingDirectory: string): string | null {
  for (const token of programArguments) {
    if (/\.(?:ts|js)$/i.test(token) && token.includes("/")) {
      return resolve(workingDirectory, token);
    }
  }
  return null;
}

// ── Snapshot — brackets the entire evidence window ──

interface Snapshot {
  readonly label: string;
  readonly pid: number;
  readonly startUsec: string | null;
  readonly cwd: string | null;
  readonly program: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly lastExitStatus: number | null;
  readonly listenerPid: number;
  readonly listenerCount: number;
  readonly writerPids: readonly number[];
}

function readSnapshot(deps: LiveReleaseDeps, opts: VerifyOptions, label: string): Snapshot {
  const evidence = deps.readServiceEvidence(label);
  const identity = deps.readProcessIdentity(evidence.pid);
  const cwd = deps.readProcessCwd(evidence.pid);
  const listener = deps.readListenerOwner(opts.port);
  const writers = deps.listWriterProcesses();
  return {
    label,
    pid: evidence.pid,
    startUsec: identity?.startUsec ?? null,
    cwd,
    program: evidence.program,
    programArguments: evidence.programArguments,
    workingDirectory: evidence.workingDirectory,
    lastExitStatus: evidence.lastExitStatus,
    listenerPid: listener.pid,
    listenerCount: listener.count,
    writerPids: [...writers.map((w) => w.pid)].sort((a, b) => a - b),
  };
}

function validateSnapshot(s: Snapshot): FailCode | null {
  if (
    typeof s.label !== "string" || s.label.length === 0 ||
    typeof s.workingDirectory !== "string" || s.workingDirectory.length === 0 || !s.workingDirectory.startsWith("/") ||
    typeof s.program !== "string" || s.program.length === 0 ||
    !Number.isSafeInteger(s.pid) || s.pid <= 0 ||
    !Array.isArray(s.programArguments)
  ) {
    return "SERVICE_EVIDENCE_INVALID";
  }
  if (s.startUsec === null) return "PROCESS_NOT_RUNNING";
  const entrypoint = resolveEntrypoint(s.programArguments, s.workingDirectory);
  if (entrypoint === null || !entrypoint.startsWith(`${s.workingDirectory}/`)) {
    return "ENTRYPOINT_ROOT_MISMATCH";
  }
  if (s.cwd !== s.workingDirectory) return "EXECUTABLE_ROOT_MISMATCH";
  if (s.writerPids.length !== 1) return "WRITER_COUNT_INVALID";
  if (s.writerPids[0] !== s.pid) return "WRITER_OWNER_MISMATCH";
  if (s.listenerCount !== 1) return "LISTENER_COUNT_INVALID";
  if (s.listenerPid !== s.pid) return "LISTENER_OWNER_MISMATCH";
  return null;
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.label === b.label &&
    a.pid === b.pid &&
    a.startUsec === b.startUsec &&
    a.cwd === b.cwd &&
    a.program === b.program &&
    a.workingDirectory === b.workingDirectory &&
    a.listenerPid === b.listenerPid &&
    a.listenerCount === b.listenerCount &&
    a.writerPids.join(",") === b.writerPids.join(",") &&
    a.programArguments.join("\n") === b.programArguments.join("\n")
  );
}

// ── One verification attempt (bracketed by before/after snapshot) ──

interface AttemptOutcome {
  readonly result: VerifyResult | null;
  readonly drifted: boolean;
}

function attempt(deps: LiveReleaseDeps, opts: VerifyOptions): AttemptOutcome {
  const before = readSnapshot(deps, opts, opts.serviceLabel);
  const beforeInvalid = validateSnapshot(before);
  if (beforeInvalid) return { result: fail(beforeInvalid), drifted: false };

  const activeRoot = before.workingDirectory;

  const http = deps.fetchHealthVersion(opts.healthUrl, opts.httpTimeoutMs);
  if (!http.ok) return { result: fail(http.code), drifted: false };
  const pkg = deps.readPackageVersion(activeRoot);
  if (!pkg.ok) return { result: fail("ACTIVE_PACKAGE_INVALID"), drifted: false };
  const manifest = deps.readManifestVersion(activeRoot);
  if (!manifest.ok) return { result: fail("ACTIVE_MANIFEST_INVALID"), drifted: false };
  if (http.version !== pkg.version || pkg.version !== manifest.version) {
    return { result: fail("ACTIVE_VERSION_MISMATCH"), drifted: false };
  }

  if (opts.requiredTargets.length === 0) return { result: fail("TARGET_SET_EMPTY"), drifted: false };
  const activeRootSkills = `${activeRoot}/skills`;
  const targetViews: TargetView[] = [];
  const seen = new Set<string>();
  for (const target of opts.requiredTargets) {
    if (!target.startsWith("/")) return { result: fail("TARGET_PATH_INVALID"), drifted: false };
    if (seen.has(target)) return { result: fail("TARGET_PATH_INVALID"), drifted: false };
    seen.add(target);
    const comparison = deps.verifySkillTarget(activeRootSkills, target);
    targetViews.push({ path: comparison.path, status: comparison.status });
    if (comparison.status !== "current") return { result: fail("TARGET_VERIFICATION_FAILED"), drifted: false };
  }

  // snapshot-after: pass requires the entire evidence window to be unchanged.
  const after = readSnapshot(deps, opts, opts.serviceLabel);
  if (!sameSnapshot(before, after)) return { result: null, drifted: true };

  // self-root proof on the stable active root — verifier code must live under it,
  // so a stale cwd cannot impersonate the deployment. Checked after stability so
  // a mid-verification restart can re-anchor instead of false-failing.
  if (!deps.ownVerifierPath.startsWith(`${activeRoot}/`)) {
    return { result: fail("VERIFIER_ROOT_MISMATCH"), drifted: false };
  }

  const callerCwd = deps.readCallerCwd();
  const callerClassification: "active" | "inactive" = callerCwd === activeRoot ? "active" : "inactive";

  const result: VerifyResult = {
    schema_version: 1,
    status: "pass",
    service: { label: before.label, pid_birth: hashBirth(before.startUsec ?? "") },
    active: { root: basename(activeRoot), version: pkg.version },
    versions: { http: http.version, package: pkg.version, manifest: manifest.version },
    targets: targetViews.map((t) => ({ path: basename(t.path), status: t.status })),
    caller_cwd: { path: basename(callerCwd), classification: callerClassification },
  };
  if (opts.rollbackCandidate) {
    return {
      result: { ...result, rollback: { path: basename(opts.rollbackCandidate), classification: "inactive" } },
      drifted: false,
    };
  }
  return { result, drifted: false };
}

// ── Main verifier ──

export function verifyLiveRelease(deps: LiveReleaseDeps, optsPartial?: Partial<VerifyOptions>): VerifyResult {
  const opts: VerifyOptions = { ...DEFAULT_VERIFY_OPTIONS, ...optsPartial };

  const owners = deps.listCbrainServiceOwners();
  if (!owners.includes(opts.serviceLabel)) return fail("SERVICE_NOT_FOUND");
  if (owners.length > 1) return fail("MULTIPLE_SERVICE_OWNERS");

  const first = attempt(deps, opts);
  if (!first.drifted) return first.result as VerifyResult;
  // One bounded whole-attempt retry. Still drifting → fail closed.
  const second = attempt(deps, opts);
  if (second.drifted) return fail("PROCESS_GENERATION_CHANGED");
  return second.result as VerifyResult;
}
