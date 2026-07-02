import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { PageManager } from "../../src/core/page.js";
import { Logger } from "../../src/core/logger.js";
import { getOrgTree } from "../../src/core/graph/hierarchy.js";

/**
 * Test fixtures: 3-level org tree
 *
 * CEO
 * ├── VP-Eng          (reports_to → CEO)
 * │   ├── EM-1        (reports_to → VP-Eng)
 * │   │   ├── Dev-A   (reports_to → EM-1)
 * │   │   └── Dev-B   (reports_to → EM-1)
 * │   └── EM-2        (reports_to → VP-Eng)
 * └── VP-Sales        (reports_to → CEO)
 */

const CEO = "entities/ceo";
const VP_ENG = "entities/vp-eng";
const VP_SALES = "entities/vp-sales";
const EM1 = "entities/em1";
const EM2 = "entities/em2";
const DEV_A = "entities/dev-a";
const DEV_B = "entities/dev-b";

function seedLink(db: CBrainDB, from: string, to: string): void {
  // #233: deterministic reports_to edges are trusted (upsertActiveReportsTo);
  // insertLink would write 'candidate', which current-fact reads exclude.
  db.upsertActiveReportsTo(from, to, "agent", 0.95);
}

function buildTestTree(db: CBrainDB, vaultPath: string): void {
  const seedPage = (slug: string, title: string, type: string) => {
    db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
    const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(vaultPath, `${slug}.md`),
      `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`,
    );
  };

  seedPage(CEO, "CEO", "entity/person");
  seedPage(VP_ENG, "VP-Engineering", "entity/person");
  seedPage(VP_SALES, "VP-Sales", "entity/person");
  seedPage(EM1, "EM-1", "entity/person");
  seedPage(EM2, "EM-2", "entity/person");
  seedPage(DEV_A, "Dev-A", "entity/person");
  seedPage(DEV_B, "Dev-B", "entity/person");

  seedLink(db, VP_ENG, CEO);
  seedLink(db, VP_SALES, CEO);
  seedLink(db, EM1, VP_ENG);
  seedLink(db, EM2, VP_ENG);
  seedLink(db, DEV_A, EM1);
  seedLink(db, DEV_B, EM1);
}

