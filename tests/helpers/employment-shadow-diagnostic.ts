import type { LinkRow } from "../../src/storage/sqlite.js";
import {
  evaluateCurrentEligibility,
  reduceClaimValidity,
  type CurrentEligibility,
  type TemporalPoint,
} from "./evidence-claim-validity-reference.js";

/**
 * Issue #469 test-only shadow diagnostic. Maps real legacy employment
 * LinkRows (from an isolated temp SQLite, supplied by the caller) onto the
 * #433 reference to report, per row, what a canonical employment Claim
 * model could and could not derive today.
 *
 * Rows only: no DB handle, no file I/O, never mounted at runtime. Legacy
 * rows stay the sole production authority; count, order, endpoints, raw
 * trust, and provenance strings pass through verbatim. Provenance strings
 * are not frozen/verified EvidenceCaptures, so shadow trust stays
 * candidate/rejected with unchecked/unavailable evidence — nothing is
 * promoted. Legacy rows carry no valid_from/valid_to (mapped to "unknown",
 * never guessed) and no transition history. Temporal semantics come
 * exclusively from the #433 reducer; known_at is out of scope.
 */

export interface EmploymentShadowDiagnostic {
  /** Verbatim legacy compatibility view; legacy storage stays the authority. */
  legacy: {
    rowId: number;
    from: string;
    to: string;
    relation: string;
    /** Raw trust_state (including null); source metadata only. */
    trust: string | null;
    sourceType: string;
    /** Provenance string, not verified evidence. */
    evidence: string | null;
    sourcePageSlug: string | null;
  };
  /** Temporary locator for this diagnosis run; not a stable Claim identity. */
  tempLocator: string;
  stableClaimIdentity: false;
  /** Legacy rows carry no effective time; unknown is never refined. */
  validTime: { from: "unknown"; to: "unknown" };
  /** Shadow view of what a canonical claim would start as. */
  shadow: {
    trust: "candidate" | "rejected";
    evidenceVerification: "unchecked" | "unavailable";
  };
  /** Lifecycle from legacy trust_state; superseded/rejected stay listed. */
  lifecycle: "active" | "superseded" | "rejected";
  /** Superseded/rejected rows have no derivable effective interval. */
  effectiveTimeDerivable: boolean;
  canonical: {
    eligible: boolean;
    reasons: CurrentEligibility["reasons"];
    temporalCertainty: "known" | "unknown";
  };
}

const lifecycleOf = (trustState: string | null | undefined): EmploymentShadowDiagnostic["lifecycle"] => {
  if (trustState === "superseded") return "superseded";
  if (trustState === "rejected") return "rejected";
  return "active";
};

export const diagnoseEmploymentShadow = (
  rows: readonly LinkRow[],
  asOf: TemporalPoint,
): EmploymentShadowDiagnostic[] =>
  rows.map((row) => {
    const lifecycle = lifecycleOf(row.trust_state);
    const hasProvenance = typeof row.evidence === "string" || typeof row.source_page_slug === "string";
    // Provenance strings never become verified evidence; without a pinned
    // source version the binding is inactive either way (#433 semantics).
    const evidenceVerification: EmploymentShadowDiagnostic["shadow"]["evidenceVerification"] = hasProvenance ? "unchecked" : "unavailable";
    const claim = {
      id: `legacy-employment-row:${row.id}`,
      kind: "fact" as const,
      trust: lifecycle === "rejected" ? ("rejected" as const) : ("candidate" as const),
      evidence: [{
        stance: "supports" as const,
        verificationState: evidenceVerification,
        sourceVersionAvailable: false,
        independenceGroupState: "unknown" as const,
      }],
    };
    // No validFrom/validTo and no transition history exist on legacy rows,
    // so the reducer yields an unknown-state validity by construction.
    const validity = reduceClaimValidity({ claimId: claim.id, asOf, transitions: [] });
    const eligibility = evaluateCurrentEligibility(claim, validity);
    return {
      legacy: {
        rowId: row.id,
        from: row.from_slug,
        to: row.to_slug,
        relation: row.relation,
        trust: row.trust_state ?? null,
        sourceType: row.source_type,
        evidence: row.evidence ?? null,
        sourcePageSlug: row.source_page_slug ?? null,
      },
      tempLocator: `legacy-employment-row:${row.id}`,
      stableClaimIdentity: false,
      validTime: { from: "unknown", to: "unknown" },
      shadow: { trust: claim.trust, evidenceVerification },
      lifecycle,
      effectiveTimeDerivable: lifecycle === "active" ? validity.temporalCertainty === "known" : false,
      canonical: {
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
        temporalCertainty: eligibility.temporalCertainty,
      },
    };
  });
