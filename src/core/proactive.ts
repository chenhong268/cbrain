import type { CBrainDB, LinkRow } from "../storage/sqlite.js";
import type { ToolContext } from "../mcp/context.js";

// ─── Types ──────────────────────────────────────────────────

export interface ProactiveHint {
  rule: "network_timeline" | "shared_connection" | "expiry_alert";
  text: string;
  score: number;
  /** Why this hint changes current understanding — without a why, the hint is discarded */
  why: string;
  /** Target entity slug for duplicate suppression */
  target_slug?: string;
  /** Days since the event — null if not applicable (used for stale filtering) */
  age_days?: number | null;
}

const JUNK_PREFIXES = ["records/", "templates/", "attachments/"];

function isJunkSlug(slug: string): boolean {
  return JUNK_PREFIXES.some(p => slug.startsWith(p));
}

export interface HintOptions {
  resultSlugs: string[];
  linksBySlug?: Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>;
  pagesBySlug?: Map<string, { slug: string; expires_at: string | null }>;
  maxHints: number;
}

// ─── Engine ─────────────────────────────────────────────────

export async function generateProactiveHints(
  ctx: ToolContext,
  options: HintOptions
): Promise<ProactiveHint[]> {
  try {
    const { resultSlugs, maxHints } = options;
    if (resultSlugs.length === 0) return [];

    const alreadyInResults = new Set(resultSlugs);
    const candidates: ProactiveHint[] = [];
    const MIN_SCORE = 0.5;

    // Ensure we have links data
    const linksMap = options.linksBySlug ?? ctx.db.batchGetLinksForSlugs(resultSlugs);

    // Rule 3: Expiry Alert (highest priority)
    const expiryHint = buildExpiryHint(ctx.db, resultSlugs, options.pagesBySlug, alreadyInResults);
    if (expiryHint) candidates.push(expiryHint);

    // Rule 1: Network Timeline
    const timelineHint = buildTimelineHint(ctx.db, resultSlugs, linksMap, alreadyInResults);
    if (timelineHint) candidates.push(timelineHint);

    // Rule 2: Shared Connections
    const sharedHint = buildSharedConnectionHint(ctx.db, linksMap, alreadyInResults, resultSlugs);
    if (sharedHint) candidates.push(sharedHint);

    return candidates
      .filter(h => h.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxHints);
  } catch {
    // Never block the main response
    return [];
  }
}

// ─── Rule 1: Network Timeline ──────────────────────────────

function buildTimelineHint(
  db: CBrainDB,
  resultSlugs: string[],
  _linksMap: Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>,
  alreadyInResults: Set<string>
): ProactiveHint | null {
  const events = db.getRecentEventsInNetwork(resultSlugs, 30, 5);
  const filtered = events.filter(e => !alreadyInResults.has(e.slug) && !isJunkSlug(e.slug));
  if (filtered.length === 0) return null;

  const evt = filtered[0];
  const date = evt.event_date ? `（${evt.event_date.slice(0, 10)}）` : "";
  const text = `🔗 ${evt.title} 近期动态：${evt.summary}${date}`;
  // Score: recency-based, 1.0 for today, 0 for 180+ days old
  const daysSince = evt.event_date
    ? (Date.now() - new Date(evt.event_date).getTime()) / (1000 * 60 * 60 * 24)
    : 90; // no date = low score
  const score = Math.max(0, 1.0 - daysSince / 180);
  return {
    rule: "network_timeline",
    text: truncateText(text, 120),
    score,
    why: `${evt.title} 有新动态，可能影响之前讨论的结论`,
    target_slug: evt.slug,
    age_days: Math.round(daysSince),
  };
}

// ─── Rule 2: Shared Connections ────────────────────────────

function buildSharedConnectionHint(
  db: CBrainDB,
  linksMap: Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>,
  alreadyInResults: Set<string>,
  resultSlugs: string[]
): ProactiveHint | null {
  if (resultSlugs.length < 2) return null;

  // Build neighbor sets per result slug
  const neighborSets = new Map<string, Set<string>>();
  for (const slug of resultSlugs) {
    const links = linksMap.get(slug);
    if (!links) continue;
    const neighbors = new Set<string>();
    for (const l of links.outgoing) {
      if (!isJunkSlug(l.to_slug)) neighbors.add(l.to_slug);
    }
    for (const l of links.incoming) {
      if (!isJunkSlug(l.from_slug)) neighbors.add(l.from_slug);
    }
    neighborSets.set(slug, neighbors);
  }

  // Find shared neighbors across ≥2 result slugs
  const neighborOwners = new Map<string, string[]>();
  for (const [slug, neighbors] of neighborSets) {
    for (const n of neighbors) {
      if (alreadyInResults.has(n)) continue;
      const owners = neighborOwners.get(n) ?? [];
      owners.push(slug);
      neighborOwners.set(n, owners);
    }
  }

  const shared = [...neighborOwners.entries()].find(([, owners]) => owners.length >= 2);
  if (!shared) return null;

  const [sharedSlug, owners] = shared;
  // Batch-resolve slugs to titles
  const slugsToResolve = [sharedSlug, ...owners.slice(0, 2)];
  const titles = db.getPageTitlesAndTypes(slugsToResolve);
  const sharedTitle = titles.get(sharedSlug)?.title ?? slugToDisplayName(sharedSlug);
  const ownerTitles = owners.slice(0, 2).map(s => titles.get(s)?.title ?? slugToDisplayName(s));
  const text = `🕸️ ${ownerTitles.join(" 和 ")} 都关联了 ${sharedTitle}`;
  // Score: 1.0 for 1 unique owner (concentrated), 0 for 10+ unique owners (diffuse)
  const uniqueOwners = neighborOwners.get(sharedSlug)?.length ?? 1;
  const score = Math.max(0, 1.0 - uniqueOwners / 10);
  return {
    rule: "shared_connection",
    text: truncateText(text, 120),
    score,
    why: `${ownerTitles.join(" 和 ")} 之间的共同关联 ${sharedTitle} 可能揭示未注意的关系`,
    target_slug: sharedSlug,
  };
}

// ─── Rule 3: Expiry Alert ──────────────────────────────────

function buildExpiryHint(
  db: CBrainDB,
  resultSlugs: string[],
  pagesBySlug?: Map<string, { slug: string; expires_at: string | null }>,
  _alreadyInResults?: Set<string>
): ProactiveHint | null {
  // Check result slugs themselves for expiry — users need to know their results are stale
  // Also check 1-hop neighbor pages if pagesBySlug provided
  const slugsToCheck = [...resultSlugs];
  if (pagesBySlug) {
    for (const [, page] of pagesBySlug) {
      if (page.expires_at) slugsToCheck.push(page.slug);
    }
  }

  const expiring = db.getExpiringSlugsInSet([...new Set(slugsToCheck)], 30);
  if (expiring.length === 0) return null;

  const exp = expiring[0];
  const isExpired = new Date(exp.expires_at) <= new Date();
  const status = isExpired ? "已过期" : "即将过期";
  const text = `⏰ ${exp.title} ${status}（${exp.expires_at.slice(0, 10)}），信息可能不是最新的`;
  return {
    rule: "expiry_alert",
    text: truncateText(text, 120),
    score: 1.0,
    why: `${exp.title} ${status}，决策前提可能需要重新评估`,
    target_slug: exp.slug,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function slugToDisplayName(slug: string): string {
  const parts = slug.split("/");
  return parts[parts.length - 1] || slug;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
