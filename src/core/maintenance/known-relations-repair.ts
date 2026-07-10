import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import { hasKnownRelationsDrift, type KnownRelationsLink } from "../graph/known-relations-projector.js";
import type { PageManager } from "../page.js";

export const KNOWN_RELATIONS_REPAIR_MAX_LIMIT = 100;

export interface KnownRelationsRepairResult {
  dryRun: boolean;
  scanned: number;
  candidates: number;
  selected: number;
  repaired: number;
  skipped: number;
  failed: number;
  remaining: number;
}

interface PageLinkSet {
  outgoing: KnownRelationsLink[];
  incoming: KnownRelationsLink[];
}

function linksByPage(links: KnownRelationsLink[]): Map<string, PageLinkSet> {
  const map = new Map<string, PageLinkSet>();
  const get = (slug: string) => {
    const existing = map.get(slug);
    if (existing) return existing;
    const created = { outgoing: [], incoming: [] };
    map.set(slug, created);
    return created;
  };
  for (const link of links) {
    get(link.from_slug).outgoing.push(link);
    get(link.to_slug).incoming.push(link);
  }
  return map;
}

function safeFilePath(vaultPath: string, filePath: string): string | null {
  const absolute = resolve(vaultPath, filePath);
  const rel = relative(vaultPath, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return absolute;
}

export function repairKnownRelations(input: {
  db: CBrainDB;
  pages: PageManager;
  vaultPath: string;
  execute: boolean;
  limit: number;
  syncSlug?: (slug: string) => void;
}): KnownRelationsRepairResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > KNOWN_RELATIONS_REPAIR_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${KNOWN_RELATIONS_REPAIR_MAX_LIMIT}`);
  }

  const rows = input.db.listPages({ limit: Math.max(input.db.getPageCount(), 1), offset: 0 })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const linkMap = linksByPage(input.db.getAllLinks());

  const driftState = (slug: string, filePath: string, freshLinks = false): boolean | null => {
    const absolute = safeFilePath(input.vaultPath, filePath);
    if (!absolute || !existsSync(absolute)) return null;
    const body = readFileSync(absolute, "utf8");
    const links = freshLinks
      ? { outgoing: input.db.getOutgoingLinks(slug), incoming: input.db.getIncomingLinks(slug) }
      : linkMap.get(slug) ?? { outgoing: [], incoming: [] };
    return hasKnownRelationsDrift(body, links.outgoing, links.incoming);
  };

  const candidates = rows.filter((row) => row.file_path && driftState(row.slug, row.file_path) === true);
  const selected = candidates.slice(0, input.limit);
  const result: KnownRelationsRepairResult = {
    dryRun: !input.execute,
    scanned: rows.length,
    candidates: candidates.length,
    selected: selected.length,
    repaired: 0,
    skipped: 0,
    failed: 0,
    remaining: Math.max(0, candidates.length - selected.length),
  };
  if (!input.execute) return result;

  const syncSlug = input.syncSlug ?? ((slug: string) => input.pages.syncLinksToMarkdown(slug));
  for (const row of selected) {
    try {
      const before = driftState(row.slug, row.file_path, true);
      if (before === false) {
        result.skipped++;
        continue;
      }
      if (before === null) {
        result.failed++;
        continue;
      }
      syncSlug(row.slug);
      if (driftState(row.slug, row.file_path, true) === false) result.repaired++;
      else result.failed++;
    } catch {
      result.failed++;
    }
  }
  result.remaining = Math.max(0, result.candidates - result.repaired - result.skipped);
  return result;
}
