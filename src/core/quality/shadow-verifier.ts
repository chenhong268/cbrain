// Shadow verifier — Phase 1 (#265).
//
// Two layers:
//  - Pure check functions (verifyNerExtraction / verifyDiscoveryCandidate /
//    summarizeShadowVerifierObservations): deterministic, zero runtime deps.
//  - Fail-open runners (runNerShadowVerifierFailOpen /
//    runDiscoveryShadowVerifierFailOpen): type-only imports, DB/logger injected.
//
// Privacy: persisted ingest_log rows hold ONLY the summary JSON
// (counts + reason codes + surface/type/worst). observations[].detail is
// in-memory only — never persisted.
//
// Task 1 lands ONLY the NER pure functions — no external imports yet (they
// would be unused and trip the lint gate at commit time). Tasks 2/4/5 add
// imports as the symbols they need come online.

export type VerifierSeverity = "info" | "warning" | "error";
export type VerifierSurface = "ner" | "discovery";

export interface ShadowVerifierObservation {
  surface: VerifierSurface;
  code: string;
  severity: VerifierSeverity;
  /** In-memory only. Counts/type-labels only — never raw names/slugs. Never persisted. */
  detail?: string;
}

export interface ShadowVerifierSummary {
  surface: VerifierSurface;
  type?: string;
  checks: number;
  counts: { info: number; warning: number; error: number };
  reasonCounts: Record<string, number>;
  worst: VerifierSeverity | "none";
}

export interface NerVerifierInput {
  bodyChars: number;
  entityCount: number;
  relationCount: number;
  eventCount: number;
  factCount: number;
  entities: Array<{ name: string; type: string }>;
  relations: Array<{ from: string; to: string }>;
  events: Array<{ date: string | null }>;
}

export interface DiscoveryVerifierInput {
  type: string;
  actionable: string;
  score: number;
  autoApplicable: boolean;
  hasEvidence: boolean;
  hasProposedActions: boolean;
  /** User-visible text only — checked against unsafe-display patterns. */
  displayTexts: string[];
}

const NER_CHECK_COUNT = 6;
const DISCOVERY_CHECK_COUNT = 5;
const ZERO_EXTRACTION_BODY_MIN = 500;
const HIGH_ENTITY_THRESHOLD_DIVISOR = 80;
const HIGH_ENTITY_THRESHOLD_FLOOR = 30;

function isValidDate(s: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  return !Number.isNaN(Date.parse(s));
}

export function verifyNerExtraction(input: NerVerifierInput): ShadowVerifierObservation[] {
  const obs: ShadowVerifierObservation[] = [];

  // 1. ner_zero_from_long_body
  if (
    input.bodyChars > ZERO_EXTRACTION_BODY_MIN &&
    input.entityCount === 0 &&
    input.relationCount === 0 &&
    input.eventCount === 0 &&
    input.factCount === 0
  ) {
    obs.push({
      surface: "ner",
      code: "ner_zero_from_long_body",
      severity: "error",
      detail: `bodyChars=${input.bodyChars}`,
    });
  }

  // 2. ner_relation_endpoint_missing
  const names = new Set(input.entities.map((e) => e.name));
  let endpointMissing = 0;
  for (const r of input.relations) {
    if (r.from && !names.has(r.from)) endpointMissing++;
    if (r.to && !names.has(r.to)) endpointMissing++;
  }
  if (endpointMissing > 0) {
    obs.push({
      surface: "ner",
      code: "ner_relation_endpoint_missing",
      severity: "warning",
      detail: `${endpointMissing} endpoints not in extracted entities`,
    });
  }

  // 3. ner_extraction_unusually_high (conservative: max(30, floor(bodyChars/80)))
  const highThreshold = Math.max(
    HIGH_ENTITY_THRESHOLD_FLOOR,
    Math.floor(input.bodyChars / HIGH_ENTITY_THRESHOLD_DIVISOR),
  );
  if (input.entityCount > highThreshold) {
    obs.push({
      surface: "ner",
      code: "ner_extraction_unusually_high",
      severity: "warning",
      detail: `${input.entityCount} > ${highThreshold} (bodyChars=${input.bodyChars})`,
    });
  }

  // 4. ner_duplicate_name_conflicting_type
  const nameTypes = new Map<string, Set<string>>();
  for (const e of input.entities) {
    const set = nameTypes.get(e.name) ?? new Set<string>();
    set.add(e.type);
    nameTypes.set(e.name, set);
  }
  let dupConflicts = 0;
  for (const types of nameTypes.values()) {
    if (types.size > 1) dupConflicts++;
  }
  if (dupConflicts > 0) {
    obs.push({
      surface: "ner",
      code: "ner_duplicate_name_conflicting_type",
      severity: "warning",
      detail: `${dupConflicts} names with conflicting types`,
    });
  }

  // 5. ner_invalid_entity_field
  let invalidFields = 0;
  for (const e of input.entities) {
    if (!e.name || !e.name.trim() || !e.type || !e.type.trim()) invalidFields++;
  }
  if (invalidFields > 0) {
    obs.push({
      surface: "ner",
      code: "ner_invalid_entity_field",
      severity: "warning",
      detail: `${invalidFields} entities with empty name/type`,
    });
  }

  // 6. ner_invalid_event_date
  let badDates = 0;
  for (const ev of input.events) {
    if (ev.date && ev.date.trim() && !isValidDate(ev.date)) badDates++;
  }
  if (badDates > 0) {
    obs.push({
      surface: "ner",
      code: "ner_invalid_event_date",
      severity: "info",
      detail: `${badDates} events with malformed date`,
    });
  }

  return obs;
}

export function summarizeShadowVerifierObservations(
  surface: VerifierSurface,
  observations: ShadowVerifierObservation[],
  type?: string,
): ShadowVerifierSummary {
  const counts = { info: 0, warning: 0, error: 0 };
  const reasonCounts: Record<string, number> = {};
  for (const o of observations) {
    counts[o.severity]++;
    reasonCounts[o.code] = (reasonCounts[o.code] ?? 0) + 1;
  }
  const worst: VerifierSeverity | "none" =
    counts.error > 0 ? "error" : counts.warning > 0 ? "warning" : counts.info > 0 ? "info" : "none";
  const checks = surface === "ner" ? NER_CHECK_COUNT : DISCOVERY_CHECK_COUNT;
  return { surface, type, checks, counts, reasonCounts, worst };
}
