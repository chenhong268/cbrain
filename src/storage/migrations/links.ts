import { Database } from "bun:sqlite";

function linkColumnNames(db: Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function migrateLinksStrength(db: Database): void {
  const names = linkColumnNames(db);
  if (!names.has("weight")) {
    db.exec("ALTER TABLE links ADD COLUMN weight REAL DEFAULT 1.0");
  }
  if (!names.has("strength")) {
    db.exec("ALTER TABLE links ADD COLUMN strength TEXT DEFAULT 'medium'");
  }
}

function migrateLinksCredibility(db: Database): void {
  const names = linkColumnNames(db);
  if (!names.has("source_type")) {
    db.exec("ALTER TABLE links ADD COLUMN source_type TEXT DEFAULT 'unknown'");
  }
  if (!names.has("confidence")) {
    db.exec("ALTER TABLE links ADD COLUMN confidence REAL DEFAULT 0.5");
  }
}

function migrateLinkDecayFields(db: Database): void {
  const names = linkColumnNames(db);
  if (!names.has("last_validated_at")) {
    db.exec("ALTER TABLE links ADD COLUMN last_validated_at TEXT");
    db.exec("UPDATE links SET last_validated_at = created_at");
  }
  if (!names.has("effective_weight")) {
    db.exec("ALTER TABLE links ADD COLUMN effective_weight REAL DEFAULT 1.0");
    db.exec("UPDATE links SET effective_weight = weight * confidence");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_links_last_validated ON links(last_validated_at)");
}

export function runLinkMigrations(db: Database): void {
  migrateLinksStrength(db);
  migrateLinksCredibility(db);
  migrateLinkDecayFields(db);
}
