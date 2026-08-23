import { describe, expect, test } from "bun:test";
import {
  approximatePoint,
  reduceClaimValidity,
  temporalPoint,
  type ClaimTransition,
} from "../helpers/evidence-claim-validity-reference.js";

const instant = (value: string) => temporalPoint(value, "instant", "Z");
const day = (value: string) => temporalPoint(value, "day", "+00:00");

describe("Evidence–Claim–Validity executable contract", () => {
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
