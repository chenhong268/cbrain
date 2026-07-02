import type { PageManager } from "../page.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import { getFactFieldWhitelist, type EntityType, type StructuredFact } from "./ner.js";

export interface FactConflict {
  slug: string;
  field: string;
  current: string;
  proposed: string;
  /** true for volatile-relation fields (e.g. reports_to) — surfaced, not silently skipped. */
  volatile?: boolean;
}

export interface FactWriteResult {
  written: number;
  skipped: number;
  conflicts: FactConflict[];
}

export function validateFacts(
  facts: StructuredFact[],
  validEntityNames: Set<string>,
  entityTypeMap: Map<string, EntityType>
): StructuredFact[] {
  const best = new Map<string, StructuredFact>();

  for (const f of facts) {
    if (!f.entity || !f.field || !f.value || !f.evidence) continue;
    if (!validEntityNames.has(f.entity)) continue;

    const entityType = entityTypeMap.get(f.entity);
    if (!entityType) continue;

    const allowedFields = getFactFieldWhitelist()[entityType];
    if (!allowedFields || !allowedFields.includes(f.field)) continue;

    const key = `${f.entity}|${f.field}`;
    const existing = best.get(key);
    if (!existing || f.confidence > existing.confidence) {
      best.set(key, f);
    }
  }

  return [...best.values()];
}

export function applyFacts(
  facts: StructuredFact[],
  resolvedSlugMap: Map<string, string>,
  pages: PageManager,
  _db: CBrainDB
): FactWriteResult {
  let written = 0;
  let skipped = 0;
  const conflicts: FactWriteResult["conflicts"] = [];

  for (const fact of facts) {
    const slug = resolvedSlugMap.get(fact.entity);
    if (!slug) {
      skipped++;
      continue;
    }

    const page = pages.getBySlug(slug);
    if (!page) {
      skipped++;
      continue;
    }

    // Only fill empty fields — never overwrite. For volatile relation fields
    // (reports_to), surface the conflict explicitly rather than treating it as
    // a generic field skip (#233 Phase 1).
    const current = page.frontmatter[fact.field];
    if (current !== undefined && current !== null && current !== "") {
      conflicts.push({
        slug,
        field: fact.field,
        current: String(current),
        proposed: fact.value,
        ...(fact.field === "reports_to" ? { volatile: true } : {}),
      });
      continue;
    }

    pages.update(slug, { extra: { [fact.field]: fact.value } });
    written++;
  }

  return { written, skipped, conflicts };
}
