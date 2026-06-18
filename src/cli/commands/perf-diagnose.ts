import type { Command } from "commander";
import { Database } from "bun:sqlite";
import { loadConfig } from "../context.js";
import {
  readDiagnosticSnapshot,
  diagnose,
  formatJson,
  formatHuman,
  type DiagnosticSnapshot,
} from "../../release/perf-diagnose.js";

const MS_PER_DAY = 86_400_000;

/** Parse a CLI int. 0 is a VALID value (only NaN/unset falls back to the default). */
function parseInt0(v: string, def: number): number {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

/**
 * `cbrain perf-diagnose` — read-only slow-journey diagnostics (#189).
 *
 * Opens the SQLite brain READ-ONLY (never migrates, never writes — SQLite enforces
 * this) and reports where time/query budget is spent across recent search journeys.
 * Safe dimensions only; never raw query text, slugs, paths, or private blobs.
 */
export function register(program: Command): void {
  program
    .command("perf-diagnose")
    .description("Read-only diagnostics: where time/query budget is spent across recent search journeys (no writes).")
    .option("--days <n>", "Lookback window in days", "7")
    .option("--limit <n>", "Max slow sessions to list", "20")
    .option("--min-latency-ms <n>", "Slow threshold in milliseconds", "1000")
    .option("--json", "Machine-readable JSON output")
    .action((opts: { days: string; limit: string; minLatencyMs: string; json?: boolean }) => {
      // 0 is a valid, honest value (days=0 → today only; min-latency=0 → all sessions).
      const days = Math.max(0, parseInt0(opts.days, 7));
      const limit = Math.max(1, parseInt0(opts.limit, 20));
      const minLatencyMs = Math.max(0, parseInt0(opts.minLatencyMs, 1000));

      const config = loadConfig();
      const cutoffIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();

      // READ-ONLY connection: no migration, no PRAGMA writes, SQLite refuses any write.
      let snapshot: DiagnosticSnapshot;
      try {
        const db = new Database(config.dbPath, { readonly: true });
        try {
          snapshot = readDiagnosticSnapshot(db, { cutoffIso, minLatencyMs, limit });
        } finally {
          try { db.close(); } catch { /* best effort */ }
        }
      } catch {
        // Database missing / unreadable: degrade to a graceful empty report (exit 0).
        snapshot = {
          sessions: [],
          steps: [],
          queryLogs: [],
          searchLogs: [],
          tables: { sessions: false, steps: false, queryLog: false, searchLog: false },
          warnings: ["database unavailable (read-only open failed)"],
        };
      }

      const report = diagnose(snapshot, { minLatencyMs, limit });
      const window = { days, min_latency_ms: minLatencyMs, limit };
      console.log(opts.json ? formatJson(report, window) : formatHuman(report, window));
    });
}
