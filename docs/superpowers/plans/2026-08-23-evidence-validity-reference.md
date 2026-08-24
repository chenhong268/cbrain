# Evidence Validity Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the #340 Evidence–Claim–Validity and Calibration semantics executable with deterministic, anonymous, test-only reference code before any production data model or runtime work.

**Architecture:** Add one narrow helper under `tests/helpers/` containing pure reference types and reducers, plus one contract test file whose cases map directly to contract fixtures 1–31 (including 24a–c). Nothing under `src/` imports the helper, and the implementation reads no vault, database, network, environment-dependent clock, or real user data.

**Tech Stack:** TypeScript 5.9, Bun 1.3 test runner, strict RFC 3339/Gregorian validation followed by deterministic UTC calendar arithmetic for fixed-offset reference timestamps.

**Spec:** `docs/superpowers/specs/2026-07-14-evidence-claim-validity-calibration-contract.md`

## Global Constraints

- This issue is test/reference scope only; do not modify `src/`, database tables, migrations, ontology, MCP schemas, tool profiles, or default display behavior.
- Use only anonymous identifiers such as `entity-a`, `claim-c`, `source-b`, and fixed synthetic timestamps.
- Reducers are pure functions: every `asOf` value is an explicit argument; no LLM, network, database, vault, `Date.now()`, or mutable singleton is allowed.
- `verified Evidence` never implies `trusted Claim`; replacement targets must qualify independently.
- `as_of` is valid-time. Do not mix it with `recorded_at` or a future `known_at` query.
- Ambiguous temporal boundaries return `unknown`; they are never rounded to the first or last day of a month.
- Tests protect returned states, eligibility, projection, and display semantics. Do not inspect source strings, variable names, or file formatting.
- No production persistence, table, migration, public API, feature flag, compatibility alias, background loop, registry, plugin layer, or future placeholder interface is permitted.

---

### Task 1: Temporal points and Claim validity reducer

**Files:**
- Create: `tests/helpers/evidence-claim-validity-reference.ts`
- Create: `tests/core/evidence-claim-validity-contract.test.ts`

**Interfaces:**
- Consumes: explicit ISO timestamps and the contract sections 4.1–4.4.
- Produces:
  - `temporalPoint(value, precision, timezone): TemporalPoint`
  - `approximatePoint(value, timezone, earliest, latestExclusive): TemporalPoint`
  - `reduceClaimValidity({ claimId, asOf, validFrom, validTo, transitions }): ValidityResult`
  - `ValidityResult = { state, temporalCertainty, transitionConflict }`

- [ ] **Step 1: Write failing tests for fixture groups 7–11, 14, 26, 27, and 31**

Add tests with these exact observable assertions:

```ts
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
});
```

- [ ] **Step 2: Run the new contract test and verify RED**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts`

Expected: FAIL because `tests/helpers/evidence-claim-validity-reference.ts` does not exist.

- [ ] **Step 3: Implement the minimal temporal types and reducer**

Use these exact public types; keep parsing/interval helpers private:

```ts
export type TemporalPrecision = "instant" | "day" | "month" | "year" | "approximate";
export interface TemporalPoint { value: string; precision: TemporalPrecision; timezone: string; earliestMs: number; latestExclusiveMs: number; }
export type ValidityState = "unknown" | "scheduled" | "effective" | "expired" | "superseded" | "revoked";
interface ClaimTransitionBase { oldClaimId: string; confirmationState: "candidate" | "confirmed" | "rejected"; effectiveAt?: TemporalPoint; recordedAt?: TemporalPoint; }
export type ClaimTransition = ClaimTransitionBase & (
  | { kind: "supersedes"; newClaimId: string }
  | { kind: "revokes"; newClaimId?: never }
);
export interface ValidityResult { state: ValidityState; temporalCertainty: "known" | "unknown"; transitionConflict: boolean; }
```

Constructors fail closed before producing a `TemporalPoint`: instant values are strict RFC 3339 with an explicit `Z` or fixed offset; day/month/year values are strict Gregorian values; fixed offsets must match `Z|[+-]HH:MM` with numeric fields in range; every derived millisecond must be finite; and approximate bounds must satisfy `earliest < latestExclusive`. The reducer rejects provably overlapping intervals and exact zero-length `[valid_from, valid_to)` intervals while retaining uncertain intervals whose ordering is provable.

Reducer order must be literal: validate the interval and transition discriminant; then crossed confirmed revocation; ambiguous confirmed revocation; crossed confirmed supersession; ambiguous confirmed supersession; scheduled/ambiguous `valid_from`; expired/ambiguous `valid_to`; effective when at least one valid-time boundary deterministically covers `asOf`; otherwise unknown. One explicit three-way comparator returns `before | ambiguous | crossed`: exact `asOf` points in `[earliest, latestExclusive)` are ambiguous, `latestExclusive` is crossed, and an exact instant boundary crosses exactly at its timestamp. `recordedAt` is stored but never read by this reducer.

- [ ] **Step 4: Run Task 1 tests and typecheck**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts && bun run typecheck:tests`

