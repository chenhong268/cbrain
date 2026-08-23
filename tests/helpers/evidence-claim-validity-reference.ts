export type TemporalPrecision = "instant" | "day" | "month" | "year" | "approximate";

export interface TemporalPoint {
  value: string;
  precision: TemporalPrecision;
  timezone: string;
  earliestMs: number;
  latestExclusiveMs: number;
}

export type ValidityState = "unknown" | "scheduled" | "effective" | "expired" | "superseded" | "revoked";

export interface ClaimTransition {
  kind: "supersedes" | "revokes";
  oldClaimId: string;
  newClaimId?: string;
  confirmationState: "candidate" | "confirmed" | "rejected";
  effectiveAt?: TemporalPoint;
  recordedAt?: TemporalPoint;
}

export interface ValidityResult {
  state: ValidityState;
  temporalCertainty: "known" | "unknown";
  transitionConflict: boolean;
}

interface ReduceClaimValidityInput {
  claimId: string;
  asOf: TemporalPoint;
  validFrom?: TemporalPoint;
  validTo?: TemporalPoint;
  transitions: ClaimTransition[];
}

const offsetMs = (timezone: string): number => {
  if (timezone === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) throw new Error(`invalid_timezone: ${timezone}`);
  const amount = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return match[1] === "+" ? amount : -amount;
};

const startOf = (value: string, precision: Exclude<TemporalPrecision, "approximate">, timezone: string): number => {
  if (precision === "instant") return Date.parse(value);
  const match = precision === "day"
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : precision === "month"
      ? /^(\d{4})-(\d{2})$/.exec(value)
      : /^(\d{4})$/.exec(value);
  if (!match) throw new Error(`invalid_${precision}: ${value}`);
  const year = Number(match[1]);
  const month = precision === "year" ? 1 : Number(match[2]);
  const day = precision === "day" ? Number(match[3]) : 1;
  return Date.UTC(year, month - 1, day) - offsetMs(timezone);
};

const calendarParts = (value: string, precision: Exclude<TemporalPrecision, "instant" | "approximate">): [number, number, number] => {
  const match = precision === "day"
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : precision === "month"
      ? /^(\d{4})-(\d{2})$/.exec(value)
      : /^(\d{4})$/.exec(value);
  if (!match) throw new Error(`invalid_${precision}: ${value}`);
  return [Number(match[1]), precision === "year" ? 1 : Number(match[2]), precision === "day" ? Number(match[3]) : 1];
};

export const temporalPoint = (value: string, precision: TemporalPrecision, timezone: string): TemporalPoint => {
  if (precision === "approximate") throw new Error("approximate_requires_interval");
  const earliestMs = startOf(value, precision, timezone);
  const latestExclusiveMs = precision === "instant"
    ? earliestMs
    : (() => {
        const [year, month, day] = calendarParts(value, precision);
        if (precision === "day") return Date.UTC(year, month - 1, day + 1) - offsetMs(timezone);
        if (precision === "month") return Date.UTC(year, month, 1) - offsetMs(timezone);
        return Date.UTC(year + 1, 0, 1) - offsetMs(timezone);
      })();
  return { value, precision, timezone, earliestMs, latestExclusiveMs };
};

export const approximatePoint = (value: string, timezone: string, earliest: string, latestExclusive: string): TemporalPoint => ({
  value,
  precision: "approximate",
  timezone,
  earliestMs: Date.parse(earliest),
  latestExclusiveMs: Date.parse(latestExclusive),
});

const crossed = (point: TemporalPoint | undefined, asOf: TemporalPoint): boolean => point !== undefined && asOf.earliestMs >= point.latestExclusiveMs;
const ambiguous = (point: TemporalPoint | undefined, asOf: TemporalPoint): boolean => point !== undefined && point.earliestMs < asOf.latestExclusiveMs && asOf.earliestMs < point.latestExclusiveMs;

