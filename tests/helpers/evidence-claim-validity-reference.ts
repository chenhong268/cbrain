export type TemporalPrecision = "instant" | "day" | "month" | "year" | "approximate";

export interface TemporalPoint {
  value: string;
  precision: TemporalPrecision;
  timezone: string;
  earliestMs: number;
  latestExclusiveMs: number;
}

export type ValidityState = "unknown" | "scheduled" | "effective" | "expired" | "superseded" | "revoked";

interface ClaimTransitionBase {
  oldClaimId: string;
  confirmationState: "candidate" | "confirmed" | "rejected";
  effectiveAt?: TemporalPoint;
  recordedAt?: TemporalPoint;
}

export type ClaimTransition = ClaimTransitionBase & (
  | { kind: "supersedes"; newClaimId: string }
  | { kind: "revokes"; newClaimId?: never }
);

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
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) throw new Error(`invalid_timezone: ${timezone}`);
  const amount = (hours * 60 + minutes) * 60_000;
  return match[1] === "+" ? amount : -amount;
};

const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const assertGregorianDate = (year: number, month: number, day: number, label: string): void => {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid_${label}`);
  }
};

const utcMs = (year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0, milliseconds = 0): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, milliseconds);
  return date.getTime();
};

const parseInstant = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid_instant: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`invalid_instant: ${value}`);
  try {
    assertGregorianDate(year, month, day, "instant");
    const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
    const parsed = utcMs(year, month, day, hours, minutes, seconds, milliseconds) - offsetMs(match[8]);
    if (!Number.isFinite(parsed)) throw new Error(`invalid_instant: ${value}`);
    return parsed;
  } catch {
    throw new Error(`invalid_instant: ${value}`);
  }
};

const startOf = (value: string, precision: Exclude<TemporalPrecision, "approximate">, timezone: string): number => {
  offsetMs(timezone);
  if (precision === "instant") return parseInstant(value);
  const match = precision === "day"
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : precision === "month"
      ? /^(\d{4})-(\d{2})$/.exec(value)
      : /^(\d{4})$/.exec(value);
  if (!match) throw new Error(`invalid_${precision}: ${value}`);
  const year = Number(match[1]);
  const month = precision === "year" ? 1 : Number(match[2]);
  const day = precision === "day" ? Number(match[3]) : 1;
  assertGregorianDate(year, month, day, precision);
  const parsed = utcMs(year, month, day) - offsetMs(timezone);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${precision}: ${value}`);
  return parsed;
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
        if (precision === "day") return utcMs(year, month, day + 1) - offsetMs(timezone);
        if (precision === "month") return utcMs(year, month + 1, 1) - offsetMs(timezone);
        return utcMs(year + 1, 1, 1) - offsetMs(timezone);
      })();
  if (!Number.isFinite(earliestMs) || !Number.isFinite(latestExclusiveMs)) throw new Error(`invalid_${precision}: ${value}`);
  return { value, precision, timezone, earliestMs, latestExclusiveMs };
};

export const approximatePoint = (value: string, timezone: string, earliest: string, latestExclusive: string): TemporalPoint => {
  try {
    offsetMs(timezone);
    const earliestMs = parseInstant(earliest);
    const latestExclusiveMs = parseInstant(latestExclusive);
    if (!Number.isFinite(earliestMs) || !Number.isFinite(latestExclusiveMs) || earliestMs >= latestExclusiveMs) throw new Error("invalid_approximate_interval");
    return { value, precision: "approximate", timezone, earliestMs, latestExclusiveMs };
  } catch {
    throw new Error("invalid_approximate_interval");
  }
};

type TemporalBoundaryRelation = "before" | "ambiguous" | "crossed";

const compareTemporalBoundary = (boundary: TemporalPoint, asOf: TemporalPoint): TemporalBoundaryRelation => {
  if (asOf.earliestMs >= boundary.latestExclusiveMs) return "crossed";
  const asOfIsExact = asOf.earliestMs === asOf.latestExclusiveMs;
  if (asOf.latestExclusiveMs < boundary.earliestMs || (asOf.latestExclusiveMs === boundary.earliestMs && !asOfIsExact)) return "before";
  return "ambiguous";
};

const assertClaimTransitionShape = (transition: ClaimTransition): void => {
  if (transition.kind === "supersedes" && (typeof transition.newClaimId !== "string" || transition.newClaimId.length === 0)) throw new Error("invalid_claim_transition_shape");
  if (transition.kind === "revokes" && "newClaimId" in transition) throw new Error("invalid_claim_transition_shape");
};