Expected: all Task 1 tests PASS; TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
git commit -m "test: execute claim temporal validity contract (#433)"
```

### Task 2: Evidence verification and factual-current eligibility

**Files:**
- Modify: `tests/helpers/evidence-claim-validity-reference.ts`
- Modify: `tests/core/evidence-claim-validity-contract.test.ts`

**Interfaces:**
- Consumes: `ValidityResult` from Task 1.
- Produces:
  - `verifyEvidence(input): EvidenceVerification`
  - `countCorroboration(bindings): { confirmedIndependentGroups, independenceUnknown }`
  - `evaluateCurrentEligibility(claim, validity): CurrentEligibility`
  - `projectFactualClaims(claims, asOf, transitions): CurrentProjection[]`
  - `projectInferenceView(claim, validity): InferenceProjection`
  - `claimDisplaySignals(claim, validity, eligibility, verification?, context?): ClaimDisplaySignal[]`
  - `buildDefaultDisplay(record): Record<string, unknown>`

- [ ] **Step 1: Add failing tests for fixture groups 1–6, 13, 23, 25, and 29**

Use these exact data contracts and assertions:

```ts
// Add these names to the existing helper import from Task 1.
// The resulting single import also keeps approximatePoint,
// reduceClaimValidity, temporalPoint, and ClaimTransition.
import {
  buildDefaultDisplay,
  claimDisplaySignals,
  countCorroboration,
  evaluateCurrentEligibility,
  projectFactualClaims,
  projectInferenceView,
  verifyEvidence,
} from "../helpers/evidence-claim-validity-reference.js";

const verifiedSupport = { stance: "supports" as const, verificationState: "verified" as const, sourceVersionAvailable: true, independenceGroupState: "confirmed" as const, independenceGroup: "group-1" };

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
```

- [ ] **Step 2: Run the new Task 2 tests and verify RED**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts`

Expected: FAIL with missing exported functions.

- [ ] **Step 3: Implement only the data contracts used by Task 2**

Use discriminated string unions for `ClaimKind`, `ClaimTrust`, `EvidenceStance`, verification state (including `unchecked`), and semantic display signals. One stance-aware active-binding predicate requires `verificationState="verified"` and an available pinned source version for both supports and contradicts. `evaluateCurrentEligibility` must evaluate every axis and return all reasons in this fixed order: kind, trust, validity, active support, authority. Validity `unknown` is eligible with `temporalCertainty: "unknown"`; only an active contradiction sets `conflict: true` and `confidenceCeiling: "not_high"`, while unchecked/mismatch/unavailable contradictions do nothing. Contradictions never add an exclusion reason. `projectFactualClaims` calls the Task 1 reducer separately for every Claim and never transfers trust/evidence from the old Claim to the replacement; fixture 10 gives the replacement its own `validFrom=T2`, which is why only the old Claim is visible before T2. `projectInferenceView` is visible only for trusted/effective inference with active support and always returns the `inference` display signal. `claimDisplaySignals` returns semantic flags rather than freezing Chinese copy; `no_confirmed_replacement` is emitted only when the supplied context explicitly says there is no eligible replacement. `buildDefaultDisplay` must return only `summary` and `state` when present.

- [ ] **Step 4: Run Task 1–2 tests and typecheck**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts && bun run typecheck:tests`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
git commit -m "test: execute factual current eligibility contract (#433)"
```

### Task 3: Event projection and legacy compatibility fixtures

**Files:**
- Modify: `tests/helpers/evidence-claim-validity-reference.ts`
- Modify: `tests/core/evidence-claim-validity-contract.test.ts`

**Interfaces:**
- Consumes: `evaluateCurrentEligibility` and temporal boundary semantics.
- Produces:
  - `projectTimelineEvent(event, asOf): TimelineProjection`
  - `adaptLegacyGraph(rows): Array<{ display, raw }>`
  - `adaptLegacyTimeline(rows): Array<{ display, raw }>`
  - `adaptLegacyRecall(envelope, dependencies): LegacyRecallProjection`

- [ ] **Step 1: Add failing tests for fixture groups 12, 24a–c, and 30**

