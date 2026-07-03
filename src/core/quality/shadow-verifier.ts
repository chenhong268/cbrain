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
//
// Task 2 adds the first external import: DISPLAY_UNSAFE_PATTERNS from the
// neutral core/safety/display-safety module, used to scan user-visible
// discovery display texts for private/internal refs (privacy invariant:
// detail holds counts only). Lives under core/safety/ to avoid a
// quality <-> maintenance circular import.

import { DISPLAY_UNSAFE_PATTERNS } from "../safety/display-safety.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { Logger } from "../logger.js";
import type { ExtractionResult } from "../ingestion/ner.js";
import { sanitizeForLog } from "../safety/sync-index-safety.js";

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

export function verifyDiscoveryCandidate(input: DiscoveryVerifierInput): ShadowVerifierObservation[] {
  const obs: ShadowVerifierObservation[] = [];
  const isActionType = input.type.startsWith("action_");

  // 1. discovery_high_actionable_no_evidence
  if (input.actionable === "high" && !input.hasEvidence && !input.hasProposedActions) {
    obs.push({
      surface: "discovery",
      code: "discovery_high_actionable_no_evidence",
      severity: "error",
      detail: `type=${input.type}`,
    });
  }

  // 2. discovery_auto_applicable_on_review_type
  if (input.autoApplicable && isActionType) {
    obs.push({
      surface: "discovery",
      code: "discovery_auto_applicable_on_review_type",
      severity: "error",
      detail: `type=${input.type}`,
    });
  }

  // 3. discovery_score_out_of_range (covers score AND unknown actionable)
  const knownActionable =
    input.actionable === "high" || input.actionable === "medium" || input.actionable === "low";
  if (input.score < 0 || input.score > 1 || !knownActionable) {
    obs.push({
      surface: "discovery",
      code: "discovery_score_out_of_range",
      severity: "warning",
      detail: `score=${input.score} actionable=${input.actionable}`,
    });
  }

  // 4. discovery_display_missing_fields
  if (isActionType && input.displayTexts.every((t) => !t || !t.trim())) {
    obs.push({
      surface: "discovery",
      code: "discovery_display_missing_fields",
      severity: "warning",
      detail: `type=${input.type}`,
    });
  }

  // 5. discovery_display_private_raw — user-visible texts only
  let unsafeHits = 0;
  for (const text of input.displayTexts) {
    if (!text) continue;
    for (const pattern of DISPLAY_UNSAFE_PATTERNS) {
      if (pattern.test(text)) unsafeHits++;
    }
  }
  if (unsafeHits > 0) {
    obs.push({
      surface: "discovery",
      code: "discovery_display_private_raw",
      severity: "warning",
      detail: `${unsafeHits} unsafe display matches`,
    });
  }

  return obs;
}

// ─── Fail-open runners (Task 4: NER) ───────────────────────────────────────
//
// #265: shadow verifier runs AFTER extract() and BEFORE the empty-extraction
// early-return in ContentPipeline.processNer, so a long body producing zero
// extraction gets flagged. Fail-open is absolute: a thrown verifier MUST NEVER
// prevent the ingest/NER write or roll back already-applied writes. The runner
// catches everything; the caller's write path is independent of the verifier.
//
// Kill switch: CBRAIN_SHADOW_VERIFIER_DISABLE=1 reads process.env EACH call
// (NOT cached at module load) so tests can toggle it in-process without flake.

function isVerifierDisabled(): boolean {
  return process.env.CBRAIN_SHADOW_VERIFIER_DISABLE === "1";
}

/** Redact raw extraction tokens (entity names / slug / relation endpoints) from
 *  an error message before it reaches the warn context. Mirrors the redaction
 *  approach in pipeline.ts (~L454-473): sanitizeForLog handles absolute paths +
 *  credential-like tokens; this pass additionally redacts relative slugs/entity
 *  names that sanitizeForLog's path regex does not match. */
