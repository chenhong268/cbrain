import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB, type LinkRow } from "../../src/storage/sqlite.js";
import { diagnoseEmploymentShadow } from "../helpers/employment-shadow-diagnostic.js";
import {
  approximatePoint,
  projectFactualClaims,
  reduceClaimValidity,
  temporalPoint,
} from "../helpers/evidence-claim-validity-reference.js";

// Issue #469 anonymous read-only shadow consumer. Fixtures are synthetic and
// anonymous; nothing here verifies real evidence or runs a production query.
// known_at (knowledge time) is explicitly out of scope for this issue.

const PERSON = "brain/entities/person/entity-a";
const ORG_C = "brain/entities/company/org-c";
const ORG_D = "brain/entities/organization/org-d";
const ORG_E = "brain/entities/organization/org-e";
const RELATION = "任职";
const asOf = temporalPoint("2026-09-01T00:00:00Z", "instant", "Z");
const instant = (value: string) => temporalPoint(value, "instant", "Z");

describe("employment shadow: real legacy rows through the #433 reference", () => {
  let testDir: string;
  let db: CBrainDB;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-employment-shadow-"));
    db = new CBrainDB(join(testDir, "test.sqlite"));
    for (const slug of [PERSON, ORG_C, ORG_D, ORG_E]) {
      db.rawDb.prepare(
        `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(slug, "entity", `标题-${slug}`, `${slug}.md`, `hash-${slug}`, 0, 3);
    }
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  // Fetch every stored column, including fields omitted by getOutgoingLinks.
  const employmentRows = () => db.rawDb.prepare(
    "SELECT * FROM links WHERE from_slug = ? AND relation = ? ORDER BY id DESC",
  ).all(PERSON, RELATION) as LinkRow[];

  const seedMixedRows = () => {
    db.upsertTrustedOrganizationEmployment(PERSON, ORG_C, "manual", 0.95, {
      source_page_slug: PERSON,
      evidence: "organization_source:manual",
    });
    db.insertLink(PERSON, ORG_D, RELATION, null, 0.5, "medium", "ner", 0.5, true);
    db.rawDb.prepare(
      `UPDATE links SET trust_state = 'rejected' WHERE from_slug = ? AND to_slug = ? AND relation = ?`,
    ).run(PERSON, ORG_D, RELATION);
    db.insertLink(PERSON, ORG_E, RELATION, null, 0.5, "medium", "ner", 0.5, true, {
      source_page_slug: PERSON,
      evidence: "candidate-ner",
    });
    db.rawDb.prepare(
      `UPDATE links SET trust_state = 'superseded' WHERE from_slug = ? AND to_slug = ? AND relation = ?`,
    ).run(PERSON, ORG_E, RELATION);
    return employmentRows();
  };

  test("same-triple unique key: a second stint overwrites the first in place, no history row", () => {
    db.insertLink(PERSON, ORG_C, RELATION, null, 0.5, "medium", "ner", 0.5, true, {
      source_page_slug: PERSON,
      evidence: "stint-1-evidence",
    });
    const firstRow = employmentRows()[0];
    db.rawDb.prepare("UPDATE links SET trust_state = 'superseded' WHERE id = ?").run(firstRow.id);

    db.upsertTrustedOrganizationEmployment(PERSON, ORG_C, "agent", 0.95, {
      source_page_slug: PERSON,
      evidence: "stint-2-evidence",
    });

    const rows = employmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence).toBe("stint-2-evidence");
    expect(rows[0].id).toBe(firstRow.id);
    expect(rows[0].created_at).toBe(firstRow.created_at);
    expect(rows[0].trust_state).toBe("trusted");
    expect(db.rawDb.prepare(
      `SELECT COUNT(*) AS count FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ?`,
    ).get(PERSON, ORG_C, RELATION)).toEqual({ count: 1 });
  });

  test("employment at another org coexists and is not closed by a new upsert", () => {
    db.upsertTrustedOrganizationEmployment(PERSON, ORG_C, "manual", 0.95, {
      source_page_slug: PERSON,
      evidence: "org-c",
    });
    db.insertLink(PERSON, ORG_D, RELATION, null, 1.0, "strong", "manual", 0.95, true, {
      source_page_slug: PERSON,
      evidence: "org-d",
    });
    db.upsertTrustedOrganizationEmployment(PERSON, ORG_C, "agent", 0.95, {
      source_page_slug: PERSON,
      evidence: "org-c-2",
    });

    const rows = employmentRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.to_slug === ORG_D)?.evidence).toBe("org-d");
    expect(rows.find((row) => row.to_slug === ORG_D)?.trust_state).toBe("trusted");
    expect(rows.find((row) => row.to_slug === ORG_C)?.evidence).toBe("org-c-2");
  });

  test("mapping preserves row count, order, endpoints, and raw legacy values", () => {
    const rows = seedMixedRows();
    const diagnostics = diagnoseEmploymentShadow(rows, asOf);
    expect(diagnostics).toHaveLength(rows.length);
    diagnostics.forEach((diagnostic, index) => {
      expect(diagnostic.legacy.rowId).toBe(rows[index].id);
      expect(diagnostic.legacy.from).toBe(rows[index].from_slug);
      expect(diagnostic.legacy.to).toBe(rows[index].to_slug);
      expect(diagnostic.legacy.relation).toBe(rows[index].relation);
      expect(diagnostic.legacy.trust).toBe(rows[index].trust_state ?? null);
      expect(diagnostic.legacy.sourceType).toBe(rows[index].source_type);
      expect(diagnostic.legacy.evidence).toBe(rows[index].evidence ?? null);
      expect(diagnostic.legacy.sourcePageSlug).toBe(rows[index].source_page_slug ?? null);
    });
  });

  test("diagnosis is read-only and repeatable on the same snapshot", () => {
    const rows = seedMixedRows();
    const before = structuredClone(rows);
    const first = diagnoseEmploymentShadow(rows, asOf);
    const second = diagnoseEmploymentShadow(rows, asOf);
    expect(first).toEqual(second);
    expect(rows).toEqual(before);
    expect(employmentRows()).toEqual(before);

    const frozen = Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    expect(diagnoseEmploymentShadow(frozen, asOf)).toEqual(first);
    expect(employmentRows()).toEqual(before);
  });

  test("no dates guessed and locator is not presented as a stable identity", () => {
    seedMixedRows();
    db.rawDb.exec("UPDATE links SET created_at = '2020-01-01', last_validated_at = '2026-08-01', context = '任职开始于 2021-02-03'");
    for (const diagnostic of diagnoseEmploymentShadow(employmentRows(), asOf)) {
      expect(diagnostic.validTime).toEqual({ from: "unknown", to: "unknown" });
      expect(diagnostic.stableClaimIdentity).toBe(false);
      expect(diagnostic.tempLocator).toBe(`legacy-employment-row:${diagnostic.legacy.rowId}`);
    }
  });

  test("trusted legacy row without verified evidence cannot enter canonical facts", () => {
    const diagnostic = diagnoseEmploymentShadow(seedMixedRows(), asOf).find((d) => d.legacy.to === ORG_C)!;
    expect(diagnostic.legacy.trust).toBe("trusted");
    expect(diagnostic.shadow).toEqual({ trust: "candidate", evidenceVerification: "unchecked" });
    expect(diagnostic.canonical.eligible).toBe(false);
    expect(diagnostic.canonical.reasons).toEqual(["trust_not_trusted", "active_support_missing"]);
    expect(diagnostic.canonical.temporalCertainty).toBe("unknown");
  });

  test("rejected and superseded rows stay listed with no derivable effective interval", () => {
    const diagnostics = diagnoseEmploymentShadow(seedMixedRows(), asOf);
    const rejected = diagnostics.find((d) => d.legacy.to === ORG_D)!;
    const superseded = diagnostics.find((d) => d.legacy.to === ORG_E)!;
    expect(diagnostics).toHaveLength(3);
    expect(rejected.lifecycle).toBe("rejected");
    expect(rejected.shadow.trust).toBe("rejected");
    expect(rejected.shadow.evidenceVerification).toBe("unavailable");
    expect(rejected.effectiveTimeDerivable).toBe(false);
    expect(rejected.canonical.eligible).toBe(false);
    expect(superseded.lifecycle).toBe("superseded");
    expect(superseded.shadow.trust).toBe("candidate");
    expect(superseded.effectiveTimeDerivable).toBe(false);
    expect(superseded.canonical.eligible).toBe(false);
  });
});

// 五类时效场景：synthetic confirmed inputs replayed through the existing #433
// reducer only. This is not real evidence verification and not a production
// temporal query; valid time and record time are never mixed, and known_at is
// not implemented by this issue.
describe("employment temporal scenarios via the existing reducer (synthetic)", () => {
  const day = (value: string) => temporalPoint(value, "day", "+00:00");

  test("late message: judgement follows effective time, not record time", () => {
    const lateRecordedRevocation = {
      kind: "revokes" as const,
      oldClaimId: "claim-stint-c1",
      confirmationState: "confirmed" as const,
      effectiveAt: day("2022-06-30"),
      recordedAt: instant("2023-01-10T00:00:00Z"),
    };
    expect(reduceClaimValidity({
      claimId: "claim-stint-c1",
      asOf: instant("2022-12-01T00:00:00Z"),
      transitions: [lateRecordedRevocation],
    })).toEqual({ state: "revoked", temporalCertainty: "known", transitionConflict: false });
    expect(reduceClaimValidity({
      claimId: "claim-stint-c1",
      asOf: instant("2022-01-01T00:00:00Z"),
      validFrom: day("2020-01-01"),
      transitions: [lateRecordedRevocation],
    })).toEqual({ state: "effective", temporalCertainty: "known", transitionConflict: false });
    expect(reduceClaimValidity({
      claimId: "claim-stint-c1",
      asOf: instant("2019-01-01T00:00:00Z"),
      validFrom: day("2020-01-01"),
      transitions: [],
    })).toEqual({ state: "scheduled", temporalCertainty: "known", transitionConflict: false });
  });

  test("dual employment: a second org claim does not close the first", () => {
    const asOfInstant = instant("2022-06-01T00:00:00Z");
    expect(reduceClaimValidity({ claimId: "claim-stint-c1", asOf: asOfInstant, validFrom: day("2020-01-01"), transitions: [] }).state).toBe("effective");
    expect(reduceClaimValidity({ claimId: "claim-stint-d1", asOf: asOfInstant, validFrom: day("2021-01-01"), transitions: [] }).state).toBe("effective");
  });

  test("rehire: two stints keep the gap; legacy storage still collapses them to one row", () => {
    const stint1 = { claimId: "claim-stint-c1", validFrom: day("2020-01-01"), validTo: day("2022-06-30"), transitions: [] };
    const stint2 = { claimId: "claim-stint-c2", validFrom: day("2024-03-01"), transitions: [] };
    expect(reduceClaimValidity({ ...stint1, asOf: instant("2023-06-01T00:00:00Z") }).state).toBe("expired");
    expect(reduceClaimValidity({ ...stint2, asOf: instant("2023-06-01T00:00:00Z") }).state).toBe("scheduled");
    expect(reduceClaimValidity({ ...stint1, asOf: instant("2025-06-01T00:00:00Z") }).state).toBe("expired");
    expect(reduceClaimValidity({ ...stint2, asOf: instant("2025-06-01T00:00:00Z") }).state).toBe("effective");
  });

  test("corrected false claim is excluded even historically; ended true employment retains history", () => {
    // Deliberately synthetic confirmed support; no production verification implied.
    const base = {
      kind: "fact" as const,
      validFrom: day("2020-01-01"), validTo: day("2022-06-30"),
      evidence: [{ stance: "supports" as const, verificationState: "verified" as const,
        sourceVersionAvailable: true, independenceGroupState: "unknown" as const }],
    };
    const claims = [
      { ...base, id: "incorrect-employment", trust: "rejected" as const },
      { ...base, id: "ended-employment", trust: "trusted" as const },
    ];
    expect(projectFactualClaims(claims, instant("2021-03-01T00:00:00Z"), []).map(row => row.claimId))
      .toEqual(["ended-employment"]);
    expect(projectFactualClaims(claims, instant("2023-01-01T00:00:00Z"), [])).toEqual([]);
  });

  test("fuzzy dates: original precision kept, inside-window stays unknown, no month-edge fill", () => {
    const monthEnd = temporalPoint("2022-12", "month", "+00:00");
    const claim = { claimId: "claim-fuzzy-c1", validFrom: day("2020-01-01"), validTo: monthEnd, transitions: [] };
    expect(reduceClaimValidity({ ...claim, asOf: instant("2022-12-15T00:00:00Z") })).toEqual({ state: "unknown", temporalCertainty: "unknown", transitionConflict: false });
    expect(reduceClaimValidity({ ...claim, asOf: instant("2023-01-15T00:00:00Z") }).state).toBe("expired");
    const approximateEnd = approximatePoint("around late 2022", "+00:00", "2022-11-01T00:00:00Z", "2023-01-01T00:00:00Z");
    expect(reduceClaimValidity({ ...claim, validTo: approximateEnd, asOf: instant("2022-12-05T00:00:00Z") }).temporalCertainty).toBe("unknown");
  });
});
