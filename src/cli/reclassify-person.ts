#!/usr/bin/env bun
/**
 * Reclassify entities currently in person/ directory.
 * Many were misclassified by the first pass — this sends them
 * back to LLM with a stricter prompt that defaults to concept, NOT person.
 *
 * Usage:
 *   bun run src/cli/reclassify-person.ts <vault-path> [--dry-run]
 */

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

function progressBar(current: number, total: number, width = 30): string {
  const pct = total > 0 ? current / total : 0;
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pctStr = (pct * 100).toFixed(1).padStart(5);
  return `${bar} ${pctStr}% (${current}/${total})`;
}

interface NerConfig {
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
}

function loadConfig(configPath: string): { ner: NerConfig } {
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

const RECLASSIFY_PROMPT = `You are an entity type classifier. Given a list of entity names currently classified as "person", re-examine each one carefully.

## CRITICAL RULE
Many entities were WRONGLY classified as "person" in a previous pass. You must be very strict:
- If the name is NOT clearly a human name, it is almost certainly NOT a person.
- When in doubt, choose concept — do NOT default to person.

## Types
- person: 具名的人 — MUST be a real or fictional human with a personal name (e.g. 张三, Elon Musk, 柏拉图, 弗洛伊德). Keywords about a person (like "罗书记") count only if they refer to a specific individual.
- company: 具名的企业 — e.g. 红杉资本, 腾讯, 微软, 英伟达, Novartis, Merck, IBM, 所罗门兄弟公司
- organization: 非企业的组织 — e.g. 高校, 政府, 协会, 国家医保局, 南京市妇幼保健院
- location: 地理位置 — e.g. 北京, 上海, 密歇根州, 冈仁波齐
- place: 餐厅/场所 — e.g. 某某餐厅, 高勒米罗美食指南
- product: 具名产品 — e.g. iPhone, 微信, 俄罗斯方块, 普拉提防滑袜, GPT-4
- drug: 具名药物/药品 — e.g. 阿司匹林, Keytruda, Entresto, Cosentyx, 诺欣妥, 瑞普多, Leqvio, Pluvicto, 飞赫达盐酸伊普可泮胶囊
- book: 具名书籍 — e.g. 《原则》, Good to Great, 把思考作为习惯
- disease: 具名疾病 — e.g. 前列腺癌, 糖尿病, 多巴胺(用作概念时), 阿尔茨海默病
- framework: 具名管理/商业/技术框架 — e.g. OKR, SWOT, prep沟通模型
- technology: 具名技术 — e.g. Transformer, Kubernetes, 向量数据库, 流处理, 分词器, git, llm, ai-agent
- theory: 具名理论/效应/定律 — e.g. 达克效应, 幸存者偏差, 帕金森定律, 希格斯粒子, 正反合, 身份认同, 阿德勒个体心理学
- concept: 不在上述分类中的抽象概念 — e.g. 同情, 文明, 行动, 错误, 大脑, 多巴胺, 伦理拒绝, 行业生态, 时间线, 烈火, 火箭, 蜡烛, 柠檬汁, 不对称测试, 进化的论

## Classification hints
- Company name patterns: ends with 公司/集团/医药/控股/有限/易购, or known global brand (Microsoft, Amazon, Tesla, Intel, Nvidia)
- Drug patterns: contains 胶囊/片/注射液, or known drug names (Entresto, Cosentyx, Leqvio, Pluvicto)
- Names with "诺华" in them are usually companies (北京诺华制药有限公司) or people+company refs (李青诺华onco → person)
- Technology terms (git, llm, ai-agent, 向量数据库) are NOT people
- Common nouns (蜡烛, 蜡烛, 火箭) are NOT people
- Abstract concepts (身份认同, 正反合, 同情, 错误) are NOT people
- Geographic names (上海, 南京市, 密歇根州) are NOT people
- Short codes/IDs (00inbox, claude-code, coding-plan, gbrain, user, seal, skill) are NOT people

## Output format
Return ONLY valid JSON, no markdown wrapping:
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
        { role: "system", content: RECLASSIFY_PROMPT },
        { role: "user", content: `Re-classify these entities (many are WRONGLY labeled as person):\n${names.join("\n")}` },
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

// ─── CLI ─────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const vaultPath = args.find((a) => !a.startsWith("--"));

if (!vaultPath) {
  console.error(red("Usage: bun run src/cli/reclassify-person.ts <vault-path> [--dry-run]"));
  process.exit(1);
}

const resolvedVault = vaultPath.startsWith("/") ? vaultPath : join(process.cwd(), vaultPath);
if (!existsSync(resolvedVault)) {
  console.error(red(`Vault not found: ${resolvedVault}`));
  process.exit(1);
}

const configPath = join(process.cwd(), "cbrain.json");
if (!existsSync(configPath)) {
  console.error(red("cbrain.json not found"));
  process.exit(1);
}
const config = loadConfig(configPath);

console.log(bold(`\nPerson Re-classification ${dryRun ? yellow("[DRY RUN]") : ""}\n`));
console.log(gray(`Vault:   ${resolvedVault}`));
console.log(gray(`LLM:     ${config.ner.llm_model}\n`));

const personDir = join(resolvedVault, "brain/entities/person");
const files = readdirSync(personDir).filter((f) => f.endsWith(".md"));
console.log(`Found ${files.length} entities in person/\n`);

// Read all person files
const entities: Array<{
  fileName: string;
  filePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
}> = [];

for (const file of files) {
  const filePath = join(personDir, file);
  try {
    const parsed = readPageFile(filePath);
    const fm = parsed.frontmatter as Record<string, unknown>;
    entities.push({
      fileName: file,
      filePath,
      title: String(fm.title ?? file.replace(".md", "")),
      frontmatter: fm,
      body: parsed.body,
    });
  } catch {
    // skip
  }
}

// LLM classify in batches
const BATCH_SIZE = 30;
const types = new Map<string, string>();
let apiCalls = 0;
let errors = 0;

console.log(bold("Phase 1: LLM Re-classification"));
console.log(gray("─".repeat(50)));

for (let i = 0; i < entities.length; i += BATCH_SIZE) {
  const batch = entities.slice(i, i + BATCH_SIZE);
  const names = batch.map((e) => e.title);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(entities.length / BATCH_SIZE);

  try {
    const classifications = await classifyBatch(names, config.ner);
    apiCalls++;

    for (const entity of batch) {
      types.set(entity.title, classifications[entity.title] ?? "concept");
    }

    process.stdout.write(
      `\r  ${progressBar(Math.min(i + BATCH_SIZE, entities.length), entities.length)} [batch ${batchNum}/${totalBatches}]`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(red(`\n  [ERR] Batch ${batchNum}: ${msg}`));
    for (const entity of batch) {
      types.set(entity.title, "concept");
    }
    errors++;
  }
}

console.log(`\n  ${green("✓")} Classified ${types.size} entities in ${apiCalls} calls\n`);

// Phase 2: Show results grouped by type
console.log(bold("Phase 2: Results"));
console.log(gray("─".repeat(50)));

const byType = new Map<string, string[]>();
for (const entity of entities) {
  const t = types.get(entity.title) ?? "concept";
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t)!.push(entity.title);
}

for (const [t, names] of byType) {
  const isPerson = t === "person";
  const prefix = isPerson ? green("✓") : yellow("→");
  console.log(`\n  ${prefix} ${bold(t)} (${names.length}):`);
  for (const name of names) {
    const marker = isPerson ? gray("  ") : yellow("  ");
    console.log(`${marker} ${name}`);
  }
}

// Phase 3: Move files
const toMove = entities.filter((e) => {
  const t = types.get(e.title) ?? "concept";
  return t !== "person";
});

console.log(`\n${bold("Phase 3: File Migration")}`);
console.log(gray("─".repeat(50)));
console.log(`  ${toMove.length} entities to move out of person/\n`);

if (!dryRun) {
  let moved = 0;
  for (const entity of toMove) {
    const newType = types.get(entity.title) ?? "concept";
    const fullType = `entity/${newType}`;
    const newSlug = generateSlug(entity.title, fullType);
    const newRelativePath = slugToFilePath(newSlug);
    const newFullPath = join(resolvedVault, newRelativePath);

    const updatedFm = {
      ...entity.frontmatter,
      type: fullType,
      slug: newSlug,
    };

    const targetDir = dirname(newFullPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    writePageFile(newFullPath, updatedFm as any, entity.body);

    if (entity.filePath !== newFullPath && existsSync(entity.filePath)) {
      unlinkSync(entity.filePath);
    }

    moved++;
    process.stdout.write(`\r  ${progressBar(moved, toMove.length)} ${entity.title} → ${fullType}`);
  }

  console.log(`\n  ${green("✓")} Moved ${moved} entities\n`);
} else {
  for (const entity of toMove) {
    const newType = types.get(entity.title) ?? "concept";
    console.log(yellow("  [DRY]") + ` ${entity.title.padEnd(20)} → entity/${newType}`);
  }
  console.log(yellow("\n  (dry-run — no files were modified)\n"));
}

// Summary
console.log(bold("─".repeat(50)));
console.log(bold("Summary"));
console.log(bold("─".repeat(50)));
console.log(`  Stayed in person: ${green(String(entities.length - toMove.length))}`);
console.log(`  Moved out:        ${yellow(String(toMove.length))}`);
console.log(`  LLM API calls:    ${String(apiCalls)}`);
if (errors > 0) {
  console.log(`  Errors:           ${red(String(errors))}`);
}

if (dryRun) {
  console.log(yellow("\n  Run without --dry-run to apply changes.\n"));
}
