import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { CBrainDB } from "../../storage/sqlite.js";
import { loadConfig, createDeps } from "../context.js";

export function register(program: Command) {
  program
    .command("ingest")
    .description("Ingest content (text or markdown)")
    .option("-t, --type <type>", "Content type: text or markdown", "text")
    .option("--title <title>", "Title (for text type)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--page-type <type>", "Page type: entity|concept|event|record|source")
    .option("--no-ner", "Skip NER entity extraction")
    .argument("<content>", "Content to ingest (use @file to read from file)")
    .action(async (content, opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { IngestManager } = await import("../../core/ingest.js");
      const ingest = new IngestManager(deps.db, deps.embedding, deps.lance, config.vaultPath, deps.llm);
      let input = content;
      let fileTitle: string | undefined;
      if (input.startsWith("@")) {
        const rawPath = input.slice(1);
        if (rawPath.includes("..")) { console.error("Error: 路径不允许包含 .."); process.exit(1); }
        if (!existsSync(rawPath)) { console.error(`Error: File not found: ${rawPath}`); process.exit(1); }
        input = readFileSync(rawPath, "utf-8");
        fileTitle = basename(rawPath, extname(rawPath));
      }
      const tags = opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined;
      const result = await ingest.ingest({ content: input, type: opts.type ?? "text", title: opts.title ?? fileTitle, tags, pageType: opts.pageType, skipNer: opts.ner === false });
      console.log(result.created ? `✓ Created: ${result.slug}` : `✓ Updated: ${result.slug}`);
      console.log(`  Links:   ${result.linksExtracted} wiki links extracted`);
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
      const page = pages.getBySlug(slug);
      if (!page) { console.error(`Page not found: ${slug}`); process.exit(1); }
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
    .option("-t, --type <type>", "Filter by type: entity|concept|event|record|source")
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
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath);
      if (pages.delete(slug)) { console.log(`Deleted: ${slug}`); }
      else { console.error(`Page not found: ${slug}`); process.exit(1); }
      db.close();
    });
}
