/**
 * #380 Stage 3 — executable dependency advisory gate.
 *
 * Stable: `bun run gate:dependencies`, gate id "dependency-advisories".
 * Reads repo bun.lock + config/dependency-advisory-exceptions.json, spawns
 * `bun audit --json` (argv array, piped, cwd=repo root, 60s timeout), runs
 * the Stage 2 evaluator, prints exactly ONE JSON line on stdout, sets exit
 * code 0 (go) / 1 (no-go) / 2 (fatal).
 *
 * Privacy: stdout contains only the result envelope. Raw audit stdout/stderr,
 * registry/lock text, exception mitigation/owner/rationale, absolute paths,
 * env, stack, Bun executable path, credentials, URLs are NEVER echoed. The
 * runtime envelope only echoes `today` if it is a valid Gregorian date, else
 * null — so a hostile today never reaches evaluated_on.
 *
 * Importing this module does NOT spawn anything — work happens only when run
 * via `import.meta.main` or by explicitly calling `runGate(deps)`.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  evaluatePolicy,
  type PolicyOutcome,
  type PolicyCounts,
  type Finding,
  type PolicyErrorReason,
} from "./lib/dependency-advisory-policy.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type RuntimeReason =
  | "audit_spawn_failed"
  | "audit_timeout"
  | "audit_command_failed"
  | "audit_output_invalid"
  | "registry_read_failed"
  | "registry_json_invalid"
  | "lock_read_failed"
  | "unexpected_runtime_failure";

export type GateErrorReason = PolicyErrorReason | RuntimeReason;

export interface AuditResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTooLarge?: boolean;
}

export interface GateDeps {
  readonly runAudit: () => Promise<AuditResult>;
  readonly readRegistry: () => string;
  readonly readLock: () => string;
  readonly today: string;
  readonly evaluate: typeof evaluatePolicy;
}

export interface GateResult {
  readonly schema_version: 1;
  readonly gate: "dependency-advisories";
  readonly outcome: PolicyOutcome;
  readonly evaluated_on: string | null;
  readonly counts: PolicyCounts;
  readonly findings: readonly Finding[];
  readonly errors: readonly { readonly reason: GateErrorReason; readonly index: number | null }[];
}

export interface GateRun extends GateResult {
  readonly exitCode: 0 | 1 | 2;
}

// ── Date safety + runtime-fatal envelope ─────────────────────────────────────

function isValidGregorianDate(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Only a valid Gregorian today is echoed; anything else → null (no leak). */
function safeToday(today: string): string | null {
  return isValidGregorianDate(today) ? today : null;
}

function envelope(reason: RuntimeReason, today: string): GateResult {
  return {
    schema_version: 1,
    gate: "dependency-advisories",
    outcome: "fatal",
    evaluated_on: safeToday(today),
    counts: { critical: 0, high: 0, moderate: 0, low: 0 },
    findings: [],
    errors: [{ reason, index: null }],
  };
}

// ── Pure, injectable gate ────────────────────────────────────────────────────

export async function runGate(deps: GateDeps): Promise<GateRun> {
  const today = deps.today;

  let registryText: string;
  try {
    registryText = deps.readRegistry();
  } catch {
    return { ...envelope("registry_read_failed", today), exitCode: 2 };
  }
  let registryJson: unknown;
  try {
    registryJson = JSON.parse(registryText);
  } catch {
    return { ...envelope("registry_json_invalid", today), exitCode: 2 };
  }

  let lockText: string;
  try {
    lockText = deps.readLock();
  } catch {
    return { ...envelope("lock_read_failed", today), exitCode: 2 };
  }

  let audit: AuditResult;
  try {
    audit = await deps.runAudit();
  } catch {
    return { ...envelope("audit_spawn_failed", today), exitCode: 2 };
  }
  // timeout takes priority over signal/exit classification.
  if (audit.timedOut) {
    return { ...envelope("audit_timeout", today), exitCode: 2 };
  }
  // Resource caps (#380 P1c): stdout/stderr/decompressed limits. Priority over
  // signal/exit classification — a size-cap SIGKILL must read as output_invalid,
  // not command_failed. No raw content is echoed (envelope carries only counts).
  if (audit.outputTooLarge) {
    return { ...envelope("audit_output_invalid", today), exitCode: 2 };
  }
  // ONLY exit 0/1 with no signal may reach JSON parse. Anything else (signal
  // kill, missing exit, negative exit, >1) is runtime fatal even if stdout
  // happens to parse as JSON — never let a signal-terminated audit masquerade
  // as a successful run.
  if (
    audit.signal !== null ||
    audit.exitCode === null ||
    audit.exitCode < 0 ||
    audit.exitCode > 1
  ) {
    return { ...envelope("audit_command_failed", today), exitCode: 2 };
  }
  if (audit.stdout.length === 0) {
    return { ...envelope("audit_output_invalid", today), exitCode: 2 };
  }
  let auditJson: unknown;
  try {
    auditJson = JSON.parse(audit.stdout);
  } catch {
    return { ...envelope("audit_output_invalid", today), exitCode: 2 };
  }

  try {
    const result = deps.evaluate(registryJson, auditJson, lockText, today);
    const exitCode: 0 | 1 | 2 = result.outcome === "go" ? 0 : result.outcome === "no-go" ? 1 : 2;
    return { ...result, exitCode };
  } catch {
    return { ...envelope("unexpected_runtime_failure", today), exitCode: 2 };
  }
}