export const reduceClaimValidity = ({ claimId, asOf, validFrom, validTo, transitions }: ReduceClaimValidityInput): ValidityResult => {
  if (validFrom && validTo && validFrom.latestExclusiveMs > validTo.earliestMs) throw new Error("invalid_or_ambiguous_valid_interval");
  const confirmed = transitions.filter((transition) => transition.oldClaimId === claimId && transition.confirmationState === "confirmed" && transition.effectiveAt);
  const crossedRevocation = confirmed.some((transition) => transition.kind === "revokes" && crossed(transition.effectiveAt, asOf));
  const crossedSupersession = confirmed.some((transition) => transition.kind === "supersedes" && crossed(transition.effectiveAt, asOf));
  if (crossedRevocation) return { state: "revoked", temporalCertainty: "known", transitionConflict: crossedSupersession };
  if (crossedSupersession) return { state: "superseded", temporalCertainty: "known", transitionConflict: false };
  if (confirmed.some((transition) => ambiguous(transition.effectiveAt, asOf))) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom && asOf.latestExclusiveMs <= validFrom.earliestMs) return { state: "scheduled", temporalCertainty: "known", transitionConflict: false };
  if (validFrom && ambiguous(validFrom, asOf)) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validTo && crossed(validTo, asOf)) return { state: "expired", temporalCertainty: "known", transitionConflict: false };
  if (validTo && ambiguous(validTo, asOf)) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom || validTo) return { state: "effective", temporalCertainty: "known", transitionConflict: false };
  return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
};

export type ClaimKind = "fact" | "inference";
export type ClaimTrust = "candidate" | "trusted" | "rejected";
export type EvidenceStance = "supports" | "contradicts" | "limits";
export type EvidenceVerificationState = "verified" | "unavailable" | "mismatch";
export type ClaimDisplaySignal = "pending_confirmation" | "not_yet_effective" | "temporal_unknown" | "no_confirmed_replacement" | "evidence_unavailable" | "authority_unconfirmed" | "inference" | "conflict";

export interface EvidenceVerification {
  state: EvidenceVerificationState;
  active: boolean;
}

export interface ClaimEvidence {
  stance: EvidenceStance;
  verificationState: EvidenceVerificationState;
  sourceVersionAvailable: boolean;
  independenceGroupState: "confirmed" | "unknown";
  independenceGroup?: string;
}

export interface Claim {
  id: string;
  kind: ClaimKind;
  trust: ClaimTrust;
  evidence: ClaimEvidence[];
  validFrom?: TemporalPoint;
  validTo?: TemporalPoint;
  authority?: { required: boolean; scopeMatched: boolean };
}

export interface CurrentEligibility {
  eligible: boolean;
  reasons: ("kind_not_fact" | "trust_not_trusted" | "validity_not_current" | "active_support_missing" | "authority_scope_mismatch")[];
  conflict: boolean;
  confidenceCeiling: "high_allowed" | "not_high";
  temporalCertainty: ValidityResult["temporalCertainty"];
}

export interface CurrentProjection {
  claimId: string;
  validity: ValidityResult;
  eligibility: CurrentEligibility;
}

export interface InferenceProjection {
  visible: boolean;
  displaySignal: "inference";
}

export const verifyEvidence = (input: { locatorResolved: boolean; pinnedVersionAvailable: boolean; pinnedHashMatches: boolean; excerptHashMatches: boolean; liveVersionId?: string; pinnedVersionId?: string }): EvidenceVerification => {
  if (!input.locatorResolved || !input.pinnedVersionAvailable) return { state: "unavailable", active: false };
  if (!input.pinnedHashMatches || !input.excerptHashMatches) return { state: "mismatch", active: false };
  return { state: "verified", active: true };
};

const isActiveSupport = (evidence: ClaimEvidence): boolean => evidence.stance === "supports" && evidence.verificationState === "verified" && evidence.sourceVersionAvailable;

export const countCorroboration = (bindings: ClaimEvidence[]): { confirmedIndependentGroups: number; independenceUnknown: number } => {
  const activeSupports = bindings.filter(isActiveSupport);
  return {
    confirmedIndependentGroups: new Set(activeSupports.filter((binding) => binding.independenceGroupState === "confirmed" && binding.independenceGroup).map((binding) => binding.independenceGroup)).size,
    independenceUnknown: activeSupports.filter((binding) => binding.independenceGroupState === "unknown").length,
  };
};

