/**
 * #380 Stage 1 — pure capabilities for the dependency advisory gate.
 *
 * Two capabilities only (no policy/verdict/CLI/CI in this stage):
 *   1. normalizeAuditJson     — Bun 1.3.14 `bun audit --json` normalization.
 *   2. resolveDependencyPaths — bun.lock dependency graph + path resolution.
 *
 * Privacy contract: structured errors carry only reason codes + a package
 * name when it passes bounded npm-name validation. Invalid package keys,
 * advisory title/url/cwe/cvss, local paths, env, registry URLs, lock keys,
 * descriptors, ranges, counters, and stack are NEVER echoed.
 *
 * Lock schema is fail-closed: every malformed field (packages not object,
 * tuple not array, descriptor without name@version, metadata not object,
 * dependency section not object, entry with bad name or non-string/empty
 * range, optionalPeers not string-array or referencing an undeclared peer)
 * returns invalid_lock_entry / invalid_lock_json with package=null.
 */

import { parseConfigFileTextToJson } from "typescript";

// ── Audit normalization ──────────────────────────────────────────────────────

export type Severity = "low" | "moderate" | "high" | "critical";

export interface NormalizedAdvisory {
  readonly advisory_id: string;
  readonly severity: Severity;
  readonly package: string;
  readonly vulnerable_versions: string;
}

export type AuditParseErrorReason =
  | "invalid_top_level"
  | "invalid_package_name"
  | "invalid_package_entries"
  | "advisory_not_object"
  | "missing_advisory_id"
  | "missing_severity"
  | "unknown_severity"
  | "missing_vulnerable_versions"
  | "invalid_vulnerable_versions";

export interface AuditParseError {
  readonly reason: AuditParseErrorReason;
  readonly package: string | null;
  readonly index: number | null;
}

export interface AuditNormalizationResult {
  readonly advisories: readonly NormalizedAdvisory[];
  readonly errors: readonly AuditParseError[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
};
const KNOWN_SEVERITIES: ReadonlySet<string> = new Set([
  "low",
  "moderate",
  "high",
  "critical",
]);

const NPM_NAME_MAX = 214;
const NPM_NAME_RE = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Bounded npm package-name validation (plain or @scope/name). */
function isValidPackageName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > NPM_NAME_MAX) return false;
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  if (name.includes("//")) return false;
  return NPM_NAME_RE.test(name);
}

function safePackage(name: string | null): string | null {
  if (name === null) return null;
  return isValidPackageName(name) ? name : null;
}

const ADVISORY_ID_RE = /^[A-Za-z0-9._:-]+$/;
const ADVISORY_ID_MAX = 128;
function normalizeId(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw.length > 0 && raw.length <= ADVISORY_ID_MAX && ADVISORY_ID_RE.test(raw) ? raw : null;
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return String(raw);
  }
  return null;
}

export function normalizeAuditJson(input: unknown): AuditNormalizationResult {
  const advisories: NormalizedAdvisory[] = [];
  const errors: AuditParseError[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({ reason: "invalid_top_level", package: null, index: null });
    return { advisories, errors };
  }

  const root = input as Record<string, unknown>;
  for (const [pkg, entries] of Object.entries(root)) {
    if (!isValidPackageName(pkg)) {
      errors.push({ reason: "invalid_package_name", package: null, index: null });
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push({ reason: "invalid_package_entries", package: pkg, index: null });
      continue;
    }
    entries.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push({ reason: "advisory_not_object", package: pkg, index: i });
        return;
      }
      const e = entry as Record<string, unknown>;
      const id = normalizeId(e["id"]);
      if (id === null) {
        errors.push({ reason: "missing_advisory_id", package: pkg, index: i });
        return;
      }
      const sev = e["severity"];
      if (typeof sev !== "string" || sev.length === 0) {
        errors.push({ reason: "missing_severity", package: pkg, index: i });
        return;
      }
      if (!KNOWN_SEVERITIES.has(sev)) {
        errors.push({ reason: "unknown_severity", package: pkg, index: i });
        return;
      }
      const vv = e["vulnerable_versions"];
      if (typeof vv !== "string") {
        errors.push({ reason: "missing_vulnerable_versions", package: pkg, index: i });
        return;
      }
      if (!isValidVulnerableVersions(vv)) {
        errors.push({ reason: "invalid_vulnerable_versions", package: pkg, index: i });
        return;
      }
      advisories.push({
        advisory_id: id,
        severity: sev as Severity,
        package: pkg,
        vulnerable_versions: vv,
      });
    });
  }

  advisories.sort(compareAdvisory);
  return { advisories, errors };
}

