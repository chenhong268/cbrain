import type { Database } from "bun:sqlite";

const COMPLETION_KEY = "migration_rec_v1_recommendation_records";

export interface MigrationHooks {
  /** Test-only: inject a fault after the DDL but before the completion marker to prove atomic rollback. */
  failBeforeMarker?: boolean;
}

/**
 * Additive, idempotent migration for the Recommendation Record contract (spec §10, §5.5).
 * DDL + completion marker run in ONE transaction so a fault before the marker rolls back
 * everything (proven by the atomic-rollback test). The partial unique index enforces
 * "at most one active (pending|current) record per maintenance_key" (§5.5).
 *
 * Mirrors the runLatePageMigrations config-key guard pattern (additive, non-destructive);
 * the transaction wrapper is required by the atomic-fault test (house additive migrations
 * are otherwise non-transactional).
 */
export function runRecommendationRecordsMigration(db: Database, hooks: MigrationHooks = {}): void {
  const done = db.prepare("SELECT value FROM config WHERE key = ?").get(COMPLETION_KEY) as { value?: string } | undefined;
  if (done?.value === "1") return;
  const txn = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recommendation_records (
        record_id TEXT PRIMARY KEY, maintenance_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        inputs_hash TEXT NOT NULL, payload TEXT NOT NULL,
        auto_execute INTEGER NOT NULL DEFAULT 0 CHECK(auto_execute = 0),
        created_at TEXT NOT NULL, last_revalidated_at TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('pending','current','superseded','rejected','invalidated')),
        freshness_status TEXT NOT NULL CHECK(freshness_status IN ('fresh','stale','version_invalid')),
        suppressed_until TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rec_fingerprint ON recommendation_records(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_rec_inputs_hash ON recommendation_records(inputs_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_active_unique ON recommendation_records(maintenance_key) WHERE lifecycle_status IN ('pending','current');
      CREATE TABLE IF NOT EXISTS recommendation_lifecycle_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL REFERENCES recommendation_records(record_id) ON DELETE CASCADE,
        action TEXT NOT NULL, from_lifecycle TEXT, to_lifecycle TEXT, from_freshness TEXT, to_freshness TEXT, reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rec_history_record ON recommendation_lifecycle_history(record_id);
    `);
    if (hooks.failBeforeMarker) throw new Error("injected failure before completion marker");
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, '1')").run(COMPLETION_KEY);
  });
  txn();
}
