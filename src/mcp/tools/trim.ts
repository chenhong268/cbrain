import type { Link } from "../../core/graph.js";
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
    from_slug: link.from_slug,
    to_slug: link.to_slug,
    relation: link.relation,
    weight: link.weight,
    strength: link.strength,
    context: truncate(link.context, 100),
    source_type: link.source_type ?? "unknown",
    confidence: link.confidence ?? 0.5,
  };
}

export function trimTimeline(
  entries: Array<{ summary: string; event_date: string | null; source: string | null; created_at: string; id: number }>,
  max: number = 3,
): Array<Record<string, unknown>> {
  return entries.slice(0, max).map(e => ({
    id: e.id,
    event_date: e.event_date,
    summary: truncate(e.summary, 100),
    created_at: e.created_at,
  }));
}

export function getExpiryWarning(expiresAt?: string | null): string | undefined {
  if (!expiresAt) return undefined;
  const expires = new Date(expiresAt);
  if (isNaN(expires.getTime())) return undefined;

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

export function trimHint(hint: ProactiveHint): { rule: string; text: string; score: number } {
  return {
    rule: VALID_RULES.has(hint.rule) ? hint.rule : "unknown",
    text: truncate(hint.text, 120),
    score: Math.round(hint.score * 100) / 100,
  };
}
