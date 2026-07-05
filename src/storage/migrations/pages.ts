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

export function runPageMigrations(db: Database): void {
  migratePagesExpiry(db);
}
