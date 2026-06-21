import type { Command } from "commander";
import { loadConfig } from "../context.js";
import { CBrainDB } from "../../storage/sqlite.js";

/**
 * `cbrain repair-fk [--execute]` — detect & repair orphan FK rows in derived
 * tables (#209). Default dry-run (report per-table orphan counts); `--execute`
 * deletes orphan rows atomically. Output is anonymized (table + count only, no
 * slugs/titles/paths). Never deletes pages or markdown — only orphan derived
 * rows whose parent page is gone.
 */
export function register(program: Command): void {
  program
    .command("repair-fk")
    .description("Detect/repair orphan FK references in derived tables (dry-run by default; --execute to delete)")
    .option("--execute", "Delete orphan rows (default is dry-run)", false)
    .action((opts: { execute: boolean }) => {
      const config = loadConfig();
      // #209: skipMigrate — repair must open a DB whose migrations currently
      // FK-fail (serve refuses to start on it). Without skipMigrate, new CBrainDB()
      // runs migrate and rethrows FKMigrationError, making repair-fk itself fail.
      const db = new CBrainDB(config.dbPath, { skipMigrate: true });
      try {
        const before = db.checkFkViolations();
        if (before.total === 0) {
          console.error("✓ No FK violations. Nothing to repair.");
          return;
        }
        console.error(`FK violations: ${before.total} row(s) across ${Object.keys(before.byTable).length} table(s):`);
        for (const [t, c] of Object.entries(before.byTable).sort()) console.error(`  ${t}:  ${c}`);

        if (!opts.execute) {
          console.error("\n(dry-run — DB 未修改。加 --execute 删除孤儿引用行[不动 page/markdown]。)");
          return;
        }
        const result = db.repairOrphanedDerivedRows();
        console.error("\n✓ Repaired (deleted orphan rows):");
        for (const [t, c] of Object.entries(result.repairedByTable).sort()) console.error(`  ${t}:  ${c}`);
        console.error(`Remaining violations: ${result.remaining}`);
        if (result.remaining > 0) {
          console.error("⚠️ 仍有残留 FK violation(可能非 derived-table orphan,需人工排查)。");
        }
      } finally {
        db.close();
      }
    });
}
