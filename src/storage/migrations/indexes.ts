import { Database } from "bun:sqlite";

const PAGES_INDEX_SPECS: ReadonlyArray<{
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}> = [
  { name: "idx_pages_type", sql: "CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type)", columns: ["type"] },
  { name: "idx_pages_tier", sql: "CREATE INDEX IF NOT EXISTS idx_pages_tier ON pages(tier)", columns: ["tier"] },
  { name: "idx_pages_title", sql: "CREATE INDEX IF NOT EXISTS idx_pages_title ON pages(title)", columns: ["title"] },
  { name: "idx_pages_updated_at", sql: "CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at)", columns: ["updated_at"] },
  { name: "idx_pages_created_at", sql: "CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages(created_at)", columns: ["created_at"] },
  { name: "idx_pages_activity_wt", sql: "CREATE INDEX IF NOT EXISTS idx_pages_activity_wt ON pages(activity_weight) WHERE activity_weight > 0", columns: ["activity_weight"] },
  { name: "idx_pages_expires_at", sql: "CREATE INDEX IF NOT EXISTS idx_pages_expires_at ON pages(expires_at) WHERE expires_at IS NOT NULL", columns: ["expires_at"] },
  { name: "idx_pages_title_uniq", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_title_uniq ON pages(title)", columns: ["title"], unique: true },
];

export function ensurePagesIndexes(db: Database): void {
  const colRows = db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
  const available = new Set(colRows.map((column) => column.name));

  for (const spec of PAGES_INDEX_SPECS) {
    if (!spec.columns.every((column) => available.has(column))) continue;

    try {
      db.exec(spec.sql);
    } catch (error) {
      if (spec.unique) {
        const hasDups = db.prepare("SELECT title FROM pages GROUP BY title HAVING COUNT(*) > 1 LIMIT 1").get();
        if (hasDups) {
          console.warn("[migrate] pages has duplicate titles — unique index skipped, run dedup first");
          continue;
        }
      }
      throw error;
    }
  }
}

export function validatePagesIndexes(db: Database): void {
  const placeholders = PAGES_INDEX_SPECS.map(() => "?").join(",");
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN (${placeholders})`).all(
    ...PAGES_INDEX_SPECS.map((spec) => spec.name),
  ) as Array<{ name: string }>;
  const found = new Set(rows.map((row) => row.name));
  for (const spec of PAGES_INDEX_SPECS) {
    if (found.has(spec.name)) continue;
    if (spec.unique) {
      const hasDups = db.prepare("SELECT title FROM pages GROUP BY title HAVING COUNT(*) > 1 LIMIT 1").get();
      if (hasDups) continue;
    }
    throw new Error(`${spec.name} missing after rebuild`);
  }
}

export function runMissingIndexMigrations(db: Database): void {
  ensurePagesIndexes(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tags_page_slug ON tags(page_slug);
    CREATE INDEX IF NOT EXISTS idx_timeline_page_slug ON timeline(page_slug);
    CREATE INDEX IF NOT EXISTS idx_ingest_log_created ON ingest_log(created_at);
  `);
}
