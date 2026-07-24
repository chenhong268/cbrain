import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { CBrainDB } from "../../storage/sqlite.js";
import { LanceDBManager } from "../../storage/lancedb.js";
import { loadConfig, createDeps } from "../context.js";
import { resolveUserSlug } from "./slug-resolver.js";
import { redactOriginRefForDisplay } from "../../core/page-write-provenance.js";

/** Parse a CLI --limit into a positive integer clamped to `max`. Fails fast
 *  (exit 2) on non-integer / <=0 input — NaN used to throw 'datatype mismatch'
 *  and -1 silently unbounded SQLite LIMIT. #386 */
function parsePositiveIntLimit(raw: string | undefined, max: number, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Error: ${label} must be a positive integer (got "${raw ?? ""}").`);
    process.exit(2);
  }
  return Math.min(n, max);
}

export function register(program: Command) {
  program
    .command("ingest")
    .description("Ingest content (text or markdown)")
    .option("-t, --type <type>", "Content type: text or markdown (omit to auto-classify @file content)")
    .option("--title <title>", "Title (for text type)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--page-type <type>", "Page type: entity|concept|record")
    .option("--no-ner", "Skip NER entity extraction")
    .option("--ner-mode <mode>", "NER mode: sync | defer | off (explicitly overrides config/env for this ingest)")
    .option("--allow-duplicate", "Allow duplicate content (normally deduped)")
    .argument("<content>", "Content to ingest (use @file to read from file)")
    .action(async (content, opts) => {
      const config = loadConfig();
      const deps = createDeps(config);
      await deps.lance.connect(config.lancePath);
      const { IngestManager } = await import("../../core/ingestion/ingest.js");
      const { JobQueueNerSubmitter } = await import("../../core/ingestion/ner-backfill.js");
      const { resolveIngestNerMode } = await import("../context.js");
      // Manager default: env > config. opts.nerMode is NOT mixed in here — it is a per-call override.
      const managerMode = resolveIngestNerMode(process.env.CBRAIN_INGEST_NER_MODE, config.ner?.ingest_mode);
      const ingest = new IngestManager(deps.db, deps.embedding, deps.lance, config.vaultPath, deps.llm, undefined, {
        nerMode: managerMode,
        deferredNerSubmitter: new JobQueueNerSubmitter(deps.db),
      });
      // CLI --ner-mode is an explicit override that BEATS env/config.
      // resolveIngestNerMode(undefined, raw) normalizes without letting env override it.
      const cliOverride = opts.nerMode !== undefined ? resolveIngestNerMode(undefined, opts.nerMode) : undefined;
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
      const result = await ingest.ingest({ content: input, type: opts.type, title: opts.title, tags, pageType: opts.pageType, skipNer: opts.ner === false, allowDuplicate: opts.allowDuplicate ?? false, nerMode: cliOverride, writer: { actorClass: "operator" } });
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

  program
    .command("writer-audit")
    .description("List record pages with no creation provenance (pre-tracking / untracked). #386")
    .option("--json", "输出稳定 JSON（供下游解析）")
    .option("--limit <number>", "Max results (1..1000)", "200")
    .action((opts: { json?: boolean; limit?: string }) => {
      const limit = parsePositiveIntLimit(opts.limit ?? "200", 1000, "--limit");
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      // list + total from ONE read-only snapshot so count/total/truncated can't
      // disagree under a concurrent writer.
      const { missing, total } = db.listAndCountRecordPagesWithoutWriteProvenance(limit);
      db.close();
      const truncated = total > missing.length;
      if (opts.json) {
        console.log(JSON.stringify({ missing, count: missing.length, total, limit, truncated }));
        return;
      }
      if (missing.length === 0) {
        console.log("All record pages have creation provenance.");
      } else {
        console.log(`Record pages without creation provenance (showing ${missing.length} of ${total}):`);
        for (const r of missing) console.log(`  ${r.slug} — ${r.title} (created ${r.created_at})`);
        if (truncated) console.log(`\nTruncated: ${total - missing.length} more not shown (raise --limit).`);
        console.log("\nAbsence is honest: created before #386 tracking, via an untracked path, or not type=record.");
      }
    });

  program
    .command("show-writer")
    .description("Show who created a page and how (creation provenance). #386")
    .argument("<slug>", "Page slug")
    .option("--json", "输出稳定 JSON（供下游解析）")
    .action((slug: string, opts: { json?: boolean }) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const page = db.getPage(slug);
      const row = page ? db.getPageWriteProvenance(slug) : null;
      db.close();
      // Distinguish not_found (page missing / typo) from untracked (page exists
      // but predates #386 / untracked path). not_found exits 1 so callers/scripts
      // can tell the difference; tracked/untracked exit 0.
      if (!page) {
        if (opts.json) console.log(JSON.stringify({ slug, status: "not_found" }));
        else console.error(`Page not found: ${slug}`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(
          row
            ? {
                slug,
                status: "tracked",
                provenance: {
                  actor_class: row.actor_class,
                  write_mode: row.write_mode,
                  creation_reason: row.creation_reason,
                  origin_kind: row.origin_kind,
                  origin_ref: redactOriginRefForDisplay(row.origin_ref),
                  created_at: row.created_at,
                },
              }
            : { slug, status: "untracked", provenance: null },
        ));
        return;
      }
      if (!row) {
        console.log(`No creation provenance for ${slug} (untracked: created before #386, via an untracked path, or not type=record).`);
        return;
      }
      console.log(`slug:            ${row.page_slug}`);
      console.log(`actor:           ${row.actor_class}`);
      console.log(`write_mode:      ${row.write_mode}`);
      console.log(`creation_reason: ${row.creation_reason}`);
      if (row.origin_kind) console.log(`origin:          ${row.origin_kind}=${redactOriginRefForDisplay(row.origin_ref)}`);
      console.log(`created_at:      ${row.created_at}`);
    });
}
