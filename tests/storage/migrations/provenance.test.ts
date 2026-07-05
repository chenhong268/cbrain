import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProvenanceMigrations } from "../../../src/storage/migrations/index.js";

describe("runProvenanceMigrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function legacyDb(): Database {
    const dir = mkdtempSync(join(tmpdir(), "cbrain-provenance-migration-"));
    dirs.push(dir);
    const db = new Database(join(dir, "brain.sqlite"));
    db.exec(`
      CREATE TABLE links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        relation TEXT NOT NULL,
        context TEXT,
        source_type TEXT DEFAULT 'unknown',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_type TEXT,
        description TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)",
    ).run("entity/a", "entity/b", "mentions", "wikilink");
    db.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)",
    ).run("entity/c", "entity/d", "related", "manual");
    db.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type) VALUES (?, ?, ?, ?)",
    ).run("entity/e", "entity/f", "related", "ner");
    db.prepare(
      "INSERT INTO timeline (slug, event_date, event_type, description) VALUES (?, ?, ?, ?)",
    ).run("entity/a", "2026-01-01", "note", "匿名事件");
    return db;
  }

  test("adds provenance columns to links and timeline with trusted backfill for strong link sources", () => {
    const db = legacyDb();
    try {
      runProvenanceMigrations(db);

      const linkColumns = db.prepare("PRAGMA table_info(links)").all() as Array<{ name: string }>;
      const linkNames = new Set(linkColumns.map((column) => column.name));
      expect(linkNames).toContain("source_page_slug");
      expect(linkNames).toContain("trust_state");
      expect(linkNames).toContain("evidence");

      const timelineColumns = db.prepare("PRAGMA table_info(timeline)").all() as Array<{ name: string }>;
      const timelineNames = new Set(timelineColumns.map((column) => column.name));
      expect(timelineNames).toContain("source_page_slug");
      expect(timelineNames).toContain("trust_state");
      expect(timelineNames).toContain("evidence");

      const links = db.prepare(
        "SELECT from_slug, trust_state FROM links ORDER BY from_slug",
      ).all() as Array<{ from_slug: string; trust_state: string }>;
      expect(links).toEqual([
        { from_slug: "entity/a", trust_state: "trusted" },
        { from_slug: "entity/c", trust_state: "trusted" },
        { from_slug: "entity/e", trust_state: "candidate" },
      ]);

      const timeline = db.prepare("SELECT trust_state FROM timeline").get() as { trust_state: string };
      expect(timeline.trust_state).toBe("candidate");
    } finally {
      db.close();
    }
  });

  test("is idempotent and promotes legacy agent reports_to candidate edges", () => {
    const db = legacyDb();
    try {
      db.exec("ALTER TABLE links ADD COLUMN source_page_slug TEXT");
      db.exec("ALTER TABLE links ADD COLUMN trust_state TEXT DEFAULT 'candidate'");
      db.exec("ALTER TABLE links ADD COLUMN evidence TEXT");
      db.exec("ALTER TABLE timeline ADD COLUMN source_page_slug TEXT");
      db.exec("ALTER TABLE timeline ADD COLUMN trust_state TEXT DEFAULT 'candidate'");
      db.exec("ALTER TABLE timeline ADD COLUMN evidence TEXT");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, evidence) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("entity/g", "entity/h", "reports_to", "agent", "candidate", "frontmatter-sync");
      db.prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state) VALUES (?, ?, ?, ?, ?)",
      ).run("entity/i", "entity/j", "reports_to", "ner", "candidate");
      db.prepare("UPDATE timeline SET trust_state = ?, evidence = ? WHERE slug = ?").run(
        "trusted",
        "manual-note",
        "entity/a",
      );

      runProvenanceMigrations(db);
      runProvenanceMigrations(db);

      const rows = db.prepare(
        "SELECT from_slug, relation, source_type, trust_state, evidence FROM links WHERE relation = 'reports_to' ORDER BY from_slug",
      ).all() as Array<{
        from_slug: string;
        relation: string;
        source_type: string;
        trust_state: string;
        evidence: string | null;
      }>;
      expect(rows).toEqual([
        {
          from_slug: "entity/g",
          relation: "reports_to",
          source_type: "agent",
          trust_state: "trusted",
          evidence: "frontmatter-sync",
        },
        {
          from_slug: "entity/i",
          relation: "reports_to",
          source_type: "ner",
          trust_state: "candidate",
          evidence: null,
        },
      ]);

      const timeline = db.prepare("SELECT trust_state, evidence FROM timeline WHERE slug = ?").get("entity/a") as {
        trust_state: string;
        evidence: string;
      };
      expect(timeline).toEqual({ trust_state: "trusted", evidence: "manual-note" });
    } finally {
      db.close();
    }
  });
});
