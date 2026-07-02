import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { PageManager } from "../../src/core/page.js";
import { Logger } from "../../src/core/logger.js";
import { setHierarchy, removeHierarchy, getHierarchyContext, getOrgTree } from "../../src/core/graph/hierarchy.js";

// Anonymous sentinel slugs only (#233).
const SEED = "entities/seed";
const MGR_A = "entities/mgr-a";
const MGR_B = "entities/mgr-b";

describe("hierarchy lifecycle (setHierarchy / removeHierarchy)", () => {
  const testDir = "/tmp/cbrain-test-hierarchy-lifecycle";
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
      fullTextSearch: async () => [], deleteByPageSlug: async () => {}, close: async () => {},
    } as any);
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

  test("setHierarchy supersedes old active reports_to, keeps evidence", () => {
    setHierarchy(SEED, MGR_A, deps());
    setHierarchy(SEED, MGR_B, deps());

    // Active: only B
    const ctx = getHierarchyContext(SEED, deps());
    expect(ctx.reports_to).toBe(MGR_B);

    // includeInactive: A edge preserved as superseded
    const all = db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to");
    expect(all).toHaveLength(2);
    const old = all.find((l) => l.to_slug === MGR_A);
    expect(old!.trust_state).toBe("superseded");
    const cur = all.find((l) => l.to_slug === MGR_B);
    expect(cur!.trust_state).toBe("trusted");
  });

  test("setHierarchy is idempotent and does not duplicate", () => {
    setHierarchy(SEED, MGR_A, deps());
    setHierarchy(SEED, MGR_A, deps());
    const all = db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to");
    expect(all).toHaveLength(1);
    expect(all[0].trust_state).toBe("trusted");
  });

  test("removeHierarchy supersedes edge instead of erasing it", () => {
    setHierarchy(SEED, MGR_A, deps());
    const old = removeHierarchy(SEED, deps());
    expect(old).toBe(MGR_A);

    // Active read: no manager
    expect(getHierarchyContext(SEED, deps()).reports_to).toBeNull();
    // Evidence preserved as superseded
    const all = db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to");
    expect(all).toHaveLength(1);
    expect(all[0].to_slug).toBe(MGR_A);
    expect(all[0].trust_state).toBe("superseded");
  });

  test("removeHierarchy with no prior reports_to returns null and writes nothing", () => {
    expect(removeHierarchy(SEED, deps())).toBeNull();
    expect(db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to")).toHaveLength(0);
  });

  test("active traversal (getOrgTree) excludes superseded reports_to", () => {
    // Build seed -> MGR_A, then switch to MGR_B (A superseded).
    setHierarchy(SEED, MGR_A, deps());
    setHierarchy(SEED, MGR_B, deps());

    // Upward traversal from SEED must reach MGR_B only, not MGR_A.
    const tree = getOrgTree(SEED, deps(), { direction: "up" })!;
    expect(tree.upward).toHaveLength(1);
    expect(tree.upward[0].slug).toBe(MGR_B);
  });

  test("setHierarchy edge carries source_page_slug provenance (the subordinate)", () => {
    setHierarchy(SEED, MGR_A, deps());
    const edge = db.getOutgoingLinks(SEED, true).find((l) => l.relation === "reports_to");
    expect(edge).toBeDefined();
    // Provenance points at the subordinate (SEED), not the manager — so the
    // edge stays correctly traceable (#233 review finding).
    expect(edge!.source_page_slug).toBe(SEED);
  });

  test("HIGH 1: weak/NER candidate reports_to does NOT appear in default org tree (up)", () => {
    // Trusted current manager MGR_A (deterministic setHierarchy)
    setHierarchy(SEED, MGR_A, deps());
    // Weak/NER candidate edge to a DIFFERENT target (does not overwrite trusted)
    db.insertLink(SEED, MGR_B, "reports_to", null, 0.5, "weak", "ner", 0.5);

    // Default up traversal must return only the trusted manager
    const tree = getOrgTree(SEED, deps(), { direction: "up" })!;
    expect(tree.upward.map((n) => n.slug)).toEqual([MGR_A]);

    // But includeInactive/debug can still see the candidate edge as evidence
    const all = db.getOutgoingLinks(SEED, true).filter((l) => l.relation === "reports_to");
    expect(all.map((l) => l.to_slug).sort()).toEqual([MGR_A, MGR_B].sort());
  });

  test("HIGH 1: candidate subordinates/peers excluded from hierarchy context", () => {
    // SUB reports to SEED (trusted), SUB2 reports to SEED (NER candidate)
    const SUB = "entities/sub-trusted";
    const SUB2 = "entities/sub-candidate";
    for (const s of [SUB, SUB2]) {
      db.upsertPage({ slug: s, type: "entity/person", title: s, filePath: `${s}.md`, contentHash: `h-${s}` });
      mkdirSync(join(vaultPath, ...s.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(vaultPath, `${s}.md`), `---\ntitle: "${s}"\ntype: entity/person\nslug: ${s}\n---\n`);
    }
    db.upsertActiveReportsTo(SUB, SEED, "agent", 0.95);
    db.insertLink(SUB2, SEED, "reports_to", null, 0.5, "weak", "ner", 0.5);

    const ctx = getHierarchyContext(SEED, deps());
    expect(ctx.subordinates.map((s) => s.slug)).toEqual([SUB]);
  });
});
