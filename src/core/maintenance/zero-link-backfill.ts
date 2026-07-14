import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isCurrentFactLink } from "../shared.js";
import type { NerSourceKind } from "../ingestion/ner-backfill-contract.js";
export {
  ZERO_LINK_BATCH_MANIFEST_JOB,
  ZERO_LINK_REPAIR_NAME,
  ZERO_LINK_REPAIR_VERSION,
} from "../ingestion/ner-backfill-contract.js";

export const ZERO_LINK_MIN_RAW_CHUNKS = 2;
export const ZERO_LINK_MIN_RAW_CHARS = 1000;
export const ZERO_LINK_MIN_TAGS = 3;
export const ZERO_LINK_JOB_PRIORITY_BASE = 1000;

export interface ZeroLinkDb {
  rawDb: Database;
}

export interface ZeroLinkCandidate {
  slug: string;
  contentHash: string | null;
  contentFingerprint: string | null;
  sourceKind: NerSourceKind | null;
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

export interface PublicZeroLinkCandidate {
  rawChunkCount: number;
  rawCharCount: number;
  tagCount: number;
}

interface CandidateAggregateRow {
  slug: string;
  type: string;
  content_hash: string | null;
  raw_chunk_count: number;
  raw_char_count: number;
  tag_count: number;
}

interface SourceChunkRow {
  id: number;
  chunk_index: number;
  content: string;
}

export interface ZeroLinkSource {
  contentFingerprint: string | null;
  sourceKind: NerSourceKind | null;
}

function activeCurrentLinkSlugs(db: ZeroLinkDb): Set<string> {
  const rows = db.rawDb.prepare(
    "SELECT from_slug, to_slug, relation, trust_state FROM links",
  ).all() as Array<{
    from_slug: string;
    to_slug: string;
    relation: string;
    trust_state: string | null;
  }>;
  const connected = new Set<string>();
  for (const row of rows) {
    if (row.from_slug === row.to_slug) continue;
    if (row.trust_state === "rejected" || row.trust_state === "superseded") continue;
    if (!isCurrentFactLink(row)) continue;
    connected.add(row.from_slug);
    connected.add(row.to_slug);
  }
  return connected;
}

function readCandidateAggregates(db: ZeroLinkDb): CandidateAggregateRow[] {
  return db.rawDb.prepare(`
    WITH raw_chunks AS (
      SELECT page_slug,
             COUNT(*) AS raw_chunk_count,
             COALESCE(SUM(LENGTH(content)), 0) AS raw_char_count
      FROM chunks
      WHERE summary_level = 0
      GROUP BY page_slug
    ), tag_counts AS (
      SELECT page_slug, COUNT(*) AS tag_count
      FROM tags
      GROUP BY page_slug
    )
    SELECT p.slug,
           p.type,
           p.content_hash,
           COALESCE(c.raw_chunk_count, 0) AS raw_chunk_count,
           COALESCE(c.raw_char_count, 0) AS raw_char_count,
           COALESCE(t.tag_count, 0) AS tag_count
    FROM pages p
    LEFT JOIN raw_chunks c ON c.page_slug = p.slug
    LEFT JOIN tag_counts t ON t.page_slug = p.slug
    WHERE p.type = 'record'
      AND (
        COALESCE(c.raw_chunk_count, 0) >= $minChunks
        OR COALESCE(c.raw_char_count, 0) >= $minChars
        OR COALESCE(t.tag_count, 0) >= $minTags
      )
    ORDER BY raw_char_count DESC, raw_chunk_count DESC, tag_count DESC, p.slug ASC
  `).all({
    $minChunks: ZERO_LINK_MIN_RAW_CHUNKS,
    $minChars: ZERO_LINK_MIN_RAW_CHARS,
    $minTags: ZERO_LINK_MIN_TAGS,
  }) as CandidateAggregateRow[];
}

export function deriveZeroLinkSource(db: ZeroLinkDb, slug: string): ZeroLinkSource {
  const page = db.rawDb.prepare(
    "SELECT type, content_hash FROM pages WHERE slug = ?",
  ).get(slug) as { type: string; content_hash: string | null } | null;
  if (!page) return { contentFingerprint: null, sourceKind: null };

  const sealed = Boolean(db.rawDb.prepare(
    "SELECT 1 FROM chunks WHERE page_slug = ? AND summary_level = 1 LIMIT 1",
  ).get(slug));

  if (!sealed) {
    const pageHash = page.content_hash?.trim();
    return pageHash
      ? { contentFingerprint: `page:${pageHash}`, sourceKind: "vault_hash" }
      : { contentFingerprint: null, sourceKind: null };
  }

  const chunks = db.rawDb.prepare(
    `SELECT id, chunk_index, content
     FROM chunks
     WHERE page_slug = ? AND summary_level = 0
     ORDER BY chunk_index ASC, id ASC`,
  ).all(slug) as SourceChunkRow[];
  if (chunks.length === 0) return { contentFingerprint: null, sourceKind: null };
  const tags = (db.rawDb.prepare(
    "SELECT tag FROM tags WHERE page_slug = ? ORDER BY tag ASC",
  ).all(slug) as Array<{ tag: string }>).map((row) => row.tag);
  const canonical = {
    version: 1,
    type: page.type,
    chunks: chunks.map((row) => ({ index: row.chunk_index, id: row.id, content: row.content })),
    tags,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
  return { contentFingerprint: `derived:${digest}`, sourceKind: "raw_chunks" };
}

export function countCurrentGraphLinks(db: ZeroLinkDb, slug: string): number {
  const rows = db.rawDb.prepare(
    `SELECT from_slug, to_slug, relation, trust_state
     FROM links
     WHERE from_slug = ? OR to_slug = ?`,
  ).all(slug, slug) as Array<{
    from_slug: string;
    to_slug: string;
    relation: string;
    trust_state: string | null;
  }>;
  let count = 0;
  for (const row of rows) {
    if (row.from_slug === row.to_slug) continue;
    if (row.trust_state === "rejected" || row.trust_state === "superseded") continue;
    if (isCurrentFactLink(row)) count++;
  }
  return count;
}

export function scanRichRecords(db: ZeroLinkDb): ZeroLinkCandidate[] {
  const connected = activeCurrentLinkSlugs(db);
  return readCandidateAggregates(db)
    .filter((row) => !connected.has(row.slug))
    .map((row) => {
      const source = deriveZeroLinkSource(db, row.slug);
      return {
        slug: row.slug,
        contentHash: row.content_hash,
        ...source,
        rawChunkCount: Number(row.raw_chunk_count),
        rawCharCount: Number(row.raw_char_count),
        tagCount: Number(row.tag_count),
      };
    });
}

export function scanZeroLinkCandidates(db: ZeroLinkDb, limit?: number): ZeroLinkCandidate[] {
  const candidates = scanRichRecords(db);
  return limit === undefined ? candidates : candidates.slice(0, Math.max(0, limit));
}

export function toPublicZeroLinkCandidate(candidate: ZeroLinkCandidate): PublicZeroLinkCandidate {
  return {
    rawChunkCount: candidate.rawChunkCount,
    rawCharCount: candidate.rawCharCount,
    tagCount: candidate.tagCount,
  };
}
