/**
 * #232 — bounded evidence completion for temporal / historical recall.
 *
 * Assembles a deterministic evidence pack (timeline + links + raw chunks + page
 * summaries) for the top result slugs, plus a coverage judgment. Pure reads,
 * no LLM planner. Shared by `deep_recall` and `cbrain_recall` so both entry
 * points produce the same pack.
 *
 * Budget is enforced by per-slug caps (slug set itself is bounded to ≤5 by the
 * callers); the underlying batch fetchers are single `IN(?)` SQL, so total cost
 * over ≤5 slugs is well under the #222 slow-query ceiling. Raw chunks of sealed
 * pages are kept at `summary_level=0` by the seal stage, so a sealed summary
 * still yields its raw detail here (marked `sealed: true`).
 */
import type { CBrainDB } from "../storage/sqlite.js";
import { extractDetailTerms } from "./search.js";

export interface EvidenceTimelineHit {
  slug: string;
  summary: string;
  event_date: string | null;
  trust_state?: string;
}
export interface EvidenceLinkHit {
  from: string;
  to: string;
  relation: string;
  trust_state?: string;
}
export interface EvidenceChunkHit {
  slug: string;
  excerpt: string;
  sealed: boolean;
}
export interface EvidenceSummary {
  slug: string;
  title: string;
  summary?: string;
}
export type CoverageStatus = "sufficient" | "partial" | "insufficient";

export interface EvidencePack {
  timeline: EvidenceTimelineHit[];
  links: EvidenceLinkHit[];
  chunks: EvidenceChunkHit[];
  summaries: EvidenceSummary[];
  coverage: {
    timeline_hits: number;
    chunk_hits: number;
    link_hits: number;
    coverage_status: CoverageStatus;
  };
}

export interface EvidencePackOptions {
  timelinePerSlug?: number;
  chunksPerSlug?: number;
  linksPerSlug?: number;
  chunkExcerptChars?: number;
}

const DEFAULT_TIMELINE_PER_SLUG = 3;
const DEFAULT_CHUNKS_PER_SLUG = 3;
const DEFAULT_LINKS_PER_SLUG = 5;
const DEFAULT_CHUNK_EXCERPT_CHARS = 200;

/** sufficient = timeline + (chunks|links); partial = any one source; insufficient = none. */
export function coverageFromHits(timelineHits: number, chunkHits: number, linkHits: number): CoverageStatus {
  if (timelineHits > 0 && (chunkHits > 0 || linkHits > 0)) return "sufficient";
  if (timelineHits > 0 || chunkHits > 0 || linkHits > 0) return "partial";
  return "insufficient";
}

const IS_CJK_TERM = (t: string) => /^[一-鿿]+$/.test(t);

/**
 * #232 + #169: query-aware raw-chunk selection for one slug. Matches the
 * query's detail terms (DB-side OR-LIKE over summary_level=0 chunks, ranked so
 * non-CJK high-signal terms win the LIMIT) so detail BEYOND the first N surfaces
 * (sealed/历史细节不再漏召回). Falls back to the first-N raw chunks only when no
 * term matches. Always bounded by `max` at the DB layer.
 */
function pickRawChunks(
  db: CBrainDB,
  slug: string,
  rankedTerms: string[],
  max: number,
): Array<{ content: string }> {
  if (rankedTerms.length > 0) {
    const hits = db.getRawChunkHitsForPage(slug, rankedTerms, max);
    if (hits.length > 0) return hits;
  }
  return db.getChunksByPage(slug, { summaryLevel: 0, limit: max }) ?? [];
}

/**
 * Build a bounded evidence pack for `slugs`. The caller MUST bound `slugs`
 * (deep_recall passes its display-capped top slugs, ≤5).
 */
export function assembleEvidencePack(
  db: CBrainDB,
  slugs: string[],
  query: string,
  opts: EvidencePackOptions = {},
): EvidencePack {
  const timelinePerSlug = opts.timelinePerSlug ?? DEFAULT_TIMELINE_PER_SLUG;
  const chunksPerSlug = opts.chunksPerSlug ?? DEFAULT_CHUNKS_PER_SLUG;
  const linksPerSlug = opts.linksPerSlug ?? DEFAULT_LINKS_PER_SLUG;
  const excerptChars = opts.chunkExcerptChars ?? DEFAULT_CHUNK_EXCERPT_CHARS;

  if (slugs.length === 0) {
    return { timeline: [], links: [], chunks: [], summaries: [], coverage: { timeline_hits: 0, chunk_hits: 0, link_hits: 0, coverage_status: "insufficient" } };
  }

  const timelineMap = db.batchGetTimelineForSlugs(slugs);
  const linksMap = db.batchGetLinksForSlugs(slugs);
  const titles = db.getPageTitlesAndTypes(slugs);
  // #169 detail terms (query-aware chunk selection). Ranked non-CJK-first so
  // high-signal terms (IDs/dates/latin) drive the OR-LIKE match_rank.
  const detailTerms = extractDetailTerms(query);
  const rankedTerms = [...detailTerms.filter((t) => !IS_CJK_TERM(t)), ...detailTerms.filter((t) => IS_CJK_TERM(t))];

  const timeline: EvidenceTimelineHit[] = [];
  const links: EvidenceLinkHit[] = [];
  const chunks: EvidenceChunkHit[] = [];
  const summaries: EvidenceSummary[] = [];

  for (const slug of slugs) {
    for (const t of (timelineMap.get(slug) ?? []).slice(0, timelinePerSlug)) {
      timeline.push({ slug, summary: t.summary, event_date: t.event_date, trust_state: t.trust_state ?? undefined });
    }

    const lr = linksMap.get(slug) ?? { outgoing: [], incoming: [] };
    for (const l of [...lr.outgoing, ...lr.incoming].slice(0, linksPerSlug)) {
      const row = l as { from_slug: string; to_slug: string; relation: string | null; trust_state?: string | null };
      links.push({ from: row.from_slug, to: row.to_slug, relation: row.relation ?? "关联", trust_state: row.trust_state ?? undefined });
    }

    const sealed = db.isSealedPage(slug);
    for (const c of pickRawChunks(db, slug, rankedTerms, chunksPerSlug)) {
      chunks.push({ slug, excerpt: (c.content ?? "").slice(0, excerptChars), sealed });
    }

    const title = titles.get(slug)?.title ?? slug;
    const l1 = db.getL1Summary(slug);
      summaries.push(l1?.content ? { slug, title, summary: l1.content.slice(0, excerptChars) } : { slug, title });
  }

  const coverage_status = coverageFromHits(timeline.length, chunks.length, links.length);
  return {
    timeline,
    links,
    chunks,
    summaries,
    coverage: {
      timeline_hits: timeline.length,
      chunk_hits: chunks.length,
      link_hits: links.length,
      coverage_status,
    },
  };
}
