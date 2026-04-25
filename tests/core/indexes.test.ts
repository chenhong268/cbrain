import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { IndexGenerator } from "../../src/core/indexes.js";

let db: CBrainDB;
let outputsDir: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "cbrain-idx-"));
  outputsDir = join(tmp, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  db = new CBrainDB(join(tmp, "test.sqlite"));
});

describe("IndexGenerator", () => {
  test("generates 4 index files", () => {
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    expect(files.length).toBe(4);
    for (const f of files) {
      expect(existsSync(f)).toBe(true);
    }
  });

  test("All-Entities includes tiered entities", () => {
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count)
       VALUES (?, 'entity', ?, ?, ?, ?, ?)`
    ).run("entities/a", "Alice", "a.md", "h1", 1, 8);
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count)
       VALUES (?, 'entity', ?, ?, ?, ?, ?)`
    ).run("entities/b", "Bob", "b.md", "h2", 3, 1);

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "All-Entities.md"), "utf-8");
    expect(content).toContain("Alice");
    expect(content).toContain("Bob");
    expect(content).toContain("2 entities total");
  });

  test("All-Concepts lists concepts by mention count", () => {
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'concept', ?, ?, ?, ?)`
    ).run("concepts/x", "AI", "x.md", "h1", 5);
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'concept', ?, ?, ?, ?)`
    ).run("concepts/y", "ML", "y.md", "h2", 2);

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "All-Concepts.md"), "utf-8");
    expect(content).toContain("AI");
    expect(content).toContain("ML");
    expect(content).toContain("2 concepts total");
  });

  test("All-Sources includes records, sources, events", () => {
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, 'record', ?, ?, ?)`
    ).run("records/r1", "Meeting Notes", "r1.md", "h1");
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, 'source', ?, ?, ?)`
    ).run("sources/s1", "Article", "s1.md", "h2");
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, 'event', ?, ?, ?)`
    ).run("events/e1", "Conference", "e1.md", "h3");

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "All-Sources.md"), "utf-8");
    expect(content).toContain("Meeting Notes");
    expect(content).toContain("Article");
    expect(content).toContain("Conference");
    expect(content).toContain("3 sources total");
  });

  test("Dashboard has overview stats", () => {
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'entity', ?, ?, ?, ?)`
    ).run("entities/a", "Alice", "a.md", "h1", 3);
    db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, 'entity', ?, ?, ?)`
    ).run("entities/b", "Bob", "b.md", "h2");
    db.prepare(
      "INSERT INTO links (from_slug, to_slug, relation) VALUES (?, ?, ?)"
    ).run("entities/a", "entities/b", "knows");

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "Dashboard.md"), "utf-8");
    expect(content).toContain("CBrain Dashboard");
    expect(content).toContain("Total Pages");
    expect(content).toContain("Entities");
    expect(content).toContain("Links");
    expect(content).toContain("All-Entities");
    expect(content).toContain("All-Concepts");
    expect(content).toContain("All-Sources");
  });

  test("handles empty brain gracefully", () => {
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    expect(files.length).toBe(4);

    const dash = readFileSync(join(outputsDir, "indexes", "Dashboard.md"), "utf-8");
    expect(dash).toContain("Total Pages | 0");
  });
});
