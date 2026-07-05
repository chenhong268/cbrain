import { Database } from "bun:sqlite";

export function runAliasMigrations(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(aliases)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("source")) {
    db.exec("ALTER TABLE aliases ADD COLUMN source TEXT DEFAULT 'manual'");
  }
}
