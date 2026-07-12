import { canonicalJson, normalizeProse, sha256Hex } from "./canonical.js";
import type { DecisionInputs, DependencyDeclaration, ProposedAction, RecommendationConclusion, RecommendationImmutablePayload, RecommendationRecord } from "./types.js";

export type IntegrityCode =
  | "inputs_hash_mismatch"
  | "fingerprint_mismatch"
  | "cross_undeclared_field"
  | "cross_evidence_not_projected"
  | "cross_rule_id_mismatch"
  | "duplicate_declaration"
  | "illegal_action_type";

export type IntegrityResult = { ok: true } | { ok: false; code: IntegrityCode; message: string };

/** Shared per-entry duplicate guard: (slug ?? __global__) + as must be unique. Thrown path uses a
 *  regex-friendly message matched by tests; the same fn is reused by projection (Task 9). */
export function validateDependencyDeclarations(declarations: DependencyDeclaration[]): void {
  const seen = new Set<string>();
  for (const d of declarations) {
    const key = `${d.slug ?? "__global__"}::${d.as}`;
    if (seen.has(key)) throw new Error(`integrity: duplicate (slug,as) ${key}`);
    seen.add(key);
  }
}

/** Canonical projection of a declaration: only present optionals are emitted (spec §6.2). */
export function canonicalDeclaration(d: DependencyDeclaration): Record<string, unknown> {
  const out: Record<string, unknown> = { table: d.table, as: d.as, fields: [...d.fields].sort() };
  if (d.slug !== undefined) out.slug = d.slug;
  if (d.relation !== undefined) out.relation = d.relation;
  if (d.direction !== undefined) out.direction = d.direction;
  if (d.filter !== undefined) out.filter = d.filter;
  return out;
}

export function computeInputsHash(di: DecisionInputs): string {
  return sha256Hex(canonicalJson({ signals: di.signals, inspected_claims: (di.inspected_claims ?? []).map(normalizeProse), entity_snapshot: di.entity_snapshot, evidence_refs: [...di.evidence_refs].sort() }));
}

export function computeFingerprint(p: RecommendationImmutablePayload): string {
  return sha256Hex(canonicalJson(canonicalPayload(p)));
}

function canonicalPayload(p: RecommendationImmutablePayload): unknown {
  validateDependencyDeclarations(p.dependency_manifest.declarations);
  return {
    namespace: p.namespace,
    maintenance_key: p.maintenance_key,
    inputs_hash: p.inputs_hash,
    conclusion: canonicalConclusion(p.conclusion),
    decision_inputs: { signals: p.decision_inputs.signals, inspected_claims: (p.decision_inputs.inspected_claims ?? []).map(normalizeProse), entity_snapshot: p.decision_inputs.entity_snapshot, evidence_refs: [...p.decision_inputs.evidence_refs].sort() },
    evidence_manifest: p.evidence_manifest.map((e) => ({ source: e.source, ref: e.ref, trust_state: e.trust_state })),
    constraints: p.constraints,
    dependency_manifest: { rule_id: p.dependency_manifest.rule_id, declarations: p.dependency_manifest.declarations.map(canonicalDeclaration) },
    applicability: p.applicability,
    risks: p.risks.map(normalizeProse),
    gaps: p.gaps.map(normalizeProse),
    producer: p.producer,
  };
}

function canonicalConclusion(c: RecommendationConclusion): unknown {
  if (c.kind === "abstain") return { kind: "abstain", reason: c.reason };
  const a: Record<string, unknown> = { type: c.action.type, target_ref: c.action.target_ref, reason: normalizeProse(c.action.reason) };
  if (c.action.rollback_note !== undefined) a.rollback_note = normalizeProse(c.action.rollback_note);
  return { kind: "propose", action: a, alternatives: c.alternatives.map((x) => {
    const o: Record<string, unknown> = { type: x.type, target_ref: x.target_ref, reason: normalizeProse(x.reason) };
    if (x.rollback_note !== undefined) o.rollback_note = normalizeProse(x.rollback_note);
    return o;
  }) };
}

/** Spec §15 #5 / F13: a proposal's action type must be in the read-only whitelist. This is a
 *  RUNTIME guard — the ActionType type alias is erased, and a DB-tampered type would otherwise
 *  yield a self-consistent fingerprint (canonicalPayload hashes whatever is present). Enforced in
 *  checkIntegrity so it bites at BOTH createRecord (reject) and display-load (block). */
const ACTION_TYPES: ReadonlySet<string> = new Set(["review", "dry_run", "notify_draft"]);

