import { Database } from "bun:sqlite";

function migrateSearchLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      strategy TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      hit_count INTEGER NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_search_log_created ON search_log(created_at)");

  try {
    db.exec("ALTER TABLE search_log ADD COLUMN details_json TEXT");
  } catch {
    // Column already exists.
  }
}

function migrateSearchTraceTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_trace_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      intent TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','degraded','error')),
      llm_calls INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT
    );
    CREATE TABLE IF NOT EXISTS search_trace_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      input_json TEXT,
      output_summary TEXT,
      latency_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES search_trace_sessions(id) ON DELETE CASCADE
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sts_started ON search_trace_sessions(started_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sts_id ON search_trace_sessions(id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_steps_session ON search_trace_steps(session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_steps_session_index ON search_trace_steps(session_id, step_index)");
}

function migrateNerQualityLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ner_quality_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extracted_entities INTEGER NOT NULL,
      extracted_concepts INTEGER NOT NULL,
      filtered_total INTEGER NOT NULL,
      filter_reasons_json TEXT,
      resolved_existing INTEGER NOT NULL,
      alias_added INTEGER NOT NULL,
      stub_created INTEGER NOT NULL,
      duplicate_candidate INTEGER NOT NULL,
      relations_total INTEGER NOT NULL,
      relations_written INTEGER NOT NULL,
      relations_skipped INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_ner_quality_log_created ON ner_quality_log(created_at)");
}

export function runTelemetryMigrations(db: Database): void {
  migrateSearchLog(db);
  migrateSearchTraceTables(db);
  migrateNerQualityLog(db);
}