export const reduceClaimValidity = ({ claimId, asOf, validFrom, validTo, transitions }: ReduceClaimValidityInput): ValidityResult => {
  if (validFrom && validTo) {
    const exactZeroLength = validFrom.earliestMs === validFrom.latestExclusiveMs
      && validTo.earliestMs === validTo.latestExclusiveMs
      && validFrom.earliestMs === validTo.earliestMs;
    if (validFrom.latestExclusiveMs > validTo.earliestMs || exactZeroLength) throw new Error("invalid_or_ambiguous_valid_interval");
  }
  transitions.forEach(assertClaimTransitionShape);
  const confirmed = transitions.filter((transition) => transition.oldClaimId === claimId && transition.confirmationState === "confirmed" && transition.effectiveAt);
  const crossedRevocation = confirmed.some((transition) => transition.kind === "revokes" && compareTemporalBoundary(transition.effectiveAt!, asOf) === "crossed");
  const ambiguousRevocation = confirmed.some((transition) => transition.kind === "revokes" && compareTemporalBoundary(transition.effectiveAt!, asOf) === "ambiguous");
  const crossedSupersession = confirmed.some((transition) => transition.kind === "supersedes" && compareTemporalBoundary(transition.effectiveAt!, asOf) === "crossed");
  if (crossedRevocation) return { state: "revoked", temporalCertainty: "known", transitionConflict: crossedSupersession };
  if (ambiguousRevocation) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (crossedSupersession) return { state: "superseded", temporalCertainty: "known", transitionConflict: false };
  if (confirmed.some((transition) => compareTemporalBoundary(transition.effectiveAt!, asOf) === "ambiguous")) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom && compareTemporalBoundary(validFrom, asOf) === "before") return { state: "scheduled", temporalCertainty: "known", transitionConflict: false };
  if (validFrom && compareTemporalBoundary(validFrom, asOf) === "ambiguous") return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validTo && compareTemporalBoundary(validTo, asOf) === "crossed") return { state: "expired", temporalCertainty: "known", transitionConflict: false };
  if (validTo && compareTemporalBoundary(validTo, asOf) === "ambiguous") return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom || validTo) return { state: "effective", temporalCertainty: "known", transitionConflict: false };
  return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
};

export type ClaimKind = "fact" | "inference";
export type ClaimTrust = "candidate" | "trusted" | "rejected";
export type EvidenceStance = "supports" | "contradicts" | "limits";
export type EvidenceVerificationState = "unchecked" | "verified" | "unavailable" | "mismatch";
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

const isActiveBinding = (evidence: ClaimEvidence, stance: EvidenceStance): boolean => evidence.stance === stance && evidence.verificationState === "verified" && evidence.sourceVersionAvailable;

export const countCorroboration = (bindings: ClaimEvidence[]): { confirmedIndependentGroups: number; independenceUnknown: number } => {
  const activeSupports = bindings.filter((binding) => isActiveBinding(binding, "supports"));
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
  if (!claim.evidence.some((evidence) => isActiveBinding(evidence, "supports"))) reasons.push("active_support_missing");
  if (claim.authority?.required && !claim.authority.scopeMatched) reasons.push("authority_scope_mismatch");
  const conflict = claim.evidence.some((evidence) => isActiveBinding(evidence, "contradicts"));
  return { eligible: reasons.length === 0, reasons, conflict, confidenceCeiling: conflict ? "not_high" : "high_allowed", temporalCertainty: validity.temporalCertainty };
};

export const projectFactualClaims = (claims: Claim[], asOf: TemporalPoint, transitions: ClaimTransition[]): CurrentProjection[] => claims.map((claim) => {
  const validity = reduceClaimValidity({ claimId: claim.id, asOf, validFrom: claim.validFrom, validTo: claim.validTo, transitions });
  return { claimId: claim.id, validity, eligibility: evaluateCurrentEligibility(claim, validity) };
}).filter((projection) => projection.eligibility.eligible);

export const projectInferenceView = (claim: Claim, validity: ValidityResult): InferenceProjection => ({
  visible: claim.kind === "inference" && claim.trust === "trusted" && validity.state === "effective" && claim.evidence.some((evidence) => isActiveBinding(evidence, "supports")),
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
  displayState: "excluded" | "planned_or_confirmed" | "planned_then_cancelled" | "temporal_unknown";
}

export const projectTimelineEvent = (event: TimelineEvent, asOf: TemporalPoint): TimelineProjection => {
  if (event.confirmationState !== "confirmed" || !event.definingClaimEligible) return { rows: [], displayState: "excluded" };
  const cancellation = event.cancellation;
  const displayState = cancellation?.confirmationState === "confirmed"
    ? compareTemporalBoundary(cancellation.effectiveAt, asOf) === "crossed"
      ? "planned_then_cancelled"
      : compareTemporalBoundary(cancellation.effectiveAt, asOf) === "ambiguous"
        ? "temporal_unknown"
        : "planned_or_confirmed"
    : "planned_or_confirmed";
  return { rows: event.participants.map((participant) => ({ participant, eventId: event.id })), displayState };
};

export const adaptLegacyGraph = (rows: readonly Readonly<{ from: string; relation: string; to: string; rank: number }>[]) => rows.map((row) => ({
  display: { from: row.from, relation: row.relation, to: row.to, rank: row.rank },
  raw: { claimId: `legacy-link:${row.from}:${row.relation}:${row.to}` },
}));

export const adaptLegacyTimeline = (rows: readonly Readonly<{ rowId: number; entity: string; date: string; summary: string }>[]) => rows.map((row) => ({
  display: { date: row.date, summary: row.summary },
  raw: { eventId: `legacy-timeline:${row.entity}:${row.rowId}` },
}));

export const adaptLegacyRecall = (
  envelope: { answer: string; citations: number },
  _dependencies: { runKernel: () => unknown; recordKernelAccounting: () => unknown },
) => ({
  display: { answer: envelope.answer, citations: envelope.citations },
  kernelSqlCount: 0,
  kernelLlmCount: 0,
});

export interface EvaluationContract {
  readonly id: string;
  readonly fingerprint: string;
  readonly [key: string]: unknown;
}

const cloneJsonShape = <T>(value: T): T => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child) => cloneJsonShape(child)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneJsonShape(child)])) as T;
};

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const frozenSnapshot = <T>(value: T): Readonly<T> => deepFreeze(cloneJsonShape(value));

