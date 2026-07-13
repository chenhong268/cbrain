import { canonicalJson } from "./canonical.js";
import type { RecommendationRecordReader } from "./record-reader.js";
import type { DependencyDeclaration, ProposedAction, RecommendationRecord } from "./types.js";

export type DiffAxis = "evidence" | "constraint" | "option" | "dependency" | "conclusion";
export type DiffChange = "added" | "removed" | "changed";

export interface DiffEntry {
  readonly axis: DiffAxis;
  readonly key: string;
  readonly change: DiffChange;
  readonly before: string;
  readonly after: string;
}

export type DiffOutcome =
  | { ok: true; entries: DiffEntry[] }
  | { ok: false; reason: "not_found" | "integrity_failed" | "incomparable" };

type InternalDiffResult =
  | { ok: true; entries: DiffEntry[] }
  | { ok: false; reason: "incomparable" };

const AXIS_ORDER: Readonly<Record<DiffAxis, number>> = {
  evidence: 0,
  constraint: 1,
  option: 2,
  dependency: 3,
  conclusion: 4,
};

const CHANGE_ORDER: Readonly<Record<DiffChange, number>> = {
  added: 0,
  changed: 1,
  removed: 2,
};

const MISSING = Symbol("missing");
type ComparableValue = unknown | typeof MISSING;

export function diffRecordsById(reader: RecommendationRecordReader, idA: string, idB: string): DiffOutcome {
  let left: RecommendationRecord | null;
  let right: RecommendationRecord | null;
  try {
    left = reader.getById(idA);
    if (!left) return { ok: false, reason: "not_found" };
    right = reader.getById(idB);
    if (!right) return { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "integrity_failed" };
  }
  return diffTrustedRecords(left, right);
}

function diffTrustedRecords(left: RecommendationRecord, right: RecommendationRecord): InternalDiffResult {
  const a = left.payload;
  const b = right.payload;
  if (a.namespace !== b.namespace || a.maintenance_key !== b.maintenance_key) {
    return { ok: false, reason: "incomparable" };
  }

  const entries: DiffEntry[] = [];
  diffEvidence(entries, a.evidence_manifest, b.evidence_manifest);
  diffConstraints(entries, a, b);
  diffOptions(entries, a.conclusion.kind === "propose" ? a.conclusion.alternatives : [], b.conclusion.kind === "propose" ? b.conclusion.alternatives : []);
  diffDependencies(entries, a, b);
  diffConclusion(entries, a.conclusion, b.conclusion);
  return { ok: true, entries: dedupeAndSort(entries) };
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointer(...segments: string[]): string {
  return `/${segments.map(escapePointerSegment).join("/")}`;
}

function addValue(entries: DiffEntry[], axis: DiffAxis, key: string, before: ComparableValue, after: ComparableValue): void {
  if (before === MISSING && after === MISSING) return;
  if (before === MISSING) {
    entries.push({ axis, key, change: "added", before: "", after: canonicalJson(after) });
    return;
  }
  if (after === MISSING) {
    entries.push({ axis, key, change: "removed", before: canonicalJson(before), after: "" });
    return;
  }
  const a = canonicalJson(before);
  const b = canonicalJson(after);
  if (a !== b) entries.push({ axis, key, change: "changed", before: a, after: b });
}

function addMappedSet(entries: DiffEntry[], axis: DiffAxis, before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): void {
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    addValue(entries, axis, key, before.has(key) ? before.get(key) : MISSING, after.has(key) ? after.get(key) : MISSING);
  }
}

function mapCanonicalMembers<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) out.set(key(item), item);
  return out;
}

function mapGroupedMembers<T>(items: readonly T[], key: (item: T) => string): Map<string, unknown> {
  const groups = new Map<string, Map<string, T>>();
  for (const item of items) {
    const groupKey = key(item);
    const values = groups.get(groupKey) ?? new Map<string, T>();
    values.set(canonicalJson(item), item);
    groups.set(groupKey, values);
  }
  const out = new Map<string, unknown>();
  for (const [groupKey, values] of groups) {
    const sorted = [...values.entries()].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value);
    out.set(groupKey, sorted.length === 1 ? sorted[0] : sorted);
  }
  return out;
}

function diffEvidence(
  entries: DiffEntry[],
  before: RecommendationRecord["payload"]["evidence_manifest"],
  after: RecommendationRecord["payload"]["evidence_manifest"],
): void {
  const toMap = (items: typeof before) => mapGroupedMembers(items, (entry) => pointer("evidence_manifest", entry.source, entry.ref));
  addMappedSet(entries, "evidence", toMap(before), toMap(after));
}

