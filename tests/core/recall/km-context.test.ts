import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildKnowledgeMapContext, kmContextApi } from "../../../src/core/recall/km-context.js";
import type { KnowledgeMapAnalysis, KnowledgeMapNode, CommunitySummary } from "../../../src/core/knowledge-map-types.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";

// Anonymous fixtures only (roadmap privacy constraint): Entity A/B/C, Domain D.
function node(slug: string, title: string, communityId: string, weightedDegree: number, degree = 2): KnowledgeMapNode {
  return { slug, title, type: "entity/person", mentionCount: 1, weightedDegree, degree, communityId };
}
function isolate(slug: string, title: string): KnowledgeMapNode {
  return { slug, title, type: "entity/person", mentionCount: 1, weightedDegree: 0, degree: 0 };
}
// Mature community: size>=3, internalEdgeCount>=3, density>=0.4 (matches isCommunityMature).
function matureCommunity(id: string, nodes: KnowledgeMapNode[]): CommunitySummary {
  return {
    id, size: nodes.length, internalEdgeCount: 3, density: 0.6,
    totalInternalWeight: 3, topCoreNodes: [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 5),
    typeDistribution: { "entity/person": nodes.length },
  };
}
function analysis(nodes: KnowledgeMapNode[], communities: CommunitySummary[], isolates: KnowledgeMapNode[] = []): KnowledgeMapAnalysis {
  return {
    resolution: "default",
    nodes: [...nodes, ...isolates],
    health: { nodeCount: nodes.length + isolates.length, edgeCount: 3, isolatedNodes: isolates, degreeOneNodes: [], connectedComponentCount: 1, largestConnectedComponentSize: nodes.length },
    communities, bridgeCandidates: [], highMentionIsolates: isolates, weaklyConnectedNodes: [],
  };
}

describe("buildKnowledgeMapContext (#245)", () => {
  const A = node("entity/a", "Entity A", "community-1", 5);
  const B = node("entity/b", "Entity B", "community-1", 4);
  const C = node("entity/c", "Entity C", "community-1", 3);

  test("appends same mature-domain nodes not already in primary results", () => {
    const an = analysis([A, B, C], [matureCommunity("community-1", [A, B, C])]);
    const res = buildKnowledgeMapContext(an, ["entity/a"]);
    expect(res.reason).toBe("same_domain_context");
    expect(res.supplemental.map(s => s.slug)).toEqual(["entity/b", "entity/c"]);
    expect(res.supplemental.every(s => s.communityId === "community-1")).toBe(true);
  });

  test("does not duplicate nodes already in primary results", () => {
    const an = analysis([A, B, C], [matureCommunity("community-1", [A, B, C])]);
    const res = buildKnowledgeMapContext(an, ["entity/a", "entity/b"]);
    expect(res.supplemental.map(s => s.slug)).toEqual(["entity/c"]);
  });

  test("excludes isolates from supplemental and counts them", () => {
    const iso = isolate("entity/iso", "Isolated X");
    const an = analysis([A, B, C], [matureCommunity("community-1", [A, B, C])], [iso]);
    const res = buildKnowledgeMapContext(an, ["entity/a"]);
    expect(res.supplemental.map(s => s.slug)).not.toContain("entity/iso");
    expect(res.excludedIsolatesCount).toBe(1);
  });

  test("respects maxPerDomain and totalCap", () => {
    const extra = node("entity/d", "Entity D", "community-1", 2);
    const extra2 = node("entity/e", "Entity E", "community-1", 1);
    const an = analysis([A, B, C, extra, extra2], [matureCommunity("community-1", [A, B, C, extra, extra2])]);
    const res = buildKnowledgeMapContext(an, ["entity/a"], { maxPerDomain: 3, totalCap: 2 });
    expect(res.supplemental.length).toBeLessThanOrEqual(2);
  });

  test("returns no_mature_domain when matched community is not mature", () => {
    const sparse = { ...matureCommunity("community-1", [A, B, C]), size: 2, internalEdgeCount: 1, density: 0.1 };
    const an = analysis([A, B], [sparse]);
    const res = buildKnowledgeMapContext(an, ["entity/a"]);
    expect(res.reason).toBe("no_mature_domain");
    expect(res.supplemental).toEqual([]);
  });

  test("orders supplemental by weightedDegree descending", () => {
    const an = analysis([A, B, C], [matureCommunity("community-1", [A, B, C])]);
    const res = buildKnowledgeMapContext(an, ["entity/a"]);
    const degs = res.supplemental.map(s => s.weightedDegree);
    expect(degs).toEqual([...degs].sort((x, y) => y - x));
  });
});

describe("kmContextApi (#245)", () => {
  const testDir = "/tmp/cbrain-test-km-context-api";
  const dbPath = join(testDir, "t.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new CBrainDB(dbPath);
  });
  afterEach(() => { db.close(); if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  test("computeForRecall returns no_mature_domain on empty graph (no communities)", () => {
    const res = kmContextApi.computeForRecall(db, ["entity/none"]);
    expect(res.reason).toBe("no_mature_domain");
    expect(res.supplemental).toEqual([]);
  });

  test("analyze is spyable (off-path zero-call proof)", () => {
    const spy = spyOn(kmContextApi, "analyze");
    kmContextApi.computeForRecall(db, []);
    // empty graph still calls analyze once (to discover emptiness); this test
    // exists to lock the spyable surface used by the recall integration test.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