/** Fixed-field-order serialization → byte-stable for same input/today. */
export function serializeGate(g: GateResult): string {
  return JSON.stringify({
    schema_version: g.schema_version,
    gate: g.gate,
    outcome: g.outcome,
    evaluated_on: g.evaluated_on,
    counts: g.counts,
    findings: g.findings,
    errors: g.errors,
  });
}

/** Production line: exactly one JSON object + one trailing newline, no banner. */
export function formatGateLine(g: GateResult): string {
  return serializeGate(g) + "\n";
}

// ── Production deps (only assembled under import.meta.main) ──────────────────

const REPO_ROOT = resolve(import.meta.dirname, ".."); // bin/ → repo root
const AUDIT_TIMEOUT_MS = 60_000;
// Hard resource caps (#380 P1c): a malicious/buggy audit emitter must not be
// able to exhaust memory via a gzip bomb or runaway output. Breaching any cap
// kills the child and surfaces a fatal audit_output_invalid (no raw content).
const MAX_COMPRESSED_STDOUT = 2 * 1024 * 1024; // 2 MB compressed (gzip) input
const MAX_DECOMPRESSED_STDOUT = 8 * 1024 * 1024; // 8 MB decompressed JSON
const MAX_STDERR = 512 * 1024; // 512 KB stderr

/** STRICT gunzip with a TRUE hard cap on decompressed size. `maxOutputLength`
 *  makes Bun's zlib abort decompression the moment output exceeds the cap,
 *  BEFORE the full decompressed buffer is allocated (a post-decode length check
 *  would let a tiny gzip bomb allocate gigabytes first). STRICT gunzipSync — no
 *  Z_SYNC_FLUSH leniency — refuses to emit partial output from a truncated
 *  stream, so a cut-off advisory cannot vanish and flip the verdict to GO; a
 *  truncated / missing-trailer / CRC-mismatch stream fails closed. Only
 *  ERR_BUFFER_TOO_LARGE (the cap firing) is a tooLarge signal; every other
 *  decompression error → audit_output_invalid via empty stdout. Exported for
 *  narrow resource-boundary testing only. */
export function maybeGunzip(buf: Buffer): { text: string; tooLarge: boolean } {
  // gzip when the magic header is present (real bun audit currently emits plain
  // JSON; this branch is defensive). Decode so JSON.parse works.
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return { text: gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_STDOUT }).toString("utf-8"), tooLarge: false };
    } catch (e) {
      if (isBufferTooLargeError(e)) return { text: "", tooLarge: true };
      return { text: "", tooLarge: false }; // truncation / CRC / header → fail-closed empty
    }
  }
  // Non-gzip plaintext (real bun audit shape) under cap.
  if (buf.length > MAX_DECOMPRESSED_STDOUT) return { text: "", tooLarge: true };
  return { text: buf.toString("utf-8"), tooLarge: false };
}

/** True only for the maxOutputLength guard firing — Bun: code
 *  `ERR_BUFFER_TOO_LARGE`, RangeError "Cannot create a Buffer larger than N". */
function isBufferTooLargeError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as Error & { code?: string }).code;
  return code === "ERR_BUFFER_TOO_LARGE" || (e.name === "RangeError" && /Buffer larger than/.test(e.message));
}

export interface SpawnCmd {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}
const DEFAULT_AUDIT_CMD: SpawnCmd = { bin: process.execPath, args: ["audit", "--json"], cwd: REPO_ROOT };

/** Production audit command is the default. Tests inject a synthetic emitter
 *  (`SpawnCmd`) to exercise the resource caps through the SAME byte-collecting
 *  + kill path — no stream/framework abstraction introduced. */
export function spawnAudit(cmd: SpawnCmd = DEFAULT_AUDIT_CMD): Promise<AuditResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd.bin, [...cmd.args], {
      cwd: cmd.cwd ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let timedOut = false;
    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, AUDIT_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes > MAX_COMPRESSED_STDOUT) {
        outputTooLarge = true;
        killChild();
        return;
      }
      stdoutChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderrBytes += c.length;
      if (stderrBytes > MAX_STDERR) {
        outputTooLarge = true;
        killChild();
        return;
      }
      stderrChunks.push(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err); // spawn failure → runGate catch → audit_spawn_failed
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let stdoutText = "";
      if (!outputTooLarge) {
        const dec = maybeGunzip(Buffer.concat(stdoutChunks));
        if (dec.tooLarge) outputTooLarge = true;
        else stdoutText = dec.text;
      }
      resolveP({
        exitCode: code,
        signal,
        stdout: outputTooLarge ? "" : stdoutText,
        stderr: outputTooLarge ? "" : Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
        outputTooLarge,
      });
    });
  });
}

function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const deps: GateDeps = {
    runAudit: spawnAudit,
    readRegistry: () =>
      readFileSync(resolve(REPO_ROOT, "config/dependency-advisory-exceptions.json"), "utf-8"),
    readLock: () => readFileSync(resolve(REPO_ROOT, "bun.lock"), "utf-8"),
    today: todayUtc(),
    evaluate: evaluatePolicy,
  };
  runGate(deps).then((run) => {
    process.stdout.write(formatGateLine(run));
    process.exitCode = run.exitCode;
  });
}
