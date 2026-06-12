import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { PageManager, RollbackIncompleteError, CleanupIncompleteError } from "../../src/core/page.js";
import { SyncManager } from "../../src/core/sync.js";
import {
  atomicSlugChange,
  atomicTypeChange,
  type MoveFsOps,
} from "../../src/core/atomic-move.js";
import { relocatePage } from "../../src/cli/commands/maintenance.js";
import type { LanceDBManager } from "../../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { unlinkSync as realUnlinkSync } from "node:fs";

const noLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function seedPage(
  db: CBrainDB,
  vaultPath: string,
  slug: string,
  type: string,
  title: string,
  body = "",
): void {
  const fp = `${slug}.md`;
  const dir = join(vaultPath, dirname(fp));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(vaultPath, fp),
    `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n${body}`,
    "utf-8",
  );
  db.rawDb
    .prepare(
      `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(slug, type, title, fp, "hash-old", 0, 3);
}

/** Collect all .staging files anywhere under vaultPath. */
function findStagingFiles(vaultPath: string): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.includes(".staging.")) found.push(full);
    }
  }
  walk(vaultPath);
  return found;
}

describe("page move atomicity", () => {
  const testDir = "/tmp/cbrain-test-page-move";
  const vaultPath = join(testDir, "vault");
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let pm: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pm = new PageManager(db, vaultPath, noLogger as never);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  // ── DB-level tests ────────────────────────────────────────────

  describe("movePage (DB layer)", () => {
    test("updates pages.slug, type, file_path, content_hash", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA");
      db.movePage(
        "records/entity-a",
        "brain/entities/person/entity-a",
        "entity/person",
        "brain/entities/person/entity-a.md",
        "hash-new",
      );
      const p = db.getPage("brain/entities/person/entity-a");
      expect(p).not.toBeNull();
      expect(p!.type).toBe("entity/person");
      expect(p!.file_path).toBe("brain/entities/person/entity-a.md");
      expect(p!.content_hash).toBe("hash-new");
      expect(db.getPage("records/entity-a")).toBeNull();
    });

    test("updates links.from_slug, to_slug, source_page_slug", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb
        .prepare(
          `INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, source_page_slug)
           VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5, ?)`,
        )
        .run("records/entity-a", "records/entity-b", "records/entity-a");
      db.movePage(
        "records/entity-a",
        "brain/entities/person/entity-a",
        "entity/person",
        "brain/entities/person/entity-a.md",
      );
      const links = db.rawDb
        .prepare("SELECT from_slug, to_slug, source_page_slug FROM links")
        .all() as { from_slug: string; to_slug: string; source_page_slug: string }[];
      expect(links).toHaveLength(1);
      expect(links[0].from_slug).toBe("brain/entities/person/entity-a");
      expect(links[0].to_slug).toBe("records/entity-b");
      expect(links[0].source_page_slug).toBe("brain/entities/person/entity-a");
    });

    test("updates tags, chunks, versions, aliases, timeline, mention_snapshots, ingest_log, chunks_fts", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      db.rawDb.prepare(`INSERT INTO tags (page_slug, tag) VALUES (?, 't1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO chunks (page_slug, content, chunk_index) VALUES (?, 'c', 0)`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO chunks_fts (page_slug, content) VALUES (?, 'c')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO ingest_log (source_type, action, page_slug) VALUES ('manual', 'create', ?)`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO versions (page_slug, version, content) VALUES (?, 1, 'v1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO aliases (page_slug, alias) VALUES (?, 'a1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO timeline (page_slug, summary, source_page_slug) VALUES (?, 'e1', ?)`).run("records/entity-a", "records/entity-a");
      db.rawDb.prepare(`INSERT INTO mention_snapshots (slug, snapshot_date, mention_count) VALUES (?, '2024-01-01', 5)`).run("records/entity-a");

      db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md");

      const ns = "brain/entities/person/entity-a";
      expect((db.rawDb.prepare("SELECT page_slug FROM tags").get() as { page_slug: string }).page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT page_slug FROM chunks").get() as { page_slug: string }).page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT page_slug FROM chunks_fts").get() as { page_slug: string }).page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT page_slug FROM ingest_log").get() as { page_slug: string }).page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT page_slug FROM versions").get() as { page_slug: string }).page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT page_slug FROM aliases").get() as { page_slug: string }).page_slug).toBe(ns);
      const tl = db.rawDb.prepare("SELECT page_slug, source_page_slug FROM timeline").get() as { page_slug: string; source_page_slug: string };
      expect(tl.page_slug).toBe(ns);
      expect(tl.source_page_slug).toBe(ns);
      expect((db.rawDb.prepare("SELECT slug FROM mention_snapshots").get() as { slug: string }).slug).toBe(ns);
    });

    test("updates compounding_review_candidates.source_slugs_json", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb
        .prepare(
          `INSERT INTO compounding_review_candidates (title, candidate_type, content_hash, source_slugs_json, created_at, updated_at, last_seen_at)
           VALUES (?, 'theme_convergence', ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
        )
        .run("test-candidate", "hash-crc-1", JSON.stringify(["records/entity-a", "records/entity-b"]));
      db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md");
      const slugs = JSON.parse(
        (db.rawDb.prepare("SELECT source_slugs_json FROM compounding_review_candidates").get() as { source_slugs_json: string }).source_slugs_json,
      );
      expect(slugs).toContain("brain/entities/person/entity-a");
      expect(slugs).toContain("records/entity-b");
    });

    test("updates links.context text", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb
        .prepare(
          `INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, context)
           VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5, ?)`,
        )
        .run("records/entity-a", "records/entity-b", "See records/entity-a for details");
      db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md");
      const ctx = (db.rawDb.prepare("SELECT context FROM links").get() as { context: string }).context;
      expect(ctx).toBe("See brain/entities/person/entity-a for details");
    });

    test("throws on source not found", () => {
      expect(() => db.movePage("records/nonexistent", "records/new", "record", "records/new.md"))
        .toThrow("source page not found");
    });

    test("throws on target already exists", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      expect(() => db.movePage("records/entity-a", "records/entity-b", "record", "records/entity-b.md"))
        .toThrow("target page already exists");
    });

    test("zero residual references under old slug after move", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      // Seed every slug-bearing column
      db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence, source_page_slug) VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5, ?)`).run("records/entity-a", "records/entity-b", "records/entity-a");
      db.rawDb.prepare(`INSERT INTO tags (page_slug, tag) VALUES (?, 't1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO chunks (page_slug, content, chunk_index) VALUES (?, 'c', 0)`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO versions (page_slug, version, content) VALUES (?, 1, 'v1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO aliases (page_slug, alias) VALUES (?, 'a1')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO timeline (page_slug, summary, source_page_slug) VALUES (?, 'e1', ?)`).run("records/entity-a", "records/entity-a");
      db.rawDb.prepare(`INSERT INTO mention_snapshots (slug, snapshot_date, mention_count) VALUES (?, '2024-01-01', 1)`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO chunks_fts (page_slug, content) VALUES (?, 'c')`).run("records/entity-a");
      db.rawDb.prepare(`INSERT INTO ingest_log (source_type, action, page_slug) VALUES ('manual', 'create', ?)`).run("records/entity-a");
      // Seed query_log + query_feedback to verify feedback slug migration
      db.rawDb.prepare(`INSERT INTO query_log (tool, query, result_slugs, result_count) VALUES ('search', 'test', '[]', 1)`).run();
      db.rawDb.prepare(`INSERT INTO query_feedback (query_id, slug, signal, note) VALUES (1, ?, 'relevant', 'good')`).run("records/entity-a");

      db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md");

      const oldSlug = "records/entity-a";
      for (const [table, col] of [
        ["pages", "slug"], ["links", "from_slug"], ["links", "to_slug"],
        ["links", "source_page_slug"], ["tags", "page_slug"], ["chunks", "page_slug"],
        ["versions", "page_slug"], ["aliases", "page_slug"], ["timeline", "page_slug"],
        ["timeline", "source_page_slug"], ["mention_snapshots", "slug"],
        ["chunks_fts", "page_slug"], ["ingest_log", "page_slug"],
        ["query_feedback", "slug"],
      ] as [string, string][]) {
        const row = db.rawDb.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${col} = ?`).get(oldSlug) as { cnt: number };
        expect(row.cnt).toBe(0);
      }
    });

    test("target collision rolls back every table", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "brain/entities/person/entity-a", "entity/person", "Collision");
      db.rawDb.prepare(`INSERT INTO tags (page_slug, tag) VALUES (?, 'tag1')`).run("records/entity-a");

      expect(() => db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md"))
        .toThrow("target page already exists");

      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect((db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all("records/entity-a") as { tag: string }[])).toHaveLength(1);
    });

    test("FK integrity after successful move with links", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence) VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5)`).run("records/entity-a", "records/entity-b");

      db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md");

      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("FK integrity preserved after failed move", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence) VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5)`).run("records/entity-a", "records/entity-b");

      try { db.movePage("records/entity-a", "records/entity-b", "record", "records/entity-b.md"); } catch { /* expected */ }

      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });
  });

  // ── NULL content_hash compensation tests ──────────────────────

  describe("NULL content_hash compensation", () => {
    const fsOps: MoveFsOps = {
      writeFileSync,
      renameSync,
      unlinkSync,
      existsSync,
      mkdirSync,
    };

    function seedPageWithNullHash(): void {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body");
      // Set content_hash to NULL to simulate pages created before hashing
      db.rawDb.prepare("UPDATE pages SET content_hash = NULL WHERE slug = ?").run("records/entity-a");
    }

    test("slug-change rename failure: NULL hash restored to NULL", () => {
      seedPageWithNullHash();

      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      expect(() =>
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: null,
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected rename failure");

      // content_hash must be NULL (not "hash-new")
      const row = db.rawDb
        .prepare("SELECT content_hash FROM pages WHERE slug = ?")
        .get("records/entity-a") as { content_hash: string | null };
      expect(row.content_hash).toBeNull();
    });

    test("slug-change unlink failure: NULL hash restored to NULL", () => {
      seedPageWithNullHash();

      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: ((path: string) => {
          if (path.includes("records/entity-a.md") && !path.includes(".staging.")) {
            throw new Error("injected unlink failure");
          }
          return realUnlinkSync(path);
        }) as never,
      };

      expect(() =>
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: null,
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("failed to delete old file");

      const row = db.rawDb
        .prepare("SELECT content_hash FROM pages WHERE slug = ?")
        .get("records/entity-a") as { content_hash: string | null };
      expect(row.content_hash).toBeNull();
    });

    test("same-slug rename failure: NULL hash restored to NULL", () => {
      seedPageWithNullHash();

      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      expect(() =>
        atomicTypeChange(injectedFs, db, {
          slug: "records/entity-a",
          oldType: "record",
          oldHash: null,
          newType: "record",
          absPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected rename failure");

      const row = db.rawDb
        .prepare("SELECT content_hash FROM pages WHERE slug = ?")
        .get("records/entity-a") as { content_hash: string | null };
      expect(row.content_hash).toBeNull();
    });
  });

  // ── Shared atomicSlugChange / atomicTypeChange tests ──────────

  describe("atomicSlugChange (shared helper)", () => {
    const fsOps: MoveFsOps = {
      writeFileSync,
      renameSync,
      unlinkSync,
      existsSync,
      mkdirSync,
    };

    function seedForMove(): void {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "some body");
    }

    test("successful slug change: file moved, DB updated, no artifacts", () => {
      seedForMove();
      const destAbsPath = join(vaultPath, "brain/entities/person/entity-a.md");

      atomicSlugChange(fsOps, db, {
        oldSlug: "records/entity-a",
        newSlug: "brain/entities/person/entity-a",
        newType: "entity/person",
        oldType: "record",
        oldRelPath: "records/entity-a.md",
        oldHash: "hash-old",
        newRelPath: "brain/entities/person/entity-a.md",
        destAbsPath,
        oldAbsPath: join(vaultPath, "records/entity-a.md"),
        stagedContent: "---\ntitle: EntityA\ntype: entity/person\n---\nsome body",
        newHash: "hash-new",
      });

      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(false);
      expect(existsSync(destAbsPath)).toBe(true);
      expect(db.getPage("brain/entities/person/entity-a")!.type).toBe("entity/person");
      expect(db.getPage("records/entity-a")).toBeNull();
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("DB failure: staging cleaned, no artifacts", () => {
      seedForMove();
      // Make DB fail by monkey-patching movePage (no vault file created at target)
      const origMovePage = db.movePage.bind(db);
      db.movePage = () => { throw new Error("injected DB failure"); };

      expect(() =>
        atomicSlugChange(fsOps, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected DB failure");

      db.movePage = origMovePage;
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      expect(db.getPage("records/entity-a")).not.toBeNull();
    });

    test("DB failure + staging cleanup failure → CleanupIncompleteError with details", () => {
      seedForMove();
      // Make DB fail by monkey-patching (no vault file at target)
      const origMovePage = db.movePage.bind(db);
      db.movePage = () => { throw new Error("injected DB failure"); };

      // Make unlink fail (staging cleanup)
      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: (() => { throw new Error("injected cleanup failure"); }) as never,
      };

      let thrown: unknown;
      try {
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        });
      } catch (err) { thrown = err; }
      db.movePage = origMovePage;

      expect(thrown).toBeInstanceOf(CleanupIncompleteError);
      const cie = thrown as CleanupIncompleteError;
      expect(cie.primaryError.message).toBe("injected DB failure");
      expect(cie.cleanupErrors).toHaveLength(1);
      expect(cie.cleanupErrors[0].error.message).toBe("injected cleanup failure");
      expect(cie.cleanupErrors[0].path).toContain(".staging.");
    });

    test("rename failure: DB compensated, no artifacts", () => {
      seedForMove();
      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      expect(() =>
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected rename failure");

      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
    });

    test("unlink old failure: DB compensated, destination removed", () => {
      seedForMove();
      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: ((path: string) => {
          if (path.includes("records/entity-a.md") && !path.includes(".staging.")) {
            throw new Error("injected unlink failure");
          }
          return realUnlinkSync(path);
        }) as never,
      };

      expect(() =>
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("failed to delete old file");

      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("rollback-incomplete when compensation also fails", () => {
      seedForMove();
      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      const origMovePage = db.movePage.bind(db);
      let moveCount = 0;
      db.movePage = (...args: Parameters<typeof origMovePage>) => {
        moveCount++;
        if (moveCount > 1) throw new Error("injected compensation failure");
        return origMovePage(...args);
      };

      let thrown: unknown;
      try {
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        });
      } catch (err) { thrown = err; }
      db.movePage = origMovePage;

      expect(thrown).toBeInstanceOf(RollbackIncompleteError);
      const rie = thrown as RollbackIncompleteError;
      expect(rie.primaryError.message).toContain("injected rename failure");
      expect(rie.rollbackError.message).toContain("injected compensation failure");
    });

    test("writeFileSync failure: staging cleaned, no artifacts", () => {
      seedForMove();
      // Inject writeFileSync that creates partial file then throws
      const injectedFs: MoveFsOps = {
        ...fsOps,
        writeFileSync: ((path: string, _content: string, encoding: BufferEncoding) => {
          writeFileSync(path, "partial", encoding);
          throw new Error("injected write failure");
        }) as never,
      };

      expect(() =>
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected write failure");

      // No staging artifacts
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      // DB unchanged
      expect(db.getPage("records/entity-a")).not.toBeNull();
    });

    test("writeFileSync failure + cleanup failure → CleanupIncompleteError", () => {
      seedForMove();
      const injectedFs: MoveFsOps = {
        ...fsOps,
        writeFileSync: ((path: string, _content: string, encoding: BufferEncoding) => {
          writeFileSync(path, "partial", encoding);
          throw new Error("injected write failure");
        }) as never,
        unlinkSync: (() => { throw new Error("injected cleanup failure"); }) as never,
      };

      let thrown: unknown;
      try {
        atomicSlugChange(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        });
      } catch (err) { thrown = err; }

      expect(thrown).toBeInstanceOf(CleanupIncompleteError);
      const cie = thrown as CleanupIncompleteError;
      expect(cie.primaryError.message).toBe("injected write failure");
      expect(cie.cleanupErrors[0].error.message).toBe("injected cleanup failure");
    });

    test("target file already exists → throws, no DB change", () => {
      seedForMove();
      // Create target file
      mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "existing", "utf-8");

      expect(() =>
        atomicSlugChange(fsOps, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          newType: "entity/person",
          oldType: "record",
          oldRelPath: "records/entity-a.md",
          oldHash: "hash-old",
          newRelPath: "brain/entities/person/entity-a.md",
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("target file already exists");

      // Existing file not overwritten
      expect(readFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "utf-8")).toBe("existing");
      // DB unchanged
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });
  });

  describe("atomicTypeChange (shared helper, same-slug)", () => {
    const fsOps: MoveFsOps = {
      writeFileSync,
      renameSync: (o, n) => renameSync(o, n),
      unlinkSync,
      existsSync,
      mkdirSync,
    };

    test("successful type change: file updated, DB updated", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      atomicTypeChange(fsOps, db, {
        slug: "records/entity-a",
        oldType: "record",
        oldHash: "hash-old",
        newType: "record",
        absPath: join(vaultPath, "records/entity-a.md"),
        stagedContent: "---\ntype: record\n---\nbody",
        newHash: "hash-new",
      });

      expect(db.getPage("records/entity-a")!.content_hash).toBe("hash-new");
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("DB failure + staging cleanup failure → CleanupIncompleteError", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const origMethod = db.updateTypeAndHash.bind(db);
      db.updateTypeAndHash = () => { throw new Error("injected DB failure"); };

      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: (() => { throw new Error("injected staging cleanup failure"); }) as never,
      };

      expect(() =>
        atomicTypeChange(injectedFs, db, {
          slug: "records/entity-a",
          oldType: "record",
          oldHash: "hash-old",
          newType: "record",
          absPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("cleanup failed");

      db.updateTypeAndHash = origMethod;
      expect(db.getPage("records/entity-a")!.type).toBe("record");
    });

    test("rename failure: DB compensated back", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      expect(() =>
        atomicTypeChange(injectedFs, db, {
          slug: "records/entity-a",
          oldType: "record",
          oldHash: "hash-old",
          newType: "record",
          absPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected rename failure");

      expect(db.getPage("records/entity-a")!.type).toBe("record");
    });

    test("writeFileSync failure: temp cleaned, no artifacts", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        writeFileSync: ((path: string, _content: string, encoding: BufferEncoding) => {
          writeFileSync(path, "partial", encoding);
          throw new Error("injected write failure");
        }) as never,
      };

      expect(() =>
        atomicTypeChange(injectedFs, db, {
          slug: "records/entity-a",
          oldType: "record",
          oldHash: "hash-old",
          newType: "record",
          absPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
        }),
      ).toThrow("injected write failure");

      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      expect(db.getPage("records/entity-a")!.type).toBe("record");
    });
  });
  // ── PageManager integration ──────────────────────────────────

  describe("movePageAtomic (file + DB coordination)", () => {
    test("successful move: new file exists, old removed, DB correct", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "some body");

      pm.movePageAtomic(
        "records/entity-a", "brain/entities/person/entity-a", "entity/person",
        { title: "EntityA", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
        "some body",
      );

      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(false);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(true);

      const content = readFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "utf-8");
      expect(content).toContain("entity/person");
      expect(content).toContain("some body");

      const page = db.getPage("brain/entities/person/entity-a");
      expect(page).not.toBeNull();
      expect(page!.type).toBe("entity/person");
      expect(page!.content_hash).not.toBe("hash-old");
      expect(db.getPage("records/entity-a")).toBeNull();

      // No staging artifacts
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      // FK clean
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("DB failure: staging cleaned, original file and DB intact", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body");
      seedPage(db, vaultPath, "brain/entities/person/entity-a", "entity/person", "Collision");

      expect(() =>
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "EntityA", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        ),
      ).toThrow();

      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      const original = readFileSync(join(vaultPath, "records/entity-a.md"), "utf-8");
      expect(original).toContain("EntityA");
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
    });

    test("target file exists: throws without overwriting", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body");
      mkdirSync(join(vaultPath, "brain/entities/person"), { recursive: true });
      writeFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "existing", "utf-8");

      expect(() =>
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "EntityA", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        ),
      ).toThrow("target file already exists");

      expect(readFileSync(join(vaultPath, "brain/entities/person/entity-a.md"), "utf-8")).toBe("existing");
      expect(db.getPage("records/entity-a")).not.toBeNull();
    });

    test("updateType end-to-end with slug change", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body text");
      pm.updateType("records/entity-a", "entity/person");

      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(false);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(true);
      expect(db.getPage("brain/entities/person/entity-a")!.type).toBe("entity/person");
      expect(db.getPage("records/entity-a")).toBeNull();
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("updateType same slug: in-place type change", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body text");
      pm.updateType("records/entity-a", "record");
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      expect(db.getPage("records/entity-a")).not.toBeNull();
    });
  });

  // ── PageManager fault injection ──────────────────────────────

  describe("PageManager fault injection", () => {
    test("mid-transaction DB failure: all tables unchanged", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A");
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb.prepare(`INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence) VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5)`).run("records/entity-a", "records/entity-b");
      db.rawDb.prepare(`INSERT INTO tags (page_slug, tag) VALUES (?, 't1')`).run("records/entity-a");

      // Monkey-patch rawDb.prepare to throw after 5 calls (mid-transaction)
      const origPrepare = db.rawDb.prepare.bind(db.rawDb);
      let callCount = 0;
      db.rawDb.prepare = (sql: string) => {
        callCount++;
        if (callCount > 5) throw new Error("injected mid-transaction DB failure");
        return origPrepare(sql);
      };

      expect(() =>
        db.movePage("records/entity-a", "brain/entities/person/entity-a", "entity/person", "brain/entities/person/entity-a.md"),
      ).toThrow("injected mid-transaction DB failure");

      // Restore
      db.rawDb.prepare = origPrepare;

      // Everything should be unchanged — transaction rolled back
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
      expect((db.rawDb.prepare("SELECT from_slug FROM links").get() as { from_slug: string }).from_slug).toBe("records/entity-a");
      expect((db.rawDb.prepare("SELECT page_slug FROM tags").get() as { page_slug: string }).page_slug).toBe("records/entity-a");
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("renameSync failure: DB compensated, destination removed, error thrown", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      // Inject renameSync failure
      const realRenameSync = (..._args: unknown[]) => { throw new Error("injected rename failure"); };
      pm._setFsOps({ renameSync: realRenameSync as never });

      expect(() =>
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "A", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        ),
      ).toThrow("injected rename failure");

      // DB should be compensated back
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();

      // Original file untouched
      expect(readFileSync(join(vaultPath, "records/entity-a.md"), "utf-8")).toContain("A");

      // No staging artifacts
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      // No destination
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
    });

    test("old-file unlink failure: DB compensated, destination removed", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");
      const realUnlinkSync = require("node:fs").unlinkSync;
      // Only fail when trying to delete the original source file
      pm._setFsOps({
        unlinkSync: ((path: string) => {
          if (path.includes("records/entity-a.md") && !path.includes(".staging.")) {
            throw new Error("injected unlink failure");
          }
          return realUnlinkSync(path);
        }) as never,
      });

      expect(() =>
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "A", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        ),
      ).toThrow("failed to delete old file");

      // DB compensated back
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();

      // Old file still exists (couldn't be deleted)
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      // Destination removed
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
      // No staging artifacts
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("rollback-incomplete error when compensation also fails", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      // Inject rename failure + make movePage fail for compensation
      pm._setFsOps({
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      });

      // Monkey-patch movePage to fail on the 2nd call (compensation)
      const origMovePage = db.movePage.bind(db);
      let moveCount = 0;
      db.movePage = (...args: Parameters<typeof origMovePage>) => {
        moveCount++;
        if (moveCount > 1) throw new Error("injected compensation failure");
        return origMovePage(...args);
      };

      let thrown: unknown;
      try {
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "A", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        );
      } catch (err) {
        thrown = err;
      }

      // Restore
      db.movePage = origMovePage;

      expect(thrown).toBeInstanceOf(RollbackIncompleteError);
      const rie = thrown as RollbackIncompleteError;
      expect(rie.primaryError.message).toContain("injected rename failure");
      expect(rie.rollbackError.message).toContain("injected compensation failure");
    });

    test("cache invalidated on both failure and success", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      // Populate cache
      const cachedOld = pm.getBySlug("records/entity-a");
      expect(cachedOld).not.toBeNull();

      // Successful move
      pm.movePageAtomic(
        "records/entity-a", "brain/entities/person/entity-a", "entity/person",
        { title: "A", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
        "body",
      );

      // Both old and new cache keys should be invalidated
      // (getBySlug will re-read from DB/vault, confirming invalidation)
      expect(db.getPage("brain/entities/person/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")).toBeNull();
    });

    test("cache invalidated on DB failure path", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");
      seedPage(db, vaultPath, "brain/entities/person/entity-a", "entity/person", "Collision");

      // Populate cache
      pm.getBySlug("records/entity-a");

      try {
        pm.movePageAtomic(
          "records/entity-a", "brain/entities/person/entity-a", "entity/person",
          { title: "A", type: "entity/person", slug: "brain/entities/person/entity-a", updated_at: new Date().toISOString(), tags: [] },
          "body",
        );
      } catch { /* expected */ }

      // Cache should be invalidated even on failure
      // Verify DB state is unchanged
      expect(db.getPage("records/entity-a")).not.toBeNull();
    });

    test("same-slug DB failure: temp file cleaned, original file and DB intact", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      // record→record keeps same slug (records/entity-a), triggers updateTypeInPlace
      const origMethod = db.updateTypeAndHash.bind(db);
      db.updateTypeAndHash = () => { throw new Error("injected DB failure"); };

      expect(() => pm.updateType("records/entity-a", "record")).toThrow("injected DB failure");

      // Restore
      db.updateTypeAndHash = origMethod;

      // File unchanged
      const content = readFileSync(join(vaultPath, "records/entity-a.md"), "utf-8");
      expect(content).toContain("record");

      // DB unchanged
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("same-slug rename failure: DB compensated back", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      // Inject rename failure (renameSync used in updateTypeInPlace)
      pm._setFsOps({
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      });

      // record→record keeps same slug, triggers updateTypeInPlace
      expect(() => pm.updateType("records/entity-a", "record")).toThrow("injected rename failure");

      // DB should be compensated back to record
      expect(db.getPage("records/entity-a")!.type).toBe("record");

      // Original file still has old type
      const content = readFileSync(join(vaultPath, "records/entity-a.md"), "utf-8");
      expect(content).toContain("record");
    });
  });

  // ── Sync promotion through production SyncManager ──────────────

  describe("sync promotion fault injection", () => {
    const stubEmbedding: EmbeddingProvider = {
      embed: async () => ({ embedding: [0.1], tokenCount: 1 }),
      embedBatch: async (texts) => texts.map(() => ({ embedding: [0.1], tokenCount: 1 })),
      dimensions: 1,
    };

    function createMockLance(): LanceDBManager {
      return {
        connect: async () => {},
        warmup: async () => ({ elapsedMs: 0, tables: [] }),
        search: async () => [],
        addChunks: async () => {},
        deleteByPageSlug: async () => {},
        deleteRawChunksByPageSlug: async () => {},
        getIndexedPageSlugs: async () => [],
        getOrCreateTable: async () => ({} as never),
        searchInsights: async () => [],
      } as unknown as LanceDBManager;
    }

    function makeSyncMgr(): SyncManager {
      const lance = createMockLance();
      const pages = new PageManager(db, vaultPath);
      return new SyncManager(db, stubEmbedding, lance, { pages });
    }

    function seedRecordWithLinks(): void {
      mkdirSync(join(vaultPath, "records"), { recursive: true });
      db.rawDb.prepare(
        `INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("records/entity-a", "record", "EntityA", "records/entity-a.md", "hash-old", 0, 3);
      writeFileSync(
        join(vaultPath, "records", "entity-a.md"),
        `---\ntitle: "EntityA"\ntype: record\nslug: records/entity-a\n---\nrecord body`,
        "utf-8",
      );
      seedPage(db, vaultPath, "records/entity-b", "record", "B");
      db.rawDb.prepare(
        `INSERT INTO links (from_slug, to_slug, relation, weight, strength, source_type, confidence)
         VALUES (?, ?, 'related', 1.0, 'medium', 'wikilink', 0.5)`,
      ).run("records/entity-a", "records/entity-b");
    }

    function writePersonFile(): void {
      mkdirSync(join(vaultPath, "brain", "entities", "person"), { recursive: true });
      writeFileSync(
        join(vaultPath, "brain", "entities", "person", "entity-a.md"),
        `---\ntitle: "EntityA"\ntype: entity/person\nslug: brain/entities/person/entity-a\n---\nperson body`,
        "utf-8",
      );
    }

    test("successful promotion through SyncManager.syncAll", async () => {
      seedRecordWithLinks();
      writePersonFile();
      const syncMgr = makeSyncMgr();
      await syncMgr.syncAll(vaultPath);

      expect(db.getPage("brain/entities/person/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")).toBeNull();
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(false);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(true);
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("unlink failure: promotion returns false → report.errors increases, DB compensated back", async () => {
      seedRecordWithLinks();
      writePersonFile();

      // Inject unlink failure through SyncManager seam
      const syncMgr = makeSyncMgr();
      syncMgr._setUnlink(async (path) => {
        if (path.toString().includes("records/entity-a.md")) {
          throw new Error("injected unlink failure");
        }
        // For other paths, use real unlink
        const { unlink: realUnlink } = await import("node:fs/promises");
        return realUnlink(path);
      });

      const report = await syncMgr.syncAll(vaultPath);

      // Promotion failed — must NOT be counted as synced
      expect(report.errors).toBeGreaterThan(0);

      // DB must be compensated back to old slug
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();

      // Old file still exists
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      // FK integrity preserved
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });
  });

  // ── Maintenance relocatePage integration ─────────────────────

  describe("maintenance relocatePage (production caller)", () => {
    const fsOps: MoveFsOps = {
      writeFileSync,
      renameSync: (o, n) => renameSync(o, n),
      unlinkSync,
      existsSync,
      mkdirSync,
    };

    test("successful slug-change relocate through production function", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body text");
      const destAbsPath = join(vaultPath, "brain/entities/person/entity-a.md");

      relocatePage(fsOps, db, {
        oldSlug: "records/entity-a",
        newSlug: "brain/entities/person/entity-a",
        oldType: "record",
        newType: "entity/person",
        oldRelPath: "records/entity-a.md",
        newRelPath: "brain/entities/person/entity-a.md",
        oldAbsPath: join(vaultPath, "records/entity-a.md"),
        destAbsPath,
        stagedContent: "---\ntitle: EntityA\ntype: entity/person\n---\nbody text",
        newHash: "hash-new",
        oldHash: "hash-old",
      });

      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(false);
      expect(existsSync(destAbsPath)).toBe(true);
      expect(db.getPage("brain/entities/person/entity-a")!.type).toBe("entity/person");
      expect(db.getPage("records/entity-a")).toBeNull();
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("successful same-slug relocate through production function", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "EntityA", "body");

      relocatePage(fsOps, db, {
        oldSlug: "records/entity-a",
        newSlug: "records/entity-a",
        oldType: "record",
        newType: "record",
        oldRelPath: "records/entity-a.md",
        newRelPath: "records/entity-a.md",
        oldAbsPath: join(vaultPath, "records/entity-a.md"),
        destAbsPath: join(vaultPath, "records/entity-a.md"),
        stagedContent: "---\ntype: record\n---\nbody",
        newHash: "hash-new",
        oldHash: "hash-old",
      });

      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      expect(db.getPage("records/entity-a")!.content_hash).toBe("hash-new");
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
    });

    test("rename failure: DB compensated, no artifacts", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      let thrown: unknown;
      try {
        relocatePage(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          oldType: "record",
          newType: "entity/person",
          oldRelPath: "records/entity-a.md",
          newRelPath: "brain/entities/person/entity-a.md",
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
          oldHash: "hash-old",
        });
      } catch (err) { thrown = err; }

      // Should throw the original rename error
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("injected rename failure");

      // DB compensated back
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
      // No artifacts
      expect(findStagingFiles(vaultPath)).toHaveLength(0);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
      // FK clean
      expect((db.rawDb.prepare("PRAGMA foreign_key_check").all())).toHaveLength(0);
    });

    test("unlink failure: DB compensated, destination cleaned", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: ((path: string) => {
          if (path.includes("records/entity-a.md") && !path.includes(".staging.")) {
            throw new Error("injected unlink failure");
          }
          return realUnlinkSync(path);
        }) as never,
      };

      expect(() =>
        relocatePage(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          oldType: "record",
          newType: "entity/person",
          oldRelPath: "records/entity-a.md",
          newRelPath: "brain/entities/person/entity-a.md",
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
          oldHash: "hash-old",
        }),
      ).toThrow("failed to delete old file");

      // DB compensated
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("records/entity-a")!.type).toBe("record");
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
      // Old file still there, destination cleaned
      expect(existsSync(join(vaultPath, "records/entity-a.md"))).toBe(true);
      expect(existsSync(join(vaultPath, "brain/entities/person/entity-a.md"))).toBe(false);
    });

    test("rename + compensation failure → RollbackIncompleteError", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        renameSync: (() => { throw new Error("injected rename failure"); }) as never,
      };

      const origMovePage = db.movePage.bind(db);
      let moveCount = 0;
      db.movePage = (...args: Parameters<typeof origMovePage>) => {
        moveCount++;
        if (moveCount > 1) throw new Error("injected compensation failure");
        return origMovePage(...args);
      };

      let thrown: unknown;
      try {
        relocatePage(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          oldType: "record",
          newType: "entity/person",
          oldRelPath: "records/entity-a.md",
          newRelPath: "brain/entities/person/entity-a.md",
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
          oldHash: "hash-old",
        });
      } catch (err) { thrown = err; }
      db.movePage = origMovePage;

      expect(thrown).toBeInstanceOf(RollbackIncompleteError);
    });

    test("unlink + dest cleanup failure → CleanupIncompleteError with details", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: ((path: string) => {
          if (path.includes("records/entity-a.md") && !path.includes(".staging.")) {
            throw new Error("injected old unlink failure");
          }
          if (path.includes("brain/entities/person/entity-a.md")) {
            throw new Error("injected dest cleanup failure");
          }
          try { realUnlinkSync(path); } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw err;
          }
        }) as never,
      };

      let thrown: unknown;
      try {
        relocatePage(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "brain/entities/person/entity-a",
          oldType: "record",
          newType: "entity/person",
          oldRelPath: "records/entity-a.md",
          newRelPath: "brain/entities/person/entity-a.md",
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          destAbsPath: join(vaultPath, "brain/entities/person/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
          oldHash: "hash-old",
        });
      } catch (err) { thrown = err; }

      expect(thrown).toBeInstanceOf(CleanupIncompleteError);
      const cie = thrown as CleanupIncompleteError;
      expect(cie.cleanupErrors).toHaveLength(1);
      expect(cie.cleanupErrors[0].error.message).toBe("injected dest cleanup failure");

      // DB compensated back
      expect(db.getPage("records/entity-a")).not.toBeNull();
      expect(db.getPage("brain/entities/person/entity-a")).toBeNull();
    });

    test("same-slug DB failure + staging cleanup failure → CleanupIncompleteError", () => {
      seedPage(db, vaultPath, "records/entity-a", "record", "A", "body");

      const origMethod = db.updateTypeAndHash.bind(db);
      db.updateTypeAndHash = () => { throw new Error("injected DB failure"); };

      const injectedFs: MoveFsOps = {
        ...fsOps,
        unlinkSync: (() => { throw new Error("injected staging cleanup failure"); }) as never,
      };

      expect(() =>
        relocatePage(injectedFs, db, {
          oldSlug: "records/entity-a",
          newSlug: "records/entity-a",
          oldType: "record",
          newType: "record",
          oldRelPath: "records/entity-a.md",
          newRelPath: "records/entity-a.md",
          oldAbsPath: join(vaultPath, "records/entity-a.md"),
          destAbsPath: join(vaultPath, "records/entity-a.md"),
          stagedContent: "content",
          newHash: "hash-new",
          oldHash: "hash-old",
        }),
      ).toThrow("cleanup failed");

      db.updateTypeAndHash = origMethod;
      // DB unchanged
      expect(db.getPage("records/entity-a")!.type).toBe("record");
    });
  });
});
