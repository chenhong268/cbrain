/**
 * #380 Stage 2 — pure dependency-advisory policy evaluator (honest/exact).
 *
 * Reuses Stage 1 (normalizeAuditJson, resolveDependencyPaths, isExactSemver)
 * + an exception registry → stable, privacy-safe verdict.
 *
 * Honesty: every fatal outcome carries a fixed reason in `errors` and an EMPTY
 * findings list (no fabricated findings with empty installed_version/path).
 * counts derive from normalized advisories (distinct per severity), never from
 * fabricated findings.
 *
 * Privacy: errors/findings expose only fixed reason codes + safe indexes and
 * canonical dependency paths. Exception mitigation/owner/rationale, advisory
 * title/url/cwe/cvss, raw registry text, absolute paths, env, and stack are
 * NEVER echoed.
 */

import {
  normalizeAuditJson,
  resolveDependencyPaths,
  isExactSemver,
  type Severity,
  type NormalizedAdvisory,
} from "./dependency-advisory-gate.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type PolicyOutcome = "go" | "no-go" | "fatal";
export type Reachability = "unreachable" | "mitigated";
export type RootClass = "prod" | "dev";

export interface Exception {
  readonly advisory_id: string;
  readonly package: string;
  readonly installed_version: string;
  readonly dependency_path: readonly string[];
  readonly reachability: Reachability;
  readonly mitigation: string;
  readonly owner: string;
  readonly rationale: string;
  readonly expires_on: string;
}

export interface ExceptionRegistry {
  readonly schema_version: 1;
  readonly exceptions: readonly Exception[];
}

export type FindingStatus = "informational" | "untriaged" | "excepted";

export type LifecycleReason =
  | "exception_expired"
  | "exception_obsolete"
  | "exception_stale_version"
  | "exception_stale_path"
  | "exception_unnecessary";

export type RegistryReason =
  | "invalid_registry_schema"
  | "invalid_exception_field"
  | "duplicate_exception_key"
  | "invalid_dependency_path"
  | "invalid_date";

export type FatalReason =
  | "invalid_evaluation_date"
  | "invalid_audit_input"
  | "lock_integrity"
  | "audit_lock_mismatch";

export type FindingReasonCode = FindingStatus | LifecycleReason;

export interface Finding {
  readonly advisory_id: string;
  readonly severity: Severity;
  readonly package: string;
  readonly installed_version: string;
  readonly dependency_path: readonly string[];
  readonly root: RootClass;
  readonly optional: boolean;
  readonly status: FindingStatus;
  readonly reason_code: FindingReasonCode;
  readonly expires_on: string | null;
}

export type PolicyErrorReason = RegistryReason | LifecycleReason | FatalReason;

export interface PolicyError {
  readonly reason: PolicyErrorReason;
  readonly index: number | null;
}

export interface PolicyCounts {
  readonly critical: number;
  readonly high: number;
  readonly moderate: number;
  readonly low: number;
}

export interface PolicyResult {
  readonly schema_version: 1;
  readonly gate: "dependency-advisories";
  readonly outcome: PolicyOutcome;
  readonly evaluated_on: string | null;
  readonly counts: PolicyCounts;
  readonly findings: readonly Finding[];
  readonly errors: readonly PolicyError[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const NPM_NAME_MAX = 214;
const NPM_NAME_RE = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TEXT_MAX = 2000;
const PATH_NODE_MAX = 280;
const WILDCARD_RE = /[*?\[\]]/;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function isValidPackageName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > NPM_NAME_MAX) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  if (name.includes("//")) return false;
  return NPM_NAME_RE.test(name);
}
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
function isNonEmptyText(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= TEXT_MAX;
}
function hasWildcard(s: string): boolean {
  return WILDCARD_RE.test(s);
}

function validateDependencyPath(
  raw: unknown,
  pkg: string,
  version: string,
): true | "invalid_dependency_path" {
  if (!Array.isArray(raw) || raw.length < 2) return "invalid_dependency_path";
  if (raw[0] !== "cbrain") return "invalid_dependency_path";
  for (const node of raw) {
    if (typeof node !== "string" || node.length === 0 || node.length > PATH_NODE_MAX) {
      return "invalid_dependency_path";
    }
    if (/[\x00-\x1f\x7f]/.test(node)) return "invalid_dependency_path";
    if (node.startsWith("/")) return "invalid_dependency_path";
  }
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "cbrain") return "invalid_dependency_path"; // duplicate root
    const node = raw[i] as string;
    const at = node.lastIndexOf("@");
    if (at <= 0) return "invalid_dependency_path";
    if (!isValidPackageName(node.slice(0, at))) return "invalid_dependency_path";
    if (!isExactSemver(node.slice(at + 1))) return "invalid_dependency_path"; // exact version
  }
  if (raw[raw.length - 1] !== `${pkg}@${version}`) return "invalid_dependency_path";
  return true;
}

