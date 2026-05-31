import type { CBrainDB } from "../storage/sqlite.js";
import type { LinkRow } from "../storage/sqlite.js";

// ─── Types ────────────────────────────────────────────────────

export interface EpisodeClues {
  query: string;
  time_hint?: string;
  topic_hint?: string;
  context_hint?: string;
  connection_hint?: string;
  limit?: number;
}

export interface CandidateEvidence {
  source_type: "timeline" | "link";
  text: string;
  source_slug: string;
  trust_state: string;
}

export interface MatchedClue {
  dimension: "time" | "topic" | "connection" | "context";
  hint_used: string;
}

export interface EpisodicCandidate {
  slug: string;
  title: string;
  score: number;
  confidence: "high" | "medium" | "low";
  matched_clues: MatchedClue[];
  evidence: CandidateEvidence[];
  next_disambiguating_clue: string | null;
}

export interface SearchMeta {
  time_parsed: string | null;
  tokens_used: string[];
  total_scanned: number;
  hints_applied: string[];
}

export interface EpisodicRecallResult {
  query: string;
  summary: string;
  candidates: EpisodicCandidate[];
  search_meta: SearchMeta;
}

// ─── Constants ────────────────────────────────────────────────

const W_TIME = 0.35;
const W_TOPIC = 0.30;
const W_CONNECTION = 0.20;
const W_CONTEXT = 0.15;
const MAX_LIMIT = 8;

type ScoredDimension = { score: number; matched: boolean; hintUsed: string };

// ─── Time parsing ─────────────────────────────────────────────

const TIME_KEYWORD_RE = /(今年|去年|前年|上个月|\d{4}[-年]\d{1,2}月?|\d{4}年?)/g;

function parseTimeHint(hint: string): string | null {
  const yearMatch = hint.match(/^(\d{4})年?$/);
  if (yearMatch) return yearMatch[1];

  const ymMatch = hint.match(/^(\d{4})[-年](\d{1,2})月?$/);
  if (ymMatch) return `${ymMatch[1]}-${ymMatch[2].padStart(2, "0")}`;

  return resolveRelativeTime(hint);
}