```ts
// Add these names to the existing single helper import.
import {
  adaptLegacyGraph,
  adaptLegacyRecall,
  adaptLegacyTimeline,
  projectTimelineEvent,
} from "../helpers/evidence-claim-validity-reference.js";

test("[12] every participant view shares one Event identity", () => {
  const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a", "entity-b"], definingClaimEligible: true };
  expect(projectTimelineEvent(event, instant("2026-03-01T00:00:00Z")).rows.map((row) => [row.participant, row.eventId])).toEqual([["entity-a", "event-d"], ["entity-b", "event-d"]]);
  expect(projectTimelineEvent({ ...event, confirmationState: "candidate" }, instant("2026-03-01T00:00:00Z"))).toEqual({ rows: [], displayState: "excluded" });
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
});

test("[24b] legacy timeline preserves rows and never merges matching content across identities", () => {
  const rows = Object.freeze([
    Object.freeze({ rowId: 7, entity: "entity-a", date: "2026-01-01", summary: "匿名事件甲" }),
    Object.freeze({ rowId: 8, entity: "entity-a", date: "2026-01-02", summary: "匿名事件乙" }),
    Object.freeze({ rowId: 7, entity: "entity-b", date: "2026-01-01", summary: "匿名事件甲" }),
  ]);
  const result = adaptLegacyTimeline(rows);
  expect(result.map((item) => item.raw.eventId)).toEqual([
    "legacy-timeline:entity-a:7",
    "legacy-timeline:entity-a:8",
    "legacy-timeline:entity-b:7",
  ]);
});

test("[24c] pre-cutover brief recall adds no kernel work", () => {
  const failIfCalled = (): never => { throw new Error("pre-cutover kernel work must not run"); };
  const legacyEnvelope = { answer: "匿名回答", citations: 1, sqlCount: 99, llmCount: 99 };
  const result = adaptLegacyRecall(
    legacyEnvelope,
    { runKernel: failIfCalled, recordKernelAccounting: failIfCalled },
  );
  expect(result.display).toEqual({ answer: "匿名回答", citations: 1 });
  expect(result.kernelSqlCount).toBe(0);
  expect(result.kernelLlmCount).toBe(0);
});

test("[30] cancellation keeps history but never claims the event occurred", () => {
  const event = { id: "event-d", confirmationState: "confirmed" as const, participants: ["entity-a"], definingClaimEligible: true, cancellation: { confirmationState: "confirmed" as const, effectiveAt: instant("2026-02-01T00:00:00Z") } };
  expect(projectTimelineEvent(event, instant("2026-01-01T00:00:00Z")).displayState).toBe("planned_or_confirmed");
  expect(projectTimelineEvent(event, instant("2026-03-01T00:00:00Z")).displayState).toBe("planned_then_cancelled");
});
```

- [ ] **Step 2: Run Task 3 tests and verify RED**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts`

Expected: FAIL with missing projection/adapter exports.

- [ ] **Step 3: Implement the minimal projections and adapters**

Timeline rules are fixed: candidate/rejected event or ineligible defining Claim returns no rows with explicit `displayState="excluded"`; confirmed eligible event returns one row per participant with the same `eventId`; crossed confirmed cancellation returns `planned_then_cancelled`; an ambiguous cancellation boundary returns `temporal_unknown`. Graph and timeline adapters map anonymous frozen multi-row fixtures without sorting, dropping, or merging rows; equal timeline content with different entity/row identities remains distinct. Recall ignores supplied throwing kernel/accounting callbacks and reports literal zero added work rather than echoing input counters. All adapters remain pure local shapes; internal IDs are additive under `raw`, and display fields remain exactly as asserted.

- [ ] **Step 4: Run contract tests and current compatibility suites**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts tests/mcp/graph-timeline-envelope.test.ts tests/core/evidence.test.ts tests/core/evidence-summary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
git commit -m "test: execute projection compatibility contract (#433)"
```

### Task 4: Frozen evaluation and Calibration precedence

**Files:**
- Modify: `tests/helpers/evidence-claim-validity-reference.ts`
- Modify: `tests/core/evidence-claim-validity-contract.test.ts`

**Interfaces:**
- Consumes: explicit `asOf` TemporalPoint and immutable evaluation inputs.
- Produces: `evaluateCalibration(input): CalibrationResult` and `replaceEvaluationContract(original, replacement): EvaluationContract`.

- [ ] **Step 1: Add failing tests for fixture groups 15–22 and 28**

