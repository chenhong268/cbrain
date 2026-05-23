#!/usr/bin/env bun
/**
 * Ontology Data Migration Script
 *
 * Migrates vault files from flat types (entity, concept) to
 * ontology path types (entity/person, concept/framework, etc.)
 * using LLM-based classification via DeepSeek.
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
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { readFileSync } from "node:fs";
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

function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function gray(s: string) { return `${GRAY}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }

// ─── Progress bar ────────────────────────────────────────

function progressBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = (pct * 100).toFixed(1).padStart(5);
  return `${bar} ${pctStr}% (${current}/${total})`;
}

// ─── Config ──────────────────────────────────────────────

interface NerConfig {
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
}

function loadConfig(configPath: string): { ner: NerConfig } {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

// ─── Types ───────────────────────────────────────────────

interface MigrationStats {
  entities: number;
  concepts: number;
  insights: number;
  records: number;
  skipped: number;
  errors: number;
  moved: number;
  llmApiCalls: number;
}

interface FileToMigrate {
  filePath: string;
  flatType: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
}

// ─── LLM Classification ─────────────────────────────────

const CLASSIFY_PROMPT = `You are an entity type classifier. Given a list of entity names, classify each into exactly one type.

## Types
- person: 具名的人（包括中文全名、英文名）
- company: 具名的企业（如 红杉资本, 腾讯, 苹果）
- organization: 非企业的组织（如 高校, 政府, 协会, 国家医疗保障局）
- location: 地理位置（如 北京, 硅谷, 上海, 香港）
- place: 餐厅/场所 — 具名的好去处（如 某某餐厅, 某某咖啡馆）
- product: 具名产品（如 iPhone, 微信, ChatGPT）
- drug: 具名药物（如 阿司匹林, Keytruda, 瑞弗兰）
- book: 具名书籍
- disease: 具名疾病（如 前列腺癌, 糖尿病, 阿尔茨海默病, 高血压）
- framework: 具名管理/商业/技术框架（如 OKR, SWOT, BCG矩阵）
- technology: 具名技术（如 Transformer, Kubernetes）
- theory: 具名理论/效应/定律（如 达克效应, 幸存者偏差）
- concept: 不在上述分类中的抽象概念

## Rules
- Return ONLY valid JSON, no markdown wrapping
- Each entity must get exactly one type
- Companies include investment firms (红杉资本), tech giants (苹果, 微软), pharma companies (诺华)
- Drugs include any named medication (Keytruda, 瑞弗兰, 库莫西利)
- Products include software products (ChatGPT, 微信, iPhone)
- Diseases include any named medical condition (前列腺癌, 糖尿病, 白血病)

## Output format
{"classifications": [{"name": "...", "type": "person|company|organization|location|place|product|drug|book|disease|framework|technology|theory|concept"}]}`;

async function classifyBatch(
  names: string[],
  config: NerConfig,
): Promise<Record<string, string>> {
  const res = await fetch(`${config.llm_base_url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm_api_key}`,
    },
    body: JSON.stringify({
      model: config.llm_model,
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: `Classify these entities:\n${names.join("\n")}` },
      ],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const raw = data.choices[0].message.content;
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  const parsed = JSON.parse(cleaned);

  const map: Record<string, string> = {};
  for (const c of parsed.classifications) {
    map[c.name] = c.type;
  }
  return map;
}

// ─── Concept subtype (rule-based — no LLM needed) ───────

function inferConceptSubtype(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const tags = ((frontmatter.tags as string[]) ?? []).map((t: string) =>
    t.toLowerCase(),
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

async function migrateVault(
  vaultPath: string,
  dryRun: boolean,
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    entities: 0,
    concepts: 0,
    insights: 0,
    records: 0,
    skipped: 0,
    errors: 0,
    moved: 0,
    llmApiCalls: 0,
  };

  // Load config
  const configPath = join(process.cwd(), "cbrain.json");
  if (!existsSync(configPath)) {
    console.error(red("Error: cbrain.json not found in current directory"));
    process.exit(1);
  }
  const config = loadConfig(configPath);

  console.log(
    bold(`\nCBrain Ontology Migration ${dryRun ? yellow("[DRY RUN]") : ""}\n`),
  );
  console.log(gray(`Vault:    ${vaultPath}`));
  console.log(gray(`LLM:      ${config.ner.llm_model} @ ${config.ner.llm_base_url}`));
  console.log(gray(`Batch:    20 entities per API call\n`));

  // Phase 1: Scan and collect files needing migration
  const mdFiles = walkDir(vaultPath);
  console.log(gray(`Scanned ${mdFiles.length} markdown files\n`));

  const toMigrate: FileToMigrate[] = [];

  for (const filePath of mdFiles) {
    try {
      const parsed = readPageFile(filePath);
      const frontmatter = parsed.frontmatter as Record<string, unknown>;
      const body = parsed.body;
      const currentType = frontmatter.type as string | undefined;

      if (!currentType) continue;
      if (currentType.includes("/")) { stats.skipped++; continue; }
      if (!["entity", "concept", "insight", "record"].includes(currentType)) {
        stats.skipped++;
        continue;
      }

      toMigrate.push({
        filePath,
        flatType: currentType,
        frontmatter,
        body,
        title: String(frontmatter.title ?? ""),
      });
    } catch {
      // skip invalid files
    }
  }

  const entities = toMigrate.filter((f) => f.flatType === "entity");
  const nonEntities = toMigrate.filter((f) => f.flatType !== "entity");

  console.log(
    `  ${bold("To migrate:")} ${entities.length} entities, ${nonEntities.filter(f => f.flatType === "concept").length} concepts, ${nonEntities.filter(f => f.flatType === "insight").length} insights, ${nonEntities.filter(f => f.flatType === "record").length} records\n`,
  );

  // Phase 2: LLM classify entities in batches
  const BATCH_SIZE = 20;
  const entityTypes = new Map<string, string>(); // title → newType

  if (entities.length > 0) {
    console.log(bold("Phase 1: LLM Classification"));
    console.log(gray("─".repeat(50)));

    const totalBatches = Math.ceil(entities.length / BATCH_SIZE);

    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
      const batch = entities.slice(i, i + BATCH_SIZE);
      const batchNames = batch.map((e) => e.title);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;

      try {
        const classifications = await classifyBatch(batchNames, config.ner);
        stats.llmApiCalls++;

        for (const entity of batch) {
          const llmType = classifications[entity.title];
          if (llmType) {
            entityTypes.set(entity.title, `entity/${llmType}`);
          } else {
            entityTypes.set(entity.title, "record");
          }
        }

        process.stdout.write(
          `\r  ${progressBar(Math.min(i + BATCH_SIZE, entities.length), entities.length)} [batch ${batchNum}/${totalBatches}]`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(red(`\n  [ERR] Batch ${batchNum} failed: ${msg}`));
        for (const entity of batch) {
          entityTypes.set(entity.title, "record");
        }
        stats.errors++;
      }
    }

    console.log(`\n  ${green("✓")} Classified ${entityTypes.size} entities in ${stats.llmApiCalls} API calls\n`);
  }

  // Phase 3: Apply migrations — all types
  console.log(bold("Phase 2: File Migration"));
  console.log(gray("─".repeat(50)));

  const allToMigrate = [...entities, ...nonEntities];
  let processed = 0;

  for (const file of allToMigrate) {
    processed++;
    try {
      let newType: string;

      if (file.flatType === "entity") {
        newType = entityTypes.get(file.title) ?? "record";
      } else if (file.flatType === "concept") {
        newType = inferConceptSubtype(file.frontmatter, file.body);
      } else if (file.flatType === "insight") {
        newType = "insight";
      } else if (file.flatType === "record") {
        newType = "record";
      } else {
        stats.skipped++;
        continue;
      }

      const newSlug = generateSlug(file.title, newType);
      const newRelativePath = slugToFilePath(newSlug);
      const newFullPath = join(vaultPath, newRelativePath);

      const updatedFrontmatter = {
        ...file.frontmatter,
        type: newType,
        slug: newSlug,
      };

      const oldRelative = relative(vaultPath, file.filePath);
      const newRelative = relative(vaultPath, newFullPath);
      const needsMove = file.filePath !== newFullPath;

      if (dryRun) {
        // Show every line in dry-run for review
        console.log(
          yellow("  [DRY]") +
            ` ${file.title.padEnd(12)} ${gray(file.flatType + " →")} ${newType}`,
        );
      } else {
        const targetDir = dirname(newFullPath);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }

        writePageFile(newFullPath, updatedFrontmatter as any, file.body);

        if (needsMove && existsSync(file.filePath)) {
          unlinkSync(file.filePath);
        }
      }

      switch (file.flatType) {
        case "entity": stats.entities++; break;
        case "concept": stats.concepts++; break;
        case "insight": stats.insights++; break;
        case "record": stats.records++; break;
      }
      if (needsMove) stats.moved++;

      // Progress for non-dry-run
      if (!dryRun) {
        process.stdout.write(`\r  ${progressBar(processed, allToMigrate.length)} ${file.title}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(red(`\n  [ERR] ${file.filePath}: ${msg}`));
      stats.errors++;
    }
  }

  if (!dryRun) {
    console.log(`\n  ${green("✓")} File migration complete\n`);
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
Uses DeepSeek LLM for entity type classification.

${bold("Usage:")}
  bun run src/cli/migrate-ontology.ts <vault-path> [--dry-run]

${bold("Options:")}
  --dry-run    Preview changes without writing files
  --help, -h   Show this help message

${bold("Classification:")}
  Entity types: LLM-based (DeepSeek v4-flash)
  Concept types: rule-based (tags + keywords)
  Insight/Record: type unchanged, slug normalized
`);
  process.exit(0);
}

const dryRun = args.includes("--dry-run");
const vaultPath = args.find((a) => !a.startsWith("--"));

if (!vaultPath) {
  console.error(
    red("Error: vault path required.\n") +
      gray("Usage: bun run src/cli/migrate-ontology.ts <vault-path> [--dry-run]"),
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

const stats = await migrateVault(resolvedVault, dryRun);

// ─── Summary ─────────────────────────────────────────────
console.log("");
console.log(bold("─".repeat(50)));
console.log(bold("Summary"));
console.log(bold("─".repeat(50)));
console.log(`  Entities:       ${green(String(stats.entities))}`);
console.log(`  Concepts:       ${cyan(String(stats.concepts))}`);
console.log(`  Insights:       ${gray(String(stats.insights))}`);
console.log(`  Records:        ${gray(String(stats.records))}`);
console.log(`  Files moved:    ${String(stats.moved)}`);
console.log(`  LLM API calls:  ${String(stats.llmApiCalls)}`);
console.log(`  Skipped:        ${gray(String(stats.skipped))}`);
if (stats.errors > 0) {
  console.log(`  Errors:         ${red(String(stats.errors))}`);
}

if (dryRun) {
  console.log(yellow("\n  (dry-run — no files were modified)\n"));
}

if (stats.errors > 0) {
  process.exit(1);
}