export const replaceEvaluationContract = <T extends EvaluationContract>(original: EvaluationContract, replacement: T): Readonly<T> => {
  if (replacement.id === original.id) throw new Error("evaluation_contract_identity_must_change");
  if (replacement.fingerprint === original.fingerprint) throw new Error("evaluation_contract_fingerprint_must_change");
  return frozenSnapshot(replacement);
};

export type CalibrationStatus = "not_calibratable" | "invalidated_by_context" | "not_due" | "inconclusive" | "refuted" | "confirmed" | "partially_confirmed";
export type CalibrationOutcomeGap = "missing" | "candidate" | "rejected" | "independence_unconfirmed" | "evidence_unverified" | "conflict_unresolved";
export type CalibrationUtility = "useful" | "neutral" | "harmful";

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
  asOf: TemporalPoint;
  windowEnd: TemporalPoint;
  outcomeReady?: boolean;
  outcomeGap?: CalibrationOutcomeGap;
  utility?: CalibrationUtility;
  evaluatorVersion: string;
  dimensions: readonly CalibrationDimension[];
}

export interface CalibrationResult {
  readonly status: CalibrationStatus;
  readonly displaySignal?: "evaluation_standard_missing";
  readonly missingRequirements?: readonly CalibrationOutcomeGap[];
  readonly utility?: CalibrationUtility;
  readonly evaluatorVersion: string;
  readonly dimensionResults: readonly Readonly<CalibrationDimension>[];
}

export const evaluateCalibration = (input: CalibrationInput): CalibrationResult => {
  if (typeof input.evaluatorVersion !== "string" || input.evaluatorVersion.trim().length === 0) throw new Error("evaluator_version_required");
  if (input.utility !== undefined && !(["useful", "neutral", "harmful"] as const).includes(input.utility)) throw new Error("invalid_calibration_utility");
  const snapshot = frozenSnapshot(input);
  const shared = {
    utility: snapshot.utility,
    evaluatorVersion: snapshot.evaluatorVersion,
    dimensionResults: snapshot.dimensions,
  };
  if (!snapshot.hasFrozenContract) return frozenSnapshot({ status: "not_calibratable" as const, displaySignal: "evaluation_standard_missing" as const, ...shared });
  if (snapshot.invalidationConfirmed && snapshot.invalidationAffectsWindow) return frozenSnapshot({ status: "invalidated_by_context" as const, ...shared });
  const windowRelation = compareTemporalBoundary(snapshot.windowEnd, snapshot.asOf);
  if (windowRelation === "before") return frozenSnapshot({ status: "not_due" as const, ...shared });
  if (windowRelation === "ambiguous") return frozenSnapshot({ status: "inconclusive" as const, ...shared });
  if (!snapshot.outcomeReady) return frozenSnapshot({ status: "inconclusive" as const, missingRequirements: snapshot.outcomeGap ? [snapshot.outcomeGap] : [], ...shared });

  const required = snapshot.dimensions.filter((dimension) => dimension.required);
  if (required.some((dimension) => dimension.decisive && dimension.result === "fail")) return frozenSnapshot({ status: "refuted" as const, ...shared });
  if (required.length > 0 && required.every((dimension) => dimension.result === "fail")) return frozenSnapshot({ status: "refuted" as const, ...shared });
  if (required.length > 0 && required.every((dimension) => dimension.result === "pass")) return frozenSnapshot({ status: "confirmed" as const, ...shared });
  if (required.some((dimension) => dimension.result === "pass") && required.some((dimension) => dimension.result === "fail")) return frozenSnapshot({ status: "partially_confirmed" as const, ...shared });
  return frozenSnapshot({ status: "inconclusive" as const, ...shared });
};
