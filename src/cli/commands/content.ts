import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { loadConfig, createDeps } from "../context.js";
import { resolveUserSlug } from "./slug-resolver.js";

export function register(program: Command) {
  program
    .command("ingest")
    .description("Ingest content (text or markdown)")
    .option("-t, --type <type>", "Content type: text or markdown (omit to auto-classify @file content)")
    .option("--title <title>", "Title (for text type)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--page-type <type>", "Page type: entity|concept|record")
    .option("--no-ner", "Skip NER entity extraction")
    .option("--allow-duplicate", "Allow duplicate content (normally deduped)")
    .argument("<content>", "Content to ingest (use @file to read from file)")
    .action(async (content, opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { IngestManager } = await import("../../core/ingest.js");
      const ingest = new IngestManager(deps.db, deps.embedding, deps.lance, config.vaultPath, deps.llm);
      let input = content;
      if (input.startsWith("@")) {
        const rawPath = input.slice(1);
        if (rawPath.includes("..")) { console.error("Error: 路径不允许包含 .."); process.exit(1); }
        if (!existsSync(rawPath)) { console.error(`Error: File not found: ${rawPath}`); process.exit(1); }
        input = readFileSync(rawPath, "utf-8");
      }
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
      // (#198) Omitting --type lets IngestManager auto-classify the content (e.g.
      // @file markdown frontmatter → markdown); omitting --title lets it derive the
      // title from frontmatter/body instead of the source filename. Explicit
      // --type/--title always take precedence over file-derived values.
      const result = await ingest.ingest({ content: input, type: opts.type, title: opts.title, tags, pageType: opts.pageType, skipNer: opts.ner === false, allowDuplicate: opts.allowDuplicate ?? false });
      if (result.outcome === "duplicate") {
        console.log(`- Duplicate: already exists as "${result.duplicateOf?.title}"`);
      } else {
        console.log(result.created ? `✓ Created: ${result.slug}` : `✓ Updated: ${result.slug}`);
        console.log(`  Links:   ${result.linksExtracted} wiki links extracted`);
      }
      deps.db.close();
    });

  program
    .command("show")
    .description("Display a page's full content")
    .argument("<slug>", "Page slug to show")
    .action(async (slug) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath);
      const resolution = resolveUserSlug(slug, (s) => pages.getBySlug(s));
      if (!resolution) { console.error(`Page not found: ${slug}`); process.exit(1); }
      if (resolution.ambiguous) {
        console.warn(`⚠ Ambiguous slug "${slug}" — matched: ${resolution.ambiguous.join(", ")}. Using: ${resolution.slug}`);
      }
      const page = pages.getBySlug(resolution.slug)!;
      console.log(`slug:       ${page.slug}`);
      console.log(`type:       ${page.type}`);
      console.log(`title:      ${page.title}`);
      console.log(`tier:       ${page.tier}`);
      console.log(`mentions:   ${page.mention_count}`);
      console.log(`updated:    ${page.updated_at}`);
      console.log(`---`);
      console.log(page.body);
      db.close();
    });

  program
    .command("list")
    .description("List all pages in the brain")
    .option("-t, --type <type>", "Filter by type: entity|concept|record")
    .option("-l, --limit <number>", "Max results", "50")
    .action(async (opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath);
      const results = pages.list({ type: opts.type, limit: parseInt(opts.limit, 10) });
      if (results.length === 0) { console.log("No pages found."); } else {
        for (const p of results) console.log(`[${p.type}] ${p.slug} — ${p.title} (tier ${p.tier})`);
        console.log(`\n${results.length} pages total`);
      }
      db.close();
    });

  program
    .command("delete")
    .description("Delete a page from the brain")
    .argument("<slug>", "Page slug to delete")
    .action(async (slug) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      // Best-effort LanceDB connection so delete can clean vectors + report repair-required.
      let lance: LanceDBManager | undefined;
      try {
        const l = new LanceDBManager();
        await l.connect(config.lancePath);
        lance = l;
      } catch { /* lance unavailable — delete still safe, just no vector cleanup */ }
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath, undefined, lance);
      const resolution = resolveUserSlug(slug, (s) => pages.getBySlug(s));
      if (!resolution) { console.error(`Page not found: ${slug}`); process.exit(1); }
      if (resolution.ambiguous) {
        console.error(`⚠ Ambiguous slug "${slug}" — matched: ${resolution.ambiguous.join(", ")}`);
        console.error("Please specify the full slug to delete.");
        process.exit(1);
      }
      const result = await pages.deleteDetailed(resolution.slug);
      if (result.committed) {
        console.log(`Deleted: ${resolution.slug}`);
        if (result.lanceRepairRequired) {
          console.error(`⚠ Vector cleanup failed for ${resolution.slug} — page is deleted from vault+DB; run 'cbrain doctor' or reindex to repair vectors.`);
        }
      } else {
        console.error(`Delete failed: ${resolution.slug}`);
        process.exit(1);
      }
      await lance?.close().catch(() => {});
      db.close();
    });
}