export const evaluateCurrentEligibility = (claim: Claim, validity: ValidityResult): CurrentEligibility => {
  const reasons: CurrentEligibility["reasons"] = [];
  if (claim.kind !== "fact") reasons.push("kind_not_fact");
  if (claim.trust !== "trusted") reasons.push("trust_not_trusted");
  if (!(validity.state === "effective" || validity.state === "unknown")) reasons.push("validity_not_current");
  if (!claim.evidence.some(isActiveSupport)) reasons.push("active_support_missing");
  if (claim.authority?.required && !claim.authority.scopeMatched) reasons.push("authority_scope_mismatch");
  const conflict = claim.evidence.some((evidence) => evidence.stance === "contradicts");
  return { eligible: reasons.length === 0, reasons, conflict, confidenceCeiling: conflict ? "not_high" : "high_allowed", temporalCertainty: validity.temporalCertainty };
};

export const projectFactualClaims = (claims: Claim[], asOf: TemporalPoint, transitions: ClaimTransition[]): CurrentProjection[] => claims.map((claim) => {
  const validity = reduceClaimValidity({ claimId: claim.id, asOf, validFrom: claim.validFrom, validTo: claim.validTo, transitions });
  return { claimId: claim.id, validity, eligibility: evaluateCurrentEligibility(claim, validity) };
}).filter((projection) => projection.eligibility.eligible);

export const projectInferenceView = (claim: Claim, validity: ValidityResult): InferenceProjection => ({
  visible: claim.kind === "inference" && claim.trust === "trusted" && validity.state === "effective" && claim.evidence.some(isActiveSupport),
  displaySignal: "inference",
});

export const claimDisplaySignals = (claim: Claim, validity: ValidityResult, eligibility: CurrentEligibility, verification?: EvidenceVerification, context?: { hasEligibleReplacement?: boolean }): ClaimDisplaySignal[] => {
  const signals = new Set<ClaimDisplaySignal>();
  if (claim.trust === "candidate") signals.add("pending_confirmation");
  if (validity.state === "scheduled") signals.add("not_yet_effective");
  if (validity.temporalCertainty === "unknown") signals.add("temporal_unknown");
  if (validity.state === "superseded" && context?.hasEligibleReplacement === false) signals.add("no_confirmed_replacement");
  if (verification && !verification.active) signals.add("evidence_unavailable");
  if (eligibility.reasons.includes("authority_scope_mismatch")) signals.add("authority_unconfirmed");
  if (eligibility.conflict) signals.add("conflict");
  if (claim.kind === "inference") signals.add("inference");
  return [...signals];
};

export const buildDefaultDisplay = (record: Record<string, unknown>): Record<string, unknown> => {
  const display: Record<string, unknown> = {};
  if ("summary" in record) display.summary = record.summary;
  if ("state" in record) display.state = record.state;
  return display;
};

export interface TimelineEvent {
  id: string;
  confirmationState: "candidate" | "confirmed" | "rejected";
  participants: string[];
  definingClaimEligible: boolean;
  cancellation?: { confirmationState: "candidate" | "confirmed" | "rejected"; effectiveAt: TemporalPoint };
}

export interface TimelineProjection {
  rows: { participant: string; eventId: string }[];
  displayState: "planned_or_confirmed" | "planned_then_cancelled" | "temporal_unknown";
}

export const projectTimelineEvent = (event: TimelineEvent, asOf: TemporalPoint): TimelineProjection => {
  if (event.confirmationState !== "confirmed" || !event.definingClaimEligible) return { rows: [], displayState: "planned_or_confirmed" };
  const cancellation = event.cancellation;
  const displayState = cancellation?.confirmationState === "confirmed"
    ? crossed(cancellation.effectiveAt, asOf)
      ? "planned_then_cancelled"
      : ambiguous(cancellation.effectiveAt, asOf)
        ? "temporal_unknown"
        : "planned_or_confirmed"
    : "planned_or_confirmed";
  return { rows: event.participants.map((participant) => ({ participant, eventId: event.id })), displayState };
};

