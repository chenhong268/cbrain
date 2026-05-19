import type { EntityType, Relevance } from "./ner.js";
import type { CBrainDB } from "../storage/sqlite.js";
import { mapEntityType } from "./shared.js";

// ─── Types ────────────────────────────────────────────────────

export type ResolutionAction =
  | "resolved_to_existing"
  | "alias_added"
  | "duplicate_candidate"
  | "stub_created";

export interface ResolutionResult {
  slug: string;
  action: ResolutionAction;
  score: number;
  matchedBy: string;
  aliasAdded?: string;
}

export interface EntityCandidate {
  name: string;
  type: EntityType;
  relevance: Relevance;
}

// ─── Constants ────────────────────────────────────────────────

const THRESHOLD_REUSE = 0.9;
const THRESHOLD_CANDIDATE = 0.7;

// ─── Resolver ─────────────────────────────────────────────────

export class EntityResolver {
  constructor(private db: CBrainDB) {}

  resolveAll(candidates: EntityCandidate[]): Map<string, ResolutionResult> {
    const results = new Map<string, ResolutionResult>();

    if (candidates.length === 0) return results;

    // Layer 0: intra-document dedup by normalized form
    const normalizedGroups = new Map<string, EntityCandidate[]>();
    for (const c of candidates) {
      const norm = normalizeForComparison(c.name);
      const group = normalizedGroups.get(norm);
      if (group) {
        group.push(c);
      } else {
        normalizedGroups.set(norm, [c]);
      }
    }

    // Resolve canonical candidates (first in each group)
    const canonicalResults = new Map<string, ResolutionResult>();
    for (const [, group] of normalizedGroups) {
      const canonical = group[0];
      const result = this.resolveSingle(canonical);
      canonicalResults.set(canonical.name, result);

      // Apply same result to all members of the group
      for (let i = 1; i < group.length; i++) {
        const member = group[i];
        results.set(member.name, {
          ...result,
          score: 1.0,
          matchedBy: "intra-doc",
        });
      }
    }

    // Merge canonical results into final map
    for (const [name, result] of canonicalResults) {
      results.set(name, result);
    }

    return results;
  }

  resolveSingle(candidate: EntityCandidate): ResolutionResult;
  resolveSingle(name: string, type: EntityType): ResolutionResult;
  resolveSingle(nameOrCandidate: string | EntityCandidate, type?: EntityType): ResolutionResult {
    const name = typeof nameOrCandidate === "string" ? nameOrCandidate : nameOrCandidate.name;
    const entityType = typeof nameOrCandidate === "string" ? type! : nameOrCandidate.type;

    // Layer 1a: exact title match
    const exactSlug = this.db.getEntitySlugByTitle(name);
    if (exactSlug) {
      if (checkTypeGate(this.db, exactSlug, entityType)) {
        return { slug: exactSlug, action: "resolved_to_existing", score: 1.0, matchedBy: "exact" };
      }
      return { slug: exactSlug, action: "duplicate_candidate", score: 0.75, matchedBy: "type-gate" };
    }

    // Layer 1b: exact alias match
    const aliasSlug = this.db.getSlugByAlias(name);
    if (aliasSlug) {
      if (checkTypeGate(this.db, aliasSlug, entityType)) {
        // Add current name as alias if different from the matched alias
        this.db.addAliasWithSource(aliasSlug, name, "ner-resolved");
        return { slug: aliasSlug, action: "alias_added", score: 0.95, matchedBy: "alias", aliasAdded: name };
      }
      return { slug: aliasSlug, action: "duplicate_candidate", score: 0.75, matchedBy: "type-gate" };
    }

    // Layer 2a: case/punctuation normalized match
    const normSlug = this.db.getEntitySlugByTitleLower(name);
    if (normSlug) {
      if (checkTypeGate(this.db, normSlug, entityType)) {
        this.db.addAliasWithSource(normSlug, name, "ner-resolved");
        return { slug: normSlug, action: "alias_added", score: 0.9, matchedBy: "normalized", aliasAdded: name };
      }
      return { slug: normSlug, action: "duplicate_candidate", score: 0.75, matchedBy: "type-gate" };
    }

    // Layer 2b: parenthetical stripping
    const stripped = stripParenthetical(name);
    if (stripped !== name) {
      const strippedSlug = this.db.getEntitySlugByTitle(stripped);
      if (strippedSlug && checkTypeGate(this.db, strippedSlug, entityType)) {
        this.db.addAliasWithSource(strippedSlug, name, "ner-resolved");
        return { slug: strippedSlug, action: "alias_added", score: 0.8, matchedBy: "parenthetical", aliasAdded: name };
      }
      if (strippedSlug) {
        return { slug: strippedSlug, action: "duplicate_candidate", score: 0.75, matchedBy: "type-gate" };
      }

      // Try normalized stripped
      const normStrippedSlug = this.db.getEntitySlugByTitleLower(stripped);
      if (normStrippedSlug && checkTypeGate(this.db, normStrippedSlug, entityType)) {
        this.db.addAliasWithSource(normStrippedSlug, name, "ner-resolved");
        return { slug: normStrippedSlug, action: "alias_added", score: 0.8, matchedBy: "parenthetical", aliasAdded: name };
      }
      if (normStrippedSlug) {
        return { slug: normStrippedSlug, action: "duplicate_candidate", score: 0.75, matchedBy: "type-gate" };
      }
    }

    // No match found — new entity
    return { slug: "", action: "stub_created", score: 0, matchedBy: "new" };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function normalizeForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_\.]+/g, "")
    .replace(/[（(].+?[）)]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function stripParenthetical(name: string): string {
  return name.replace(/[（(].+?[）)]$/, "").trim();
}

function checkTypeGate(db: CBrainDB, existingSlug: string, nerType: EntityType): boolean {
  const dbType = db.getEntityType(existingSlug);
  if (!dbType) return true;
  const mappedNerType = mapEntityType(nerType);
  return dbType === mappedNerType;
}
