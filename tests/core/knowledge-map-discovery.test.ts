import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { produceKnowledgeMapDiscoveries } from "../../src/core/knowledge-map/discovery.js";
import type { KnowledgeMapAnalysis, KnowledgeMapNode, BridgeCandidate } from "../../src/core/knowledge-map/types.js";

// 匿名 sentinel fixture —— 不含真人名/路径/email
function isolateNode(slug: string, title: string, mentionCount: number): KnowledgeMapNode {
  return { slug, title, type: "entity/x", mentionCount, weightedDegree: 0, degree: 0 };
}
function bridge(slug: string, title: string, communityCount: number): BridgeCandidate {
  return {
    slug,
    title,
    type: "concept/x",
    neighborCommunityIds: Array.from({ length: communityCount }, (_, i) => `community-${i + 1}`),
  };
}
function makeAnalysis(opts: { isolates?: KnowledgeMapNode[]; bridges?: BridgeCandidate[] }): KnowledgeMapAnalysis {
  return {
    resolution: "default",
    nodes: [],
    health: {
      nodeCount: 0,
      edgeCount: 0,
      isolatedNodes: [],
      degreeOneNodes: [],
      connectedComponentCount: 0,
      largestConnectedComponentSize: 0,
    },
    communities: [],
    bridgeCandidates: opts.bridges ?? [],
    highMentionIsolates: opts.isolates ?? [],
    weaklyConnectedNodes: [],
  };
}

describe("produceKnowledgeMapDiscoveries", () => {
  let testDir: string;
  let db: CBrainDB;

  beforeEach(() => {
    testDir = `/tmp/cbrain-test-km-disco-${process.pid}-${Math.random().toString(36).slice(2)}`;
    db = new CBrainDB(`${testDir}/test.sqlite`);
  });
  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("isolation nodes → knowledge_map_isolation discoveries", () => {
    const analysis = makeAnalysis({
      isolates: [isolateNode("entity/a", "实体A", 12), isolateNode("entity/b", "实体B", 8)],
    });
    const res = produceKnowledgeMapDiscoveries(db, analysis);
    expect(res.isolation).toBe(2);
    expect(res.bridge).toBe(0);
    expect(res.total).toBe(2);
    const rows = db.getDiscoveriesByType("knowledge_map_isolation", 10);
    expect(rows).toHaveLength(2);
    expect(rows.flatMap((r) => JSON.parse(r.entities)).sort()).toEqual(["entity/a", "entity/b"]);
  });

  test("bridge candidates → knowledge_map_bridge discoveries", () => {
    const analysis = makeAnalysis({ bridges: [bridge("concept/d", "主题D", 3)] });
    const res = produceKnowledgeMapDiscoveries(db, analysis);
    expect(res.bridge).toBe(1);
    const rows = db.getDiscoveriesByType("knowledge_map_bridge", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].actionable).toBe("medium");
  });

  test("limits isolation to 3 and bridge to 3", () => {
    const analysis = makeAnalysis({
      isolates: [1, 2, 3, 4, 5].map((n) => isolateNode(`entity/n${n}`, `实体N${n}`, 20 - n)),
      bridges: [1, 2, 3, 4].map((n) => bridge(`concept/b${n}`, `主题B${n}`, 2 + n)),
    });
    const res = produceKnowledgeMapDiscoveries(db, analysis);
    expect(res.isolation).toBe(3);
    expect(res.bridge).toBe(3);
    expect(db.getDiscoveriesByType("knowledge_map_isolation", 10)).toHaveLength(3);
    expect(db.getDiscoveriesByType("knowledge_map_bridge", 10)).toHaveLength(3);
  });

  test("empty analysis → no-op", () => {
    const res = produceKnowledgeMapDiscoveries(db, makeAnalysis({}));
    expect(res.total).toBe(0);
    expect(res.inserted).toBe(0);
    expect(db.getDiscoveriesByType("knowledge_map_isolation", 10)).toHaveLength(0);
  });

  test("deterministic: same analysis → same dedup keys (idempotent)", () => {
    const analysis = makeAnalysis({ isolates: [isolateNode("entity/a", "实体A", 12)] });
    produceKnowledgeMapDiscoveries(db, analysis);
    const firstId = db.getDiscoveriesByType("knowledge_map_isolation", 10)[0].id;
    const second = produceKnowledgeMapDiscoveries(db, analysis);
    expect(second.inserted).toBe(0); // recurrence, not new insert
    const rows = db.getDiscoveriesByType("knowledge_map_isolation", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstId);
  });

  test("dismissed KM discovery is NOT resurrected by recurrence (#172)", () => {
    const analysis = makeAnalysis({ isolates: [isolateNode("entity/a", "实体A", 12)] });
    produceKnowledgeMapDiscoveries(db, analysis);
    const created = db.getDiscoveriesByType("knowledge_map_isolation", 10);
    expect(created).toHaveLength(1);
    db.updateDiscoveryStatus(created[0].id, "dismissed"); // #172

    produceKnowledgeMapDiscoveries(db, analysis); // next Dream cycle

    // dismissed row exists, status untouched, NOT surfaced as pending
    expect(db.getDiscoveriesByType("knowledge_map_isolation", 10)).toHaveLength(0);
    const allRows = db.rawDb
      .prepare("SELECT status, seen FROM discoveries WHERE type = 'knowledge_map_isolation'")
      .all() as Array<{ status: string; seen: number }>;
    expect(allRows[0].status).toBe("dismissed");
    expect(allRows[0].seen).toBe(1);
  });

  test("metadata carries audit signal", () => {
    const analysis = makeAnalysis({ isolates: [isolateNode("entity/a", "实体A", 12)] });
    produceKnowledgeMapDiscoveries(db, analysis);
    const row = db.getDiscoveriesByType("knowledge_map_isolation", 10)[0];
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.source).toBe("knowledge_map");
    expect(meta.mention_count).toBe(12);
  });
});
