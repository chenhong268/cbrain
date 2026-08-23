import { describe, expect, test } from "bun:test";
import {
  approximatePoint,
  buildDefaultDisplay,
  claimDisplaySignals,
  countCorroboration,
  evaluateCurrentEligibility,
  projectFactualClaims,
  projectInferenceView,
  reduceClaimValidity,
  temporalPoint,
  type ClaimTransition,
  verifyEvidence,
} from "../helpers/evidence-claim-validity-reference.js";

const instant = (value: string) => temporalPoint(value, "instant", "Z");
const day = (value: string) => temporalPoint(value, "day", "+00:00");
const verifiedSupport = { stance: "supports" as const, verificationState: "verified" as const, sourceVersionAvailable: true, independenceGroupState: "confirmed" as const, independenceGroup: "group-1" };

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

  test("[25] trusted inference remains outside factual current", () => {
    expect(evaluateCurrentEligibility({ id: "claim-c", kind: "inference", trust: "trusted", evidence: [verifiedSupport] }, { state: "effective", temporalCertainty: "known", transitionConflict: false })).toMatchObject({ eligible: false, reasons: ["kind_not_fact"] });
  });

  test("[29] a verified capture stays active when a newer live version exists", () => {
    expect(verifyEvidence({ locatorResolved: true, pinnedVersionAvailable: true, pinnedHashMatches: true, excerptHashMatches: true, liveVersionId: "source-b-v2", pinnedVersionId: "source-b-v1" })).toEqual({ state: "verified", active: true });
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

  test("confirmed revocation wins over supersession and reports the conflict", () => {
    const effectiveAt = instant("2026-02-01T00:00:00Z");
    const transitions: ClaimTransition[] = [
      { kind: "supersedes", oldClaimId: "claim-c", newClaimId: "claim-d", confirmationState: "confirmed", effectiveAt },
      { kind: "revokes", oldClaimId: "claim-c", confirmationState: "confirmed", effectiveAt },
    ];
    expect(reduceClaimValidity({ claimId: "claim-c", asOf: instant("2026-03-01T00:00:00Z"), transitions })).toEqual({ state: "revoked", temporalCertainty: "known", transitionConflict: true });
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
