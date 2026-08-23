import { describe, expect, test } from "bun:test";
import {
  approximatePoint,
  adaptLegacyGraph,
  adaptLegacyRecall,
  adaptLegacyTimeline,
  buildDefaultDisplay,
  claimDisplaySignals,
  countCorroboration,
  evaluateCalibration,
  evaluateCurrentEligibility,
  projectFactualClaims,
  projectInferenceView,
  projectTimelineEvent,
  reduceClaimValidity,
  replaceEvaluationContract,
  temporalPoint,
  type CalibrationDimension,
  type ClaimEvidence,
  type ClaimTransition,
  verifyEvidence,
} from "../helpers/evidence-claim-validity-reference.js";

const instant = (value: string) => temporalPoint(value, "instant", "Z");
const day = (value: string) => temporalPoint(value, "day", "+00:00");
const verifiedSupport = { stance: "supports" as const, verificationState: "verified" as const, sourceVersionAvailable: true, independenceGroupState: "confirmed" as const, independenceGroup: "group-1" };
const fuzzyBoundaryCases = [
  { label: "day", boundary: temporalPoint("2026-02-01", "day", "+00:00"), earliest: "2026-02-01T00:00:00Z", inside: "2026-02-01T12:00:00Z", latestExclusive: "2026-02-02T00:00:00Z" },
  { label: "month", boundary: temporalPoint("2026-02", "month", "+00:00"), earliest: "2026-02-01T00:00:00Z", inside: "2026-02-15T00:00:00Z", latestExclusive: "2026-03-01T00:00:00Z" },
  { label: "year", boundary: temporalPoint("2026", "year", "+00:00"), earliest: "2026-01-01T00:00:00Z", inside: "2026-07-01T00:00:00Z", latestExclusive: "2027-01-01T00:00:00Z" },
  { label: "approximate", boundary: approximatePoint("around February", "+00:00", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"), earliest: "2026-02-01T00:00:00Z", inside: "2026-02-15T00:00:00Z", latestExclusive: "2026-03-01T00:00:00Z" },
];

const acceptClaimTransition = (_transition: ClaimTransition): void => {};
// @ts-expect-error supersedes requires a replacement Claim identity
acceptClaimTransition({ kind: "supersedes", oldClaimId: "claim-c", confirmationState: "confirmed" });
// @ts-expect-error revokes cannot carry a replacement Claim identity
acceptClaimTransition({ kind: "revokes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed" });

const acceptCalibrationInput = (_input: Parameters<typeof evaluateCalibration>[0]): void => {};
// @ts-expect-error evaluatorVersion is mandatory
acceptCalibrationInput({ hasFrozenContract: true, asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), dimensions: [] });
// @ts-expect-error utility is limited to useful, neutral, or harmful
acceptCalibrationInput({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), utility: "excellent", dimensions: [] });