```ts
// Add these names to the existing single helper import.
import {
  evaluateCalibration,
  replaceEvaluationContract,
} from "../helpers/evidence-claim-validity-reference.js";

const windowEnd = instant("2026-02-01T00:00:00Z");
const beforeWindowEnd = instant("2026-01-01T00:00:00Z");
const afterWindowEnd = instant("2026-02-02T00:00:00Z");

test("[15] a frozen EvaluationContract cannot be mutated in place", () => {
  const original = Object.freeze({ id: "contract-f", fingerprint: "fp-1", tolerance: 0.1 });
  const replacement = replaceEvaluationContract(original, { id: "contract-f2", fingerprint: "fp-2", tolerance: 0.2 });
  expect(original).toEqual({ id: "contract-f", fingerprint: "fp-1", tolerance: 0.1 });
  expect(replacement.id).toBe("contract-f2");
  expect(() => replaceEvaluationContract(original, { id: "contract-f", fingerprint: "fp-2", tolerance: 0.2 })).toThrow("evaluation_contract_identity_must_change");
  expect(() => replaceEvaluationContract(original, { id: "contract-f2", fingerprint: "fp-1", tolerance: 0.2 })).toThrow("evaluation_contract_fingerprint_must_change");
});

test("[16] missing frozen contract is not calibratable", () => {
  expect(evaluateCalibration({ hasFrozenContract: false, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, dimensions: [] })).toMatchObject({ status: "not_calibratable", displaySignal: "evaluation_standard_missing" });
});

test("[17] not_due precedes missing Outcome", () => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: beforeWindowEnd, windowEnd, outcomeReady: false, dimensions: [] }).status).toBe("not_due");
});

test.each(["missing", "candidate", "rejected", "independence_unconfirmed", "evidence_unverified", "conflict_unresolved"] as const)("[18] Outcome gap %s is inconclusive", (outcomeGap) => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, outcomeReady: false, outcomeGap, dimensions: [] })).toMatchObject({ status: "inconclusive", missingRequirements: [outcomeGap] });
});

test("[19] mixed required dimensions are partially confirmed", () => {
  const dimensions = [{ id: "direction", required: true as const, result: "pass" as const }, { id: "timing", required: true as const, result: "fail" as const }];
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, outcomeReady: true, dimensions })).toMatchObject({ status: "partially_confirmed", dimensionResults: dimensions });
});

test("[20] frozen invalidation precedes not_due", () => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", invalidationConfirmed: true, invalidationAffectsWindow: true, asOf: beforeWindowEnd, windowEnd, dimensions: [] }).status).toBe("invalidated_by_context");
});

test("[21] utility cannot overwrite an objective refutation", () => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, outcomeReady: true, utility: "useful", dimensions: [{ required: true, decisive: true, result: "fail" }] })).toMatchObject({ status: "refuted", utility: "useful" });
});

test("[22] evaluator v1 and v2 preserve independently diffable immutable results", () => {
  const dimensions = Object.freeze([Object.freeze({ id: "direction", required: true as const, result: "pass" as const })]);
  const input = Object.freeze({ hasFrozenContract: true, asOf: Object.freeze(afterWindowEnd), windowEnd: Object.freeze(windowEnd), outcomeReady: true, dimensions });
  const v1 = evaluateCalibration({ ...input, evaluatorVersion: "v1" });
  const v2 = evaluateCalibration({ ...input, evaluatorVersion: "v2" });
  expect([v1.evaluatorVersion, v2.evaluatorVersion]).toEqual(["v1", "v2"]);
  expect(v1.dimensionResults).not.toBe(v2.dimensionResults);
  expect(Object.isFrozen(v1)).toBe(true);
  expect(Object.isFrozen(v2)).toBe(true);
});

test("[28] decisive failure precedes partial confirmation", () => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, outcomeReady: true, dimensions: [{ required: true, decisive: true, result: "fail" }, { required: true, result: "pass" }] }).status).toBe("refuted");
});

test("an empty scored dimension set is inconclusive rather than vacuously confirmed or refuted", () => {
  expect(evaluateCalibration({ hasFrozenContract: true, evaluatorVersion: "v1", asOf: afterWindowEnd, windowEnd, outcomeReady: true, dimensions: [] }).status).toBe("inconclusive");
});
```

