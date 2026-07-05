import { Database } from "bun:sqlite";

function columnNames(db: Database, table: "links" | "timeline"): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function migrateLinkProvenance(db: Database): void {
  const names = columnNames(db, "links");
  if (!names.has("source_page_slug")) {
    db.exec("ALTER TABLE links ADD COLUMN source_page_slug TEXT");
  }
  if (!names.has("trust_state")) {
    db.exec(
      "ALTER TABLE links ADD COLUMN trust_state TEXT DEFAULT 'candidate' CHECK(trust_state IN ('trusted','user_thought','candidate','rejected','superseded'))",
    );
    db.exec("UPDATE links SET trust_state = 'trusted' WHERE source_type IN ('wikilink','manual')");
  }
  if (!names.has("evidence")) {
    db.exec("ALTER TABLE links ADD COLUMN evidence TEXT");
  }

  // #233 Phase 1: deterministic reports_to edges produced by agent paths are
  // authoritative current facts. Promote legacy candidate rows idempotently.
  db.exec(
    "UPDATE links SET trust_state = 'trusted' WHERE relation = 'reports_to' AND source_type = 'agent' AND trust_state = 'candidate'",
  );
}

function migrateTimelineProvenance(db: Database): void {
  const names = columnNames(db, "timeline");
  if (!names.has("source_page_slug")) {
    db.exec("ALTER TABLE timeline ADD COLUMN source_page_slug TEXT");
  }
  if (!names.has("trust_state")) {
    db.exec("ALTER TABLE timeline ADD COLUMN trust_state TEXT DEFAULT 'candidate'");
  }
  if (!names.has("evidence")) {
    db.exec("ALTER TABLE timeline ADD COLUMN evidence TEXT");
  }
}

export function runProvenanceMigrations(db: Database): void {
  migrateLinkProvenance(db);
  migrateTimelineProvenance(db);
}
