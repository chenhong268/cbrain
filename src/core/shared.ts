import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, extname, resolve, sep, dirname, basename } from "node:path";
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

/**
 * Normalize body for deterministic ingest fingerprinting.
 * CRLF → LF, standalone CR → LF, trim surrounding whitespace only.
 * Does NOT touch internal whitespace, punctuation, or Markdown structure.
 */
export function normalizeAndHashBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return hashContent(normalized);
}

// ─── File Collection ─────────────────────────────────────────

export async function collectMarkdownFiles(dir: string, excludeDirs?: Set<string>, logger?: import("./logger.js").Logger, requireComplete = false): Promise<string[]> {
  const results: string[] = [];
  const walk = async (d: string) => {
    // biome-ignore lint/suspicious/noImplicitAnyLet: readdir return type varies by runtime
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch (e) {
      if (requireComplete) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "EACCES") {
        logger?.error("shared", `readdir 失败: ${d}`, { error: e instanceof Error ? e.message : String(e) });
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
  return getOntology().resolvePageType(type) ?? "record";
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

/** #510: reserved vault area of generated topic pages. A file here is a
 *  generated surface EVEN when its frontmatter/DB type still says `record`
 *  (an explicitly retyped or legacy stray): it must never feed NER or the
 *  wikilink graph, and never counts as original record material. */
export function isTopicManagedPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const dir = getOntology().getVaultDir("topic");
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

/** #511: a page row on a generated topic surface — DB type `topic` OR a
 *  file inside the reserved managed path (a stray/legacy record-typed row
 *  there is still a generated surface, so a missing/old row type can never
 *  become a read or evidence bypass). Shared by search, direct page reads,
 *  evidence guards, the NER execution gate and the CLI. */
export function isTopicRow(row: { type: string; file_path: string | null | undefined } | null | undefined): boolean {
  if (!row) return false;
  return row.type === "topic" || isTopicManagedPath(row.file_path);
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

/** Human-written originals directory (docs/vault-spec.md: raw/ 只读不写). */
const RAW_VAULT_DIR = "raw";

function isWithinDir(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * True when the file lexically OR physically lives in the vault's raw/ directory
 * (#447). Judged at the actual file-write boundary from normalized paths and
 * realpath — slug prefixes, `..` aliases, and symlinks cannot smuggle a raw
 * original past it. Raw is read-only: link rewrites and their rollback skip it.
 */
export function isRawVaultFile(vaultPath: string, filePath: string): boolean {
  const rawRoot = resolve(vaultPath, RAW_VAULT_DIR);
  if (isWithinDir(resolve(filePath), rawRoot)) return true;
  // A new destination may not exist yet: resolve its nearest existing parent,
  // so creating/moving through a directory symlink cannot write into raw either.
  let existing = resolve(filePath);
  const suffix: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    try {
      if (lstatSync(existing).isSymbolicLink()) throw new Error("VAULT_WRITE_PATH_UNRESOLVED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  const physicalRaw = existsSync(rawRoot) ? realpathSync(rawRoot) : rawRoot;
  return isWithinDir(resolve(realpathSync(existing), ...suffix), physicalRaw);
}

/** Reject a requested write before its file, metadata, or version side effects. */
export function assertWritableVaultFile(vaultPath: string, filePath: string): void {
  if (isRawVaultFile(vaultPath, filePath)) throw new Error("RAW_PAGE_READ_ONLY");
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
    if (isRawVaultFile(vaultPath, filePath)) continue; // #447: raw originals are read-only

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

/**
 * Candidate reports_to is evidence, not a current organizational fact.
 * Default user/LLM-facing relation reads should exclude it, while ordinary
 * non-reports_to candidate links remain visible as pending graph evidence.
 */
export function isCurrentFactLink(l: { relation?: string | null; trust_state?: string | null }): boolean {
  if (l.relation !== "reports_to") return true;
  return l.trust_state === undefined ||
    l.trust_state === null ||
    l.trust_state === "trusted" ||
    l.trust_state === "user_thought";
}

export function filterCurrentFactLinks<T extends { relation?: string | null; trust_state?: string | null }>(links: T[]): T[] {
  return links.filter(isCurrentFactLink);
}

export function isValidRelation(r: string): boolean {
  return getOntology().isValidRelation(r) || HIERARCHY_RELATIONS.has(r);
}

export function getRelationStrength(relation: string): { strength: string; weight: number } {
  return getOntology().getRelationStrength(relation);
}

export const RELATION_DOMAIN_VIOLATION = "relation endpoints do not satisfy ontology domain/range";

/**
 * Preflight for canonical semantic relation writes: the endpoints must satisfy
 * the ontology-declared domain/range using each page's actual stored type —
 * never a caller-supplied type hint. Unconstrained relations (e.g. 提及) pass
 * without type lookups so mentions keep linking arbitrary (record) pages.
 * Callers normalize first, so a relation with no ontology definition fails
 * closed instead of bypassing the constraint.
 */
export function relationEndpointsAllowed(
  db: CBrainDB,
  fromSlug: string,
  toSlug: string,
  relation: string,
): boolean {
  const def = getOntology().getRelationType(relation);
  if (!def) return false;
  if (def.domain.length === 0 && def.range.length === 0) return true;
  const fromType = db.getPage(fromSlug)?.type;
  const toType = db.getPage(toSlug)?.type;
  if (!fromType || !toType) return false;
  return getOntology().validateRelationDomain(relation, fromType, toType);
}

export const RELATION_LABEL_CONFLICT = "relation label conflicts with an existing canonical edge";

export interface SemanticLinkInsert {
  context?: string | null;
  weight?: number;
  strength?: string;
  sourceType?: string;
  confidence?: number;
  provenance?: { source_page_slug?: string; evidence?: string };
}

/** Any existing row for the triple — including inactive/rejected/superseded
 *  tombstones — or for the ontology-declared reverse triple. */
function semanticEdgeTaken(db: CBrainDB, from: string, to: string, canonical: string): boolean {
  const forward = db.rawDb
    .prepare("SELECT 1 FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ? LIMIT 1")
    .get(from, to, canonical);
  if (forward) return true;
  const reverse = getOntology().getReverseRelation(canonical);
  if (!reverse) return false;
  return db.rawDb
    .prepare("SELECT 1 FROM links WHERE from_slug = ? AND to_slug = ? AND relation = ? LIMIT 1")
    .get(to, from, reverse) != null;
}

/**
 * Semantic link insertion that preserves the caller's original relation label
 * (#472). Normalizes the label; when it differs from the canonical name the
 * original label is prepended to the context as explicit, JSON-escaped input
 * metadata with the original context appended unchanged. Evidence, source,
 * and trust values pass through the caller's insert args untouched — no
 * inferred dates or truth claims.
 *
 * Alias writes fail closed (return false) when any forward or
 * ontology-reverse triple already exists, so a repeat alias never silently
 * overwrites context or reports success. Canonical-input writes keep the
 * low-level INSERT OR IGNORE semantics. The check and insert share one
 * transaction (nesting as a savepoint inside a caller transaction), so a
 * failed reverse write rolls the forward edge back. Storage errors throw.
 * Callers keep the #471 endpoint preflight before calling this helper.
 */
export function insertSemanticLink(
  db: CBrainDB,
  from: string,
  to: string,
  rawRelation: string,
  insert: SemanticLinkInsert,
): boolean {
  const canonical = normalizeRelation(rawRelation);
  const isAlias = rawRelation !== canonical;
  const context = isAlias
    ? `[input_label:${JSON.stringify(rawRelation)}]${insert.context ?? ""}`
    : insert.context;
  return db.runInTransaction(() => {
    if (isAlias && semanticEdgeTaken(db, from, to, canonical)) return false;
    db.insertLink(from, to, canonical, context, insert.weight, insert.strength, insert.sourceType, insert.confidence, undefined, insert.provenance);
    return true;
  });
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
