import type { SourceCategory, TrustState } from "../provenance.js";
import { mapSourceType } from "../provenance.js";
import type { CBrainDB, LinkRow } from "../../storage/sqlite.js";

export type Confidence = "high" | "medium" | "low";

// ─── Types ────────────────────────────────────────────────────

export type EvidenceType = "fact" | "user_thought" | "candidate";
export type EvidenceSourceType = "page" | "chunk" | "link" | "timeline";

export interface EvidenceItem {
  claim: string;
  evidence_type: EvidenceType;
  source_type: EvidenceSourceType;
  source_slug: string;
  source_category: SourceCategory;
  trust_state: TrustState;
  excerpt?: string;
  confidence?: number;
  timestamp?: string;
}

export interface Conflict {
  claim: string;
  evidence: EvidenceItem[];
}

export interface EvidenceBoardResult {
  facts: EvidenceItem[];
  user_thoughts: EvidenceItem[];
  candidates: EvidenceItem[];
  gaps: string[];
  conflicts: Conflict[];
}

/** Lightweight evidence quality summary for normal (non-grounded) recall. */
export interface EvidenceSummary {
  confidence: Confidence;
  top_facts: string[];
  gap_count: number;
  conflict_count: number;
  total_evidence: number;
}

export interface EvidenceSource {
  resolveSlug(slug: string): boolean;
}

// ─── Internal ─────────────────────────────────────────────────

const INACTIVE_STATES: ReadonlySet<TrustState> = new Set(["rejected", "superseded"]);

/**
 * Compute confidence level from evidence board state.
 * Shared by lightweight evidence summary and grounded answer synthesis.
 */
export function computeConfidence(board: EvidenceBoardResult): Confidence {
  const hasFacts = board.facts.length > 0;
  const hasThoughts = board.user_thoughts.length > 0;
  const hasUnresolved = board.gaps.length > 0;
  const hasConflicts = board.conflicts.length > 0;

  if (hasFacts && !hasConflicts && !hasUnresolved) return "high";
  if (hasFacts && (hasConflicts || hasUnresolved)) return "medium";
  if (!hasFacts && hasThoughts) return "medium";
  return "low";
}

function trustToEvidenceType(ts: TrustState): EvidenceType | null {
  switch (ts) {
    case "trusted": return "fact";
    case "user_thought": return "user_thought";
    case "candidate": return "candidate";
    default: return null;
  }
}

function dedupKey(item: EvidenceItem): string {
  return `${item.claim}\0${item.source_slug}\0${item.trust_state}`;
}

// ─── EvidenceBoard ────────────────────────────────────────────

export class EvidenceBoard {
  private source: EvidenceSource;
  private items: EvidenceItem[] = [];
  private conflictGroups: Conflict[] = [];

  constructor(source: EvidenceSource) {
    this.source = source;
  }

  add(item: EvidenceItem): void {
    if (!item.source_slug || !this.source.resolveSlug(item.source_slug)) return;
    this.items.push(item);
  }

  addConflict(label: string, items: EvidenceItem[]): void {
    const seen = new Set<string>();
    const active: EvidenceItem[] = [];
    for (const it of items) {
      if (!it.source_slug || !this.source.resolveSlug(it.source_slug)) continue;
      if (INACTIVE_STATES.has(it.trust_state)) continue;
      const et = trustToEvidenceType(it.trust_state);
      if (!et) continue;
      const derived = { ...it, evidence_type: et };
      const key = dedupKey(derived);
      if (seen.has(key)) continue;
      seen.add(key);
      active.push(derived);
    }
    if (active.length >= 2) {
      this.conflictGroups.push({ claim: label, evidence: active });
    }
  }

  build(): EvidenceBoardResult {
    const seen = new Set<string>();
    const facts: EvidenceItem[] = [];
    const userThoughts: EvidenceItem[] = [];
    const candidates: EvidenceItem[] = [];

    for (const item of this.items) {
      if (INACTIVE_STATES.has(item.trust_state)) continue;
      const key = dedupKey(item);
      if (seen.has(key)) continue;
      seen.add(key);

      const partition = trustToEvidenceType(item.trust_state);
      const derived = { ...item, evidence_type: partition ?? item.evidence_type };
      switch (partition) {
        case "fact": facts.push(derived); break;
        case "user_thought": userThoughts.push(derived); break;
        case "candidate": candidates.push(derived); break;
      }
    }

    const gaps = this.detectGaps(facts, candidates);

    return {
      facts,
      user_thoughts: userThoughts,
      candidates,
      gaps,
      conflicts: this.conflictGroups,
    };
  }

