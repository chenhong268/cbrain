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

export function collectMarkdownFiles(dir: string, excludeDirs?: Set<string>): string[] {
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
      if (excludeDirs?.has(e.name)) continue;
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

// ─── Canonical relation types ──────────────────────────────

const CANONICAL_RELATIONS: Record<string, string> = {
  // 1. 认识
  "knows": "认识", "认识": "认识",
  // 2. 提及
  "提及": "提及", "mentions": "提及", "announced": "提及", "发布了": "提及",
  // 3. 任职
  "works_at": "任职", "joined": "任职", "任职于": "任职", "works_on": "任职",
  // 4. 创立
  "founded": "创立", "founded_by": "创立", "founder_of": "创立", "创立了": "创立",
  // 5. 归属
  "subsidiary_of": "归属", "part_of": "归属", "same_company": "归属", "company": "归属",
  "子公司": "归属", "同属诺华公司": "归属", "同公司": "归属", "公司": "归属",
  // 6. 合作
  "partnered_with": "合作", "合作": "合作",
  // 7. 竞争
  "competitor": "竞争", "竞争对手": "竞争",
  // 8. 资本
  "invested_in": "资本", "投资了": "资本", "acquired": "资本", "收购了": "资本",
  // 9. 制造
  "manufactured_by": "制造", "developed_by": "制造", "contains": "制造",
  "contained_in": "制造", "成分": "制造", "uses": "制造", "implemented_by": "制造",
  // 10. 间接关联
  "间接关系": "间接关联", "间接连接": "间接关联",
  // Singletons → nearest semantic match or 提及
  "targets": "竞争", "requires": "制造",
  "evolves_to": "间接关联", "has": "归属",
  "wrote": "制造", "applies_to": "提及",
  "characterized_by": "提及", "focus_of": "提及",
  "methodology": "提及", "studied_in": "提及",
  "triggered_by": "间接关联", "implemented": "制造",
};

export function normalizeRelation(rel: string): string {
  return CANONICAL_RELATIONS[rel] ?? "提及";
}

const DEFAULT_WEIGHTS: Record<string, { strength: string; weight: number }> = {
  "任职": { strength: "strong", weight: 1.0 },
  "创立": { strength: "strong", weight: 1.0 },
  "归属": { strength: "strong", weight: 1.0 },
  "合作": { strength: "medium", weight: 0.7 },
  "竞争": { strength: "medium", weight: 0.7 },
  "资本": { strength: "medium", weight: 0.7 },
  "制造": { strength: "medium", weight: 0.7 },
  "认识": { strength: "weak", weight: 0.3 },
  "提及": { strength: "weak", weight: 0.3 },
  "间接关联": { strength: "weak", weight: 0.2 },
};

export function getRelationStrength(relation: string): { strength: string; weight: number } {
  return DEFAULT_WEIGHTS[relation] ?? { strength: "medium", weight: 0.5 };
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

