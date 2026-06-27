import type { ToolSummary } from "./format-result.js";

/**
 * #231 — default deep_recall returns a compact Agent-facing response. Full
 * raw/audit data only returns when the caller passes include_raw=true. This
 * helper is pure (no ctx/DB) so it is unit-testable in isolation.
 */

/** Hard char budget for the default (compact) deep_recall response. */
export const MAX_DEFAULT_RECALL_RESPONSE_CHARS = 12000;

/** Per-entity snippet cap in the compact response. */
export const COMPACT_SNIPPET_CAP = 240;

/** Second-pass snippet cap when the first pass still exceeds the budget. */
const COMPACT_SNIPPET_FLOOR = 120;

/**
 * First-turn entity fields. Heavy fields (body, frontmatter, links, timeline,
 * dossier, memory_skeleton, related, subordinates, peers) return only with
 * include_raw=true — they bloat context without changing the first answer.
 */
const COMPACT_ENTITY_KEYS = [
  "slug", "title", "type", "relevance", "quality", "tier",
  "snippet", "tags", "expiry_warning", "birthday",
] as const;

export interface CompactRecallInput {
  display: string;
  summary: ToolSummary;
  resultSummary: string;
  query: string;
  entities: Array<Record<string, unknown>>;
  searchMeta: Record<string, unknown>;
}

export interface CompactRecallResponse {
  display: string;
  summary: ToolSummary;
  result_summary: string;
  query: string;
  entities: Array<Record<string, unknown>>;
  search_meta: {
    latency_ms?: number;
    candidate_count?: number;
    degraded?: boolean;
    has_more?: boolean;
  };
}

/** Pick only first-turn fields and cap the snippet length. */
function projectCompactEntity(entity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of COMPACT_ENTITY_KEYS) {
    if (entity[key] != null) out[key] = entity[key];
  }
  if (typeof out.snippet === "string" && out.snippet.length > COMPACT_SNIPPET_CAP) {
    out.snippet = out.snippet.slice(0, COMPACT_SNIPPET_CAP);
  }
  return out;
}

/**
 * Shorten an already-projected entity's snippet to `cap`. At cap 0 the snippet
 * is dropped entirely (the field costs more than it's worth under a tight
 * budget). Immutable — returns a fresh object when it changes anything.
 */
function trimSnippet(entity: Record<string, unknown>, cap: number): Record<string, unknown> {
  if (typeof entity.snippet !== "string" || entity.snippet.length <= cap) return entity;
  const cut = entity.snippet.slice(0, cap);
  if (cut.length === 0) {
    const { snippet: _omit, ...rest } = entity;
    return rest;
  }
  return { ...entity, snippet: cut };
}

/**
 * Build a safe search_meta for the compact response — keeps only Agent-safe
 * summary signals. Audit fields (strategy, truncated, reason_codes,
 * quality_gate) are stripped; they belong in raw (include_raw=true) only.
 */
function safeSearchMeta(
  meta: Record<string, unknown>,
  hasMore: boolean,
): CompactRecallResponse["search_meta"] {
  const out: Record<string, unknown> = {};
  if (typeof meta.latency_ms === "number") out.latency_ms = meta.latency_ms;
  if (typeof meta.candidate_count === "number") out.candidate_count = meta.candidate_count;
  if (meta.degraded === true) out.degraded = true;
  if (hasMore) out.has_more = true;
  return out as CompactRecallResponse["search_meta"];
}

/**
 * Build the default Agent-facing compact response. Projects entities to a
 * first-turn subset, strips audit diagnostics from search_meta, and enforces a
 * hard char budget: shorten snippets → drop tail entities → shrink snippets to
 * empty (display text is never cut mid-sentence). has_more signals a wider
 * candidate pool or a budget-driven entity drop.
 *
 * The budget is a true hard ceiling: every stage measures the JSON with the
 * has_more value the final response will actually carry (candidateHasMore until
 * an entity is dropped, then true), so the returned response never exceeds
 * maxChars — except the degenerate case where the no-entity floor itself
 * (display/summary/query/search_meta) is larger than maxChars.
 */
export function buildCompactRecallResponse(
  input: CompactRecallInput,
  maxChars: number = MAX_DEFAULT_RECALL_RESPONSE_CHARS,
): CompactRecallResponse {
  // Wider candidate pool than the display cap → already has more to show.
  const candidateHasMore =
    input.searchMeta.has_more === true || input.searchMeta.truncated === true;

  let entities = input.entities.map(projectCompactEntity);

  const assemble = (
    ents: Array<Record<string, unknown>>,
    hasMore: boolean,
  ): CompactRecallResponse => ({
    display: input.display,
    summary: input.summary,
    result_summary: input.resultSummary,
    query: input.query,
    entities: ents,
    search_meta: safeSearchMeta(input.searchMeta, hasMore),
  });

  // Measure with the FINAL has_more semantics: pre-drop stages use
  // candidateHasMore (no entities hidden yet); once we drop, has_more is true.
  // Keeps the measured length honest so the response never exceeds maxChars.
  const fits = (ents: Array<Record<string, unknown>>, hasMore: boolean): boolean =>
    JSON.stringify(assemble(ents, hasMore)).length <= maxChars;

  // Stage 1 — full projection, no trimming.
  if (fits(entities, candidateHasMore)) return assemble(entities, candidateHasMore);

  // Stage 2 — shorten snippets to the floor, keep all entities (no has_more flip).
  entities = entities.map((e) => trimSnippet(e, COMPACT_SNIPPET_FLOOR));
  if (fits(entities, candidateHasMore)) return assemble(entities, candidateHasMore);

  // Stage 3 — over budget even with floor snippets: drop tail entities one by
  // one (down to 0 when the budget is extremely tight). Dropping flips has_more.
  while (entities.length > 0 && !fits(entities, true)) {
    entities = entities.slice(0, -1);
  }
  // Stage 4 — shrink remaining snippets progressively to empty to claw back the
  // last chars (e.g. the has_more flag itself under a very tight budget).
  for (const cap of [80, 40, 16, 0]) {
    if (fits(entities, true)) break;
    entities = entities.map((e) => trimSnippet(e, cap));
  }
  return assemble(entities, true);
}
