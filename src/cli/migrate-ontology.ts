#!/usr/bin/env bun
/**
 * Ontology Data Migration Script
 *
 * Migrates vault files from flat types (entity, concept) to
 * ontology path types (entity/person, concept/framework, etc).
 *
 * Usage:
 *   bun run src/cli/migrate-ontology.ts <vault-path> [--dry-run]
 *   bun run src/cli/migrate-ontology.ts --help
 */

import { getOntology } from "../ontology/loader.js";
import {
  readdirSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { readPageFile, writePageFile } from "../utils/frontmatter.js";
import { slugToFilePath, generateSlug } from "../utils/slug.js";

// ─── Colors ──────────────────────────────────────────────
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function green(msg: string): string {
  return `${GREEN}${msg}${RESET}`;
}
function yellow(msg: string): string {
  return `${YELLOW}${msg}${RESET}`;
}
function red(msg: string): string {
  return `${RED}${msg}${RESET}`;
}
function cyan(msg: string): string {
  return `${CYAN}${msg}${RESET}`;
}
function gray(msg: string): string {
  return `${GRAY}${msg}${RESET}`;
}
function bold(msg: string): string {
  return `${BOLD}${msg}${RESET}`;
}

// ─── Types ───────────────────────────────────────────────
type FlatType = "entity" | "concept" | "insight" | "record";

interface MigrationStats {
  entities: number;
  concepts: number;
  insights: number;
  records: number;
  skipped: number;
  errors: number;
  moved: number;
}

// ─── Subtype inference ───────────────────────────────────

function inferEntitySubtype(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const tags = (frontmatter.tags as string[]) ?? [];

  if (frontmatter.industry !== undefined) return "entity/company";
  if (frontmatter.generic_name !== undefined) return "entity/product";
  if (
    frontmatter.location !== undefined &&
    frontmatter.category !== undefined
  )
    return "entity/place";
  if (frontmatter.organization !== undefined) return "entity/person";

  if (tags.includes("auto-extracted")) return "entity/person";

  // Default
  return "entity/person";
}

function inferConceptSubtype(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const tags = ((frontmatter.tags as string[]) ?? []).map((t: string) =>
    t.toLowerCase()
  );
  const title = String(frontmatter.title ?? "").toLowerCase();
  const content = body.toLowerCase();

  if (tags.includes("technology") || tags.includes("技术")) {
    return "concept/technology";
  }

  const frameworkKeywords = ["框架", "模型", "方法论", "framework", "model"];
  if (frameworkKeywords.some((kw) => title.includes(kw) || content.includes(kw))) {
    return "concept/framework";
  }

  return "concept/concept";
}

function inferNewType(
  flatType: string,
  frontmatter: Record<string, unknown>,
  body: string
): string {
  switch (flatType) {
    case "entity":
      return inferEntitySubtype(frontmatter, body);
    case "concept":
      return inferConceptSubtype(frontmatter, body);
    case "insight":
      return "insight";
    case "record":
      return "record";
    default:
      return flatType;
  }
}

// ─── Vault scanning ──────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Main migration ──────────────────────────────────────

function migrateVault(vaultPath: string, dryRun: boolean): MigrationStats {
  const stats: MigrationStats = {
    entities: 0,
    concepts: 0,
    insights: 0,
    records: 0,
    skipped: 0,
    errors: 0,
    moved: 0,
  };

  const ontology = getOntology();

  console.log(
    bold(`\nCBrain Ontology Migration ${dryRun ? yellow("[DRY RUN]") : ""}\n`)
  );
  console.log(gray(`Scanning vault: ${vaultPath}\n`));

  const mdFiles = walkDir(vaultPath);
  console.log(gray(`Found ${mdFiles.length} markdown files\n`));

  for (const filePath of mdFiles) {
    try {
      let frontmatter: Record<string, unknown>;
      let body: string;

      try {
        const parsed = readPageFile(filePath);
        frontmatter = parsed.frontmatter as Record<string, unknown>;
        body = parsed.body;
      } catch {
        // Not a valid frontmatter file, skip
        continue;
      }

      const currentType = frontmatter.type as string | undefined;

      if (!currentType) {
        continue;
      }

      // Already a path type (contains /) — skip
      if (currentType.includes("/")) {
        stats.skipped++;
        continue;
      }

      // Only migrate known flat types
      if (!["entity", "concept", "insight", "record"].includes(currentType)) {
        stats.skipped++;
        continue;
      }

      const newType = inferNewType(currentType, frontmatter, body);

      // Compute new slug and path
      const title = String(frontmatter.title ?? "");
      const newSlug = generateSlug(title, newType);
      const newRelativePath = slugToFilePath(newSlug);
      const newFullPath = join(vaultPath, newRelativePath);

      // Skip if type unchanged and slug already matches
      if (newType === currentType && frontmatter.slug === newSlug) {
        stats.skipped++;
        continue;
      }

      // Update frontmatter
      const updatedFrontmatter = {
        ...frontmatter,
        type: newType,
        slug: newSlug,
      };

      const oldRelative = relative(vaultPath, filePath);
      const newRelative = relative(vaultPath, newFullPath);
      const needsMove = filePath !== newFullPath;

      if (dryRun) {
        console.log(
          yellow("  [DRY]") +
            ` ${oldRelative}` +
            gray(" → ") +
            `${newRelative}` +
            gray(` (${currentType} → ${newType})`)
        );
      } else {
        // Create target directory
        const targetDir = dirname(newFullPath);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }

        // Write to new location
        writePageFile(newFullPath, updatedFrontmatter as any, body);

        // Remove old file if path changed
        if (needsMove && existsSync(filePath)) {
          unlinkSync(filePath);
        }

        console.log(
          green("  [OK]") +
            ` ${oldRelative}` +
            gray(" → ") +
            `${newRelative}` +
            gray(` (${currentType} → ${newType})`)
        );
      }

      // Update stats
      switch (currentType) {
        case "entity":
          stats.entities++;
          break;
        case "concept":
          stats.concepts++;
          break;
        case "insight":
          stats.insights++;
          break;
        case "record":
          stats.records++;
          break;
      }

      if (needsMove) {
        stats.moved++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(red(`  [ERR] ${filePath}: ${message}`));
      stats.errors++;
    }
  }

  return stats;
}

// ─── CLI entry point ─────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${bold("CBrain Ontology Migration")}

Migrates vault files from flat types (entity, concept)
to ontology path types (entity/person, concept/framework, etc).

${bold("Usage:")}
  bun run src/cli/migrate-ontology.ts <vault-path> [--dry-run]

${bold("Options:")}
  --dry-run    Preview changes without writing files
  --help, -h   Show this help message

${bold("Subtype Inference Rules:")}

  entity:
    - has 'industry' field       → entity/company
    - has 'generic_name' field   → entity/product
    - has 'location' + 'category' → entity/place
    - has 'organization' field   → entity/person
    - tag includes 'auto-extracted' → entity/person
    - default                    → entity/person

  concept:
    - tag 'technology' or '技术' → concept/technology
    - title/body has 框架/模型/方法论 → concept/framework
    - default                    → concept/concept

  insight → insight (unchanged, just normalized)
  record  → record  (unchanged)
`);
  process.exit(0);
}

const dryRun = args.includes("--dry-run");
const vaultPath = args.find((a) => !a.startsWith("--"));

if (!vaultPath) {
  console.error(
    red("Error: vault path required.\n") +
      gray("Usage: bun run src/cli/migrate-ontology.ts <vault-path> [--dry-run]")
  );
  process.exit(1);
}

if (!existsSync(vaultPath)) {
  console.error(red(`Error: vault path does not exist: ${vaultPath}`));
  process.exit(1);
}

const resolvedVault = vaultPath.startsWith("/")
  ? vaultPath
  : join(process.cwd(), vaultPath);

const stats = migrateVault(resolvedVault, dryRun);

// ─── Summary ─────────────────────────────────────────────
console.log("");
console.log(bold("─".repeat(50)));
console.log(bold("Summary"));
console.log(bold("─".repeat(50)));
console.log(
  `  Entities migrated:  ${green(String(stats.entities))}`
);
console.log(
  `  Concepts migrated:  ${green(String(stats.concepts))}`
);
console.log(
  `  Insights migrated:  ${cyan(String(stats.insights))}`
);
console.log(
  `  Records migrated:   ${gray(String(stats.records))}`
);
console.log(
  `  Files moved:        ${String(stats.moved)}`
);
console.log(
  `  Skipped (already ok): ${gray(String(stats.skipped))}`
);
if (stats.errors > 0) {
  console.log(`  Errors:             ${red(String(stats.errors))}`);
}

const totalMigrated = stats.entities + stats.concepts + stats.insights + stats.records;
console.log(
  `\n  ${bold(`Migrated ${totalMigrated} entities, ${stats.concepts} concepts, ${stats.insights} insights.`)} ${gray(`Skipped ${stats.skipped} (already path-typed).`)}`
);

if (dryRun) {
  console.log(yellow("\n  (dry-run — no files were modified)\n"));
}

if (stats.errors > 0) {
  process.exit(1);
}

process.exit(0);