function compareAdvisory(a: NormalizedAdvisory, b: NormalizedAdvisory): number {
  const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (r !== 0) return r;
  if (a.advisory_id !== b.advisory_id) return a.advisory_id < b.advisory_id ? -1 : 1;
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  if (a.vulnerable_versions !== b.vulnerable_versions) {
    return a.vulnerable_versions < b.vulnerable_versions ? -1 : 1;
  }
  return 0;
}

// ── bun.lock dependency path resolution ──────────────────────────────────────

export type RootClass = "prod" | "dev";

export interface PathNode {
  readonly name: string;
  readonly version: string;
}

export interface ResolvedPath {
  readonly root: RootClass;
  readonly optional: boolean;
  readonly nodes: readonly PathNode[];
}

export type LockIntegrityErrorReason =
  | "invalid_lock_json"
  | "invalid_lock_entry"
  | "missing_resolution"
  | "range_mismatch"
  | "traversal_limit_exceeded";

export interface LockIntegrityError {
  readonly reason: LockIntegrityErrorReason;
  readonly package: string | null;
}

export interface LockResolutionResult {
  readonly paths: readonly ResolvedPath[];
  readonly errors: readonly LockIntegrityError[];
}

type EdgeKind = "dep" | "optional" | "peer" | "optional_peer";

interface Edge {
  readonly name: string;
  readonly range: string;
  readonly kind: EdgeKind;
}

interface PkgEntry {
  readonly lockKey: string;
  readonly name: string;
  readonly version: string;
  readonly edges: readonly Edge[];
}

/** Split "@scope/pkg@1.2.3" into name + version (scoped-aware). */
function splitResolved(resolved: string): { name: string; version: string } | null {
  const at = resolved.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: resolved.slice(0, at), version: resolved.slice(at + 1) };
}

/**
 * Strict SemVer 2.0 exact version (semver.org): MAJOR.MINOR.PATCH with optional
 * prerelease (-) and build (+) metadata, numeric parts without leading zeros.
 * Rejects range operators, wildcards, leading zeros, wrong part count, and
 * trailing garbage.
 *
 * Pure regex — Bun.semver's lenient parser is NOT used for VALIDITY, so
 * malicious values like "01.2.3", "1.2.3.4", "1.2.3," are rejected (they slip
 * through Bun.semver.satisfies). Bun.semver is used only for MATCHING, after a
 * version/range has passed these validators. Used for installed_version, every
 * dependency_path node version, and the lock descriptor version.
 */
const SEMVER_CORE =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
  "(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?" +
  "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?";
const SEMVER_RE = new RegExp(`^${SEMVER_CORE}$`);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Bound every MAJOR.MINOR.PATCH numeric component to [0, Number.MAX_SAFE_INTEGER].
 * The regex already guarantees non-negative integers with no leading zeros, so
 * BigInt never throws; BigInt is used instead of Number() because Number() loses
 * precision past 2^53 — the #380 P1c hole, where ">99999999999999999999.0.0"
 * parsed as a finite float that Bun.semver then treated as satisfiable, opening
 * a high+exception pair to GO.
 */
function versionComponentsBounded(version: string): boolean {
  const core = version.split("-")[0].split("+")[0]; // "X.Y.Z"
  for (const p of core.split(".")) {
    if (BigInt(p) > MAX_SAFE_BIGINT) return false;
  }
  return true;
}
export function isExactSemver(version: string): boolean {
  return SEMVER_RE.test(version) && versionComponentsBounded(version);
}

/**
 * Strict npm range validator for `vulnerable_versions` (#380 P1 fail-open fix).
 * Accepts the conservative set Bun audit actually emits: `*`, exact SemVer,
 * single comparators (`<` `<=` `>` `>=`), whitespace-separated intersections
 * (`>=1.0.0 <2.0.0`), `||` unions, and SemVer prerelease/build. Rejects empty,
 * garbage, trailing garbage, lone operators, partials, x-ranges, and
 * unsupported operators (`^` `~` `=`). The raw range is NEVER echoed; on failure
 * normalizeAuditJson records a fixed `invalid_vulnerable_versions` reason.
 * Bun.semver is used only for matching, after this validator passes — it
 * returns `true` for malformed ranges (`""`, `garbage`, `,`), so it cannot be
 * trusted to judge range validity.
 */