function diffConstraints(entries: DiffEntry[], a: RecommendationRecord["payload"], b: RecommendationRecord["payload"]): void {
  for (const field of ["policy_version", "ontology_version", "schema_version"] as const) {
    addValue(entries, "constraint", pointer("constraints", field), a.constraints[field], b.constraints[field]);
  }
  for (const field of ["rule_id", "rule_version", "code_hash", "registry_ref"] as const) {
    addValue(entries, "constraint", pointer("producer", field), a.producer[field], b.producer[field]);
  }
  addValue(entries, "constraint", pointer("applicability", "audience"), a.applicability.audience, b.applicability.audience);
  addValue(entries, "constraint", pointer("applicability", "auto_execute"), a.applicability.auto_execute, b.applicability.auto_execute);
  const ac = a.applicability.requires_confirmation;
  const bc = b.applicability.requires_confirmation;
  addValue(entries, "constraint", pointer("applicability", "requires_confirmation", "tier"), ac.tier, bc.tier);
  addValue(entries, "constraint", pointer("applicability", "requires_confirmation", "reason"), ac.tier === "high_impact" ? ac.reason : MISSING, bc.tier === "high_impact" ? bc.reason : MISSING);
  const confirmations = (value: typeof ac) => value.tier === "high_impact" ? value.confirm : [];
  addMappedSet(entries, "constraint", canonicalStringSet(confirmations(ac), "applicability", "requires_confirmation", "confirm"), canonicalStringSet(confirmations(bc), "applicability", "requires_confirmation", "confirm"));
  addMappedSet(entries, "constraint", canonicalStringSet(a.risks, "risks"), canonicalStringSet(b.risks, "risks"));
  addMappedSet(entries, "constraint", canonicalStringSet(a.gaps, "gaps"), canonicalStringSet(b.gaps, "gaps"));
}

function canonicalStringSet(values: readonly string[], ...prefix: string[]): Map<string, string> {
  return mapCanonicalMembers(values, (value) => pointer(...prefix, canonicalJson(value)));
}

function identifierSet(values: readonly string[], ...prefix: string[]): Map<string, string> {
  return mapCanonicalMembers(values, (value) => pointer(...prefix, value));
}

function diffOptions(entries: DiffEntry[], before: readonly ProposedAction[], after: readonly ProposedAction[]): void {
  const toMap = (items: readonly ProposedAction[]) => mapCanonicalMembers(items, (action) => pointer("conclusion", "alternatives", canonicalJson(action)));
  addMappedSet(entries, "option", toMap(before), toMap(after));
}

function diffDependencies(entries: DiffEntry[], a: RecommendationRecord["payload"], b: RecommendationRecord["payload"]): void {
  if (a.inputs_hash !== b.inputs_hash) {
    addMappedSet(entries, "dependency", objectMap(a.decision_inputs.signals, "decision_inputs", "signals"), objectMap(b.decision_inputs.signals, "decision_inputs", "signals"));
    addMappedSet(entries, "dependency", entitySnapshotMap(a.decision_inputs.entity_snapshot), entitySnapshotMap(b.decision_inputs.entity_snapshot));
    addMappedSet(entries, "dependency", identifierSet(a.decision_inputs.evidence_refs, "decision_inputs", "evidence_refs"), identifierSet(b.decision_inputs.evidence_refs, "decision_inputs", "evidence_refs"));
    addMappedSet(entries, "dependency", identifierSet(a.decision_inputs.inspected_claims ?? [], "decision_inputs", "inspected_claims"), identifierSet(b.decision_inputs.inspected_claims ?? [], "decision_inputs", "inspected_claims"));
  }
  addMappedSet(entries, "dependency", declarationMap(a.dependency_manifest.declarations), declarationMap(b.dependency_manifest.declarations));
}

function objectMap(value: Readonly<Record<string, unknown>>, ...prefix: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, item] of Object.entries(value)) out.set(pointer(...prefix, key), item);
  return out;
}

function entitySnapshotMap(value: RecommendationRecord["payload"]["decision_inputs"]["entity_snapshot"]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [slug, projection] of Object.entries(value)) {
    for (const [as, item] of Object.entries(projection)) out.set(pointer("decision_inputs", "entity_snapshot", slug, as), item);
  }
  return out;
}

function declarationMap(declarations: readonly DependencyDeclaration[]): Map<string, DependencyDeclaration> {
  const out = new Map<string, DependencyDeclaration>();
  for (const declaration of declarations) {
    const key = declaration.slug === undefined
      ? pointer("dependency_manifest", "declarations", "global", declaration.as)
      : pointer("dependency_manifest", "declarations", "slug", declaration.slug, declaration.as);
    out.set(key, declaration);
  }
  return out;
}

function diffConclusion(
  entries: DiffEntry[],
  a: RecommendationRecord["payload"]["conclusion"],
  b: RecommendationRecord["payload"]["conclusion"],
): void {
  addValue(entries, "conclusion", pointer("conclusion", "kind"), a.kind, b.kind);
  for (const field of ["type", "target_ref", "reason", "rollback_note"] as const) {
    const av = a.kind === "propose" && a.action[field] !== undefined ? a.action[field] : MISSING;
    const bv = b.kind === "propose" && b.action[field] !== undefined ? b.action[field] : MISSING;
    addValue(entries, "conclusion", pointer("conclusion", "action", field), av, bv);
  }
  addValue(entries, "conclusion", pointer("conclusion", "reason"), a.kind === "abstain" ? a.reason : MISSING, b.kind === "abstain" ? b.reason : MISSING);
}

function dedupeAndSort(entries: readonly DiffEntry[]): DiffEntry[] {
  const unique = new Map<string, DiffEntry>();
  for (const entry of entries) unique.set(canonicalJson(entry), entry);
  return [...unique.values()].sort(compareEntry);
}

function compareEntry(a: DiffEntry, b: DiffEntry): number {
  return AXIS_ORDER[a.axis] - AXIS_ORDER[b.axis]
    || compareText(a.key, b.key)
    || CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change]
    || compareText(a.before, b.before)
    || compareText(a.after, b.after);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
