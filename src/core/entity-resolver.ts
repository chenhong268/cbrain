import type { EntityType, Relevance } from "./ner.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import { mapEntityType } from "./shared.js";
import { getOntology } from "../ontology/loader.js";
import type { EmbeddingProvider } from "../embedding/provider.js";

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

export type ResolverEmbeddingMode = "off" | "shadow";

export interface ResolverOptions {
  /** Embedding provider for the candidate shortlist. Undefined ⇒ embedding disabled. */
  embedding?: EmbeddingProvider;
  /** "off" (default) preserves current behavior; "shadow" enables shortlist focusing only. */
  embeddingMode?: ResolverEmbeddingMode;
}

// ─── Resolver ─────────────────────────────────────────────────

export class EntityResolver {
  private titleCache: string[] | null = null;

  constructor(
    private db: CBrainDB,
    private llm?: LLMProvider,
    private readonly options: ResolverOptions = {},
  ) {}

  private get embedding(): EmbeddingProvider | undefined {
    return this.options.embedding;
  }
  private get embeddingMode(): ResolverEmbeddingMode {
    return this.options.embeddingMode ?? "off";
  }

  private getCachedTitles(): string[] {
    if (!this.titleCache) this.titleCache = this.db.getAllEntityTitles();
    return this.titleCache;
  }

  resolveAll(candidates: EntityCandidate[]): Map<string, ResolutionResult> {
    // Pre-load entity titles cache for this resolution session
    this.getCachedTitles();
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

    // Layer 0b: prefix-based intra-document dedup
    // "人物A全" and "人物A全名" normalize to different keys,
    // but the shorter is a prefix of the longer — merge them.
    const groupKeys = [...normalizedGroups.keys()];
    for (let i = 0; i < groupKeys.length; i++) {
      const keyA = groupKeys[i];
      if (!normalizedGroups.has(keyA)) continue;
      for (let j = i + 1; j < groupKeys.length; j++) {
        const keyB = groupKeys[j];
        if (!normalizedGroups.has(keyB)) continue;
        const [shorter, longer] = keyA.length <= keyB.length ? [keyA, keyB] : [keyB, keyA];
        if (shorter.length < 2 || !longer.startsWith(shorter)) continue;
        // Length ratio filter: shorter must be >= 50% of longer to avoid false merges
        if (shorter.length / longer.length < 0.5) continue;
        // Type compatibility check
        const groupShorter = normalizedGroups.get(shorter)!;
        const groupLonger = normalizedGroups.get(longer)!;
        const typeS = mapEntityType(groupShorter[0].type);
        const typeL = mapEntityType(groupLonger[0].type);
        if (typeS !== typeL && !getOntology().areTypesAffine(typeS, typeL)) continue;
        // Merge shorter into longer (longer name is more specific)
        groupLonger.push(...groupShorter);
        normalizedGroups.delete(shorter);
        if (shorter === keyA) break;
      }
    }

    // Resolve canonical candidates (best type priority in each group)
    const canonicalResults = new Map<string, ResolutionResult>();
    for (const [, group] of normalizedGroups) {
      const canonical = pickBestCandidate(group);
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

    // Release cache after session
    this.titleCache = null;
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
    const subMatch = findSubstringMatch(name, this.db, this.titleCache);
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
    const allTitles = this.getCachedTitles();
    const existingEntities = allTitles
      .filter(title => !resolvedTitles.has(title))
      .slice(0, MAX_ENTITIES_IN_PROMPT)
      .map(title => {
        const slug = this.db.getEntitySlugByTitle(title) ?? "";
        const type = this.db.getEntityType(slug) ?? "record";
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
    const candidateMap = new Map(candidates.map(c => [c.name, c]));
    for (const match of validMatches) {
      if (match.confidence < 0.7) continue;

      const candidateResult = resolutionMap.get(match.candidate);
      if (!candidateResult || candidateResult.action !== "stub_created") continue;

      const entitySlug = this.db.getEntitySlugByTitle(match.entity);
      if (!entitySlug) continue;

      const candidate = candidateMap.get(match.candidate);
      if (candidate && !checkTypeGate(this.db, entitySlug, candidate.type)) continue;

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

function findSubstringMatch(name: string, db: CBrainDB, cachedTitles?: string[] | null): { slug: string; title: string } | null {
  const allTitles = cachedTitles ?? db.getAllEntityTitles();
  for (const existing of allTitles) {
    // New entity is substring of existing (e.g. "AI" ⊂ "AI Agents")
    if (existing.includes(name) && name.length > 1 && isSignificantSubstring(name, existing)) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
    // Existing is substring of new (e.g. "Claude" ⊂ "Claude Code")
    if (name.includes(existing) && existing.length > 1 && isSignificantSubstring(existing, name)) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
  }
  return null;
}

function isSignificantSubstring(shorter: string, longer: string): boolean {
  const diff = longer.length - shorter.length;
  // Absolute diff >= 3 (e.g. "Claude" ⊂ "Claude Code" = 5)
  if (diff >= 3) return true;
  // Or shorter occupies >= 60% of longer (e.g. "数字化" 3/5 = 60%)
  if (shorter.length >= longer.length * 0.6) return true;
  return false;
}

function normalizeForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-_.]+/g, "")
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
  if (mappedNerType === "record") return true;
  if (dbType === mappedNerType) return true;
  return getOntology().areTypesAffine(dbType, mappedNerType);
}

function pickBestCandidate(group: EntityCandidate[]): EntityCandidate {
  if (group.length === 1) return group[0];
  let best = group[0];
  let bestPageType = mapEntityType(best.type);
  for (let i = 1; i < group.length; i++) {
    const currentPageType = mapEntityType(group[i].type);
    const winner = getOntology().resolveTypePriority(bestPageType, currentPageType);
    if (winner !== bestPageType) {
      best = group[i];
      bestPageType = currentPageType;
    }
  }
  return best;
}
