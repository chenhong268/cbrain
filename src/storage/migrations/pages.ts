import { Database } from "bun:sqlite";

function pageColumnNames(db: Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function migratePagesExpiry(db: Database): void {
  const names = pageColumnNames(db);
  if (!names.has("expires_at")) {
    db.exec("ALTER TABLE pages ADD COLUMN expires_at TEXT");
  }
  // Backfill: entity pages without expires_at get now + 90d
  db.exec("UPDATE pages SET expires_at = datetime('now', '+90 days') WHERE type LIKE 'entity/%' AND expires_at IS NULL");
  if (!names.has("confidence_decay")) {
    db.exec("ALTER TABLE pages ADD COLUMN confidence_decay REAL DEFAULT 1.0");
  }
}

function migratePageActivityFields(db: Database): void {
  const names = pageColumnNames(db);
  if (!names.has("activity_weight")) {
    db.exec("ALTER TABLE pages ADD COLUMN activity_weight REAL DEFAULT 0.0");
  }
  if (!names.has("last_queried_at")) {
    db.exec("ALTER TABLE pages ADD COLUMN last_queried_at TEXT");
  }
}

function migratePageHotnessScore(db: Database): void {
  const names = pageColumnNames(db);
  if (!names.has("hotness_score")) {
    db.exec("ALTER TABLE pages ADD COLUMN hotness_score REAL NOT NULL DEFAULT 0.0");
  }
}

export function runPageMigrations(db: Database): void {
  migratePagesExpiry(db);
  migratePageActivityFields(db);
  migratePageHotnessScore(db);
}

export function runLatePageMigrations(db: Database): void {
  const done = db.prepare("SELECT value FROM config WHERE key = 'migration_v7_ingest_content_hash'").get() as { value: string } | undefined;
  if (done) return;

  const names = pageColumnNames(db);
  if (!names.has("ingest_content_hash")) {
    db.exec("ALTER TABLE pages ADD COLUMN ingest_content_hash TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_pages_ingest_hash ON pages(ingest_content_hash) WHERE ingest_content_hash IS NOT NULL");
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('migration_v7_ingest_content_hash', '1')").run();
}
