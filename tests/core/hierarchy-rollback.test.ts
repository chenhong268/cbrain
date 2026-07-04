import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { PageManager } from "../../src/core/page.js";
import { Logger } from "../../src/core/logger.js";
import { setHierarchy, removeHierarchy } from "../../src/core/graph/hierarchy.js";
import { RollbackIncompleteError } from "../../src/core/safety/atomic-move.js";

// Anonymous sentinel slugs only (#273).
const SEED = "entities/seed";
const MGR_A = "entities/mgr-a";
const MGR_B = "entities/mgr-b";

describe("hierarchy rollback compensation (#273)", () => {
  const testDir = "/tmp/cbrain-test-hierarchy-rollback";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let graph: GraphManager;
  let pages: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    graph = new GraphManager(db);
    const logger = new Logger(vaultPath);
    pages = new PageManager(db, vaultPath, logger, {
      connect: async () => {}, addChunks: async () => {}, search: async () => [],
      fullTextSearch: async () => {}, deleteByPageSlug: async () => {}, close: async () => {},
    } as never);
    const seedPage = (slug: string, title: string) => {
      db.upsertPage({ slug, type: "entity/person", title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
      mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${title}"\ntype: entity/person\nslug: ${slug}\n---\n`);
    };
    seedPage(SEED, "Seed");
    seedPage(MGR_A, "Mgr A");
    seedPage(MGR_B, "Mgr B");
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const deps = () => ({ pages, graph });

  const readReportsTo = (slug: string): string | null => {
    const p = pages.getBySlugFresh(slug);
    return (p?.frontmatter.reports_to as string | null) ?? null;
  };

  // Fault injection helper: make pages.update throw on the Nth call (1-indexed).
  function throwOnNthUpdate(n: number): () => void {
    const origUpdate = pages.update.bind(pages);
    let count = 0;
    (pages as unknown as { update: typeof pages.update }).update = (...args: Parameters<typeof pages.update>) => {
      count++;
      if (count === n) throw new Error(`injected pages.update failure #${count}`);
      return origUpdate(...args);
    };
    return () => { (pages as unknown as { update: typeof pages.update }).update = origUpdate; };
  }

  test("setHierarchy: graph throws after frontmatter write → frontmatter restored to old value", () => {
    setHierarchy(SEED, MGR_A, deps()); // establish old reports_to = MGR_A
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    expect(() => setHierarchy(SEED, MGR_B, deps())).toThrow();
    expect(readReportsTo(SEED)).toBe(MGR_A); // restored
  });

  test("setHierarchy: no old reports_to + graph throws → frontmatter cleared afterward", () => {
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    expect(() => setHierarchy(SEED, MGR_A, deps())).toThrow();
    expect(readReportsTo(SEED)).toBeNull(); // no reports_to key afterward (deleted, not null/empty)
  });

  test("setHierarchy: graph throws + restore throws → RollbackIncompleteError with anonymous message", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    const restore = throwOnNthUpdate(2); // 1st=frontmatter write, 2nd=restore
    let caught: unknown;
    try {
      setHierarchy(SEED, MGR_B, deps());
      expect.unreachable("should have thrown");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RollbackIncompleteError);
    const msg = (caught as Error).message;
    expect(msg).toContain(SEED); // slug present (diagnosable)
    expect(msg).not.toContain("injected graph failure"); // raw graph error not leaked
    expect(msg).not.toContain("injected pages.update failure"); // raw restore error not leaked
    restore();
  });

  test("removeHierarchy: frontmatter clear throws → graph current edge remains active", () => {
    setHierarchy(SEED, MGR_A, deps()); // active edge SEED → MGR_A
    const restore = throwOnNthUpdate(1); // 1st update = frontmatter clear
    expect(() => removeHierarchy(SEED, deps())).toThrow();
    restore();
    // graph untouched: active reports_to edge to MGR_A still current
    const links = db.getCurrentReportsToLinks(SEED, "outgoing");
    expect(links.some((l) => l.to_slug === MGR_A)).toBe(true);
  });

  test("removeHierarchy: graph supersede throws after frontmatter clear → frontmatter restored", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { supersedeReportsTo: () => void }).supersedeReportsTo = () => {
      throw new Error("injected graph supersede failure");
    };
    expect(() => removeHierarchy(SEED, deps())).toThrow();
    expect(readReportsTo(SEED)).toBe(MGR_A); // restored
  });

  test("removeHierarchy: graph supersede throws + restore throws → RollbackIncompleteError with anonymous message", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { supersedeReportsTo: () => void }).supersedeReportsTo = () => {
      throw new Error("injected graph supersede failure");
    };
    const restore = throwOnNthUpdate(2); // 1st=clear, 2nd=restore
    let caught: unknown;
    try {
      removeHierarchy(SEED, deps());
      expect.unreachable("should have thrown");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RollbackIncompleteError);
    const msg = (caught as Error).message;
    expect(msg).toContain(SEED);
    expect(msg).not.toContain("injected graph supersede failure");
    expect(msg).not.toContain("injected pages.update failure");
    restore();
  });

  test("setHierarchy: frontmatter write throws → graph untouched (no active edge)", () => {
    const restore = throwOnNthUpdate(1); // 1st update = frontmatter write
    expect(() => setHierarchy(SEED, MGR_A, deps())).toThrow();
    restore();
    // graph.setActiveReportsTo was never reached: no active reports_to edge.
    expect(db.getCurrentReportsToLinks(SEED, "outgoing")).toHaveLength(0);
  });
});
