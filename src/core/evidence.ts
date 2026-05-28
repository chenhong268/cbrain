import type { SourceCategory, TrustState } from "./provenance.js";
import { mapSourceType } from "./provenance.js";
import type { CBrainDB, LinkRow } from "../storage/sqlite.js";

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

export interface EvidenceSource {
  resolveSlug(slug: string): boolean;
}

// ─── Internal ─────────────────────────────────────────────────

const INACTIVE_STATES: ReadonlySet<TrustState> = new Set(["rejected", "superseded"]);

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

export function collectEvidenceForSlugs(db: CBrainDB, slugs: string[]): EvidenceBoardResult {
  if (slugs.length === 0) {
    return { facts: [], user_thoughts: [], candidates: [], gaps: [], conflicts: [] };
  }

  const linksMap = db.batchGetLinksForSlugs(slugs, true);
  const timelineMap = db.batchGetTimelineForSlugs(slugs, true);
  const board = new EvidenceBoard(ACCEPT_ALL);

  for (const slug of slugs) {
    const { outgoing, incoming } = linksMap.get(slug) ?? { outgoing: [], incoming: [] };

    for (const link of [...outgoing, ...incoming] as LinkRow[]) {
      const otherSlug = link.from_slug !== slug ? link.from_slug : link.to_slug;
      const sourceSlug = link.source_page_slug || otherSlug;
      const trustState = (link.trust_state as TrustState) ?? "candidate";

      board.add({
        claim: link.context || link.relation,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "link",
        source_slug: sourceSlug,
        source_category: mapSourceType(link.source_type ?? undefined),
        trust_state: trustState,
        confidence: link.confidence ?? 0.5,
        timestamp: link.created_at,
      });
    }

    const timeline = timelineMap.get(slug) ?? [];
    for (const entry of timeline) {
      const trustState = (entry.trust_state as TrustState) ?? "candidate";

      board.add({
        claim: entry.summary,
        evidence_type: trustState === "trusted" ? "fact" : trustState === "user_thought" ? "user_thought" : "candidate",
        source_type: "timeline",
        source_slug: entry.source_page_slug || slug,
        source_category: mapSourceType(entry.source ?? undefined),
        trust_state: trustState,
        confidence: 0.5,
        timestamp: entry.created_at,
      });
    }
  }

  return board.build();
}
