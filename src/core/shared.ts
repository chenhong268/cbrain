import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";
import { getOntology } from "../ontology/loader.js";

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

export async function collectMarkdownFiles(dir: string, excludeDirs?: Set<string>): Promise<string[]> {
  const results: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EACCES") {
        console.error(`[shared] readdir 失败: ${d}`, e);
      }
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (excludeDirs?.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else if (extname(e.name).toLowerCase() === ".md") { results.push(p); }
    }
  };
  await walk(dir);
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

export function mapEntityType(type: string): string {
  return getOntology().resolvePageType(type);
}

export type PageType = string;
export type PageLayer = "source" | "derived";

export function normalizePageType(type: string): PageType {
  const ontology = getOntology();
  if (ontology.getEntityType(type) && !ontology.isAbstract(type)) return type;
  return "record";
}

export function getLayer(type: string): PageLayer {
  if (type === "record") return "source";
  return "derived";
}

export function canMerge(typeA: string, typeB: string): boolean {
  return getLayer(typeA) === getLayer(typeB);
}

// ─── Vault Wiki-Link Rewriting ───────────────────────────────

function getVaultDirs(): string[] {
  const ontology = getOntology();
  const dirs = new Set<string>();
  for (const type of ontology.getConcreteEntityTypes()) {
    dirs.add(ontology.getVaultDir(type));
  }
  return [...dirs];
}

export interface VaultLinkOp {
  oldSlug: string;
  newSlug?: string;
}

/**
 * Rewrite wiki-links across vault files.
 * - newSlug present → replace `[[old]]` → `[[new]]`  (merge)
 * - newSlug absent  → strip `[[]]`, keep plain text   (delete)
 *
 * When `db` is provided, uses chunks_fts to find only candidate files.
 * Falls back to full vault scan when `db` is omitted.
 */
export function rewriteVaultLinks(vaultPath: string, operations: VaultLinkOp[], db?: CBrainDB): number {
  type Replacement = { from: string; to: string };
  const replacements: Replacement[] = [];
  const searchPatterns: string[] = [];

  for (const op of operations) {
    const oldShort = op.oldSlug.split("/").pop()!;
    searchPatterns.push(`[[${op.oldSlug}]]`, `[[${oldShort}]]`);
    if (op.newSlug) {
      const newShort = op.newSlug.split("/").pop()!;
      replacements.push({ from: `[[${op.oldSlug}]]`, to: `[[${newShort}]]` });
      if (oldShort !== op.oldSlug) {
        replacements.push({ from: `[[${oldShort}]]`, to: `[[${newShort}]]` });
      }
    } else {
      replacements.push({ from: `[[${op.oldSlug}]]`, to: oldShort });
      if (oldShort !== op.oldSlug) {
        replacements.push({ from: `[[${oldShort}]]`, to: oldShort });
      }
    }
  }

  let totalRewritten = 0;

  // Collect candidate file paths
  const candidateFiles = new Set<string>();

  if (db) {
    const slugs = db.findSlugsByText(searchPatterns);
    for (const slug of slugs) {
      const fp = db.getPageFilePath(slug);
      if (fp) candidateFiles.add(join(vaultPath, fp));
    }
  } else {
    for (const dir of getVaultDirs()) {
      const absDir = join(vaultPath, dir);
      if (!existsSync(absDir)) continue;
      for (const file of readdirSync(absDir)) {
        if (!file.endsWith(".md")) continue;
        candidateFiles.add(join(absDir, file));
      }
    }
  }

  for (const filePath of candidateFiles) {
    let content: string;
    try { content = readFileSync(filePath, "utf-8"); } catch { continue; }

    let updated = content;
    let changed = false;
    for (const { from, to } of replacements) {
      if (updated.includes(from)) {
        updated = updated.replaceAll(from, to);
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, updated, "utf-8");
      totalRewritten++;
    }
  }

  return totalRewritten;
}

// ─── Canonical relation types ──────────────────────────────

export function normalizeRelation(rel: string): string {
  return getOntology().resolveAlias(rel);
}

export function getCanonicalRelationTypes(): Set<string> {
  return new Set(Object.keys(getOntology().getAllRelationTypes()));
}

export function getReverseRelation(rel: string): string | undefined {
  return getOntology().getReverseRelation(rel);
}

export const HIERARCHY_RELATIONS = new Set(["reports_to"]);

export function isValidRelation(r: string): boolean {
  return getOntology().isValidRelation(r) || HIERARCHY_RELATIONS.has(r);
}

/** @deprecated Use getRelationStrength() which delegates to ontology */
const DEFAULT_WEIGHTS: Record<string, { strength: string; weight: number }> = {};

export function getRelationStrength(relation: string): { strength: string; weight: number } {
  return getOntology().getRelationStrength(relation);
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
  return db.getEntitySlugByTitle(name) ?? db.getSlugByAlias(name);
}

/** @deprecated Use EntityResolver.resolveAll() instead */
export function buildLowercaseIndex(entitySlugMap: Map<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [key, slug] of entitySlugMap) {
    idx.set(key.toLowerCase(), slug);
  }
  return idx;
}

/** @deprecated Use EntityResolver.resolveAll() instead */
export function resolveEntityName(
  name: string,
  entitySlugMap: Map<string, string>,
  db: CBrainDB,
  lowerIndex?: Map<string, string>
): string | null {
  // 1. Exact
  const exact = entitySlugMap.get(name);
  if (exact) return exact;

  // 2. Case-insensitive (O(1) with prebuilt index)
  const lower = name.toLowerCase();
  const ciResult = lowerIndex?.get(lower);
  if (ciResult) return ciResult;
  if (!lowerIndex) {
    for (const [key, slug] of entitySlugMap) {
      if (key.toLowerCase() === lower) return slug;
    }
  }

  // 3. Strip parenthetical suffix
  const stripped = name.replace(/[（(].+?[）)]$/, "").trim();
  if (stripped !== name) {
    const s = entitySlugMap.get(stripped);
    if (s) return s;
    const strippedLower = stripped.toLowerCase();
    const ciStripped = lowerIndex?.get(strippedLower);
    if (ciStripped) return ciStripped;
    if (!lowerIndex) {
      for (const [key, slug] of entitySlugMap) {
        if (key.toLowerCase() === strippedLower) return slug;
      }
    }
    for (const [key, slug] of entitySlugMap) {
      if (key.startsWith(stripped) || stripped.startsWith(key)) return slug;
    }
  }

  // 4. DB fallback
  return findEntitySlug(db, name) ?? findEntitySlug(db, stripped);
}