function resolveRelativeTime(keyword: string): string | null {
  const now = new Date();
  switch (keyword) {
    case "今年":
      return `${now.getFullYear()}`;
    case "去年":
      return `${now.getFullYear() - 1}`;
    case "前年":
      return `${now.getFullYear() - 2}`;
    case "上个月": {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    default:
      return null;
  }
}

function extractTimeFromQuery(query: string): string | null {
  const matches = query.match(TIME_KEYWORD_RE);
  if (!matches || matches.length === 0) return null;
  // Prefer longer (more specific) matches first: "2024年3月" > "2024年"
  const sorted = [...matches].sort((a, b) => b.length - a.length);
  for (const m of sorted) {
    const parsed = parseTimeHint(m);
    if (parsed) return m;
  }
  return null;
}

// ─── Chinese tokenization ─────────────────────────────────────

const SPLIT_RE = /[\s,，。！？、；：""''()（）[]【】和与或者]+/;

function tokenizeHint(hint: string): string[] {
  const tokens = hint.split(SPLIT_RE).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const bigrams: string[] = [];
  for (let i = 0; i < hint.length - 1; i++) {
    const pair = hint.slice(i, i + 2);
    if (!SPLIT_RE.test(pair)) bigrams.push(pair);
  }
  return [...tokens, ...bigrams];
}

function matchTokens(tokens: string[], text: string): number {
  if (tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let fullMatches = 0;
  for (const tok of tokens) {
    if (lower.includes(tok.toLowerCase())) fullMatches++;
  }
  if (fullMatches > 0) return Math.min(fullMatches / tokens.length, 1.0);
  return 0;
}

// ─── Scoring ──────────────────────────────────────────────────

function scoreTime(
  timeHint: string | undefined,
  timeline: Array<{ event_date: string | null }>,
): ScoredDimension {
  if (!timeHint) return { score: 0, matched: false, hintUsed: "" };
  const prefix = parseTimeHint(timeHint);
  if (!prefix) return { score: 0, matched: false, hintUsed: timeHint };
  const hit = timeline.some(
    (e) => e.event_date !== null && e.event_date.startsWith(prefix),
  );
  return { score: hit ? 1.0 : 0, matched: hit, hintUsed: timeHint };
}

function scoreTextHint(
  hint: string | undefined,
  texts: string[],
): ScoredDimension {
  if (!hint) return { score: 0, matched: false, hintUsed: "" };
  const tokens = tokenizeHint(hint);
  if (tokens.length === 0) return { score: 0, matched: false, hintUsed: hint };
  let best = 0;
  for (const text of texts) {
    const s = matchTokens(tokens, text);
    if (s > best) best = s;
  }
  return { score: best, matched: best > 0, hintUsed: hint };
}

function scoreConnection(
  connectionHint: string | undefined,
  links: LinkRow[],
  slug: string,
  titleMap: Map<string, { title: string; type: string }>,
): ScoredDimension {
  if (!connectionHint) return { score: 0, matched: false, hintUsed: "" };
  const tokens = tokenizeHint(connectionHint);
  if (tokens.length === 0) return { score: 0, matched: false, hintUsed: connectionHint };
  for (const link of links) {
    const otherSlug = link.from_slug !== slug ? link.from_slug : link.to_slug;
    const info = titleMap.get(otherSlug);
    if (!info) continue;
    const s = matchTokens(tokens, info.title);
    if (s > 0) return { score: s, matched: true, hintUsed: connectionHint };
  }
  return { score: 0, matched: false, hintUsed: connectionHint };
}

function scoreToConfidence(score: number): "high" | "medium" | "low" {
  if (score >= 0.6) return "high";
  if (score >= 0.3) return "medium";
  return "low";
}

// ─── Evidence collection ──────────────────────────────────────

function collectEvidence(
  personSlug: string,
  timeline: Array<{ summary: string; source_page_slug?: string; trust_state?: string; event_date?: string | null }>,
  links: LinkRow[],
  matchedDims: Set<string>,
  timePrefix: string | null,
  textTokens: string[],
  connectionTokens: string[],
  titleMap: Map<string, { title: string; type: string }>,
): CandidateEvidence[] {
  const evidence: CandidateEvidence[] = [];

  if (matchedDims.has("time")) {
    for (const entry of timeline) {
      if (timePrefix && !entry.event_date?.startsWith(timePrefix)) {
        continue;
      }
      evidence.push({
        source_type: "timeline",
        text: entry.summary,
        source_slug: entry.source_page_slug ?? personSlug,
        trust_state: entry.trust_state ?? "trusted",
      });
    }
  }

  if (matchedDims.has("topic") || matchedDims.has("context")) {
    const tokens = textTokens;
    for (const entry of timeline) {
      if (matchTokens(tokens, entry.summary) > 0 && !evidence.some((e) => e.text === entry.summary)) {
        evidence.push({
          source_type: "timeline",
          text: entry.summary,
          source_slug: entry.source_page_slug ?? personSlug,
          trust_state: entry.trust_state ?? "trusted",
        });
      }
    }
    for (const link of links) {
      const text = link.context ?? "";
      if (text.length > 0 && matchTokens(tokens, text) > 0) {
        const otherSlug = link.from_slug !== personSlug ? link.from_slug : link.to_slug;
        evidence.push({
          source_type: "link",
          text,
          source_slug: link.source_page_slug ?? otherSlug,
          trust_state: link.trust_state ?? "trusted",
        });
      }
    }
  }

  if (matchedDims.has("connection")) {
    for (const link of links) {
      const otherSlug = link.from_slug !== personSlug ? link.from_slug : link.to_slug;
      const info = titleMap.get(otherSlug);
      if (!info || matchTokens(connectionTokens, info.title) <= 0) continue;
      const text = link.context ?? `${link.from_slug} → ${link.to_slug}`;
      const alreadyAdded = evidence.some((e) => e.source_type === "link" && e.text === text);
      if (!alreadyAdded) {
        evidence.push({
          source_type: "link",
          text,
          source_slug: link.source_page_slug ?? otherSlug,
          trust_state: link.trust_state ?? "trusted",
        });
      }
    }
  }

  return evidence.slice(0, 10);
}

// ─── Disambiguation ───────────────────────────────────────────

function generateDisambiguatingClue(
  candidate: EpisodicCandidate,
  allCandidates: EpisodicCandidate[],
): string | null {
  if (allCandidates.length <= 1) return null;
  const dims = new Set(candidate.matched_clues.map((c) => c.dimension));
  const allDims: ("time" | "topic" | "connection" | "context")[] = ["time", "topic", "connection", "context"];
  const missing = allDims.filter((d) => !dims.has(d));
  if (missing.length === 0) return null;

  const labelMap: Record<string, string> = {
    time: "时间段",
    topic: "讨论的主题",
    connection: "共同认识的人或组织",
    context: "见面的场景",
  };
  return `可以补充${missing.map((d) => labelMap[d]).join("或")}来缩小范围`;
}

// ─── Summary ──────────────────────────────────────────────────

function buildSummary(result: EpisodicRecallResult): string {
  const { candidates } = result;
  if (candidates.length === 0) return "没有找到匹配的人物候选。";
  const parts = candidates.map((c) => `${c.title} (${c.confidence})`);
  return `找到 ${candidates.length} 个候选：${parts.join("、")}。`;
}

// ─── EpisodicRecaller ─────────────────────────────────────────

export class EpisodicRecaller {
  private db: CBrainDB;

  constructor(db: CBrainDB) {
    this.db = db;
  }

  recall(clues: EpisodeClues): EpisodicRecallResult {
    const limit = Math.max(1, Math.min(clues.limit ?? 5, MAX_LIMIT));

    // Query fallback: derive missing hints from query text
    const resolvedClues = this.resolveClues(clues);

    const personSlugs = this.db.listPageSlugs({ type: "entity/person" });
    if (personSlugs.length === 0) {
      return this.buildEmptyResult(clues.query, resolvedClues);
    }

    const timelineMap = this.db.batchGetTimelineForSlugs(personSlugs, false);
    const linksMap = this.db.batchGetLinksForSlugs(personSlugs, false);

    const allReferencedSlugs = new Set<string>();
    for (const [, data] of linksMap) {
      for (const link of [...data.outgoing, ...data.incoming]) {
        allReferencedSlugs.add(link.from_slug);
        allReferencedSlugs.add(link.to_slug);
      }
    }
    const titleMap = this.db.getPageTitlesAndTypes([...allReferencedSlugs]);
    const personTitleMap = this.db.getPageTitlesAndTypes(personSlugs);
    for (const [slug, info] of personTitleMap) {
      titleMap.set(slug, info);
    }

    const candidates: EpisodicCandidate[] = [];

    for (const slug of personSlugs) {
      const timeline = timelineMap.get(slug) ?? [];
      const { outgoing, incoming } = linksMap.get(slug) ?? { outgoing: [], incoming: [] };
      const allLinks = [...outgoing, ...incoming];

      const timeDim = scoreTime(resolvedClues.time_hint, timeline);
      const topicTexts = [
        ...timeline.map((e) => e.summary),
        ...allLinks.map((l) => l.context ?? ""),
      ];
      const topicDim = scoreTextHint(resolvedClues.topic_hint, topicTexts);
      const connDim = scoreConnection(resolvedClues.connection_hint, allLinks, slug, titleMap);
      const contextTexts = timeline.map((e) => e.summary);
      const contextDim = scoreTextHint(resolvedClues.context_hint, contextTexts);

      const rawScore =
        W_TIME * timeDim.score +
        W_TOPIC * topicDim.score +
        W_CONNECTION * connDim.score +
        W_CONTEXT * contextDim.score;

      const score = Math.min(rawScore, 1.0);
      if (score <= 0) continue;

      const matchedClues: MatchedClue[] = [];
      if (timeDim.matched) matchedClues.push({ dimension: "time", hint_used: timeDim.hintUsed });
      if (topicDim.matched) matchedClues.push({ dimension: "topic", hint_used: topicDim.hintUsed });
      if (connDim.matched) matchedClues.push({ dimension: "connection", hint_used: connDim.hintUsed });
      if (contextDim.matched) matchedClues.push({ dimension: "context", hint_used: contextDim.hintUsed });

      const matchedDims = new Set(matchedClues.map((c) => c.dimension));
      const textTokens = [
        ...tokenizeHint(resolvedClues.topic_hint ?? ""),
        ...tokenizeHint(resolvedClues.context_hint ?? ""),
      ].filter((t) => t.length > 0);
      const connectionTokens = tokenizeHint(resolvedClues.connection_hint ?? "").filter((t) => t.length > 0);
      const timePrefix = resolvedClues.time_hint ? parseTimeHint(resolvedClues.time_hint) : null;

      const info = titleMap.get(slug);
      const title = info?.title ?? slug.split("/").pop() ?? slug;

      candidates.push({
        slug,
        title,
        score,
        confidence: scoreToConfidence(score),
        matched_clues: matchedClues,
        evidence: collectEvidence(
          slug,
          timeline,
          allLinks,
          matchedDims,
          timePrefix,
          textTokens,
          connectionTokens,
          titleMap,
        ),
        next_disambiguating_clue: null,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const capped = candidates.slice(0, limit);

    for (const c of capped) {
      c.next_disambiguating_clue = generateDisambiguatingClue(c, capped);
    }

    const result: EpisodicRecallResult = {
      query: clues.query,
      summary: "",
      candidates: capped,
      search_meta: {
        time_parsed: resolvedClues.time_hint ?? null,
        tokens_used: this.collectTokens(resolvedClues),
        total_scanned: personSlugs.length,
        hints_applied: this.collectHintsApplied(resolvedClues),
      },
    };
    result.summary = buildSummary(result);
    return result;
  }

  private resolveClues(clues: EpisodeClues): EpisodeClues {
    const resolved = { ...clues };

    // Fallback: parse time from query
    if (!resolved.time_hint) {
      const extracted = extractTimeFromQuery(clues.query);
      if (extracted) resolved.time_hint = extracted;
    }

    // Fallback: use query as topic/context when hints are missing
    const queryBody = clues.query
      .replace(TIME_KEYWORD_RE, "")
      .replace(/见过谁|认识谁|是谁|的人|的人是谁|谁/g, "")
      .trim();

    if (!resolved.topic_hint && queryBody.length > 0) {
      resolved.topic_hint = queryBody;
    }

    return resolved;
  }

  private collectTokens(clues: EpisodeClues): string[] {
    const tokens: string[] = [];
    if (clues.topic_hint) tokens.push(...tokenizeHint(clues.topic_hint));
    if (clues.context_hint) tokens.push(...tokenizeHint(clues.context_hint));
    if (clues.connection_hint) tokens.push(...tokenizeHint(clues.connection_hint));
    return [...new Set(tokens)];
  }

  private collectHintsApplied(clues: EpisodeClues): string[] {
    const applied: string[] = [];
    if (clues.time_hint) applied.push("time");
    if (clues.topic_hint) applied.push("topic");
    if (clues.context_hint) applied.push("context");
    if (clues.connection_hint) applied.push("connection");
    return applied;
  }

  private buildEmptyResult(query: string, resolvedClues: EpisodeClues): EpisodicRecallResult {
    const result: EpisodicRecallResult = {
      query,
      summary: "没有找到匹配的人物候选。",
      candidates: [],
      search_meta: {
        time_parsed: resolvedClues.time_hint ?? null,
        tokens_used: this.collectTokens(resolvedClues),
        total_scanned: 0,
        hints_applied: this.collectHintsApplied(resolvedClues),
      },
    };
    return result;
  }
}
