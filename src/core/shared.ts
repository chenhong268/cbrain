import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, extname } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";

/**
 * Shared utilities used by SyncManager, IngestManager, and PageManager.
 * Single source of truth for chunking, hashing, NER helpers, etc.
 */

// ─── Constants ───────────────────────────────────────────────

export const DEFAULT_CHUNK_SIZE = 500;

// ─── Content Hashing ─────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── File Collection ─────────────────────────────────────────

export function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EACCES") {
        console.error(`[shared] readdirSync 失败: ${d}`, e);
      }
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); }
      else if (extname(e.name).toLowerCase() === ".md") { results.push(p); }
    }
  };
  walk(dir);
  return results;
}

// ─── Chunking ────────────────────────────────────────────────

export function chunkContent(
  body: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE
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
): "entity" | "concept" {
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

const VALID_PAGE_TYPES = new Set(["entity", "concept", "record", "insight"]);

export function normalizePageType(type: string): "entity" | "concept" | "record" | "insight" {
  return (VALID_PAGE_TYPES.has(type) ? type : "record") as "entity" | "concept" | "record" | "insight";
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
  return db.getEntitySlugByTitle(name);
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

