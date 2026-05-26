import type { Command } from "commander";
import { CBrainDB } from "../../storage/sqlite.js";
import { loadConfig } from "../context.js";

export function register(program: Command) {
  program
    .command("tags")
    .description("Manage tags on a page")
    .argument("<slug>", "Page slug")
    .argument("[action]", "Action: add <tag> | remove <tag> (omit to list)")
    .argument("[value]", "Tag value for add/remove")
    .action(async (slug, action, value) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      if (!action) {
        const tags = db.getTags(slug);
        if (tags.length === 0) { console.log(`No tags on ${slug}`); }
        else { console.log(`Tags on ${slug}:`); for (const t of tags) console.log(`  ${t}`); }
      } else if (action === "add" && value) {
        if (db.addTag(slug, value)) { console.log(`Added tag "${value}" to ${slug}`); }
        else { console.error(`Failed to add tag. Check that ${slug} exists.`); process.exit(1); }
      } else if (action === "remove" && value) {
        if (db.removeTag(slug, value)) { console.log(`Removed tag "${value}" from ${slug}`); }
        else { console.error(`Failed to remove tag.`); process.exit(1); }
      } else { console.error("Usage: cbrain tags <slug> [add|remove <tag>]"); process.exit(1); }
      db.close();
    });

  program
    .command("timeline")
    .description("View or add timeline events on a page")
    .argument("<slug>", "Page slug")
    .argument("[action]", "Action: add (omit to list)")
    .option("--date <date>", "Event date (e.g. 2024-03-01)")
    .option("--source <source>", "Source reference")
    .option("--summary <summary>", "Event summary (required for add)")
    .action(async (slug, action, opts) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      if (action === "add") {
        if (!opts.summary) { console.error("--summary is required."); process.exit(1); }
        const id = db.addTimelineEntry(slug, opts.summary, opts.date, opts.source);
        console.log(`Added timeline event #${id} to ${slug}`);
      } else {
        const events = db.getTimeline(slug);
        if (events.length === 0) { console.log(`No timeline events on ${slug}`); }
        else {
          console.log(`Timeline for ${slug}:\n`);
          for (const ev of events) {
            const date = ev.event_date ? ev.event_date.padEnd(12) : "            ";
            const src = ev.source ? ` (${ev.source})` : "";
            console.log(`  ${date}${ev.summary}${src}`);
          }
        }
      }
      db.close();
    });

  program
    .command("versions")
    .description("Show version history of a page")
    .argument("<slug>", "Page slug")
    .action(async (slug) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath);
      const vm = new (await import("../../core/version.js")).VersionManager(db, pages, config.vaultPath);
      const versions = vm.getVersions(slug);
      if (versions.length === 0) { console.log("No versions found."); }
      else {
        console.log(`Version history for ${slug}:\n`);
        for (const v of versions) console.log(`  v${v.version} — ${v.created_at}`);
        console.log(`\n  Tip: use "cbrain show ${slug}" to see current content`);
        console.log(`       use "cbrain revert ${slug} <version>" to roll back`);
      }
      db.close();
    });

  program
    .command("revert")
    .description("Revert a page to a previous version")
    .argument("<slug>", "Page slug")
    .argument("<version>", "Version number to revert to")
    .action(async (slug, version) => {
      const config = loadConfig();
      const db = new CBrainDB(config.dbPath);
      const pages = new (await import("../../core/page.js")).PageManager(db, config.vaultPath);
      const vm = new (await import("../../core/version.js")).VersionManager(db, pages, config.vaultPath);
      const vn = parseInt(version, 10);
      if (Number.isNaN(vn)) { console.error("Version must be a number."); process.exit(1); }
      if (vm.revertToVersion(slug, vn)) { console.log(`Reverted ${slug} to version ${vn}`); }
      else { console.error(`Revert failed.`); process.exit(1); }
      db.close();
    });
}
