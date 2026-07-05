import { isCurrentFactLink } from "../shared.js";

export const KNOWN_RELATIONS_HEADER = "## Known Relations";

export interface KnownRelationsProjection {
  outgoingLines: string[];
  incomingLines: string[];
  lines: string[];
  block: string;
}

export interface KnownRelationsLink {
  from_slug: string;
  to_slug: string;
  relation: string;
  trust_state?: string | null;
}

function uniqueSorted(lines: string[]): string[] {
  return [...new Set(lines)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Strip CBrain-managed relation projection from a body while preserving
 * user-authored content before it. The projection is derived from SQLite links;
 * it is never parsed as a fact source.
 */
export function stripKnownRelationsSection(body: string): string {
  let clean = body;
  const legacyOpen = "<!-- cbrain-links -->";
  const legacyClose = "<!-- /cbrain-links -->";
  let legacyOpenIdx = clean.indexOf(legacyOpen);
  while (legacyOpenIdx !== -1) {
    const legacyCloseIdx = clean.indexOf(legacyClose, legacyOpenIdx);
    if (legacyCloseIdx === -1) break;
    clean = clean.substring(0, legacyOpenIdx) + clean.substring(legacyCloseIdx + legacyClose.length);
    legacyOpenIdx = clean.indexOf(legacyOpen);
  }

  const sectionIdx = clean.indexOf(KNOWN_RELATIONS_HEADER);
  if (sectionIdx !== -1) {
    clean = clean.substring(0, sectionIdx);
  }

  clean = clean.replace(/\n\*\*关联\*\*\n/g, "\n");
  return clean.trimEnd();
}

export function buildKnownRelationsProjection(outgoing: KnownRelationsLink[], incoming: KnownRelationsLink[]): KnownRelationsProjection {
  const currentOutgoing = outgoing.filter(isCurrentFactLink);
  const currentIncoming = incoming.filter(isCurrentFactLink);

  const outgoingLines = uniqueSorted(currentOutgoing.map((l) => `- ${l.relation} → [[${l.to_slug}]]`));
  const incomingLines = uniqueSorted(currentIncoming.map((l) => `- ← ${l.relation} from [[${l.from_slug}]]`));
  const lines = [...outgoingLines, ...incomingLines];
  const block = lines.length > 0
    ? `${KNOWN_RELATIONS_HEADER}\n\n${lines.join("\n")}\n`
    : "";

  return { outgoingLines, incomingLines, lines, block };
}

export function buildKnownRelationsBlock(outgoing: KnownRelationsLink[], incoming: KnownRelationsLink[]): string {
  return buildKnownRelationsProjection(outgoing, incoming).block;
}

export function replaceKnownRelationsSection(body: string, block: string): string {
  const cleanBody = stripKnownRelationsSection(body);
  if (!block.trim()) return cleanBody;
  return cleanBody ? `${cleanBody}\n\n${block}` : block;
}

function extractKnownRelationsBlock(body: string): string {
  const idx = body.indexOf(KNOWN_RELATIONS_HEADER);
  if (idx === -1) return "";
  return body.substring(idx).trimEnd();
}

export function hasKnownRelationsDrift(body: string, outgoing: KnownRelationsLink[], incoming: KnownRelationsLink[]): boolean {
  const expected = buildKnownRelationsBlock(outgoing, incoming).trimEnd();
  const actual = extractKnownRelationsBlock(body);
  return actual !== expected;
}