function validateConclusionActionTypes(c: RecommendationConclusion): void {
  if (c.kind === "abstain") return;
  if (!ACTION_TYPES.has(c.action.type)) throw new Error(`integrity: illegal action.type '${c.action.type}'`);
  for (const alt of c.alternatives) {
    if (!ACTION_TYPES.has(alt.type)) throw new Error(`integrity: illegal alternative action.type '${alt.type}'`);
  }
}

/**
 * Normalize the prose fields of an immutable payload (NFKC + whitespace fold). MUST cover exactly
 * the same fields `canonicalPayload` normalizes for fingerprinting, so that the persisted/returned
 * payload is byte-identical to what was hashed. Without this, a fullwidth internal term like
 * "ｓｃｏｒｅ" hashes as ascii "score" (fingerprint passes) yet persists raw and bypasses the display
 * safety guard (which matches /\bscore\b/i on ascii only). Identifiers (refs/slug/source/...) are
 * left untouched — only prose fields normalize. Returns a new payload (immutable). */
export function normalizePayloadProse(p: RecommendationImmutablePayload): RecommendationImmutablePayload {
  const conclusion: RecommendationConclusion = p.conclusion.kind === "abstain"
    ? p.conclusion
    : { kind: "propose", action: normalizeActionProse(p.conclusion.action), alternatives: p.conclusion.alternatives.map(normalizeActionProse) };
  return {
    ...p,
    conclusion,
    decision_inputs: {
      ...p.decision_inputs,
      ...(p.decision_inputs.inspected_claims !== undefined ? { inspected_claims: p.decision_inputs.inspected_claims.map(normalizeProse) } : {}),
    },
    risks: p.risks.map(normalizeProse),
    gaps: p.gaps.map(normalizeProse),
  };
}

function normalizeActionProse(a: ProposedAction): ProposedAction {
  const out: ProposedAction = { type: a.type, target_ref: a.target_ref, reason: normalizeProse(a.reason) };
  if (a.rollback_note !== undefined) out.rollback_note = normalizeProse(a.rollback_note);
  return out;
}

export function checkIntegrity(r: RecommendationRecord): IntegrityResult {
  try {
    validateConclusionActionTypes(r.payload.conclusion);
  } catch {
    return { ok: false, code: "illegal_action_type", message: "non-whitelist action type" };
  }
  try {
    validateDependencyDeclarations(r.payload.dependency_manifest.declarations);
  } catch {
    return { ok: false, code: "duplicate_declaration", message: "duplicate declaration" };
  }
  if (computeInputsHash(r.payload.decision_inputs) !== r.payload.inputs_hash) return { ok: false, code: "inputs_hash_mismatch", message: "inputs_hash mismatch" };
  if (computeFingerprint(r.payload) !== r.fingerprint) return { ok: false, code: "fingerprint_mismatch", message: "fingerprint mismatch" };
  return checkCrossConsistency(r.payload);
}

function checkCrossConsistency(p: RecommendationImmutablePayload): IntegrityResult {
  const declared = new Map<string, Map<string, Set<string>>>();
  for (const d of p.dependency_manifest.declarations) {
    const key = d.slug ?? "__global__";
    const m = declared.get(key) ?? new Map<string, Set<string>>();
    m.set(d.as, new Set(d.fields));
    declared.set(key, m);
  }
  for (const [slug, snap] of Object.entries(p.decision_inputs.entity_snapshot)) {
    const allowed = declared.get(slug);
    if (!allowed) return { ok: false, code: "cross_undeclared_field", message: "slug not declared" };
    for (const asKey of Object.keys(snap as object)) {
      const fs = allowed.get(asKey);
      if (!fs) return { ok: false, code: "cross_undeclared_field", message: "undeclared projection key" };
      const v = (snap as Record<string, unknown>)[asKey];
      const els = Array.isArray(v) ? v : [v];
      for (const el of els) {
        if (el && typeof el === "object") {
          for (const f of Object.keys(el as object)) {
            if (!fs.has(f)) return { ok: false, code: "cross_undeclared_field", message: "undeclared field" };
          }
        }
      }
    }
  }
  const refs = new Set(p.decision_inputs.evidence_refs);
  for (const e of p.evidence_manifest) {
    if (!refs.has(e.ref)) return { ok: false, code: "cross_evidence_not_projected", message: "evidence ref not projected" };
  }
  if (p.dependency_manifest.rule_id !== p.producer.rule_id) return { ok: false, code: "cross_rule_id_mismatch", message: "rule_id mismatch" };
  return { ok: true };
}