  private detectGaps(facts: EvidenceItem[], candidates: EvidenceItem[]): string[] {
    const supportedClaims = new Set(facts.map((i) => i.claim));
    const gaps: string[] = [];
    for (const c of candidates) {
      if (!supportedClaims.has(c.claim)) {
        gaps.push(c.claim);
      }
    }
    return gaps;
  }
}

// ─── Slug→Evidence Bridge ────────────────────────────────────

const ACCEPT_ALL: EvidenceSource = { resolveSlug: () => true };

function slugDisplayName(slug: string): string {
  return slug.split("/").pop() || slug;
}

export function collectEvidenceForSlugs(db: CBrainDB, slugs: string[]): EvidenceBoardResult {
  if (slugs.length === 0) {
    return { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] };
  }

  const linksMap = db.batchGetLinksForSlugs(slugs, true);
  const timelineMap = db.batchGetTimelineForSlugs(slugs, true);
  const board = new EvidenceBoard(ACCEPT_ALL);
  const addedItems: EvidenceItem[] = [];

  for (const slug of slugs) {
    const { outgoing, incoming } = linksMap.get(slug) ?? { outgoing: [], incoming: [] };

    for (const link of [...outgoing, ...incoming] as LinkRow[]) {
      const otherSlug = link.from_slug !== slug ? link.from_slug : link.to_slug;
      const sourceSlug = link.source_page_slug || otherSlug;
      const trustState = (link.trust_state as TrustState) ?? "candidate";

      const fromName = slugDisplayName(link.from_slug);
      const toName = slugDisplayName(link.to_slug);
      const claim = link.context || `${fromName} ${link.relation} ${toName}`;

      const item: EvidenceItem = {
        claim,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "link",
        source_slug: sourceSlug,
        source_category: mapSourceType(link.source_type ?? undefined),
        trust_state: trustState,
        confidence: link.confidence ?? 0.5,
        timestamp: link.created_at,
      };
      board.add(item);
      addedItems.push(item);
    }

    const timeline = timelineMap.get(slug) ?? [];
    for (const entry of timeline) {
      const trustState = (entry.trust_state as TrustState) ?? "candidate";

      const item: EvidenceItem = {
        claim: entry.summary,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "timeline",
        source_slug: entry.source_page_slug || slug,
        source_category: mapSourceType(entry.source ?? undefined),
        trust_state: trustState,
        confidence: 0.5,
        timestamp: entry.created_at,
      };
      board.add(item);
      addedItems.push(item);
    }

    // Page-level evidence: L1 summary (condensed entity content)
    const l1 = db.getL1Summary(slug);
    if (l1?.content) {
      const claim = l1.content.length > MAX_SOURCE_CLAIM_CHARS
        ? l1.content.slice(0, MAX_SOURCE_CLAIM_CHARS) + "..."
        : l1.content;
      const pageItem: EvidenceItem = {
        claim,
        evidence_type: "fact",
        source_type: "page",
        source_slug: slug,
        source_category: "explicit_input",
        trust_state: "trusted",
        confidence: 0.8,
      };
      board.add(pageItem);
      addedItems.push(pageItem);
    }

    // Chunk-level evidence: top level-0 chunks (raw text segments)
    const chunks = db.getChunksByPage(slug, { summaryLevel: 0 });
    for (const chunk of chunks.slice(0, 3)) {
      const claim = chunk.content.length > MAX_SOURCE_CLAIM_CHARS
        ? chunk.content.slice(0, MAX_SOURCE_CLAIM_CHARS) + "..."
        : chunk.content;
      const chunkItem: EvidenceItem = {
        claim,
        evidence_type: "fact",
        source_type: "chunk",
        source_slug: slug,
        source_category: "explicit_input",
        trust_state: "trusted",
        confidence: 0.7,
      };
      board.add(chunkItem);
      addedItems.push(chunkItem);
    }
  }

  detectClaimConflicts(board, addedItems);

  return board.build();
}

