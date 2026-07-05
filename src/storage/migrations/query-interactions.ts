import { Database } from "bun:sqlite";

function migrateQueryLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      query TEXT NOT NULL,
      result_slugs TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      latency_ms INTEGER,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_query_log_created ON query_log(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_query_log_session ON query_log(session_id)");
}

function migrateQueryFeedbackAndSnapshots(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER REFERENCES query_log(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      signal TEXT NOT NULL CHECK(signal IN ('relevant', 'irrelevant', 'corrected', 'expanded')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brain_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'wakeup_diff',
      page_count INTEGER NOT NULL,
      link_count INTEGER NOT NULL,
      health_issue_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS brain_snapshot_items (
      snapshot_id TEXT NOT NULL REFERENCES brain_snapshots(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT,
      tier INTEGER,
      mention_count INTEGER,
      link_count INTEGER,
      updated_at TEXT,
      page_type TEXT,
      confidence_decay REAL,
      PRIMARY KEY (snapshot_id, slug)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_slug ON query_feedback(slug)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_created ON query_feedback(created_at)");
}

export function runQueryInteractionMigrations(db: Database): void {
  migrateQueryLog(db);
  migrateQueryFeedbackAndSnapshots(db);
}