function sanitizeVerifierError(
  rawMessage: string,
  slug: string | null,
  extraction?: ExtractionResult,
  displayTexts?: string[],
): string {
  let safe = sanitizeForLog(rawMessage);
  const tokens = new Set<string>();
  if (slug) tokens.add(slug);
  if (extraction) {
    for (const e of extraction.entities) {
      tokens.add(e.name);
      if (e.context) tokens.add(e.context);
    }
    for (const f of extraction.filtered ?? []) tokens.add(f.name);
    for (const r of extraction.relations) {
      tokens.add(r.from);
      tokens.add(r.to);
      if (r.context) tokens.add(r.context);
    }
    for (const ev of extraction.events) {
      if (ev.description) tokens.add(ev.description);
      for (const p of ev.participants ?? []) tokens.add(p);
    }
    for (const fa of extraction.facts) {
      tokens.add(fa.entity);
      tokens.add(fa.value);
      tokens.add(fa.evidence);
    }
  }
  if (displayTexts) for (const t of displayTexts) { if (t && t.length >= 2) tokens.add(t); }
  for (const token of tokens) {
    if (token && token.length >= 2) safe = safe.split(token).join("<redacted>");
  }
  return safe;
}

export function runNerShadowVerifierFailOpen(opts: {
  db: CBrainDB;
  logger?: Logger | null;
  slug: string;
  bodyChars: number;
  extraction: ExtractionResult;
}): void {
  if (isVerifierDisabled()) return;
  try {
    const input: NerVerifierInput = {
      bodyChars: opts.bodyChars,
      entityCount: opts.extraction.entities.length,
      relationCount: opts.extraction.relations.length,
      eventCount: opts.extraction.events.length,
      factCount: opts.extraction.facts.length,
      entities: opts.extraction.entities.map((e) => ({ name: e.name, type: e.type })),
      relations: opts.extraction.relations.map((r) => ({ from: r.from, to: r.to })),
      events: opts.extraction.events.map((e) => ({ date: e.date })),
    };
    const observations = verifyNerExtraction(input);
    const summary = summarizeShadowVerifierObservations("ner", observations);
    // Privacy: persisted row holds ONLY summary JSON (counts + reason codes +
    // surface + worst + checks). No observations[].detail, no raw names. The
    // slug column legitimately holds fromSlug (ingest_log audit semantic).
    opts.db.addIngestLog("verifier", "ner_shadow_verifier", opts.slug, JSON.stringify(summary));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = sanitizeVerifierError(raw, opts.slug, opts.extraction);
    opts.logger?.warn("pipeline", "ner shadow verifier failed (fail-open, ignored)", { error: safe });
  }
}

// ─── Fail-open runner (Task 5: discovery) ───────────────────────────────────
//
// #265: discovery shadow verifier runs at all three upsertDiscovery sites —
// runDiscovery upsert loop, runSimilarEntityDetection upsert loop, and
// ActionCandidateManager.persistDrafts. The runner is fail-open absolute: a
// thrown verifier MUST NEVER block the upsert/persist. page_slug is ALWAYS
// null for discovery rows — discovery has no page affinity and the row must
// never carry dedup_key/slug/entity-refs/title/display-text. Only the summary
// JSON (counts + reason codes + type + worst) is persisted.

export function runDiscoveryShadowVerifierFailOpen(opts: {
  db: CBrainDB;
  logger?: Logger | null;
  input: DiscoveryVerifierInput;
}): void {
  if (isVerifierDisabled()) return;
  try {
    const observations = verifyDiscoveryCandidate(opts.input);
    const summary = summarizeShadowVerifierObservations("discovery", observations, opts.input.type);
    // page_slug=null: discovery rows have no page affinity; never write
    // dedup_key/slug/entities/title/display text — only the summary JSON.
    opts.db.addIngestLog("verifier", "discovery_shadow_verifier", null, JSON.stringify(summary));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = sanitizeVerifierError(raw, null, undefined, opts.input.displayTexts);
    opts.logger?.warn("discovery", "discovery shadow verifier failed (fail-open, ignored)", { error: safe });
  }
}