describe("getOrgTree", () => {
  const testDir = "/tmp/cbrain-test-hierarchy";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let graph: GraphManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    graph = new GraphManager(db);
    buildTestTree(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function makeDeps() {
    const logger = new Logger(vaultPath);
    const pages = new PageManager(db, vaultPath, logger, { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, close: async () => {} } as any);
    return { pages, graph };
  }

  test("direction=down from CEO returns all subordinates", () => {
    const result = getOrgTree(CEO, makeDeps(), { direction: "down" });
    expect(result).not.toBeNull();
    expect(result!.seed.slug).toBe(CEO);
    expect(result!.upward).toHaveLength(0);

    const down = result!.downward;
    expect(down).toHaveLength(6);

    // Depth 1: VP-Eng, VP-Sales
    const depth1 = down.filter(n => n.depth === 1);
    expect(depth1).toHaveLength(2);
    expect(depth1.map(n => n.slug).sort()).toEqual([VP_ENG, VP_SALES].sort());
    for (const n of depth1) {
      expect(n.parent_slug).toBe(CEO);
    }

    // Depth 2: EM-1, EM-2
    const depth2 = down.filter(n => n.depth === 2);
    expect(depth2).toHaveLength(2);
    expect(depth2.map(n => n.slug).sort()).toEqual([EM1, EM2].sort());
    for (const n of depth2) {
      expect(n.parent_slug).toBe(VP_ENG);
    }

    // Depth 3: Dev-A, Dev-B
    const depth3 = down.filter(n => n.depth === 3);
    expect(depth3).toHaveLength(2);
    expect(depth3.map(n => n.slug).sort()).toEqual([DEV_A, DEV_B].sort());
    for (const n of depth3) {
      expect(n.parent_slug).toBe(EM1);
    }
  });

  test("direction=up from Dev-A returns manager chain", () => {
    const result = getOrgTree(DEV_A, makeDeps(), { direction: "up" });
    expect(result).not.toBeNull();
    expect(result!.seed.slug).toBe(DEV_A);
    expect(result!.downward).toHaveLength(0);

    const up = result!.upward;
    expect(up).toHaveLength(3);

    // Depth 1: EM-1
    expect(up[0]).toEqual({
      slug: EM1, title: "EM-1", type: "entity/person",
      depth: 1, parent_slug: DEV_A,
    });

    // Depth 2: VP-Eng
    expect(up[1]).toEqual({
      slug: VP_ENG, title: "VP-Engineering", type: "entity/person",
      depth: 2, parent_slug: EM1,
    });

    // Depth 3: CEO
    expect(up[2]).toEqual({
      slug: CEO, title: "CEO", type: "entity/person",
      depth: 3, parent_slug: VP_ENG,
    });
  });

  test("direction=both from VP-Eng returns upward and downward", () => {
    const result = getOrgTree(VP_ENG, makeDeps(), { direction: "both" });
    expect(result).not.toBeNull();
    expect(result!.seed.slug).toBe(VP_ENG);

    // Upward: just CEO
    expect(result!.upward).toHaveLength(1);
    expect(result!.upward[0].slug).toBe(CEO);
    expect(result!.upward[0].depth).toBe(1);
    expect(result!.upward[0].parent_slug).toBe(VP_ENG);

    // Downward: EM-1, EM-2, Dev-A, Dev-B
    expect(result!.downward).toHaveLength(4);
    const downSlugs = result!.downward.map(n => n.slug).sort();
    expect(downSlugs).toEqual([DEV_A, DEV_B, EM1, EM2].sort());
  });

  test("depth=1 from VP-Eng returns only direct reports", () => {
    const result = getOrgTree(VP_ENG, makeDeps(), { direction: "down", depth: 1 });
    expect(result).not.toBeNull();

    const down = result!.downward;
    expect(down).toHaveLength(2);
    expect(down.map(n => n.slug).sort()).toEqual([EM1, EM2].sort());
  });

  test("limit=2 from CEO (down) truncates with warning", () => {
    const result = getOrgTree(CEO, makeDeps(), { direction: "down", limit: 2 });
    expect(result).not.toBeNull();
    expect(result!.downward).toHaveLength(2);
    expect(result!.warnings.length).toBeGreaterThan(0);
    expect(result!.warnings[0]).toContain("截断");
  });

  test("cycle detection does not loop infinitely", () => {
    // Add a cycle: Dev-A reports_to Dev-B, Dev-B reports_to Dev-A (in addition to existing)
    seedLink(db, DEV_A, DEV_B);
    seedLink(db, DEV_B, DEV_A);

    // Should not hang and should still return results
    const result = getOrgTree(DEV_A, makeDeps(), { direction: "both", depth: 5 });
    expect(result).not.toBeNull();
    expect(result!.seed.slug).toBe(DEV_A);
    // Cycle warning should be present
    expect(result!.warnings.some(w => w.includes("循环"))).toBe(true);
  });

  test("non-existent seed returns null", () => {
    const result = getOrgTree("entities/ghost", makeDeps());
    expect(result).toBeNull();
  });

  test("isolated node returns empty arrays", () => {
    const isolatedSlug = "entities/isolated";
    db.upsertPage({ slug: isolatedSlug, type: "entity/person", title: "Isolated Person", filePath: `${isolatedSlug}.md`, contentHash: `h-${isolatedSlug}` });
    mkdirSync(join(vaultPath, "entities"), { recursive: true });
    writeFileSync(join(vaultPath, `${isolatedSlug}.md`), `---\ntitle: "Isolated Person"\ntype: entity/person\nslug: ${isolatedSlug}\n---\n`);

    const result = getOrgTree(isolatedSlug, makeDeps(), { direction: "both" });
    expect(result).not.toBeNull();
    expect(result!.seed.slug).toBe(isolatedSlug);
    expect(result!.upward).toHaveLength(0);
    expect(result!.downward).toHaveLength(0);
    expect(result!.warnings).toHaveLength(0);
  });

  test("parent_slug correctness for all nodes in full tree", () => {
    const result = getOrgTree(VP_ENG, makeDeps(), { direction: "both" })!;
    expect(result).not.toBeNull();

    // Every upward node's parent should be either the seed or another upward node
    for (const node of result.upward) {
      if (node.depth === 1) {
        expect(node.parent_slug).toBe(VP_ENG);
      } else {
        // parent must be an upward node at depth-1
        const parent = result.upward.find(n => n.slug === node.parent_slug);
        expect(parent).toBeDefined();
        expect(parent!.depth).toBe(node.depth - 1);
      }
    }

    // Every downward node's parent should be either the seed or another downward node
    for (const node of result.downward) {
      if (node.depth === 1) {
        expect(node.parent_slug).toBe(VP_ENG);
      } else {
        const parent = result.downward.find(n => n.slug === node.parent_slug);
        expect(parent).toBeDefined();
        expect(parent!.depth).toBe(node.depth - 1);
      }
    }
  });

  test("default options: direction=both, depth=3, limit=50", () => {
    const result = getOrgTree(CEO, makeDeps())!;
    expect(result).not.toBeNull();
    // CEO has 3 levels down, 0 up
    expect(result.downward).toHaveLength(6);
    expect(result.upward).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("includes stub entities (tier-3) if they have hierarchy edges", () => {
    // Seed a stub (tier=3, minimal info) with vault file for PageManager
    const internSlug = "entities/intern";
    db.upsertPage({ slug: internSlug, type: "entity/person", title: "Intern", filePath: `${internSlug}.md`, contentHash: `h-${internSlug}` });
    mkdirSync(join(vaultPath, "entities"), { recursive: true });
    writeFileSync(join(vaultPath, `${internSlug}.md`), `---\ntitle: "Intern"\ntype: entity/person\nslug: ${internSlug}\n---\n`);
    seedLink(db, internSlug, EM1);

    const result = getOrgTree(EM1, makeDeps(), { direction: "down" })!;
    expect(result.downward.some(n => n.slug === internSlug)).toBe(true);
    const intern = result.downward.find(n => n.slug === internSlug)!;
    expect(intern.title).toBe("Intern");
    expect(intern.parent_slug).toBe(EM1);
  });

  test("excessive depth is clamped to hard max with warning", () => {
    const result = getOrgTree(CEO, makeDeps(), { direction: "down", depth: 999 })!;
    // Hard max is 5, CEO tree is only 3 levels deep, so no extra nodes but warning present
    expect(result.warnings.some(w => w.includes("截断为 5"))).toBe(true);
    // Still returns all 3 levels since tree is shallower than the cap
    expect(result.downward).toHaveLength(6);
  });

  test("excessive limit is clamped to hard max with warning", () => {
    const result = getOrgTree(CEO, makeDeps(), { direction: "down", limit: 99999 })!;
    expect(result.warnings.some(w => w.includes("截断为 100"))).toBe(true);
    // All 6 nodes fit within 100 cap, no truncation warning from BFS
    expect(result.downward).toHaveLength(6);
  });

  test("depth=0 is clamped to 1", () => {
    const result = getOrgTree(CEO, makeDeps(), { direction: "down", depth: 0 })!;
    expect(result).not.toBeNull();
    // depth clamped to 1, so only direct reports
    expect(result.downward).toHaveLength(2);
  });
});
