import type { CBrainDB } from "../../storage/sqlite.js";
import type { LinkRow } from "../../storage/sqlite.js";

// ─── Types ────────────────────────────────────────────────────

export interface EpisodeClues {
  query: string;
  time_hint?: string;
  topic_hint?: string;
  context_hint?: string;
  connection_hint?: string;
  relation_hint?: string;
  event_hint?: string;
  limit?: number;
}

export interface CandidateEvidence {
  source_type: "timeline" | "link" | "page" | "chunk";
  excerpt: string;
  source_slug: string;
  trust_state?: string;
  date?: string;
}

export interface MatchedClue {
  dimension: "time" | "topic" | "connection" | "context" | "event" | "relation";
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

export interface RecallDiagnostics {
  clues_checked: Array<{ clue_type: string; had_support: boolean; scanned: number }>;
}

export interface EpisodicRecallResult {
  query: string;
  summary: string;
  candidates: EpisodicCandidate[];
  search_meta: SearchMeta;
  diagnostics: RecallDiagnostics;
}

// ─── Constants ────────────────────────────────────────────────

const W_TIME = 0.30;
const W_TOPIC = 0.25;
const W_EVENT = 0.15;
const W_CONNECTION = 0.15;
const W_CONTEXT = 0.15;
const MULTI_CLUE_BONUS = 0.1;
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

function scoreEvent(
  eventHint: string | undefined,
  timeline: Array<{ summary: string }>,
): ScoredDimension {
  if (!eventHint) return { score: 0, matched: false, hintUsed: "" };
  const texts = timeline.map((e) => e.summary);
  return scoreTextHint(eventHint, texts);
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
  chunkContents: string[],
): CandidateEvidence[] {
  const evidence: CandidateEvidence[] = [];

  if (matchedDims.has("time")) {
    for (const entry of timeline) {
      if (timePrefix && !entry.event_date?.startsWith(timePrefix)) {
        continue;
      }
      evidence.push({
        source_type: "timeline",
        excerpt: entry.summary,
        source_slug: entry.source_page_slug ?? personSlug,
        trust_state: entry.trust_state ?? "trusted",
        date: entry.event_date ?? undefined,
      });
    }
  }

  if (matchedDims.has("topic") || matchedDims.has("context") || matchedDims.has("event")) {
    const tokens = textTokens;
    for (const entry of timeline) {
      if (matchTokens(tokens, entry.summary) > 0 && !evidence.some((e) => e.excerpt === entry.summary)) {
        evidence.push({
          source_type: "timeline",
          excerpt: entry.summary,
          source_slug: entry.source_page_slug ?? personSlug,
          trust_state: entry.trust_state ?? "trusted",
          date: entry.event_date ?? undefined,
        });
      }
    }
    for (const link of links) {
      const ctx = link.context ?? "";
      if (ctx.length > 0 && matchTokens(tokens, ctx) > 0) {
        const otherSlug = link.from_slug !== personSlug ? link.from_slug : link.to_slug;
        evidence.push({
          source_type: "link",
          excerpt: ctx,
          source_slug: link.source_page_slug ?? otherSlug,
          trust_state: link.trust_state ?? "trusted",
        });
      }
    }
  }

  const connDim = matchedDims.has("connection") || matchedDims.has("relation");
  if (connDim) {
    for (const link of links) {
      const otherSlug = link.from_slug !== personSlug ? link.from_slug : link.to_slug;
      const info = titleMap.get(otherSlug);
      if (!info || matchTokens(connectionTokens, info.title) <= 0) continue;
      const ctx = link.context ?? `${link.from_slug} → ${link.to_slug}`;
      const alreadyAdded = evidence.some((e) => e.source_type === "link" && e.excerpt === ctx);
      if (!alreadyAdded) {
        evidence.push({
          source_type: "link",
          excerpt: ctx,
          source_slug: link.source_page_slug ?? otherSlug,
          trust_state: link.trust_state ?? "trusted",
        });
      }
    }
  }

  if (chunkContents.length > 0 && (matchedDims.has("topic") || matchedDims.has("context") || matchedDims.has("event"))) {
    let chunkCount = 0;
    for (const chunk of chunkContents) {
      if (matchTokens(textTokens, chunk) > 0) {
        evidence.push({
          source_type: "chunk",
          excerpt: chunk.slice(0, 200),
          source_slug: personSlug,
        });
        chunkCount++;
        if (chunkCount >= 3) break;
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
  const allDims: ("time" | "topic" | "connection" | "context" | "event" | "relation")[] = ["time", "topic", "relation", "context", "event"];
  const missing = allDims.filter((d) => !dims.has(d));
  if (missing.length === 0) return null;

  const labelMap: Record<string, string> = {
    time: "时间段",
    topic: "讨论的主题",
    relation: "共同认识的人或组织",
    context: "见面的场景",
    event: "参与的事件",
  };
  return `可以补充${missing.map((d) => labelMap[d]).join("或")}来缩小范围`;
}

// ─── Summary ──────────────────────────────────────────────────

function buildNoCandidateSummary(
  diagnostics: RecallDiagnostics,
  totalScanned: number,
): string {
  const unsupported = diagnostics.clues_checked
    .filter((c) => !c.had_support)
    .map((c) => c.clue_type);
  const suffix = unsupported.length > 0
    ? `（${unsupported.join("、")}线索无匹配，扫描了${totalScanned}个人物）`
    : "";
  return `没有找到匹配的人物候选。${suffix}`;
}

function buildSummary(result: EpisodicRecallResult): string {
  const { candidates } = result;
  if (candidates.length === 0) {
    return buildNoCandidateSummary(result.diagnostics, result.search_meta.total_scanned);
  }
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

    const resolvedClues = this.resolveClues(clues);

    const personSlugs = this.db.listPageSlugs({ type: "entity/person" });
    if (personSlugs.length === 0) {
      return this.buildEmptyResult(clues.query, resolvedClues, 0);
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

    // FTS pre-fetch for chunk evidence
    const personSlugsSet = new Set(personSlugs);
    const chunkMap = this.fetchChunkMap(resolvedClues, personSlugsSet);

    const candidates: EpisodicCandidate[] = [];

    for (const slug of personSlugs) {
      const timeline = timelineMap.get(slug) ?? [];
      const { outgoing, incoming } = linksMap.get(slug) ?? { outgoing: [], incoming: [] };
      const allLinks = [...outgoing, ...incoming];
      const chunks = chunkMap.get(slug) ?? [];

      const timeDim = scoreTime(resolvedClues.time_hint, timeline);
      const topicTexts = [
        ...timeline.map((e) => e.summary),
        ...allLinks.map((l) => l.context ?? ""),
        ...chunks,
      ];
      const topicDim = scoreTextHint(resolvedClues.topic_hint, topicTexts);
      const connDim = scoreConnection(resolvedClues.connection_hint, allLinks, slug, titleMap);
      const contextTexts = [...timeline.map((e) => e.summary), ...chunks];
      const contextDim = scoreTextHint(resolvedClues.context_hint, contextTexts);
      const eventDim = scoreEvent(resolvedClues.event_hint, timeline);

      const rawScore =
        W_TIME * timeDim.score +
        W_TOPIC * topicDim.score +
        W_CONNECTION * connDim.score +
        W_CONTEXT * contextDim.score +
        W_EVENT * eventDim.score;

      if (rawScore <= 0) continue;

      const matchedClues: MatchedClue[] = [];
      if (timeDim.matched) matchedClues.push({ dimension: "time", hint_used: timeDim.hintUsed });
      if (topicDim.matched) matchedClues.push({ dimension: "topic", hint_used: topicDim.hintUsed });
      if (connDim.matched) matchedClues.push({ dimension: "relation", hint_used: connDim.hintUsed });
      if (contextDim.matched) matchedClues.push({ dimension: "context", hint_used: contextDim.hintUsed });
      if (eventDim.matched) matchedClues.push({ dimension: "event", hint_used: eventDim.hintUsed });

      const matchCount = matchedClues.length;
      const bonus = matchCount >= 2 ? 1 + MULTI_CLUE_BONUS * (matchCount - 1) : 1;
      const score = Math.min(rawScore * bonus, 1.0);

      const matchedDims = new Set(matchedClues.map((c) => c.dimension));
      const textTokens = [
        ...tokenizeHint(resolvedClues.topic_hint ?? ""),
        ...tokenizeHint(resolvedClues.context_hint ?? ""),
        ...tokenizeHint(resolvedClues.event_hint ?? ""),
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
          chunks,
        ),
        next_disambiguating_clue: null,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const capped = candidates.slice(0, limit);

    for (const c of capped) {
      c.next_disambiguating_clue = generateDisambiguatingClue(c, capped);
    }

    const diagnostics = this.buildDiagnostics(resolvedClues, capped, personSlugs.length);

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
      diagnostics,
    };
    result.summary = buildSummary(result);
    return result;
  }

  private fetchChunkMap(
    clues: EpisodeClues,
    personSlugs: Set<string>,
  ): Map<string, string[]> {
    const parts = [clues.topic_hint, clues.context_hint, clues.event_hint, clues.connection_hint]
      .filter((h): h is string => !!h && h.length >= 2);
    if (parts.length === 0) return new Map();

    const combined = parts.join(" ");
    const results = this.db.ftsSearch(combined, 50);
    const chunkMap = new Map<string, string[]>();
    for (const r of results) {
      if (!personSlugs.has(r.page_slug)) continue;
      const list = chunkMap.get(r.page_slug);
      if (list) list.push(r.content);
      else chunkMap.set(r.page_slug, [r.content]);
    }
    return chunkMap;
  }

  private buildDiagnostics(
    clues: EpisodeClues,
    candidates: EpisodicCandidate[],
    totalScanned: number,
  ): RecallDiagnostics {
    const dims = [
      { type: "time", hint: clues.time_hint },
      { type: "topic", hint: clues.topic_hint },
      { type: "event", hint: clues.event_hint },
      { type: "connection", hint: clues.connection_hint ?? clues.relation_hint },
      { type: "context", hint: clues.context_hint },
    ];
    return {
      clues_checked: dims.map(({ type, hint }) => ({
        clue_type: type,
        had_support: hint ? candidates.some((c) => c.matched_clues.some((mc) => mc.dimension === type || (type === "connection" && mc.dimension === "relation"))) : false,
        scanned: totalScanned,
      })),
    };
  }

  private resolveClues(clues: EpisodeClues): EpisodeClues {
    const resolved = { ...clues };

    // Fallback: relation_hint -> connection_hint
    if (!resolved.connection_hint && resolved.relation_hint) {
      resolved.connection_hint = resolved.relation_hint;
    }

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
    if (clues.event_hint) tokens.push(...tokenizeHint(clues.event_hint));
    return [...new Set(tokens)];
  }

  private collectHintsApplied(clues: EpisodeClues): string[] {
    const applied: string[] = [];
    if (clues.time_hint) applied.push("time");
    if (clues.topic_hint) applied.push("topic");
    if (clues.context_hint) applied.push("context");
    if (clues.connection_hint || clues.relation_hint) applied.push("relation");
    if (clues.event_hint) applied.push("event");
    return applied;
  }

  private buildEmptyResult(query: string, resolvedClues: EpisodeClues, totalScanned: number): EpisodicRecallResult {
    const diagnostics = this.buildDiagnostics(resolvedClues, [], totalScanned);

    const result: EpisodicRecallResult = {
      query,
      summary: "",
      candidates: [],
      search_meta: {
        time_parsed: resolvedClues.time_hint ?? null,
        tokens_used: this.collectTokens(resolvedClues),
        total_scanned: totalScanned,
        hints_applied: this.collectHintsApplied(resolvedClues),
      },
      diagnostics,
    };
    result.summary = buildSummary(result);
    return result;
  }
}