describe("Evidence–Claim–Validity executable contract", () => {
  test("[1] verification does not upgrade Claim trust", () => {
    const evidence = verifyEvidence({ locatorResolved: true, pinnedVersionAvailable: true, pinnedHashMatches: true, excerptHashMatches: true });
    expect(evidence).toEqual({ state: "verified", active: true });
    expect(evaluateCurrentEligibility({ id: "claim-c", kind: "fact", trust: "candidate", evidence: [verifiedSupport] }, { state: "unknown", temporalCertainty: "unknown", transitionConflict: false }).eligible).toBe(false);
  });

  test("[2] unavailable or mismatched pinned bytes deactivate Evidence", () => {
    expect(verifyEvidence({ locatorResolved: true, pinnedVersionAvailable: false, pinnedHashMatches: false, excerptHashMatches: true })).toEqual({ state: "unavailable", active: false });
    expect(verifyEvidence({ locatorResolved: true, pinnedVersionAvailable: true, pinnedHashMatches: false, excerptHashMatches: true })).toEqual({ state: "mismatch", active: false });
  });

  test("[3] a candidate fact is excluded even with verified support", () => {
    const result = evaluateCurrentEligibility({ id: "claim-c", kind: "fact", trust: "candidate", evidence: [verifiedSupport] }, { state: "effective", temporalCertainty: "known", transitionConflict: false });
    expect(result).toMatchObject({ eligible: false, reasons: ["trust_not_trusted"] });
  });

  test("[4] authority scope is required only when policy asks for it", () => {
    const claim = { id: "claim-c", kind: "fact" as const, trust: "trusted" as const, evidence: [verifiedSupport], authority: { required: true, scopeMatched: false } };
    const validity = { state: "effective" as const, temporalCertainty: "known" as const, transitionConflict: false };
    const eligibility = evaluateCurrentEligibility(claim, validity);
    expect(eligibility.reasons).toContain("authority_scope_mismatch");
    expect(claimDisplaySignals(claim, validity, eligibility)).toContain("authority_unconfirmed");
  });

  test("[5] same-origin sources count as one independent group", () => {
    expect(countCorroboration([verifiedSupport, { ...verifiedSupport }])).toEqual({ confirmedIndependentGroups: 1, independenceUnknown: 0 });
  });

  test("[5] corroboration ignores bindings that are not active supports", () => {
    expect(countCorroboration([
      verifiedSupport,
      { ...verifiedSupport, independenceGroup: "group-2", verificationState: "unavailable" },
      { ...verifiedSupport, independenceGroup: "group-3", sourceVersionAvailable: false },
      { ...verifiedSupport, independenceGroup: "group-4", stance: "contradicts" },
      { ...verifiedSupport, independenceGroup: "group-5", stance: "limits" },
    ])).toEqual({ confirmedIndependentGroups: 1, independenceUnknown: 0 });
  });

  test("[6] contradiction marks but does not erase an eligible Claim", () => {
    const claim = { id: "claim-c", kind: "fact" as const, trust: "trusted" as const, evidence: [verifiedSupport, { ...verifiedSupport, stance: "contradicts" as const }] };
    expect(evaluateCurrentEligibility(claim, { state: "effective", temporalCertainty: "known", transitionConflict: false })).toMatchObject({ eligible: true, conflict: true, confidenceCeiling: "not_high" });
  });

  test.each([
    { label: "unchecked", contradiction: { ...verifiedSupport, stance: "contradicts" as const, verificationState: "unchecked" as const } as unknown as ClaimEvidence },
    { label: "mismatched", contradiction: { ...verifiedSupport, stance: "contradicts" as const, verificationState: "mismatch" as const } },
    { label: "source-version-unavailable", contradiction: { ...verifiedSupport, stance: "contradicts" as const, sourceVersionAvailable: false } },
  ])("a non-active $label contradiction does not create conflict", ({ contradiction }) => {
    const claim = { id: "claim-c", kind: "fact" as const, trust: "trusted" as const, evidence: [verifiedSupport, contradiction] };
    expect(evaluateCurrentEligibility(claim, { state: "effective", temporalCertainty: "known", transitionConflict: false })).toMatchObject({ eligible: true, conflict: false, confidenceCeiling: "high_allowed" });
  });

  test("[13] every disallowed axis is excluded from factual current", () => {
    const validityStates = ["scheduled", "expired", "superseded", "revoked"] as const;
    for (const state of validityStates) expect(evaluateCurrentEligibility({ id: "claim-c", kind: "fact", trust: "trusted", evidence: [verifiedSupport] }, { state, temporalCertainty: "known", transitionConflict: false }).eligible).toBe(false);
    expect(evaluateCurrentEligibility({ id: "claim-c", kind: "fact", trust: "rejected", evidence: [verifiedSupport] }, { state: "effective", temporalCertainty: "known", transitionConflict: false }).eligible).toBe(false);
    expect(evaluateCurrentEligibility({ id: "claim-c", kind: "fact", trust: "trusted", evidence: [{ ...verifiedSupport, stance: "limits" }] }, { state: "effective", temporalCertainty: "known", transitionConflict: false }).reasons).toContain("active_support_missing");
  });

  test("eligibility reports every disallowed axis in its fixed order", () => {
    expect(evaluateCurrentEligibility({
      id: "claim-c",
      kind: "inference",
      trust: "candidate",
      evidence: [{ ...verifiedSupport, stance: "limits" }],
      authority: { required: true, scopeMatched: false },
    }, { state: "scheduled", temporalCertainty: "known", transitionConflict: false }).reasons).toEqual([
      "kind_not_fact",
      "trust_not_trusted",
      "validity_not_current",
      "active_support_missing",
      "authority_scope_mismatch",
    ]);
  });

  test("trusted factual current keeps unknown temporal certainty eligible", () => {
    expect(evaluateCurrentEligibility(
      { id: "claim-c", kind: "fact", trust: "trusted", evidence: [verifiedSupport] },
      { state: "unknown", temporalCertainty: "unknown", transitionConflict: false },
    )).toMatchObject({ eligible: true, temporalCertainty: "unknown" });
  });

  test("[23] default display excludes private audit fields", () => {
    expect(buildDefaultDisplay({ summary: "匿名摘要", state: "effective", id: "claim-c", slug: "private/a", path: "/private/a.md", uri: "file:///private/a.md", excerpt: "private", hash: "abc" })).toEqual({ summary: "匿名摘要", state: "effective" });
  });

  test("[12] every participant view shares one Event identity", () => {
    const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a", "entity-b"], definingClaimEligible: true };
    expect(projectTimelineEvent(event, instant("2026-03-01T00:00:00Z")).rows.map((row) => [row.participant, row.eventId])).toEqual([["entity-a", "event-d"], ["entity-b", "event-d"]]);
    expect(projectTimelineEvent({ ...event, confirmationState: "candidate" }, instant("2026-03-01T00:00:00Z"))).toEqual({ rows: [], displayState: "excluded" });
    expect(projectTimelineEvent({ ...event, confirmationState: "rejected" }, instant("2026-03-01T00:00:00Z"))).toEqual({ rows: [], displayState: "excluded" });
    expect(projectTimelineEvent({ ...event, definingClaimEligible: false }, instant("2026-03-01T00:00:00Z"))).toEqual({ rows: [], displayState: "excluded" });
  });

  test("[24a] legacy graph preserves multi-row count, order, display, and raw-only identity", () => {
    const rows = Object.freeze([
      Object.freeze({ from: "entity-a", relation: "knows", to: "entity-b", rank: 2 }),
      Object.freeze({ from: "entity-b", relation: "supports", to: "entity-c", rank: 1 }),
    ]);
    const result = adaptLegacyGraph(rows);
    expect(result.map((item) => item.display)).toEqual([
      { from: "entity-a", relation: "knows", to: "entity-b", rank: 2 },
      { from: "entity-b", relation: "supports", to: "entity-c", rank: 1 },
    ]);
    expect(result.map((item) => item.raw)).toEqual([
      { claimId: "legacy-link:entity-a:knows:entity-b" },
      { claimId: "legacy-link:entity-b:supports:entity-c" },
    ]);
  });

  test("[24b] legacy timeline preserves rows and never merges matching content across identities", () => {
    const rows = Object.freeze([
      Object.freeze({ rowId: 7, entity: "entity-a", date: "2026-01-01", summary: "匿名事件甲" }),
      Object.freeze({ rowId: 8, entity: "entity-a", date: "2026-01-02", summary: "匿名事件乙" }),
      Object.freeze({ rowId: 7, entity: "entity-b", date: "2026-01-01", summary: "匿名事件甲" }),
      Object.freeze({ rowId: 9, entity: "entity-a", date: "2026-01-01", summary: "匿名事件甲" }),
    ]);
    const result = adaptLegacyTimeline(rows);
    expect(result.map((item) => item.display)).toEqual([
      { date: "2026-01-01", summary: "匿名事件甲" },
      { date: "2026-01-02", summary: "匿名事件乙" },
      { date: "2026-01-01", summary: "匿名事件甲" },
      { date: "2026-01-01", summary: "匿名事件甲" },
    ]);
    expect(result.map((item) => item.raw)).toEqual([
      { eventId: "legacy-timeline:entity-a:7" },
      { eventId: "legacy-timeline:entity-a:8" },
      { eventId: "legacy-timeline:entity-b:7" },
      { eventId: "legacy-timeline:entity-a:9" },
    ]);
  });

  test("[24c] pre-cutover brief recall adds no kernel work", () => {
    const failIfCalled = (): never => {
      throw new Error("pre-cutover kernel work must not run");
    };
    const legacyEnvelope = { answer: "匿名回答", citations: 1, sqlCount: 99, llmCount: 99 };
    const result = adaptLegacyRecall(legacyEnvelope, { runKernel: failIfCalled, recordKernelAccounting: failIfCalled });
    expect(result.display).toEqual({ answer: "匿名回答", citations: 1 });
    expect(result.kernelSqlCount).toBe(0);
    expect(result.kernelLlmCount).toBe(0);
  });

  test("[30] cancellation keeps history but never claims the event occurred", () => {
    const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a"], definingClaimEligible: true, cancellation: { confirmationState: "confirmed" as const, effectiveAt: instant("2026-02-01T00:00:00Z") } };
    expect(projectTimelineEvent(event, instant("2026-01-01T00:00:00Z")).displayState).toBe("planned_or_confirmed");
    expect(projectTimelineEvent(event, instant("2026-03-01T00:00:00Z")).displayState).toBe("planned_then_cancelled");
  });

  test("[30] an uncertain cancellation boundary remains temporally unknown", () => {
    const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a"], definingClaimEligible: true, cancellation: { confirmationState: "confirmed" as const, effectiveAt: approximatePoint("around February", "+00:00", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z") } };
    expect(projectTimelineEvent(event, instant("2026-02-15T00:00:00Z")).displayState).toBe("temporal_unknown");
  });

  test.each(fuzzyBoundaryCases)("fuzzy $label cancellation classifies earliest, inside, and latestExclusive", ({ boundary, earliest, inside, latestExclusive }) => {
    const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a"], definingClaimEligible: true, cancellation: { confirmationState: "confirmed" as const, effectiveAt: boundary } };
    expect([
      projectTimelineEvent(event, instant(earliest)).displayState,
      projectTimelineEvent(event, instant(inside)).displayState,
      projectTimelineEvent(event, instant(latestExclusive)).displayState,
    ]).toEqual(["temporal_unknown", "temporal_unknown", "planned_then_cancelled"]);
  });

  test("[25] trusted inference remains outside factual current", () => {
    expect(evaluateCurrentEligibility({ id: "claim-c", kind: "inference", trust: "trusted", evidence: [verifiedSupport] }, { state: "effective", temporalCertainty: "known", transitionConflict: false })).toMatchObject({ eligible: false, reasons: ["kind_not_fact"] });
  });

  test("[29] a verified capture stays active when a newer live version exists", () => {
    expect(verifyEvidence({ locatorResolved: true, pinnedVersionAvailable: true, pinnedHashMatches: true, excerptHashMatches: true, liveVersionId: "source-b-v2", pinnedVersionId: "source-b-v1" })).toEqual({ state: "verified", active: true });
  });

  test("[15] a frozen EvaluationContract cannot be mutated in place", () => {
    const original = Object.freeze({ id: "contract-f", fingerprint: "fp-1", tolerance: 0.1 });
    const replacement = replaceEvaluationContract(original, { id: "contract-f2", fingerprint: "fp-2", tolerance: 0.2 });
    expect(original).toEqual({ id: "contract-f", fingerprint: "fp-1", tolerance: 0.1 });
    expect(replacement).not.toBe(original);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(replacement.id).toBe("contract-f2");
    expect(() => replaceEvaluationContract(original, { id: "contract-f", fingerprint: "fp-2", tolerance: 0.2 })).toThrow("evaluation_contract_identity_must_change");
    expect(() => replaceEvaluationContract(original, { id: "contract-f2", fingerprint: "fp-1", tolerance: 0.2 })).toThrow("evaluation_contract_fingerprint_must_change");
  });

  test("[15] replacement EvaluationContract freezes nested evaluation inputs", () => {
    const original = Object.freeze({ id: "contract-n", fingerprint: "fp-n1" });
    const replacement = replaceEvaluationContract(original, {
      id: "contract-n2",
      fingerprint: "fp-n2",
      required_evidence: [{ source: "source-a", minimum: 1 }],
      invalidation_conditions: { required: [{ kind: "context-window", affectsWindow: true }] },
      scoring_rule: { dimensions: [{ id: "direction", decisive: true }] },
    });

    expect(replacement).not.toBe(original);
    expect(replacement.id).toBe("contract-n2");
    expect(replacement.fingerprint).toBe("fp-n2");
    expect(Object.isFrozen(replacement.required_evidence)).toBe(true);
    expect(Object.isFrozen(replacement.required_evidence[0])).toBe(true);
    expect(Object.isFrozen(replacement.invalidation_conditions)).toBe(true);
    expect(Object.isFrozen(replacement.invalidation_conditions.required)).toBe(true);
    expect(Object.isFrozen(replacement.scoring_rule)).toBe(true);
    expect(Object.isFrozen(replacement.scoring_rule.dimensions[0])).toBe(true);
    expect(() => replacement.required_evidence.push({ source: "source-b", minimum: 2 })).toThrow();
    expect(() => {
      replacement.required_evidence[0].minimum = 2;
    }).toThrow();
  });

  test("[15] a pre-frozen parent is cloned before all mutable children are frozen", () => {
    const callerDimension = { id: "direction", threshold: 1 };
    const callerDimensions = [callerDimension];
    const preFrozenRule = Object.freeze({ dimensions: callerDimensions });
    const replacement = replaceEvaluationContract(
      Object.freeze({ id: "contract-p", fingerprint: "fp-p1" }),
      { id: "contract-p2", fingerprint: "fp-p2", scoring_rule: preFrozenRule },
    );

    expect(replacement.scoring_rule).not.toBe(preFrozenRule);
    expect(Object.isFrozen(replacement.scoring_rule)).toBe(true);
    expect(Object.isFrozen(replacement.scoring_rule.dimensions)).toBe(true);
    expect(Object.isFrozen(replacement.scoring_rule.dimensions[0])).toBe(true);
    expect(Object.isFrozen(callerDimensions)).toBe(false);
    expect(Object.isFrozen(callerDimension)).toBe(false);
    callerDimension.threshold = 2;
    expect(replacement.scoring_rule.dimensions[0].threshold).toBe(1);
  });

  test("[15] replacing a contract never freezes or aliases caller-owned nested inputs", () => {
    const callerEvidence = [{ source: "source-a", minimum: 1 }];
    const replacement = replaceEvaluationContract(
      Object.freeze({ id: "contract-o", fingerprint: "fp-o1" }),
      { id: "contract-o2", fingerprint: "fp-o2", required_evidence: callerEvidence },
    );

    expect(replacement.required_evidence).not.toBe(callerEvidence);
    expect(Object.isFrozen(callerEvidence)).toBe(false);
    expect(Object.isFrozen(callerEvidence[0])).toBe(false);
    callerEvidence[0].minimum = 2;
    callerEvidence.push({ source: "source-b", minimum: 3 });
    expect(replacement.required_evidence).toEqual([{ source: "source-a", minimum: 1 }]);
  });

  test("[16] missing frozen contract is not calibratable", () => {
    expect(evaluateCalibration({ hasFrozenContract: false, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), dimensions: [] })).toMatchObject({ status: "not_calibratable", displaySignal: "evaluation_standard_missing" });
  });

  test("[17] not_due precedes missing Outcome", () => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-01-01T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: false, dimensions: [] }).status).toBe("not_due");
  });

  test.each(fuzzyBoundaryCases)("Calibration treats fuzzy $label window earliest and inside as inconclusive", ({ boundary, earliest, inside, latestExclusive }) => {
    const base = { hasFrozenContract: true, evaluatorVersion: "v1", windowEnd: boundary, outcomeReady: true, dimensions: [{ required: true as const, result: "pass" as const }] };
    expect([earliest, inside, latestExclusive].map((value) => evaluateCalibration({ ...base, asOf: instant(value) }).status)).toEqual(["inconclusive", "inconclusive", "confirmed"]);
  });

  test.each([undefined, "", "   "])("Calibration rejects missing or blank evaluator version %#", (evaluatorVersion) => {
    expect(() => evaluateCalibration({
      hasFrozenContract: true,
      evaluatorVersion,
      asOf: instant("2026-02-02T00:00:00Z"),
      windowEnd: instant("2026-02-01T00:00:00Z"),
      outcomeReady: true,
      dimensions: [{ required: true, result: "pass" }],
    } as unknown as Parameters<typeof evaluateCalibration>[0])).toThrow("evaluator_version_required");
  });

  test("Calibration rejects utility outside its governed vocabulary", () => {
    expect(() => evaluateCalibration({
      hasFrozenContract: true,
      evaluatorVersion: "v1",
      asOf: instant("2026-02-02T00:00:00Z"),
      windowEnd: instant("2026-02-01T00:00:00Z"),
      outcomeReady: true,
      utility: "excellent",
      dimensions: [{ required: true, result: "pass" }],
    } as unknown as Parameters<typeof evaluateCalibration>[0])).toThrow("invalid_calibration_utility");
  });

  test.each(["missing", "candidate", "rejected", "independence_unconfirmed", "evidence_unverified", "conflict_unresolved"] as const)("[18] Outcome gap %s is inconclusive", (outcomeGap) => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: false, outcomeGap, dimensions: [] })).toMatchObject({ status: "inconclusive", missingRequirements: [outcomeGap] });
  });

  test.each([
    { label: "decisive failure", dimensions: [{ required: true as const, decisive: true, result: "fail" as const }] },
    { label: "all required pass", dimensions: [{ required: true as const, result: "pass" as const }, { required: true as const, result: "pass" as const }] },
    { label: "mixed pass and fail", dimensions: [{ required: true as const, result: "pass" as const }, { required: true as const, result: "fail" as const }] },
  ])("[18] missing Outcome precedes scoring for $label", ({ dimensions }) => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: false, outcomeGap: "missing", dimensions })).toMatchObject({
      status: "inconclusive",
      missingRequirements: ["missing"],
    });
  });

  test("[19] mixed required dimensions are partially confirmed", () => {
    const dimensions = [{ id: "direction", required: true as const, result: "pass" as const }, { id: "timing", required: true as const, result: "fail" as const }];
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: true, dimensions })).toMatchObject({ status: "partially_confirmed", dimensionResults: dimensions });
  });

  test("Calibration returns a frozen dimension snapshot independent of caller mutation", () => {
    const dimensions: CalibrationDimension[] = [{ id: "direction", required: true, result: "pass" }];
    const result = evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: true, dimensions });

    expect(result.dimensionResults).not.toBe(dimensions);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.dimensionResults)).toBe(true);
    expect(Object.isFrozen(result.dimensionResults[0])).toBe(true);
    expect(Object.isFrozen(dimensions)).toBe(false);
    expect(Object.isFrozen(dimensions[0])).toBe(false);
    dimensions[0].result = "fail";
    dimensions.push({ id: "timing", required: true, result: "fail" });
    expect(result).toMatchObject({ status: "confirmed", dimensionResults: [{ id: "direction", required: true, result: "pass" }] });
    expect(() => (result.dimensionResults as CalibrationDimension[]).push({ required: true, result: "fail" })).toThrow();
  });

  test("Calibration returns an independent frozen missing-requirements snapshot", () => {
    const result = evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: false, outcomeGap: "missing", dimensions: [] });
    expect(result.missingRequirements).toEqual(["missing"]);
    expect(Object.isFrozen(result.missingRequirements)).toBe(true);
    expect(() => (result.missingRequirements as unknown as string[]).push("candidate")).toThrow();
  });

  test("[20] frozen invalidation precedes not_due", () => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", invalidationConfirmed: true, invalidationAffectsWindow: true, asOf: instant("2026-01-01T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), dimensions: [] }).status).toBe("invalidated_by_context");
  });

  test("[21] utility cannot overwrite an objective refutation", () => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: true, utility: "useful", dimensions: [{ required: true, decisive: true, result: "fail" }] })).toMatchObject({ status: "refuted", utility: "useful" });
  });

  test("[22] evaluator v1 and v2 preserve independently diffable immutable results", () => {
    const dimensions = Object.freeze([Object.freeze({ id: "direction", required: true as const, result: "pass" as const })]);
    const frozenInput = Object.freeze({
      hasFrozenContract: true,
      asOf: Object.freeze(instant("2026-02-02T00:00:00Z")),
      windowEnd: Object.freeze(instant("2026-02-01T00:00:00Z")),
      outcomeReady: true,
      dimensions,
    });
    const v1 = evaluateCalibration({ ...frozenInput, evaluatorVersion: "v1" });
    const v2 = evaluateCalibration({ ...frozenInput, evaluatorVersion: "v2" });

    expect([
      { status: v1.status, evaluatorVersion: v1.evaluatorVersion, dimensionResults: v1.dimensionResults },
      { status: v2.status, evaluatorVersion: v2.evaluatorVersion, dimensionResults: v2.dimensionResults },
    ]).toEqual([
      { status: "confirmed", evaluatorVersion: "v1", dimensionResults: [{ id: "direction", required: true, result: "pass" }] },
      { status: "confirmed", evaluatorVersion: "v2", dimensionResults: [{ id: "direction", required: true, result: "pass" }] },
    ]);
    expect(v1).not.toBe(v2);
    expect(v1.dimensionResults).not.toBe(v2.dimensionResults);
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v2)).toBe(true);
  });

  test("[28] decisive failure precedes partial confirmation", () => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: true, dimensions: [{ required: true, decisive: true, result: "fail" }, { required: true, result: "pass" }] }).status).toBe("refuted");
  });

  test("an empty scored dimension set is inconclusive rather than vacuously confirmed or refuted", () => {
    expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: instant("2026-02-02T00:00:00Z"), windowEnd: instant("2026-02-01T00:00:00Z"), outcomeReady: true, dimensions: [] }).status).toBe("inconclusive");
  });

  test("[10,27] replacement targets qualify independently", () => {
    const effectiveAt = instant("2026-02-01T00:00:00Z");
    const transition = { kind: "supersedes" as const, oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed" as const, effectiveAt };
    const oldClaim = { id: "claim-c", kind: "fact" as const, trust: "trusted" as const, evidence: [verifiedSupport] };
    const trustedReplacement = { id: "claim-d", kind: "fact" as const, trust: "trusted" as const, validFrom: effectiveAt, evidence: [verifiedSupport] };
    const candidateReplacement = { ...trustedReplacement, trust: "candidate" as const };
    expect(projectFactualClaims([oldClaim, trustedReplacement], instant("2026-01-01T00:00:00Z"), [transition]).map((item) => item.claimId)).toEqual(["claim-c"]);
    expect(projectFactualClaims([oldClaim, trustedReplacement], instant("2026-03-01T00:00:00Z"), [transition]).map((item) => item.claimId)).toEqual(["claim-d"]);
    expect(projectFactualClaims([oldClaim, candidateReplacement], instant("2026-03-01T00:00:00Z"), [transition])).toEqual([]);
  });

  test("[25] inference has an explicit non-factual view", () => {
    const inference = { id: "claim-c", kind: "inference" as const, trust: "trusted" as const, evidence: [verifiedSupport] };
    expect(projectInferenceView(inference, { state: "effective", temporalCertainty: "known", transitionConflict: false })).toEqual({ visible: true, displaySignal: "inference" });
  });

  test("[1,2,3,4,5,7,11,26,27,31] display semantics remain honest", () => {
    const trusted = { id: "claim-c", kind: "fact" as const, trust: "trusted" as const, evidence: [verifiedSupport] };
    const candidate = { ...trusted, trust: "candidate" as const };
    expect(claimDisplaySignals(candidate, { state: "effective", temporalCertainty: "known", transitionConflict: false }, evaluateCurrentEligibility(candidate, { state: "effective", temporalCertainty: "known", transitionConflict: false }))).toContain("pending_confirmation");
    expect(claimDisplaySignals(trusted, { state: "scheduled", temporalCertainty: "known", transitionConflict: false }, { eligible: false, reasons: ["validity_not_current"], conflict: false, confidenceCeiling: "high_allowed", temporalCertainty: "known" })).toContain("not_yet_effective");
    expect(claimDisplaySignals(trusted, { state: "unknown", temporalCertainty: "unknown", transitionConflict: false }, evaluateCurrentEligibility(trusted, { state: "unknown", temporalCertainty: "unknown", transitionConflict: false }))).toContain("temporal_unknown");
    expect(claimDisplaySignals(trusted, { state: "superseded", temporalCertainty: "known", transitionConflict: false }, { eligible: false, reasons: ["validity_not_current"], conflict: false, confidenceCeiling: "high_allowed", temporalCertainty: "known" }, undefined, { hasEligibleReplacement: false })).toContain("no_confirmed_replacement");
    expect(claimDisplaySignals(trusted, { state: "unknown", temporalCertainty: "unknown", transitionConflict: false }, evaluateCurrentEligibility(trusted, { state: "unknown", temporalCertainty: "unknown", transitionConflict: false }), { state: "unavailable", active: false })).toContain("evidence_unavailable");
    expect(countCorroboration([verifiedSupport, { ...verifiedSupport }]).confirmedIndependentGroups).toBe(1);
  });

  test("[7] future valid_from is scheduled", () => {
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-01-01T00:00:00Z"), validFrom: day("2026-02-01"), transitions: [] }).state).toBe("scheduled");
  });

  test("[8] valid_to is exclusive and restores historical visibility", () => {
    const validTo = instant("2026-02-01T00:00:00Z");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-01T00:00:00Z"), validTo, transitions: [] }).state).toBe("expired");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-01-31T23:59:59Z"), validTo, transitions: [] }).state).toBe("effective");
  });

  test("[9] candidate supersession does not change validity", () => {
    const transition: ClaimTransition = { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "candidate", effectiveAt: instant("2026-02-01T00:00:00Z") };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-03-01T00:00:00Z"), transitions: [transition] }).state).toBe("unknown");
  });

  test("[10] confirmed supersession applies only after its effective boundary", () => {
    const transition: ClaimTransition = { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt: instant("2026-02-01T00:00:00Z") };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-01-31T23:59:59Z"), transitions: [transition] }).state).toBe("unknown");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-01T00:00:00Z"), transitions: [transition] }).state).toBe("superseded");
  });

  test("[11] age alone does not expire a Claim", () => {
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2036-01-01T00:00:00Z"), transitions: [] })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });

  test("[14] valid-time uses effective_at rather than recorded_at", () => {
    const transition: ClaimTransition = { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt: instant("2026-02-01T00:00:00Z"), recordedAt: instant("2026-03-01T00:00:00Z") };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-01-01T00:00:00Z"), transitions: [transition] }).state).toBe("unknown");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), transitions: [transition] }).state).toBe("superseded");
  });

  test("[26] trusted fact with unknown time remains temporally unknown", () => {
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-01-01T00:00:00Z"), transitions: [] }).temporalCertainty).toBe("unknown");
  });

  test("[27] a crossed supersession removes only the old Claim", () => {
    const transition: ClaimTransition = { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt: instant("2026-02-01T00:00:00Z") };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-03-01T00:00:00Z"), transitions: [transition] }).state).toBe("superseded");
    expect(reduceClaimValidity({ claimId: "claim-d", asOf: instant("2026-03-01T00:00:00Z"), transitions: [transition] }).state).toBe("unknown");
  });

  test("[31] month precision stays unknown inside its uncertainty interval", () => {
    const month = temporalPoint("2026-02", "month", "+00:00");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), validFrom: month, transitions: [] })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });

  test.each(fuzzyBoundaryCases)("fuzzy $label Claim boundaries classify earliest, inside, and latestExclusive", ({ boundary, earliest, inside, latestExclusive }) => {
    const points = [earliest, inside, latestExclusive].map(instant);
    expect(points.map((asOf) => reduceClaimValidity({ claimId: "claim-c", asOf, validFrom: boundary, transitions: [] }).state)).toEqual(["unknown", "unknown", "effective"]);
    expect(points.map((asOf) => reduceClaimValidity({ claimId: "claim-c", asOf, validTo: boundary, transitions: [] }).state)).toEqual(["unknown", "unknown", "expired"]);
  });

  test.each(fuzzyBoundaryCases)("fuzzy $label transition classifies earliest, inside, and latestExclusive", ({ boundary, earliest, inside, latestExclusive }) => {
    const transition: ClaimTransition = { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt: boundary };
    const points = [earliest, inside, latestExclusive].map(instant);
    expect(points.map((asOf) => reduceClaimValidity({ claimId: "claim-c", asOf, validFrom: instant("2025-01-01T00:00:00Z"), transitions: [transition] }).state)).toEqual(["unknown", "unknown", "revoked"]);
  });

  test("exact instant boundaries cross at the exact timestamp", () => {
    const boundary = instant("2026-02-01T00:00:00Z");
    const transition: ClaimTransition = { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt: boundary };
    const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a"], definingClaimEligible: true, cancellation: { confirmationState: "confirmed" as const, effectiveAt: boundary } };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: boundary, validFrom: boundary, transitions: [] }).state).toBe("effective");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: boundary, validTo: boundary, transitions: [] }).state).toBe("expired");
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: boundary, transitions: [transition] }).state).toBe("revoked");
    expect(projectTimelineEvent(event, boundary).displayState).toBe("planned_then_cancelled");
  });

  test("confirmed revocation wins over supersession and reports the conflict", () => {
    const effectiveAt = instant("2026-02-01T00:00:00Z");
    const transitions: ClaimTransition[] = [
      { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt },
      { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt },
    ];
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-03-01T00:00:00Z"), transitions })).toEqual({ state: "revoked", temporalCertainty: "known", transitionConflict: true });
  });

  test("an ambiguous confirmed revocation blocks a crossed supersession", () => {
    const transitions: ClaimTransition[] = [
      { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt: instant("2026-01-01T00:00:00Z") },
      { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt: approximatePoint("around February", "+00:00", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z") },
    ];
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), transitions })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });

  test.each([
    { label: "supersedes without newClaimId", transition: { kind: "supersedes", oldClaimId: "claim-c", confirmationState: "confirmed" } },
    { label: "revokes with newClaimId", transition: { kind: "revokes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed" } },
  ])("runtime validation rejects $label", ({ transition }) => {
    expect(() => reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), transitions: [transition as unknown as ClaimTransition] })).toThrow("invalid_claim_transition_shape");
  });

  test("an ambiguous transition boundary cannot change the projection", () => {
    const effectiveAt = approximatePoint("around February", "+00:00", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
    const transition: ClaimTransition = { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), transitions: [transition] }).state).toBe("unknown");
  });

  test("a confirmed transition without effective_at cannot change validity", () => {
    const transition: ClaimTransition = { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed" };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-03-01T00:00:00Z"), transitions: [transition] }).state).toBe("unknown");
  });

  test("an interval that cannot prove valid_from before valid_to is rejected", () => {
    expect(() => reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-15T00:00:00Z"), validFrom: temporalPoint("2026-02", "month", "+00:00"), validTo: temporalPoint("2026-02-15", "day", "+00:00"), transitions: [] })).toThrow("invalid_or_ambiguous_valid_interval");
  });

  test("positive timezone precision boundaries use local calendar dates", () => {
    expect(temporalPoint("2026-02-01", "day", "+08:00")).toMatchObject({ earliestMs: Date.parse("2026-01-31T16:00:00Z"), latestExclusiveMs: Date.parse("2026-02-01T16:00:00Z") });
    expect(temporalPoint("2026-02", "month", "+08:00")).toMatchObject({ earliestMs: Date.parse("2026-01-31T16:00:00Z"), latestExclusiveMs: Date.parse("2026-02-28T16:00:00Z") });
    expect(temporalPoint("2026", "year", "+08:00")).toMatchObject({ earliestMs: Date.parse("2025-12-31T16:00:00Z"), latestExclusiveMs: Date.parse("2026-12-31T16:00:00Z") });
  });

  test.each([
    { label: "invalid Gregorian day", run: () => temporalPoint("2026-02-30", "day", "+00:00"), error: "invalid_day" },
    { label: "invalid Gregorian instant", run: () => temporalPoint("2026-02-30T00:00:00Z", "instant", "Z"), error: "invalid_instant" },
    { label: "invalid month", run: () => temporalPoint("2026-13", "month", "+00:00"), error: "invalid_month" },
    { label: "timezone-free instant", run: () => temporalPoint("2026-02-01T00:00:00", "instant", "Z"), error: "invalid_instant" },
    { label: "out-of-range timezone hour", run: () => temporalPoint("2026-02-01", "day", "+24:00"), error: "invalid_timezone" },
    { label: "out-of-range timezone minute", run: () => temporalPoint("2026-02-01", "day", "+08:60"), error: "invalid_timezone" },
    { label: "non-finite approximate endpoint", run: () => approximatePoint("around February", "+00:00", "not-a-time", "2026-03-01T00:00:00Z"), error: "invalid_approximate_interval" },
    { label: "timezone-free approximate endpoint", run: () => approximatePoint("around February", "+00:00", "2026-02-01T00:00:00", "2026-03-01T00:00:00Z"), error: "invalid_approximate_interval" },
    { label: "reverse approximate range", run: () => approximatePoint("around February", "+00:00", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"), error: "invalid_approximate_interval" },
    { label: "equal approximate range", run: () => approximatePoint("around February", "+00:00", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z"), error: "invalid_approximate_interval" },
  ])("TemporalPoint validation fails closed for $label", ({ run, error }) => {
    expect(run).toThrow(error);
  });

  test("an exact zero-length validity interval is rejected", () => {
    const boundary = instant("2026-02-01T00:00:00Z");
    expect(() => reduceClaimValidity({ claimId: "claim-c", asOf: boundary, validFrom: boundary, validTo: boundary, transitions: [] })).toThrow("invalid_or_ambiguous_valid_interval");
  });

  test("a provably ordered uncertain validity interval remains valid", () => {
    const validFrom = day("2026-02-01");
    const validTo = instant("2026-02-02T00:00:00Z");
    expect(() => reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-02-01T12:00:00Z"), validFrom, validTo, transitions: [] })).not.toThrow();
  });

  test("non-instant as_of overlapping valid_from boundary remains unknown", () => {
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: temporalPoint("2026-02-01", "day", "+08:00"), validFrom: instant("2026-02-01T00:00:00Z"), transitions: [] })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });

  test("non-instant as_of overlapping valid_to boundary remains unknown", () => {
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: temporalPoint("2026-02-01", "day", "+08:00"), validTo: instant("2026-02-01T00:00:00Z"), transitions: [] })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });

  test("non-instant as_of overlapping transition boundary remains unknown", () => {
    const transition: ClaimTransition = { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt: instant("2026-02-01T00:00:00Z") };
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: temporalPoint("2026-02-01", "day", "+08:00"), transitions: [transition] })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
  });
});
