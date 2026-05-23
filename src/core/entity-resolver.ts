import type { EntityType, Relevance } from "./ner.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
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
  constructor(private db: CBrainDB, private llm?: LLMProvider) {}

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

    // Layer 2c: substring dedup
    const subMatch = findSubstringMatch(name, this.db);
    if (subMatch) {
      if (checkTypeGate(this.db, subMatch.slug, entityType)) {
        return { slug: subMatch.slug, action: "resolved_to_existing", score: 0.7, matchedBy: "substring_dedup" };
      }
      return { slug: subMatch.slug, action: "duplicate_candidate", score: 0.7, matchedBy: "substring_dedup" };
    }

    // No match found — new entity
    return { slug: "", action: "stub_created", score: 0, matchedBy: "new" };
  }

  // ─── Layer 3: LLM semantic resolution ──────────────────────

  async semanticResolve(
    resolutionMap: Map<string, ResolutionResult>,
    candidates: EntityCandidate[]
  ): Promise<void> {
    if (!this.llm) return;

    // Collect only stub_created candidates
    const unmatched: Array<{ name: string; type: string }> = [];
    for (const c of candidates) {
      const result = resolutionMap.get(c.name);
      if (result?.action === "stub_created") {
        unmatched.push({ name: c.name, type: c.type });
      }
    }
    if (unmatched.length === 0) return;

    // Get existing entities from DB, excluding those already resolved from input candidates
    const resolvedTitles = new Set<string>();
    for (const c of candidates) {
      const result = resolutionMap.get(c.name);
      if (result && result.action !== "stub_created") {
        // This candidate resolved to an existing entity — exclude that entity
        const title = this.db.getPageTitle(result.slug);
        if (title) resolvedTitles.add(title);
      }
    }

    const MAX_ENTITIES_IN_PROMPT = 200;
    const allTitles = this.db.getAllEntityTitles();
    const existingEntities = allTitles
      .filter(title => !resolvedTitles.has(title))
      .slice(0, MAX_ENTITIES_IN_PROMPT)
      .map(title => {
        const slug = this.db.getEntitySlugByTitle(title) ?? "";
        const type = this.db.getEntityType(slug) ?? "entity/person";
        return { title, type };
      });
    // Call LLM
    const prompt = SEMANTIC_MATCH_PROMPT(unmatched, existingEntities);
    let response: SemanticResponse;
    try {
      const raw = await this.llm.chat([
        { role: "system", content: "Return valid JSON only. No markdown wrapping." },
        { role: "user", content: prompt },
      ]);
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      response = JSON.parse(cleaned) as SemanticResponse;
    } catch {
      return;
    }

    if (!response || typeof response !== "object" || !Array.isArray(response.matches)) return;

    const validMatches = response.matches.filter(
      (m): m is SemanticMatch =>
        typeof m?.candidate === "string" && typeof m?.entity === "string" && typeof m?.confidence === "number"
    );

    // Apply matches
    for (const match of validMatches) {
      if (match.confidence < 0.7) continue;

      const candidateResult = resolutionMap.get(match.candidate);
      if (!candidateResult || candidateResult.action !== "stub_created") continue;

      const entitySlug = this.db.getEntitySlugByTitle(match.entity);
      if (!entitySlug) continue;

      // Upgrade resolution from stub_created → alias_added
      this.db.addAliasWithSource(entitySlug, match.candidate, "llm-semantic");
      resolutionMap.set(match.candidate, {
        slug: entitySlug,
        action: "alias_added",
        score: match.confidence,
        matchedBy: "llm_semantic",
        aliasAdded: match.candidate,
      });
    }
  }
}

// ─── Layer 3: LLM semantic resolution ──────────────────────

const safe = (s: string) => s.replace(/[\n\r]/g, " ").slice(0, 100);

const SEMANTIC_MATCH_PROMPT = (
  candidates: Array<{ name: string; type: string }>,
  existingEntities: Array<{ title: string; type: string }>
) => `You are an entity resolution assistant for a Chinese knowledge graph.
Given new entity candidates and existing entities, determine if any candidate is an alternative name of an existing entity.

## Rules
- Chinese abbreviation patterns: taking key characters (南药→南京医药, 京东→京东集团)
- Full name vs short name (南京医药集团股份有限公司→南京医药)
- Subsidiary abbreviations (招行→招商银行)
- English-Chinese variants are NOT the same unless obviously equivalent
- When uncertain, return no match

## New Candidates
${candidates.map(c => `- ${safe(c.name)} (${safe(c.type)})`).join("\n")}

## Existing Entities
${existingEntities.map(e => `- ${safe(e.title)} (${safe(e.type)})`).join("\n")}

## Output
Return JSON only, no markdown:
{"matches": [{"candidate": "exact candidate name", "entity": "exact existing entity title", "confidence": 0.9}]}
If no matches, return: {"matches": []}`;

interface SemanticMatch {
  candidate: string;
  entity: string;
  confidence: number;
}

interface SemanticResponse {
  matches: SemanticMatch[];
}

// ─── Helpers ──────────────────────────────────────────────────

function findSubstringMatch(name: string, db: CBrainDB): { slug: string; title: string } | null {
  const allTitles = db.getAllEntityTitles();
  for (const existing of allTitles) {
    // New entity is substring of existing (e.g. "AI" ⊂ "AI Agents")
    if (existing.includes(name) && name.length > 1 && existing.length - name.length >= 2) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
    // Existing is substring of new (e.g. "Claude" ⊂ "Claude Code")
    if (name.includes(existing) && existing.length > 1 && name.length - existing.length >= 2) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
  }
  return null;
}

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