const RANGE_CMP = `(?:\\*|(?:<=|>=|<|>|=)?${SEMVER_CORE})`;
const RANGE_CMP_SET = `${RANGE_CMP}(?:\\s+${RANGE_CMP})*`;
const RANGE_RE = new RegExp(`^\\s*${RANGE_CMP_SET}(?:\\s*\\|\\|\\s*${RANGE_CMP_SET})*\\s*$`);
export function isValidVulnerableVersions(range: string): boolean {
  if (typeof range !== "string" || !RANGE_RE.test(range)) return false;
  // Bound every comparator's numeric components (single "=" comparator supported;
  // "=="/"===" are rejected by the regex because the second "=" fails SEMVER_CORE).
  for (const tok of range.trim().split(/\s*\|\|\s*|\s+/)) {
    if (tok === "" || tok === "*") continue;
    const v = tok.replace(/^(?:<=|>=|<|>|=)/, "");
    if (!versionComponentsBounded(v)) return false;
  }
  return true;
}

/** Split a lock key into segments, treating "@scope/name" as ONE segment. */
function splitKeySegments(key: string): string[] {
  const segs: string[] = [];
  let i = 0;
  while (i < key.length) {
    let end: number;
    if (key[i] === "@") {
      const firstSlash = key.indexOf("/", i);
      if (firstSlash < 0) {
        segs.push(key.slice(i));
        break;
      }
      const secondSlash = key.indexOf("/", firstSlash + 1);
      end = secondSlash < 0 ? key.length : secondSlash;
    } else {
      const slash = key.indexOf("/", i);
      end = slash < 0 ? key.length : slash;
    }
    segs.push(key.slice(i, end));
    if (end >= key.length) break;
    i = end + 1;
  }
  return segs;
}

function parentScope(key: string): string | null {
  const segs = splitKeySegments(key);
  if (segs.length <= 1) return null;
  return segs.slice(0, -1).join("/");
}

function scopeCandidates(parentKey: string, depName: string): string[] {
  const out: string[] = [];
  if (parentKey !== "") {
    let cur: string | null = parentKey;
    while (cur !== null) {
      out.push(`${cur}/${depName}`);
      cur = parentScope(cur);
    }
  }
  out.push(depName);
  return out;
}

/** True if `x` is a plain object (not array/null). */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

const INVALID = "invalid_section" as const;

/**
 * Validate one dependency section. Absent section → []. Section present but
 * not a plain object → INVALID (caller records invalid_lock_entry). Per-entry
 * violations (bad name / non-string or empty range) are recorded directly into
 * `errors` and the entry is dropped — never silently kept.
 */
function validateDepSection(
  sec: unknown,
  kind: EdgeKind,
  errors: LockIntegrityError[],
): readonly Edge[] | typeof INVALID {
  // Only undefined is "absent". Explicit null or any non-object is a violation.
  if (sec === undefined) return [];
  if (!isPlainObject(sec)) return INVALID;
  const edges: Edge[] = [];
  for (const [n, r] of Object.entries(sec)) {
    if (!isValidPackageName(n) || typeof r !== "string" || r.length === 0) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    edges.push({ name: n, range: r, kind });
  }
  return edges;
}

/**
 * Validate optionalPeers. Absent → empty set. Must be a string array; every
 * name must pass package-name validation AND be declared in peerDependencies.
 * Violations recorded into `errors` (package=null, never echoed).
 */
function validateOptionalPeers(
  raw: unknown,
  declaredPeers: ReadonlySet<string>,
  errors: LockIntegrityError[],
): { set: Set<string>; invalidSection: boolean } {
  // Only undefined is "absent". Explicit null or non-array is a violation.
  if (raw === undefined) return { set: new Set(), invalidSection: false };
  if (!Array.isArray(raw)) return { set: new Set(), invalidSection: true };
  const set = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string" || !isValidPackageName(p) || !declaredPeers.has(p)) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    set.add(p);
  }
  return { set, invalidSection: false };
}