- [ ] **Step 2: Run Task 4 tests and verify RED**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts`

Expected: FAIL with missing Calibration exports.

- [ ] **Step 3: Implement the literal precedence table**

`CalibrationInput` requires non-empty `evaluatorVersion`, explicit `TemporalPoint` values for `asOf` and `windowEnd`, and optional `utility: "useful" | "neutral" | "harmful"`. Compare the window with the same three-way temporal comparator: deterministically before is `not_due`, an ambiguous boundary is `inconclusive`, and only crossed proceeds to Outcome scoring.

Return the first matching terminal status in this exact order: `not_calibratable`, `invalidated_by_context`, `not_due`, `inconclusive`, `refuted`, `confirmed`, `partially_confirmed`, final fallback `inconclusive`. A decisive required failure or all-required failure is `refuted`; all required dimensions passing is `confirmed`; mixed pass/fail without decisive failure is `partially_confirmed`. Preserve `utility` and `dimensionResults` as separate return fields. When the status is inconclusive, copy the exact `outcomeGap` into `missingRequirements`; do not replace it with a generic message. Return semantic `displaySignal: "evaluation_standard_missing"` for `not_calibratable`.

Both `replaceEvaluationContract` and `evaluateCalibration` deep-clone JSON-shaped caller inputs before recursively freezing the clone, including children beneath a pre-frozen parent. They never freeze caller-owned nested objects. Every result owns frozen `dimensionResults` and `missingRequirements` snapshots; v1/v2 evaluations of frozen inputs remain separate immutable results. `replaceEvaluationContract` also rejects reuse of the original ID or fingerprint.

- [ ] **Step 4: Run the complete contract test and typecheck**

Run: `bun test tests/core/evidence-claim-validity-contract.test.ts && bun run typecheck:tests`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
git commit -m "test: execute calibration precedence contract (#433)"
```

### Task 5: Contract completeness, subtraction review, and integration proof

**Files:**
- Modify only if a behavioral gap is found: `tests/helpers/evidence-claim-validity-reference.ts`
- Modify only if a fixture assertion is missing: `tests/core/evidence-claim-validity-contract.test.ts`
- Add: `docs/superpowers/plans/2026-08-23-evidence-validity-reference.md`

**Interfaces:**
- Consumes: all Task 1–4 outputs.
- Produces: verified issue evidence; no new runtime interface.

- [ ] **Step 1: Map all contract fixtures to executable tests**

Verify this exact coverage table by test name and assertion, without adding a source-string meta-test:

```text
Temporal/transition: 7, 8, 9, 10, 11, 14, 26, 27, 31
Evidence/current/privacy: 1, 2, 3, 4, 5, 6, 13, 23, 25, 29
Event/compatibility: 12, 24a, 24b, 24c, 30
Evaluation/calibration: 15, 16, 17, 18, 19, 20, 21, 22, 28
```

Expected: every numbered group 1–31 is present; group 24 has all three required compatibility subassertions.

- [ ] **Step 2: Run subtraction and privacy checks**

Run:

```bash
git diff main...HEAD --name-only
git diff main...HEAD --stat
git status --short
git ls-files --others --exclude-standard
rg -n "/Users/|file:///(Users|home)/|[[:alnum:]._%+-]+@[[:alnum:].-]+\\.[[:alpha:]]{2,}" tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
```

Expected: changed implementation files are under `tests/` plus this plan; the mechanical path/email privacy scan returns no matches; manual review confirms every entity/source/product remains an anonymous placeholder; no `src/`, schema, migration, MCP, CLI, package, or lockfile change exists.

- [ ] **Step 3: Run targeted and repository gates**

Run:

```bash
bun test tests/core/evidence-claim-validity-contract.test.ts tests/mcp/graph-timeline-envelope.test.ts tests/core/evidence.test.ts tests/core/evidence-summary.test.ts
bun run typecheck:tests
bun run check:docs
bun run check:ci
```

Expected: every command exits 0.

- [ ] **Step 4: Perform adversarial review and fix verified findings**

Review against these concrete attacks:

```text
1. Can verified Evidence enter factual current while Claim is candidate?
2. Can candidate or ambiguous transitions remove an old Claim?
3. Can supersession automatically promote the replacement Claim?
4. Can month precision be silently rounded, or recorded_at affect valid-time?
5. Can contradictions disappear, private audit fields leak, or utility overwrite objective calibration?
```

Expected: each answer is “no”, demonstrated by an executable assertion. Any discovered issue is fixed with a new failing test before implementation changes.

- [ ] **Step 5: Commit plan and any final test correction**

```bash
git add docs/superpowers/plans/2026-08-23-evidence-validity-reference.md tests/helpers/evidence-claim-validity-reference.ts tests/core/evidence-claim-validity-contract.test.ts
git commit -m "docs: record evidence validity reference plan (#433)"
```

- [ ] **Step 6: Update GitHub evidence without releasing**

Open one PR that closes #433, link the passing commands and independent adversarial-review result, and add a short Phase 1A evidence comment to #339. Do not create a tag, release, deployment worktree, or modify the installed CBrain.
