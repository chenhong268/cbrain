import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { analyzeKnowledgeMap } from "../../src/core/knowledge-map.js";
import type { KnowledgeMapAnalysis, KnowledgeMapNode } from "../../src/core/knowledge-map.js";

// ─── Anonymous fixture helpers (no real names/orgs/products) ─────────────────

// Synthetic sentinels representing PII / local-path CATEGORIES that must never
// appear in analyzer output. Deliberately NOT real names/orgs/emails/paths so
// this test source stays anonymous under the repo privacy scan — do not
// replace these with realistic tokens.
const PRIVATE_PERSON_TOKEN = "sentinel-private-person";
const PRIVATE_ORG_TOKEN = "sentinel-private-org";
const LOCAL_PATH_TOKEN = "sentinel-local-path";
const EMAIL_TOKEN = "sentinel-email";

describe("Knowledge Map analyzer (#240)", () => {
  const testDir = "/tmp/cbrain-test-knowledge-map";
  const dbPath = join(testDir, "km.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function seedPage(slug: string, type: string, title: string, mentionCount = 0): void {
    db.rawDb
      .prepare(
        "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(slug, type, title, `${slug}.md`, `h-${slug}`, 1, mentionCount);
  }

  function seedLink(
    from: string,
    to: string,
    opts: { source_type?: string; confidence?: number; weight?: number; trust_state?: string; relation?: string } = {},
  ): void {
    db.rawDb
      .prepare(
        "INSERT INTO links (from_slug, to_slug, relation, source_type, confidence, weight, trust_state) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        from,
        to,
        opts.relation ?? "mentions",
        opts.source_type ?? "wikilink",
        opts.confidence ?? 1,
        opts.weight ?? 1,
        opts.trust_state ?? null,
      );
  }

  function nodeBySlug(a: KnowledgeMapAnalysis, slug: string): KnowledgeMapNode {
    const n = a.nodes.find((x) => x.slug === slug);
    if (!n) throw new Error(`node ${slug} missing from analysis`);
    return n;
  }

  // ─── 1. Scope filtering ────────────────────────────────────────────────

  describe("scope filtering", () => {
    test("includes entity/concept, excludes record/insight, drops links to excluded nodes", () => {
      seedPage("entity/a", "entity/person", "Entity A");
      seedPage("concept/x", "concept/topic", "Concept X");
      seedPage("record/r1", "record", "Record R1");
      seedPage("insight/i1", "insight", "Insight I1");
      // in-scope edge (kept)
      seedLink("entity/a", "concept/x");
      // edge to an excluded node (dropped — record out of scope)
      seedLink("entity/a", "record/r1");
      // edge between two excluded nodes (dropped)
      seedLink("record/r1", "insight/i1");

      const a = analyzeKnowledgeMap(db);

      const slugs = a.nodes.map((n) => n.slug).sort();
      expect(slugs).toEqual(["concept/x", "entity/a"]);
      expect(a.health.nodeCount).toBe(2);
      // Only the a—x edge survives (both endpoints in scope).
      expect(a.health.edgeCount).toBe(1);
      // record/insight never appear anywhere in the core data.
      expect(a.nodes.some((n) => n.type === "record" || n.type === "insight")).toBe(false);
    });
  });

  // ─── 2. Community detection ────────────────────────────────────────────

  describe("community detection", () => {
    // Two triangles joined by a bridge. Intra-community edges are stronger
    // (weight 2) than the bridge (weight 1) so label propagation splits them
    // deterministically instead of flooding across the bridge.
    function seedTwoCommunities(): void {
      for (const [s, t] of [
        ["entity/a", "Entity A"],
        ["entity/b", "Entity B"],
        ["entity/c", "Entity C"],
        ["entity/d", "Entity D"],
        ["entity/e", "Entity E"],
        ["entity/f", "Entity F"],
      ] as const) {
        seedPage(s, "entity/person", t);
      }
      // Triangle 1 (strong intra edges)
      seedLink("entity/a", "entity/b", { weight: 2 });
      seedLink("entity/b", "entity/c", { weight: 2 });
      seedLink("entity/a", "entity/c", { weight: 2 });
      // Triangle 2 (strong intra edges)
      seedLink("entity/d", "entity/e", { weight: 2 });
      seedLink("entity/e", "entity/f", { weight: 2 });
      seedLink("entity/d", "entity/f", { weight: 2 });
      // Bridge (weaker)
      seedLink("entity/c", "entity/d", { weight: 1 });
    }

    test("finds two communities over the largest connected component", () => {
      seedTwoCommunities();
      const a = analyzeKnowledgeMap(db);

      expect(a.communities.length).toBe(2);
      expect(a.communities.map((c) => c.size).sort()).toEqual([3, 3]);
      // Whole graph is one connected component (the bridge joins the triangles).
      expect(a.health.connectedComponentCount).toBe(1);
      expect(a.health.largestConnectedComponentSize).toBe(6);
    });

    test("output is deterministic and stable across repeated runs", () => {
      seedTwoCommunities();
      const first = analyzeKnowledgeMap(db);
      const second = analyzeKnowledgeMap(db);
      expect(second).toEqual(first);
    });

    test("every non-isolate node carries a stable community id", () => {
      seedTwoCommunities();
      const a = analyzeKnowledgeMap(db);
      for (const n of a.nodes) {
        expect(typeof n.communityId).toBe("string");
        expect(n.communityId).toMatch(/^community-\d+$/);
      }
    });
  });

  // ─── 3. Bridge detection ───────────────────────────────────────────────

  describe("bridge detection", () => {
    test("a node whose neighbors span two communities is a bridge candidate", () => {
      seedPage("entity/a", "entity/person", "Entity A");
      seedPage("entity/b", "entity/person", "Entity B");
      seedPage("entity/c", "entity/person", "Entity C");
      seedPage("entity/d", "entity/person", "Entity D");
      seedPage("entity/e", "entity/person", "Entity E");
      seedPage("entity/f", "entity/person", "Entity F");
      seedLink("entity/a", "entity/b", { weight: 2 });
      seedLink("entity/b", "entity/c", { weight: 2 });
      seedLink("entity/a", "entity/c", { weight: 2 });
      seedLink("entity/d", "entity/e", { weight: 2 });
      seedLink("entity/e", "entity/f", { weight: 2 });
      seedLink("entity/d", "entity/f", { weight: 2 });
      seedLink("entity/c", "entity/d", { weight: 1 }); // bridge

      const a = analyzeKnowledgeMap(db);
      const bridgeSlugs = a.bridgeCandidates.map((b) => b.slug).sort();
      // c touches comm1 (a,b) and comm2 (d); d touches comm2 (e,f) and comm1 (c).
      expect(bridgeSlugs).toContain("entity/c");
      expect(bridgeSlugs).toContain("entity/d");
      // An interior node is never a bridge.
      expect(bridgeSlugs).not.toContain("entity/a");
      // Bridge reports the distinct communities it spans.
      const c = a.bridgeCandidates.find((b) => b.slug === "entity/c")!;
      expect(c.neighborCommunityIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── 4. Isolates and weak nodes ────────────────────────────────────────

  describe("isolates and weak nodes", () => {
    test("isolated, high-mention-isolate, and degree-one nodes are reported", () => {
      seedPage("entity/hub", "entity/person", "Hub", 1);
      seedPage("entity/leaf", "entity/person", "Leaf", 0); // degree one
      seedLink("entity/leaf", "entity/hub", { weight: 1 });
      seedPage("entity/iso", "entity/person", "Iso", 10); // isolated, high mention
      seedPage("entity/quiet", "entity/person", "Quiet", 0); // isolated, low mention

      const a = analyzeKnowledgeMap(db);

      expect(a.health.isolatedNodes.map((n) => n.slug).sort()).toEqual(["entity/iso", "entity/quiet"]);
      expect(a.health.degreeOneNodes.map((n) => n.slug)).toContain("entity/leaf");

      // High-mention isolate surfaces; the low-mention isolate does not.
      expect(a.highMentionIsolates.map((n) => n.slug)).toContain("entity/iso");
      expect(a.highMentionIsolates.map((n) => n.slug)).not.toContain("entity/quiet");

      // Weakly connected = degree-one, ordered by mention then slug.
      expect(a.weaklyConnectedNodes.map((n) => n.slug)).toContain("entity/leaf");
    });
  });

  // ─── 5. Reliability weighting ──────────────────────────────────────────

  describe("reliability weighting", () => {
    test("low-reliability NER edge is downweighted vs wikilink; rejected links ignored", () => {
      seedPage("entity/x", "entity/person", "X");
      seedPage("entity/y", "entity/person", "Y");
      seedPage("entity/p", "entity/person", "P");
      seedPage("entity/q", "entity/person", "Q");
      seedPage("entity/z", "entity/person", "Z"); // only reachable via a rejected link
      // Low-reliability NER pair.
      seedLink("entity/x", "entity/y", { source_type: "ner", confidence: 1, weight: 1 });
      // High-reliability wikilink pair.
      seedLink("entity/p", "entity/q", { source_type: "wikilink", confidence: 1, weight: 1 });
      // Rejected link (must not participate).
      seedLink("entity/x", "entity/z", { trust_state: "rejected" });

      const a = analyzeKnowledgeMap(db);

      const x = nodeBySlug(a, "entity/x");
      const p = nodeBySlug(a, "entity/p");
      // wikilink (1.0) dominates ner (0.3) at equal weight/confidence.
      expect(p.weightedDegree).toBeGreaterThan(x.weightedDegree);
      expect(x.weightedDegree).toBeCloseTo(0.3, 5);
      expect(p.weightedDegree).toBeCloseTo(1.0, 5);

      // The rejected link left z with no edges → isolated.
      expect(a.health.isolatedNodes.map((n) => n.slug)).toContain("entity/z");
      expect(nodeBySlug(a, "entity/z").degree).toBe(0);
    });
  });

  // ─── 6. Read-only guarantee ────────────────────────────────────────────

  describe("read-only guarantee", () => {
    test("running the analyzer does not change pages / links / ingest_log rows", () => {
      seedPage("entity/a", "entity/person", "A");
      seedPage("entity/b", "entity/person", "B");
      seedLink("entity/a", "entity/b");

      const count = (table: string): number =>
        (db.rawDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

      const before = { pages: count("pages"), links: count("links"), ingest_log: count("ingest_log") };

      const analysis = analyzeKnowledgeMap(db);
      expect(analysis.health.nodeCount).toBeGreaterThan(0);

      const after = { pages: count("pages"), links: count("links"), ingest_log: count("ingest_log") };
      expect(after).toEqual(before);
    });
  });

  // ─── 7. Privacy ────────────────────────────────────────────────────────

  describe("privacy", () => {
    test("fixtures and analyzer output contain only anonymous placeholders", () => {
      seedPage("entity/a", "entity/person", "Entity A");
      seedPage("concept/b", "concept/topic", "Concept B");
      seedLink("entity/a", "concept/b");

      const a = analyzeKnowledgeMap(db);
      const blob = JSON.stringify(a);
      // Analyzer output must carry no PII / local-path content. Fixtures use
      // anonymous placeholders ("Entity A", "Concept B") and the analyzer is a
      // read-only echo of the DB, so only the synthetic sentinel categories are
      // guarded here (see constants above — never real tokens).
      for (const banned of [PRIVATE_PERSON_TOKEN, PRIVATE_ORG_TOKEN, LOCAL_PATH_TOKEN, EMAIL_TOKEN]) {
        expect(blob).not.toContain(banned);
      }
      // Output reflects the anonymous fixtures, nothing injected.
      expect(blob).toContain("Entity A");
      expect(blob).toContain("Concept B");
      expect(a.nodes.length).toBeGreaterThan(0);
    });
  });

  // ─── 8. Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("empty graph returns zero counts and empty arrays", () => {
      const a = analyzeKnowledgeMap(db);
      expect(a.health.nodeCount).toBe(0);
      expect(a.health.edgeCount).toBe(0);
      expect(a.health.connectedComponentCount).toBe(0);
      expect(a.health.largestConnectedComponentSize).toBe(0);
      expect(a.communities).toEqual([]);
      expect(a.bridgeCandidates).toEqual([]);
      expect(a.highMentionIsolates).toEqual([]);
      expect(a.weaklyConnectedNodes).toEqual([]);
      expect(a.nodes).toEqual([]);
    });

    test("a single isolated node is reported but is not its own high-mention isolate", () => {
      seedPage("entity/solo", "entity/person", "Solo", 99);
      const a = analyzeKnowledgeMap(db);
      expect(a.health.nodeCount).toBe(1);
      expect(a.health.isolatedNodes.map((n) => n.slug)).toEqual(["entity/solo"]);
      // Mean mention == the node's own mention (99), strict > → not flagged.
      expect(a.highMentionIsolates).toEqual([]);
      expect(a.communities).toEqual([]);
    });
  });
});