type ResolveOk = { ok: true; lockKey: string; version: string };
type ResolveErr = { ok: false; reason: "missing_resolution" | "range_mismatch" };

export function resolveDependencyPaths(
  lockText: string,
  targetPackage: string,
): LockResolutionResult {
  const paths: ResolvedPath[] = [];
  const errors: LockIntegrityError[] = [];

  const parsed = parseConfigFileTextToJson("bun.lock", lockText);
  if (parsed.error || !parsed.config) {
    errors.push({ reason: "invalid_lock_json", package: null });
    return { paths, errors };
  }
  const lock = parsed.config as {
    workspaces?: unknown;
    packages?: unknown;
  };

  // Root workspace "" only; missing/illegal structure → fail closed.
  if (!isPlainObject(lock.workspaces)) {
    errors.push({ reason: "invalid_lock_json", package: null });
    return { paths, errors };
  }
  const rootWs = lock.workspaces[""];
  if (!isPlainObject(rootWs)) {
    errors.push({ reason: "invalid_lock_json", package: null });
    return { paths, errors };
  }

  // lock.packages: undefined → empty graph; null or non-object → invalid_lock_json.
  // (explicit null is NOT absent — only undefined is.)
  if (lock.packages !== undefined && !isPlainObject(lock.packages)) {
    errors.push({ reason: "invalid_lock_json", package: null });
    return { paths, errors };
  }
  const packagesRaw: Record<string, unknown> =
    lock.packages === undefined ? {} : lock.packages;

  const entries = new Map<string, PkgEntry>();
  for (const [lockKey, value] of Object.entries(packagesRaw)) {
    // tuple must be an array; descriptor a non-empty string with name@version;
    // metadata (value[2]) a plain object when present.
    if (!Array.isArray(value)) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    if (typeof value[0] !== "string" || value[0].length === 0) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    const split = splitResolved(value[0]);
    if (!split || split.version.length === 0 || !isValidPackageName(split.name) || !isExactSemver(split.version)) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    const segs = splitKeySegments(lockKey);
    if (
      segs.length === 0 ||
      !segs.every(isValidPackageName) ||
      (segs[segs.length - 1] as string) !== split.name
    ) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    // metadata (value[2]) MUST be a plain object — null/undefined/string/array
    // are all illegal (null is not absent). No `meta ?? {}` fallback.
    const meta = value[2];
    if (!isPlainObject(meta)) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      continue;
    }
    const m = meta;

    // Collect declared peer names first so optionalPeers can be checked against them.
    const declaredPeers = new Set<string>();
    const peersSec = m["peerDependencies"];
    if (isPlainObject(peersSec)) {
      for (const n of Object.keys(peersSec)) declaredPeers.add(n);
    }
    const opt = validateOptionalPeers(m["optionalPeers"], declaredPeers, errors);
    if (opt.invalidSection) {
      errors.push({ reason: "invalid_lock_entry", package: null });
    }

    const edges: Edge[] = [];
    for (const [sec, kind] of [
      ["dependencies", "dep"],
      ["optionalDependencies", "optional"],
      ["peerDependencies", "peer"],
    ] as const) {
      const r = validateDepSection(m[sec], kind, errors);
      if (r === INVALID) {
        errors.push({ reason: "invalid_lock_entry", package: null });
        continue;
      }
      for (const e of r) {
        edges.push(e.kind === "peer" && opt.set.has(e.name) ? { ...e, kind: "optional_peer" } : e);
      }
    }
    entries.set(lockKey, { lockKey, name: split.name, version: split.version, edges });
  }

  function resolve(parentKey: string, name: string, range: string): ResolveOk | ResolveErr {
    for (const cand of scopeCandidates(parentKey, name)) {
      const e = entries.get(cand);
      if (!e) continue;
      if (Bun.semver.satisfies(e.version, range)) {
        return { ok: true, lockKey: cand, version: e.version };
      }
      return { ok: false, reason: "range_mismatch" };
    }
    return { ok: false, reason: "missing_resolution" };
  }

  // Root edges via the shared section validator.
  interface RootEdge extends Edge {
    readonly root: RootClass;
  }
  const rootEdges: RootEdge[] = [];
  const pushSec = (sec: unknown, root: RootClass, kind: EdgeKind): void => {
    const r = validateDepSection(sec, kind, errors);
    if (r === INVALID) {
      errors.push({ reason: "invalid_lock_entry", package: null });
      return;
    }
    for (const e of r) rootEdges.push({ name: e.name, range: e.range, kind: e.kind, root });
  };
  pushSec(rootWs["dependencies"], "prod", "dep");
  pushSec(rootWs["optionalDependencies"], "prod", "optional");
  pushSec(rootWs["devDependencies"], "dev", "dep");

  const budget = Math.max(1024, Math.min(100_000, entries.size * 64));
  const maxDepth = entries.size + 2;
  let framesProcessed = 0;

  interface Frame {
    readonly lockKey: string;
    readonly name: string;
    readonly version: string;
    readonly nodes: readonly PathNode[];
    readonly optional: boolean;
    readonly root: RootClass;
    readonly visited: ReadonlySet<string>;
  }

  const recordError = (reason: LockIntegrityErrorReason, pkg: string): void => {
    errors.push({ reason, package: safePackage(pkg) });
  };

  const stack: Frame[] = [];
  for (const e of rootEdges) {
    const r = resolve("", e.name, e.range);
    if (!r.ok) {
      if (r.reason === "range_mismatch" || e.kind === "dep") {
        recordError(r.reason, e.name);
      }
      continue;
    }
    stack.push({
      lockKey: r.lockKey,
      name: e.name,
      version: r.version,
      nodes: [{ name: e.name, version: r.version }],
      optional: e.kind !== "dep",
      root: e.root,
      visited: new Set([r.lockKey]),
    });
  }

  while (stack.length > 0) {
    if (framesProcessed >= budget) {
      return { paths: [], errors: [{ reason: "traversal_limit_exceeded", package: null }] };
    }
    framesProcessed++;
    const f = stack.pop() as Frame;
    if (f.name === targetPackage) {
      paths.push({ root: f.root, optional: f.optional, nodes: f.nodes });
      continue;
    }
    if (f.nodes.length >= maxDepth) continue;
    const entry = entries.get(f.lockKey);
    if (!entry) continue;
    const ordered = [...entry.edges].sort(compareEdge);
    for (const edge of ordered) {
      const r = resolve(f.lockKey, edge.name, edge.range);
      if (!r.ok) {
        if (r.reason === "range_mismatch" || edge.kind === "dep" || edge.kind === "peer") {
          recordError(r.reason, edge.name);
        }
        continue;
      }
      if (f.visited.has(r.lockKey)) continue;
      const visited = new Set(f.visited);
      visited.add(r.lockKey);
      stack.push({
        lockKey: r.lockKey,
        name: edge.name,
        version: r.version,
        nodes: [...f.nodes, { name: edge.name, version: r.version }],
        optional: f.optional || edge.kind === "optional" || edge.kind === "optional_peer",
        root: f.root,
        visited,
      });
    }
  }

  const seenPath = new Set<string>();
  const dedupPaths: ResolvedPath[] = [];
  for (const p of paths.sort(comparePath)) {
    const k = `${p.root}|${p.optional}|${p.nodes.map((n) => `${n.name}@${n.version}`).join("→")}`;
    if (seenPath.has(k)) continue;
    seenPath.add(k);
    dedupPaths.push(p);
  }

  const seenErr = new Set<string>();
  const dedupErr: LockIntegrityError[] = [];
  for (const e of errors) {
    const k = `${e.reason}|${e.package ?? ""}`;
    if (seenErr.has(k)) continue;
    seenErr.add(k);
    dedupErr.push(e);
  }
  dedupErr.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    const pa = a.package ?? "";
    const pb = b.package ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });

  return { paths: dedupPaths, errors: dedupErr };
}

function compareEdge(a: Edge, b: Edge): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

function comparePath(a: ResolvedPath, b: ResolvedPath): number {
  if (a.root !== b.root) return a.root < b.root ? -1 : 1;
  if (a.optional !== b.optional) return a.optional ? 1 : -1;
  const an = a.nodes.map((n) => `${n.name}@${n.version}`).join("→");
  const bn = b.nodes.map((n) => `${n.name}@${n.version}`).join("→");
  if (an !== bn) return an < bn ? -1 : 1;
  return 0;
}