export const adaptLegacyGraph = (row: { from: string; relation: string; to: string; rank: number }) => ({
  display: { from: row.from, relation: row.relation, to: row.to, rank: row.rank },
  raw: { claimId: `legacy-link:${row.from}:${row.relation}:${row.to}` },
});

export const adaptLegacyTimeline = (row: { rowId: number; entity: string; date: string; summary: string }) => ({
  display: { date: row.date, summary: row.summary },
  raw: { eventId: `legacy-timeline:${row.entity}:${row.rowId}` },
});

export const adaptLegacyRecall = (envelope: { answer: string; citations: number; sqlCount: number; llmCount: number }) => ({
  display: { answer: envelope.answer, citations: envelope.citations },
  kernelSqlCount: envelope.sqlCount,
  kernelLlmCount: envelope.llmCount,
});

export interface EvaluationContract {
  readonly id: string;
  readonly fingerprint: string;
  readonly [key: string]: unknown;
}

export const replaceEvaluationContract = <T extends EvaluationContract>(original: EvaluationContract, replacement: T): Readonly<T> => {
  if (replacement.id === original.id) throw new Error("evaluation_contract_identity_must_change");
  if (replacement.fingerprint === original.fingerprint) throw new Error("evaluation_contract_fingerprint_must_change");
  return Object.freeze({ ...replacement });
};

export type CalibrationStatus = "not_calibratable" | "invalidated_by_context" | "not_due" | "inconclusive" | "refuted" | "confirmed" | "partially_confirmed";
export type CalibrationOutcomeGap = "missing" | "candidate" | "rejected" | "independence_unconfirmed" | "evidence_unverified" | "conflict_unresolved";

export interface CalibrationDimension {
  id?: string;
  required: boolean;
  decisive?: boolean;
  result: "pass" | "fail";
}

export interface CalibrationInput {
  hasFrozenContract: boolean;
  invalidationConfirmed?: boolean;
  invalidationAffectsWindow?: boolean;
  asOfMs: number;
  windowEndMs: number;
  outcomeReady?: boolean;
  outcomeGap?: CalibrationOutcomeGap;
  utility?: string;
  evaluatorVersion?: string;
  dimensions: CalibrationDimension[];
}

export interface CalibrationResult {
  status: CalibrationStatus;
  displaySignal?: "evaluation_standard_missing";
  missingRequirements?: CalibrationOutcomeGap[];
  utility?: string;
  evaluatorVersion?: string;
  dimensionResults: CalibrationDimension[];
}

export const evaluateCalibration = (input: CalibrationInput): CalibrationResult => {
  const shared = {
    utility: input.utility,
    evaluatorVersion: input.evaluatorVersion,
    dimensionResults: input.dimensions,
  };
  if (!input.hasFrozenContract) return { status: "not_calibratable", displaySignal: "evaluation_standard_missing", ...shared };
  if (input.invalidationConfirmed && input.invalidationAffectsWindow) return { status: "invalidated_by_context", ...shared };
  if (input.asOfMs < input.windowEndMs) return { status: "not_due", ...shared };
  if (!input.outcomeReady) return { status: "inconclusive", missingRequirements: input.outcomeGap ? [input.outcomeGap] : [], ...shared };

  const required = input.dimensions.filter((dimension) => dimension.required);
  if (required.some((dimension) => dimension.decisive && dimension.result === "fail")) return { status: "refuted", ...shared };
  if (required.length > 0 && required.every((dimension) => dimension.result === "fail")) return { status: "refuted", ...shared };
  if (required.length > 0 && required.every((dimension) => dimension.result === "pass")) return { status: "confirmed", ...shared };
  if (required.some((dimension) => dimension.result === "pass") && required.some((dimension) => dimension.result === "fail")) return { status: "partially_confirmed", ...shared };
  return { status: "inconclusive", ...shared };
};
