import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";

function insertPage(db: CBrainDB, slug: string, title: string, type: string, mentionCount = 0) {
  db.rawDb.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(slug, type, title, `${slug}.md`, `h-${slug}`, mentionCount);
}

describe("GraphManager", () => {
  const testDir = "/tmp/cbrain-test-graph";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;
  let graph: GraphManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
    graph = new GraphManager(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("addLink / removeLink", () => {
    test("adds and retrieves a link", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b");

      const links = graph.getLinks("entities/a", "outgoing");
      expect(links.length).toBe(1);
      expect(links[0].to_slug).toBe("entities/b");
      expect(links[0].relation).toBe("mentions");
    });

    test("addLink with custom relation", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b", "works_with");

      const links = graph.getLinks("entities/a", "outgoing");
      expect(links[0].relation).toBe("works_with");
    });

    test("addLink with context", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b", "mentions", "同在一个项目组");

      const links = graph.getLinks("entities/a", "outgoing");
      expect(links[0].context).toBe("同在一个项目组");
    });

    test("addLink ignores duplicate", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/a", "entities/b");

      const links = graph.getLinks("entities/a", "outgoing");
      expect(links.length).toBe(1);
    });

    test("removeLink returns true for existing link", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b");
      const removed = graph.removeLink("entities/a", "entities/b");
      expect(removed).toBe(true);

      const links = graph.getLinks("entities/a", "outgoing");
      expect(links.length).toBe(0);
    });

    test("removeLink returns false for non-existing link", () => {
      const removed = graph.removeLink("entities/x", "entities/y");
      expect(removed).toBe(false);
    });
  });

  describe("getLinks", () => {
    test("outgoing links only", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/a");

      const out = graph.getLinks("entities/a", "outgoing");
      expect(out.length).toBe(1);
      expect(out[0].to_slug).toBe("entities/b");
    });

    test("incoming links only", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/b");

      const inc = graph.getLinks("entities/b", "incoming");
      expect(inc.length).toBe(2);
    });

    test("both directions", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/a");

      const all = graph.getLinks("entities/a", "both");
      expect(all.length).toBe(2);
    });
  });

  describe("getBacklinks", () => {
    test("returns pages linking to slug", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/b");

      const backlinks = graph.getBacklinks("entities/b");
      const fromSlugs = backlinks.map((l) => l.from_slug);
      expect(fromSlugs).toContain("entities/a");
      expect(fromSlugs).toContain("entities/c");
    });
  });

  describe("traverse", () => {
    test("BFS depth-2 traversal", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");
      insertPage(db, "entities/d", "D", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/a", "entities/c");
      graph.addLink("entities/b", "entities/d");

      const results = graph.traverse("entities/a", { maxDepth: 2 });
      const slugs = results.map((r) => r.slug);

      expect(slugs).toContain("entities/b");
      expect(slugs).toContain("entities/c");
      expect(slugs).toContain("entities/d");
      expect(slugs).not.toContain("entities/a");
    });

    test("excludes seed from results", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/b", "entities/a");

      const results = graph.traverse("entities/a", { maxDepth: 2 });
      expect(results.every((r) => r.slug !== "entities/a")).toBe(true);
    });

    test("respects limit", () => {
      insertPage(db, "entities/seed", "Seed", "entity");
      for (let i = 0; i < 10; i++) {
        insertPage(db, `entities/n${i}`, `N${i}`, "entity");
        graph.addLink("entities/seed", `entities/n${i}`);
      }

      const results = graph.traverse("entities/seed", { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    test("filters by relation", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b", "mentions");
      graph.addLink("entities/a", "entities/c", "works_with");

      const mentions = graph.traverse("entities/a", { relation: "mentions" });
      expect(mentions.length).toBe(1);
      expect(mentions[0].slug).toBe("entities/b");
    });

    test("outgoing only traversal", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/a");

      const out = graph.traverse("entities/a", { direction: "outgoing" });
      expect(out.length).toBe(1);
      expect(out[0].slug).toBe("entities/b");
    });

    test("returns empty for isolated node", () => {
      insertPage(db, "entities/solo", "Solo", "entity");

      const results = graph.traverse("entities/solo");
      expect(results).toEqual([]);
    });

    test("reports correct depth", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");
      insertPage(db, "entities/c", "C", "entity");

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/b", "entities/c");

      const results = graph.traverse("entities/a", { maxDepth: 2 });
      const b = results.find((r) => r.slug === "entities/b");
      const c = results.find((r) => r.slug === "entities/c");
      expect(b?.depth).toBe(1);
      expect(c?.depth).toBe(2);
    });
  });

  describe("getRelatedEntities", () => {
    test("returns direct neighbors sorted by mention count", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity", 5);
      insertPage(db, "entities/c", "C", "entity", 10);

      graph.addLink("entities/a", "entities/b");
      graph.addLink("entities/c", "entities/a");

      const related = graph.getRelatedEntities("entities/a");
      const slugs = related.map((r) => r.slug);
      expect(slugs).toContain("entities/b");
      expect(slugs).toContain("entities/c");
      // c has higher mention_count, should come first
      expect(slugs[0]).toBe("entities/c");
    });

    test("excludes self", () => {
      insertPage(db, "entities/a", "A", "entity");
      insertPage(db, "entities/b", "B", "entity");

      graph.addLink("entities/a", "entities/b");

      const related = graph.getRelatedEntities("entities/a");
      expect(related.every((r) => r.slug !== "entities/a")).toBe(true);
    });

    test("respects limit", () => {
      insertPage(db, "entities/seed", "Seed", "entity");
      for (let i = 0; i < 10; i++) {
        insertPage(db, `entities/n${i}`, `N${i}`, "entity");
        graph.addLink("entities/seed", `entities/n${i}`);
      }

      const related = graph.getRelatedEntities("entities/seed", 3);
      expect(related.length).toBeLessThanOrEqual(3);
    });
  });

  describe("#233: candidate reports_to excluded from default graph reads", () => {
    const SEED = "entities/seed";
    const TRUSTED = "entities/trusted";
    const WEAK = "entities/weak";
    const MENTION = "entities/mention-target";

    beforeEach(() => {
      for (const s of [SEED, TRUSTED, WEAK, MENTION]) {
        insertPage(db, s, s, "entity/person");
      }
      db.upsertActiveReportsTo(SEED, TRUSTED, "agent", 0.95); // trusted reports_to
      db.insertLink(SEED, WEAK, "reports_to", null, 0.5, "weak", "ner", 0.5); // candidate reports_to
      db.insertLink(SEED, MENTION, "提及", null, 0.3, "weak", "ner", 0.5); // ordinary candidate, non-reports_to
    });

    test("traverse() default branch excludes candidate reports_to, keeps ordinary candidate", () => {
      const slugs = graph.traverse(SEED, { direction: "outgoing", maxDepth: 1 }).map((r) => r.slug);
      expect(slugs).toContain(TRUSTED);
      expect(slugs).not.toContain(WEAK);
      expect(slugs).toContain(MENTION);
    });

    test("traverse() minWeight branch excludes candidate reports_to", () => {
      // candidate reports_to effective_weight ~0.25, passes minWeight 0.1 by weight
      const slugs = graph.traverse(SEED, { direction: "outgoing", maxDepth: 1, minWeight: 0.1 }).map((r) => r.slug);
      expect(slugs).toContain(TRUSTED);
      expect(slugs).not.toContain(WEAK);
    });

    test("traverse() relation=reports_to returns only trusted", () => {
      const slugs = graph.traverse(SEED, { direction: "outgoing", maxDepth: 1, relation: "reports_to" }).map((r) => r.slug);
      expect(slugs).toEqual([TRUSTED]);
    });

    test("getLinks() excludes candidate reports_to, keeps ordinary candidate", () => {
      const out = graph.getLinks(SEED, "outgoing");
      const reportsTargets = out.filter((l) => l.relation === "reports_to").map((l) => l.to_slug);
      expect(reportsTargets).toEqual([TRUSTED]);
      expect(out.some((l) => l.relation === "提及")).toBe(true);
    });

    test("getBacklinks() excludes candidate reports_to", () => {
      expect(graph.getBacklinks(TRUSTED).filter((l) => l.relation === "reports_to")).toHaveLength(1);
      expect(graph.getBacklinks(WEAK).filter((l) => l.relation === "reports_to")).toHaveLength(0);
    });

    test("getRelatedEntities() excludes candidate reports_to", () => {
      const slugs = graph.getRelatedEntities(SEED, 10).map((r) => r.slug);
      expect(slugs).toContain(TRUSTED);
      expect(slugs).not.toContain(WEAK);
      expect(slugs).toContain(MENTION);
    });

    test("includeInactive still sees candidate reports_to evidence", () => {
      const all = db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to");
      expect(all.map((l) => l.to_slug).sort()).toEqual([TRUSTED, WEAK].sort());
    });
  });
});
