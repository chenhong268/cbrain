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
  test("generates 3 index files", () => {
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    expect(files.length).toBe(3);
    for (const f of files) {
      expect(existsSync(f)).toBe(true);
    }
  });

  test("All-Entities includes tiered entities", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count)
       VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
    ).run("entities/a", "Alice", "a.md", "h1", 1, 8);
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count)
       VALUES (?, 'entity/person', ?, ?, ?, ?, ?)`
    ).run("entities/b", "Bob", "b.md", "h2", 3, 1);

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "All-Entities.md"), "utf-8");
    expect(content).toContain("Alice");
    expect(content).toContain("Bob");
    expect(content).toContain("2 entities total");
  });

  test("All-Concepts lists concepts by mention count", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'concept/concept', ?, ?, ?, ?)`
    ).run("concepts/x", "AI", "x.md", "h1", 5);
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'concept/concept', ?, ?, ?, ?)`
    ).run("concepts/y", "ML", "y.md", "h2", 2);

    const gen = new IndexGenerator(db, outputsDir);
    gen.generateAll();

    const content = readFileSync(join(outputsDir, "indexes", "All-Concepts.md"), "utf-8");
    expect(content).toContain("AI");
    expect(content).toContain("ML");
    expect(content).toContain("2 concepts total");
  });

  test("Dashboard has overview stats", () => {
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count)
       VALUES (?, 'entity/person', ?, ?, ?, ?)`
    ).run("entities/a", "Alice", "a.md", "h1", 3);
    db.rawDb.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash)
       VALUES (?, 'entity/person', ?, ?, ?)`
    ).run("entities/b", "Bob", "b.md", "h2");
    db.rawDb.prepare(
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

  });

  test("handles empty brain gracefully", () => {
    const gen = new IndexGenerator(db, outputsDir);
    const files = gen.generateAll();
    expect(files.length).toBe(3);

    const dash = readFileSync(join(outputsDir, "indexes", "Dashboard.md"), "utf-8");
    expect(dash).toContain("Total Pages | 0");
  });
});
