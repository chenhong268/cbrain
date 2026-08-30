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

function removeLegacyKnownRelationsBlocks(body: string): string {
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
  return clean;
}

function knownRelationsRange(body: string): { start: number; end: number } | null {
  const start = body.indexOf(KNOWN_RELATIONS_HEADER);
  if (start === -1) return null;

  const afterHeader = start + KNOWN_RELATIONS_HEADER.length;
  const nextHeading = body.slice(afterHeader).match(/\r?\n#{1,2}(?=[ \t\r\n]|$)/);
  const end = nextHeading?.index === undefined ? body.length : afterHeader + nextHeading.index;
  return { start, end };
}

/**
 * Strip CBrain-managed relation projection from a body while preserving
 * user-authored content before it. The projection is derived from SQLite links;
 * it is never parsed as a fact source.
 */
export function stripKnownRelationsSection(body: string): string {
  let clean = removeLegacyKnownRelationsBlocks(body);
  const range = knownRelationsRange(clean);
  if (range) {
    const before = clean.substring(0, range.start).trimEnd();
    const after = clean.substring(range.end).trimStart();
    clean = before && after ? `${before}\n\n${after}` : before || after;
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
  const clean = removeLegacyKnownRelationsBlocks(body).replace(/\n\*\*关联\*\*\n/g, "\n");
  const range = knownRelationsRange(clean);
  if (!range) {
    const cleanBody = clean.trimEnd();
    if (!block.trim()) return cleanBody;
    return cleanBody ? `${cleanBody}\n\n${block}` : block;
  }

  const before = clean.substring(0, range.start).trimEnd();
  const after = clean.substring(range.end).trimStart();
  if (!block.trim()) return before && after ? `${before}\n\n${after}` : before || after;
  if (!after) return before ? `${before}\n\n${block}` : block;
  return [before, block.trimEnd(), after].filter(Boolean).join("\n\n");
}

function extractKnownRelationsBlock(body: string): string {
  const range = knownRelationsRange(body);
  if (!range) return "";
  return body.substring(range.start, range.end).trimEnd();
}

export function hasKnownRelationsDrift(body: string, outgoing: KnownRelationsLink[], incoming: KnownRelationsLink[]): boolean {
  const expected = buildKnownRelationsBlock(outgoing, incoming).trimEnd();
  const actual = extractKnownRelationsBlock(body);
  return actual !== expected;
}
