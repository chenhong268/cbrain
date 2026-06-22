import type { LLMProvider } from "../llm/provider.js";
import type { CBrainDB } from "../storage/sqlite.js";
import type { EntityType, StructuredFact } from "./ner.js";
import { getFactFieldWhitelist } from "./ner.js";
import { readPageFile, writePageFile } from "../utils/frontmatter.js";
import { join } from "node:path";

const BACKFILL_PROMPT = `You are a structured fact extractor. Given an entity's page content, extract concrete, verifiable facts as key-value pairs.

## Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name

## Rules:
- Every fact MUST have an evidence field (verbatim quote from source)
- Do NOT infer or fabricate — only extract explicitly stated facts
- Skip fields not in the whitelist
- confidence: 0.0-1.0

## Output (JSON only):
{"facts": [{"entity": "entity name", "field": "field name", "value": "value", "confidence": 0.9, "evidence": "verbatim quote"}]}

Return ONLY valid JSON.`;

export interface BackfillOptions {
  dryRun?: boolean;
  slug?: string;
  limit?: number;
  apply?: boolean;
  onlyFields?: string[];
  onlySlugs?: string[];
}

export interface BackfillReport {
  scanned: number;
  wouldApply: number;
  conflicts: number;
  skipped: number;
  examples: Array<{
    slug: string;
    field: string;
    current: string | null;
    proposed: string;
    evidence: string;
  }>;
}

export async function structuredFactsBackfill(
  db: CBrainDB,
  vaultPath: string,
  llm: LLMProvider,
  options: BackfillOptions = {}
): Promise<BackfillReport> {
  const dryRun = options.apply !== true;
  const limit = options.limit ?? 50;

  // Get target entities
  const targets = getBackfillTargets(db, options);

  const report: BackfillReport = {
    scanned: 0,
    wouldApply: 0,
    conflicts: 0,
    skipped: 0,
    examples: [],
  };

  for (const target of targets.slice(0, limit)) {
    report.scanned++;

    const filePath = join(vaultPath, target.file_path);
    let content: string;
    try {
      const parsed = readPageFile(filePath);
      content = parsed.body;
    } catch {
      report.skipped++;
      continue;
    }

    if (!content.trim()) {
      report.skipped++;
      continue;
    }

    // Call LLM to extract facts
    const raw = await llm.chat([
      { role: "system", content: BACKFILL_PROMPT },
      { role: "user", content: `Entity: ${target.title}\nType: ${target.type}\n\nContent:\n${content.slice(0, 3000)}` },
    ]);

    let facts: StructuredFact[];
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .filter((f: Record<string, unknown>) => f.field && f.value && f.evidence)
        .map((f: Record<string, unknown>) => ({
          entity: target.title,
          field: String(f.field),
          value: String(f.value),
          confidence: typeof f.confidence === "number" ? f.confidence : 0.5,
          evidence: String(f.evidence),
        }));
    } catch {
      report.skipped++;
      continue;
    }

    // Filter by whitelist
    const shortType = target.type.includes("/") ? target.type.split("/").pop()! : target.type;
    const entityType = shortType as EntityType;
    const allowedFields = getFactFieldWhitelist()[entityType] ?? [];
    const filtered = facts.filter(f => {
      if (options.onlyFields && !options.onlyFields.includes(f.field)) return false;
      return allowedFields.includes(f.field);
    });

    if (filtered.length === 0) {
      report.skipped++;
      continue;
    }

    // Read current frontmatter
    const { frontmatter, body } = readPageFile(filePath);

    for (const fact of filtered) {
      const current = frontmatter[fact.field];
      const hasValue = current !== undefined && current !== null && current !== "";

      if (hasValue) {
        report.conflicts++;
        if (report.examples.length < 20) {
          report.examples.push({
            slug: target.slug,
            field: fact.field,
            current: String(current),
            proposed: fact.value,
            evidence: fact.evidence,
          });
        }
        continue;
      }

      report.wouldApply++;
      if (report.examples.length < 20) {
        report.examples.push({
          slug: target.slug,
          field: fact.field,
          current: null,
          proposed: fact.value,
          evidence: fact.evidence,
        });
      }

      if (!dryRun) {
        frontmatter[fact.field] = fact.value;
        frontmatter.updated_at = new Date().toISOString();
      }
    }

    // Write back if not dry-run and changes were made
    if (!dryRun) {
      writePageFile(filePath, frontmatter, body);
    }
  }

  return report;
}

function getBackfillTargets(
  db: CBrainDB,
  options: BackfillOptions
): Array<{ slug: string; title: string; type: string; file_path: string; mention_count: number }> {
  if (options.onlySlugs && options.onlySlugs.length > 0) {
    return options.onlySlugs
      .map(slug => db.getPage(slug))
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }

  if (options.slug) {
    const page = db.getPage(options.slug);
    return page ? [page] : [];
  }

  // Top entities by mention_count, entity prefix only
  const pages = db.listPages({ typePrefix: "entity/", orderBy: "mention_count DESC" });
  return pages.filter(p => {
    // listPages doesn't have tag info, so we check by reading frontmatter is unnecessary
    // duplicate-candidate entities have lower tier; skip those with tier >= 5
    return p.tier < 5;
  });
}
