import type { Link } from "../../core/graph/graph.js";
import { mapSourceType } from "../../core/provenance.js";
import type { ProactiveHint } from "../../core/proactive.js";
import type { PageFrontmatter } from "../../utils/frontmatter.js";
import type { Page } from "../../core/page.js";
import type { SearchResult } from "../../core/search.js";

const KNOWN_FM_KEYS = new Set([
  "title", "type", "slug", "tags", "tier",
  "expires_at", "confidence_decay", "created_at", "updated_at",
  "reports_to", "dossier_updated",
]);

export function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

export function safeFrontmatter(fm: PageFrontmatter | null | undefined): Record<string, unknown> {
  if (!fm) return {};
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_FM_KEYS) {
    if (fm[key] !== undefined) out[key] = fm[key];
  }
  return out;
}

export function trimLink(link: Link): Record<string, unknown> | null {
  if (link.weight === 0) return null;
  return {
    id: link.id,
    from_slug: link.from_slug,
    to_slug: link.to_slug,
    relation: link.relation,
    weight: link.weight,
    strength: link.strength,
    context: truncate(link.context, 100),
    source_type: link.source_type ?? "unknown",
    source_category: mapSourceType(link.source_type),
    confidence: link.confidence ?? 0.5,
    trust_state: link.trust_state ?? "candidate",
    source_page_slug: link.source_page_slug,
    evidence: link.evidence,
  };
}

export function trimTimeline(
  entries: Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number; trust_state?: string; source_page_slug?: string; evidence?: string; source_type?: string }>,
  max: number = 3,
): Array<Record<string, unknown>> {
  return entries.slice(0, max).map(e => ({
    id: e.id,
    event_date: e.event_date,
    summary: truncate(e.summary, 100),
    created_at: e.created_at,
    source: e.source ?? "unknown",
    source_category: mapSourceType(e.source_type ?? e.source ?? undefined),
    trust_state: e.trust_state ?? "candidate",
    source_page_slug: e.source_page_slug,
    evidence: e.evidence,
  }));
}

export function getExpiryWarning(expiresAt?: string | null): string | undefined {
  if (!expiresAt) return undefined;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return undefined;

  const now = new Date();
  const dateStr = expires.toISOString().slice(0, 10);

  if (expires <= now) return `⚠️ 已过期（${dateStr}）`;

  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (expires.getTime() - now.getTime() <= thirtyDays) return `⏰ 即将过期（${dateStr}）`;

  return undefined;
}

export function trimPageBody(body: string, maxChars: number = 1500): { body: string; has_more: boolean } {
  if (body.length <= maxChars) return { body, has_more: false };
  return { body: body.slice(0, maxChars) + "...", has_more: true };
}

export function stubEntity(
  sr: SearchResult,
  page?: Page | null,
): Record<string, unknown> {
  return {
    slug: sr.slug,
    title: page?.title ?? sr.slug,
    type: page?.type ?? "unknown",
    relevance: sr.score,
    snippet: sr.snippet,
    _stub: true,
    expiry_warning: getExpiryWarning((page as { expires_at?: string } | undefined)?.expires_at),
  };
}

const VALID_RULES = new Set(["network_timeline", "shared_connection", "expiry_alert"]);

export function trimHint(hint: ProactiveHint): { rule: string; text: string; score: number; why: string; target_slug?: string; age_days?: number | null } {
  return {
    rule: VALID_RULES.has(hint.rule) ? hint.rule : "unknown",
    text: truncate(hint.text, 120),
    score: Math.round(hint.score * 100) / 100,
    why: truncate(hint.why ?? "", 200),
    target_slug: hint.target_slug,
    age_days: hint.age_days,
  };
}

export interface ProactiveBudgetOptions {
  grounded: boolean;
  toolType: "recall" | "search";
  minScore?: number;
  /** Days threshold for stale network_timeline hints. Default: 7. expiry_alert is exempt. */
  staleDays?: number;
}

type BudgetHint = { rule: string; text: string; score: number; why?: string; target_slug?: string; age_days?: number | null };

/**
 * Apply the proactive budget policy.
 * - grounded mode: always return [] (no hints in grounded responses)
 * - normal mode: return at most 1 hint, filtered by:
 *   1. score >= threshold (default 0.5)
 *   2. must have a non-empty `why` (no-why → discard)
 *   3. stale: network_timeline with age_days > staleDays (default 7) is suppressed; expiry_alert exempt
 *   4. duplicate: same rule + target_slug only kept once
 */
export function applyProactiveBudget(
  hints: BudgetHint[],
  options: ProactiveBudgetOptions,
): BudgetHint[] {
  if (options.grounded) return [];

  const threshold = options.minScore ?? 0.5;
  const staleDays = options.staleDays ?? 7;

  const filtered = hints
    // Score threshold
    .filter(h => h.score >= threshold)
    // No-why filter: must explain why it matters
    .filter(h => (h.why ?? "").length > 0)
    // Stale filter: suppress old network_timeline hints (expiry_alert exempt)
    .filter(h => {
      if (h.rule === "expiry_alert") return true;
      if (h.age_days == null) return true;
      return h.age_days <= staleDays;
    });

  // Duplicate suppression: same rule + target_slug
  const seen = new Set<string>();
  const deduped = filtered.filter(h => {
    const key = `${h.rule}:${h.target_slug ?? h.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) return [];
  deduped.sort((a, b) => b.score - a.score);
  return [deduped[0]];
}
