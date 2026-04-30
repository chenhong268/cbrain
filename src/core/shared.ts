import { createHash } from "node:crypto";
import type { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LanceDBManager } from "../storage/lancedb.js";

/**
 * Shared utilities used by SyncManager, IngestManager, and PageManager.
 * Single source of truth for chunking, hashing, NER helpers, etc.
 */

// ─── Content Hashing ─────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── Chunking ────────────────────────────────────────────────

export function chunkContent(
  body: string,
  chunkSize: number = 500
): Array<{ index: number; content: string }> {
  if (!body.trim()) return [];

  const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: Array<{ index: number; content: string }> = [];
  let current = "";
  let index = 0;

  for (const para of paragraphs) {
    if (current.length + para.length > chunkSize && current.length > 0) {
      chunks.push({ index, content: current.trim() });
      index++;
      current = para;
    } else {
      current = current.length > 0 ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) {
    chunks.push({ index, content: current.trim() });
  }

  return chunks;
}

// ─── NER Helpers ─────────────────────────────────────────────

export function mapEntityType(
  type: string
): "entity" | "concept" | "event" | "record" | "source" {
  switch (type) {
    case "person":
    case "company":
    case "product":
      return "entity";
    case "concept":
      return "concept";
    default:
      return "entity";
  }
}

export function buildStubBody(
  name: string,
  rels: Array<{ from: string; to: string; relation: string }>,
  sourceSlug: string
): string {
  const lines = [
    `> Auto-extracted from [[${sourceSlug}]]`,
    "",
    `## Known Relations`,
    "",
  ];
  for (const rel of rels) {
    if (rel.from === name) {
      lines.push(`- ${rel.relation} → [[${rel.to}]]`);
    } else {
      lines.push(`- ← ${rel.relation} from [[${rel.from}]]`);
    }
  }
  return lines.join("\n");
}

/**
 * Look up an entity slug by exact title match in DB.
 * Only matches entity/concept pages — raw files and records are source material,
 * not valid targets for wikilinks.
 */
export function findEntitySlug(
  db: CBrainDB,
  name: string
): string | null {
  const byTitle = db
    .prepare("SELECT slug FROM pages WHERE title = $name AND type IN ('entity', 'concept')")
    .get({ $name: name }) as { slug: string } | null;
  return byTitle?.slug ?? null;
}

/**
 * Resolve a NER-extracted name to a known entity slug.
 * Strategy:
 * 1. Exact match in entitySlugMap
 * 2. Case-insensitive match in entitySlugMap
 * 3. Strip parenthetical suffix (e.g. "赵磊（投资总监）" → "赵磊")
 * 4. DB lookup by title
 */
export function resolveEntityName(
  name: string,
  entitySlugMap: Map<string, string>,
  db: CBrainDB
): string | null {
  // 1. Exact
  const exact = entitySlugMap.get(name);
  if (exact) return exact;

  // 2. Case-insensitive
  const lower = name.toLowerCase();
  for (const [key, slug] of entitySlugMap) {
    if (key.toLowerCase() === lower) return slug;
  }

  // 3. Strip parenthetical suffix
  const stripped = name.replace(/[（(].+?[）)]$/, "").trim();
  if (stripped !== name) {
    const s = entitySlugMap.get(stripped);
    if (s) return s;
    for (const [key, slug] of entitySlugMap) {
      if (key.toLowerCase() === stripped.toLowerCase()) return slug;
    }
    for (const [key, slug] of entitySlugMap) {
      if (key.startsWith(stripped) || stripped.startsWith(key)) return slug;
    }
  }

  // 4. DB fallback
  return findEntitySlug(db, name) ?? findEntitySlug(db, stripped);
}

// ─── Page Indexing ─────────────────────────────────────────────

/**
 * Write chunks + embeddings + FTS for a page.
 * Single implementation used by sync, ingest, and MCP server.
 */
export async function indexPageContent(
  db: CBrainDB,
  embedding: EmbeddingProvider,
  lance: LanceDBManager,
  slug: string,
  body: string,
  chunkSize: number = 500
): Promise<void> {
  const chunks = chunkContent(body, chunkSize);
  if (chunks.length === 0) return;

  const embedResults = await embedding.embedBatch(chunks.map((c) => c.content));

  await lance.deleteByPageSlug(slug);
  await lance.addChunks(
    chunks.map((c, i) => ({
      pageSlug: slug,
      chunkIndex: c.index,
      content: c.content,
      vector: new Float32Array(embedResults[i].embedding),
    }))
  );

  db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({ $slug: slug });
  db.ftsDeleteByPage(slug);
  const insertChunk = db.prepare(
    "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
  );
  for (const chunk of chunks) {
    insertChunk.run({ $slug: slug, $idx: chunk.index, $content: chunk.content });
  }

  const fullContent = chunks.map((c) => c.content).join("\n\n");
  db.ftsInsert(slug, fullContent);
}