const EXC_FIELDS = [
  "advisory_id",
  "package",
  "installed_version",
  "dependency_path",
  "reachability",
  "mitigation",
  "owner",
  "rationale",
  "expires_on",
] as const;

function validateException(raw: unknown): { ok: true; exc: Exception } | { ok: false; reason: RegistryReason } {
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid_exception_field" };
  for (const k of Object.keys(raw)) {
    if (!(EXC_FIELDS as readonly string[]).includes(k)) return { ok: false, reason: "invalid_exception_field" };
  }
  for (const k of EXC_FIELDS) {
    if (!(k in raw)) return { ok: false, reason: "invalid_exception_field" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["advisory_id"] !== "string" || r["advisory_id"].length === 0 || hasWildcard(r["advisory_id"])) {
    return { ok: false, reason: "invalid_exception_field" };
  }
  if (!isValidPackageName(r["package"]) || hasWildcard(r["package"] as string)) {
    return { ok: false, reason: "invalid_exception_field" };
  }
  // installed_version must be EXACT semver (no ^ >= * etc).
  if (typeof r["installed_version"] !== "string" || !isExactSemver(r["installed_version"]) || hasWildcard(r["installed_version"] as string)) {
    return { ok: false, reason: "invalid_exception_field" };
  }
  const dp = validateDependencyPath(r["dependency_path"], r["package"] as string, r["installed_version"] as string);
  if (dp !== true) return { ok: false, reason: dp };
  if (r["reachability"] !== "unreachable" && r["reachability"] !== "mitigated") {
    return { ok: false, reason: "invalid_exception_field" };
  }
  if (!isNonEmptyText(r["mitigation"]) || !isNonEmptyText(r["owner"]) || !isNonEmptyText(r["rationale"])) {
    return { ok: false, reason: "invalid_exception_field" };
  }
  if (!isValidGregorianDate(r["expires_on"])) return { ok: false, reason: "invalid_date" };
  return {
    ok: true,
    exc: {
      advisory_id: r["advisory_id"] as string,
      package: r["package"] as string,
      installed_version: r["installed_version"] as string,
      dependency_path: [...(r["dependency_path"] as readonly string[])],
      reachability: r["reachability"] as Reachability,
      mitigation: r["mitigation"] as string,
      owner: r["owner"] as string,
      rationale: r["rationale"] as string,
      expires_on: r["expires_on"] as string,
    },
  };
}

/** Unambiguous canonical serialization (no hand-rolled delimiter). */
function exactKey(parts: { advisory_id: string; package: string; installed_version: string; dependency_path: readonly string[] }): string {
  return JSON.stringify([parts.advisory_id, parts.package, parts.installed_version, parts.dependency_path]);
}

// ── Finding (mutable during evaluation) ──────────────────────────────────────

interface MFinding {
  advisory_id: string;
  severity: Severity;
  package: string;
  installed_version: string;
  dependency_path: string[];
  root: RootClass;
  optional: boolean;
  status: FindingStatus;
  reason_code: FindingReasonCode;
  expires_on: string | null;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

export function evaluatePolicy(
  registryInput: unknown,
  auditInput: unknown,
  lockText: string,
  today: string,
): PolicyResult {
  // ── today must be a real Gregorian date ──
  if (!isValidGregorianDate(today)) {
    return {
      schema_version: 1,
      gate: "dependency-advisories",
      outcome: "fatal",
      evaluated_on: null,
      counts: { critical: 0, high: 0, moderate: 0, low: 0 },
      findings: [],
      errors: [{ reason: "invalid_evaluation_date", index: null }],
    };
  }

  const errors: PolicyError[] = [];
  const findings: MFinding[] = [];

  const finish = (outcome: PolicyOutcome, evaluatedOn: string, counts: PolicyCounts): PolicyResult => ({
    schema_version: 1,
    gate: "dependency-advisories",
    outcome,
    evaluated_on: evaluatedOn,
    counts,
    findings: sortFindings(findings),
    errors: sortErrors(errors),
  });

  // ── Registry schema ──
  if (!isPlainObject(registryInput)) {
    errors.push({ reason: "invalid_registry_schema", index: null });
    return fatalFromErrors(errors, today, { critical: 0, high: 0, moderate: 0, low: 0 });
  }
  const topKeys = Object.keys(registryInput);
  for (const k of topKeys) {
    if (k !== "schema_version" && k !== "exceptions") {
      errors.push({ reason: "invalid_registry_schema", index: null });
      break;
    }
  }
  if (!topKeys.includes("schema_version") || !topKeys.includes("exceptions")) {
    errors.push({ reason: "invalid_registry_schema", index: null });
  }
  if (registryInput["schema_version"] !== 1) {
    errors.push({ reason: "invalid_registry_schema", index: null });
  }
  const excRawUnknown = registryInput["exceptions"];
  if (!Array.isArray(excRawUnknown)) {
    errors.push({ reason: "invalid_registry_schema", index: null });
  }
  if (errors.length > 0) return fatalFromErrors(errors, today, { critical: 0, high: 0, moderate: 0, low: 0 });
  const excRaw: unknown[] = excRawUnknown as unknown[];

  // ── Exceptions ──
  const valid: Array<{ exc: Exception; index: number }> = [];
  const seenKeys = new Set<string>();
  for (let i = 0; i < excRaw.length; i++) {
    const v = validateException(excRaw[i]);
    if (!v.ok) {
      errors.push({ reason: v.reason, index: i });
      continue;
    }
    const key = exactKey(v.exc);
    if (seenKeys.has(key)) {
      errors.push({ reason: "duplicate_exception_key", index: i });
      continue;
    }
    seenKeys.add(key);
    valid.push({ exc: v.exc, index: i });
  }
  if (errors.length > 0) return fatalFromErrors(errors, today, { critical: 0, high: 0, moderate: 0, low: 0 });

  // ── Normalize audit ──
  const { advisories, errors: auditErrors } = normalizeAuditJson(auditInput);
  if (auditErrors.length > 0) {
    return {
      schema_version: 1,
      gate: "dependency-advisories",
      outcome: "fatal",
      evaluated_on: today,
      counts: { critical: 0, high: 0, moderate: 0, low: 0 },
      findings: [],
      errors: [{ reason: "invalid_audit_input", index: null }],
    };
  }
  const counts = countAdvisories(advisories);

  // All installed versions per package (across every resolved path, vulnerable
  // or not) — lets lifecycle classification distinguish stale_version (gone)
  // from obsolete (still installed but no longer the vulnerable target).
  const installedVersionsByPkg = new Map<string, Set<string>>();

  // ── Materialize findings (fatal = empty findings + honest error) ──
  for (const adv of advisories) {
    const resolved = resolveDependencyPaths(lockText, adv.package);
    if (resolved.errors.length > 0) {
      return { schema_version: 1, gate: "dependency-advisories", outcome: "fatal", evaluated_on: today, counts, findings: [], errors: [{ reason: "lock_integrity", index: null }] };
    }
    const matched = resolved.paths.filter((p) => {
      const last = p.nodes[p.nodes.length - 1];
      return last ? semverSatisfies(last.version, adv.vulnerable_versions) : false;
    });
    if (resolved.paths.length === 0 || matched.length === 0) {
      return { schema_version: 1, gate: "dependency-advisories", outcome: "fatal", evaluated_on: today, counts, findings: [], errors: [{ reason: "audit_lock_mismatch", index: null }] };
    }
    if (!installedVersionsByPkg.has(adv.package)) {
      const vers = new Set<string>();
      for (const rp of resolved.paths) {
        const last = rp.nodes[rp.nodes.length - 1];
        if (last) vers.add(last.version);
      }
      installedVersionsByPkg.set(adv.package, vers);
    }
    for (const p of matched) {
      const last = p.nodes[p.nodes.length - 1]!;
      findings.push({
        advisory_id: adv.advisory_id,
        severity: adv.severity,
        package: adv.package,
        installed_version: last.version,
        dependency_path: ["cbrain", ...p.nodes.map((n) => `${n.name}@${n.version}`)],
        root: p.root,
        optional: p.optional,
        status: "informational",
        reason_code: "informational",
        expires_on: null,
      });
    }
  }

  // ── Match exceptions ──
  const matchedExcIdx = new Set<number>();
  for (const f of findings) {
    const isHigh = f.severity === "high" || f.severity === "critical";
    const match = valid.find((ve) => exactKey(ve.exc) === exactKey(f));
    if (match) matchedExcIdx.add(match.index);

    if (!isHigh) {
      if (match) {
        errors.push({ reason: "exception_unnecessary", index: match.index });
      }
      f.status = "informational";
      f.reason_code = "informational";
      continue;
    }
    if (!match) {
      f.status = "untriaged";
      f.reason_code = "untriaged";
      continue;
    }
    // matched high/critical — check expiry
    f.expires_on = match.exc.expires_on;
    if (today > match.exc.expires_on) {
      // expired: NOT excepted. Treat as untriaged + flag expired (exception located → no stale/obsolete).
      f.status = "untriaged";
      f.reason_code = "exception_expired";
      errors.push({ reason: "exception_expired", index: match.index });
    } else {
      f.status = "excepted";
      f.reason_code = "excepted";
    }
  }

  // ── Lifecycle for unmatched exceptions ──
  const advisoryIndex = new Map<string, Severity>();
  for (const a of advisories) advisoryIndex.set(`${a.advisory_id}|${a.package}`, a.severity);
  for (const ve of valid) {
    if (matchedExcIdx.has(ve.index)) continue;
    const severity = advisoryIndex.get(`${ve.exc.advisory_id}|${ve.exc.package}`);
    if (severity === undefined) {
      errors.push({ reason: "exception_obsolete", index: ve.index });
      continue;
    }
    const isHigh = severity === "high" || severity === "critical";
    if (!isHigh) {
      errors.push({ reason: "exception_unnecessary", index: ve.index });
      continue;
    }
    // The exception's exact key matched no finding. Classify across ALL
    // installed paths of this package (not just vulnerable findings):
    //   version still a vulnerable target → the dependency path moved (stale_path);
    //   version still installed but no longer vulnerable → obsolete;
    //   version no longer installed at all → stale_version.
    const stillVulnerableAtVersion = findings.some(
      (f) => f.advisory_id === ve.exc.advisory_id && f.package === ve.exc.package && f.installed_version === ve.exc.installed_version,
    );
    if (stillVulnerableAtVersion) {
      errors.push({ reason: "exception_stale_path", index: ve.index });
    } else {
      const installed = installedVersionsByPkg.get(ve.exc.package);
      errors.push({
        reason: installed !== undefined && installed.has(ve.exc.installed_version) ? "exception_obsolete" : "exception_stale_version",
        index: ve.index,
      });
    }
  }

  const outcome: PolicyOutcome = findings.some((f) => f.reason_code === "untriaged") || errors.length > 0
    ? "no-go"
    : "go";
  return finish(outcome, today, counts);
}

function fatalFromErrors(errors: PolicyError[], evaluatedOn: string, counts: PolicyCounts): PolicyResult {
  return {
    schema_version: 1,
    gate: "dependency-advisories",
    outcome: "fatal",
    evaluated_on: evaluatedOn,
    counts,
    findings: [],
    errors: sortErrors(errors),
  };
}

/** Wrap Bun.semver.satisfies with try/catch (fail-closed). */
function semverSatisfies(version: string, range: string): boolean {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

// ── Output stability ─────────────────────────────────────────────────────────

function countAdvisories(advisories: readonly NormalizedAdvisory[]): PolicyCounts {
  const seen = new Set<string>();
  const c = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const a of advisories) {
    const key = `${a.advisory_id}|${a.package}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (a.severity === "critical") c.critical++;
    else if (a.severity === "high") c.high++;
    else if (a.severity === "moderate") c.moderate++;
    else if (a.severity === "low") c.low++;
  }
  return c;
}

function sortFindings(findings: readonly MFinding[]): readonly Finding[] {
  return [...findings].sort(compareFinding).map(toFinding);
}
function toFinding(f: MFinding): Finding {
  return {
    advisory_id: f.advisory_id,
    severity: f.severity,
    package: f.package,
    installed_version: f.installed_version,
    dependency_path: f.dependency_path,
    root: f.root,
    optional: f.optional,
    status: f.status,
    reason_code: f.reason_code,
    expires_on: f.expires_on,
  };
}
function compareFinding(a: MFinding, b: MFinding): number {
  const sev: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
  if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
  if (a.advisory_id !== b.advisory_id) return a.advisory_id < b.advisory_id ? -1 : 1;
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  if (a.installed_version !== b.installed_version) return a.installed_version < b.installed_version ? -1 : 1;
  const ap = a.dependency_path.join("→");
  const bp = b.dependency_path.join("→");
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}
function sortErrors(errs: readonly PolicyError[]): readonly PolicyError[] {
  return [...errs].sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return (a.index ?? -1) - (b.index ?? -1);
  });
}

export { normalizeAuditJson, resolveDependencyPaths };