const MAX_SOURCE_CLAIM_CHARS = 200;

const NEGATION_RE = /已不|不再|不是|没有/g;

function stripNegation(claim: string): string {
  return claim.replace(NEGATION_RE, "");
}

function detectClaimConflicts(board: EvidenceBoard, items: EvidenceItem[]): void {
  const active = items.filter((it) => !INACTIVE_STATES.has(it.trust_state));
  if (active.length < 2) return;

  const groups = new Map<string, EvidenceItem[]>();
  for (const item of active) {
    const key = stripNegation(item.claim);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const uniqueClaims = new Set(group.map((it) => it.claim));
    if (uniqueClaims.size < 2) continue;
    board.addConflict(group[0].claim, group);
  }
}

// ─── Evidence Summary (lightweight, for normal recall) ───────

const MAX_TOP_FACTS = 5;
const MAX_FACT_CHARS = 80;

function truncateFact(claim: string): string {
  if (claim.length <= MAX_FACT_CHARS) return claim;
  return claim.slice(0, MAX_FACT_CHARS) + "...";
}

/**
 * Build a lightweight evidence summary from a full board.
 * Returns null when total_evidence === 0.
 */
export function buildEvidenceSummary(board: EvidenceBoardResult): EvidenceSummary | null {
  const totalEvidence = board.facts.length + board.user_thoughts.length + board.candidates.length;
  if (totalEvidence === 0) return null;

  const topFacts = board.facts
    .slice()
    .sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5))
    .slice(0, MAX_TOP_FACTS)
    .map(f => truncateFact(f.claim));

  return {
    confidence: computeConfidence(board),
    top_facts: topFacts,
    gap_count: board.gaps.length,
    conflict_count: board.conflicts.length,
    total_evidence: totalEvidence,
  };
}

interface TimelineEntry {
  id: number;
  event_date: string | null;
  source: string | null;
  summary: string;
  created_at: string;
  trust_state?: string;
  source_page_slug?: string;
  evidence?: string;
}

/**
 * Build EvidenceBoardResult from pre-fetched links and timeline maps.
 * This keeps normal recall evidence lightweight and avoids extra DB calls.
 */
export function buildEvidenceFromBatched(
  linksMap: Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>,
  timelineMap: Map<string, TimelineEntry[]>,
  slugs: string[],
): EvidenceBoardResult {
  if (slugs.length === 0) {
    return { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] };
  }

  const board = new EvidenceBoard(ACCEPT_ALL);
  const addedItems: EvidenceItem[] = [];

  for (const slug of slugs) {
    const { outgoing, incoming } = linksMap.get(slug) ?? { outgoing: [], incoming: [] };

    for (const link of [...outgoing, ...incoming]) {
      const otherSlug = link.from_slug !== slug ? link.from_slug : link.to_slug;
      const sourceSlug = link.source_page_slug || otherSlug;
      const trustState = (link.trust_state as TrustState) ?? "candidate";

      const fromName = slugDisplayName(link.from_slug);
      const toName = slugDisplayName(link.to_slug);
      const claim = link.context || `${fromName} ${link.relation} ${toName}`;

      const item: EvidenceItem = {
        claim,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "link",
        source_slug: sourceSlug,
        source_category: mapSourceType(link.source_type ?? undefined),
        trust_state: trustState,
        confidence: link.confidence ?? 0.5,
        timestamp: link.created_at,
      };
      board.add(item);
      addedItems.push(item);
    }

    const timeline = timelineMap.get(slug) ?? [];
    for (const entry of timeline) {
      const trustState = (entry.trust_state as TrustState) ?? "candidate";

      const item: EvidenceItem = {
        claim: entry.summary,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "timeline",
        source_slug: entry.source_page_slug || slug,
        source_category: mapSourceType(entry.source ?? undefined),
        trust_state: trustState,
        confidence: 0.5,
        timestamp: entry.created_at,
      };
      board.add(item);
      addedItems.push(item);
    }
  }

  detectClaimConflicts(board, addedItems);

  return board.build();
}
