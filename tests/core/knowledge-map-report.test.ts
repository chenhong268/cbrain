import { describe, test, expect } from "bun:test";
import { buildKnowledgeMapReport } from "../../src/core/knowledge-map/report.js";
import type {
  BridgeCandidate,
  CommunitySummary,
  KnowledgeMapAnalysis,
  KnowledgeMapNode,
} from "../../src/core/knowledge-map/index.js";

// ─── Anonymous synthetic fixtures (slugs are test-only; titles are the
//     human labels the report is allowed to show) ────────────────────────────

function node(slug: string, title: string, overrides: Partial<KnowledgeMapNode> = {}): KnowledgeMapNode {
  return {
    slug,
    title,
    type: "entity/person",
    mentionCount: 0,
    weightedDegree: 1,
    degree: 1,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<KnowledgeMapAnalysis> = {}): KnowledgeMapAnalysis {
  const community1: CommunitySummary = {
    id: "community-1",
    size: 12,
    internalEdgeCount: 20,
    density: 0.6,
    totalInternalWeight: 28.5,
    topCoreNodes: [
      node("entity/a", "实体A", { weightedDegree: 5, degree: 3, communityId: "community-1" }),
      node("entity/b", "实体B", { weightedDegree: 4, degree: 3, communityId: "community-1" }),
      node("entity/c", "实体C", { weightedDegree: 4, degree: 3, communityId: "community-1" }),
    ],
    typeDistribution: { "entity/person": 8, "concept/topic": 4 },
  };
  const community2: CommunitySummary = {
    id: "community-2",
    size: 3,
    internalEdgeCount: 1,
    density: 0.2,
    totalInternalWeight: 1.5,
    topCoreNodes: [
      node("concept/d", "概念D", { type: "concept/topic", communityId: "community-2" }),
      node("concept/e", "概念E", { type: "concept/topic", communityId: "community-2" }),
    ],
    typeDistribution: { "concept/topic": 2, "entity/person": 1 },
  };
  const bridge: BridgeCandidate = {
    slug: "entity/c",
    title: "实体C",
    type: "entity/person",
    neighborCommunityIds: ["community-1", "community-2"],
  };
  const isolate = node("entity/x", "实体X", { mentionCount: 10, degree: 0, weightedDegree: 0 });
  const weak = node("entity/y", "实体Y", { mentionCount: 2, degree: 1, weightedDegree: 1, communityId: "community-1" });

  return {
    resolution: "default",
    nodes: [isolate, weak],
    health: {
      nodeCount: 17,
      edgeCount: 21,
      isolatedNodes: [isolate],
      degreeOneNodes: [weak],
      connectedComponentCount: 2,
      largestConnectedComponentSize: 7,
    },
    communities: [community1, community2],
    bridgeCandidates: [bridge],
    highMentionIsolates: [isolate],
    weaklyConnectedNodes: [weak],
    ...overrides,
  };
}

describe("Knowledge Map report builder (#241)", () => {
  // ─── 1. All required sections render ───────────────────────────────────

  test("renders summary + all required sections", () => {
    const { markdown, summary } = buildKnowledgeMapReport(makeAnalysis());
    expect(summary.length).toBeGreaterThan(0);
    expect(markdown).toContain(summary);
    expect(summary).toContain("1 个主知识域");
    expect(summary).toContain("子域/边缘小簇");
    for (const section of ["主要领域", "子域与边缘小簇", "成熟度", "桥接", "孤立", "建议"]) {
      expect(markdown, `${section} section missing`).toContain(section);
    }
  });

  // ─── 2. Domains ordered, human titles (not slugs) ──────────────────────

  test("main domains render human titles and small clusters are not promoted", () => {
    const { markdown } = buildKnowledgeMapReport(makeAnalysis());
    // Human titles appear…
    expect(markdown).toContain("实体A");
    expect(markdown).toContain("概念D");
    // …slugs never do.
    expect(markdown).not.toContain("entity/");
    expect(markdown).not.toContain("concept/");
    // community-1 is a main domain; community-2 is summarized as a small cluster.
    expect(markdown).toContain("### 领域 1（12 项）");
    expect(markdown).not.toContain("### 领域 2（3 项）");
    expect(markdown.indexOf("实体A")).toBeLessThan(markdown.indexOf("概念D"));
  });

  // ─── 3. Maturity wording (mature vs sparse) ────────────────────────────

  test("mature vs sparse wording follows size/density/internal-edge signals", () => {
    const { markdown } = buildKnowledgeMapReport(makeAnalysis());
    // community-1 (size12, density0.6, edges20) → mature wording.
    expect(markdown).toContain("成熟");
    // community-2 (edges1, density0.2) → sparse/loose wording.
    expect(markdown).toContain("松散");
  });

  // ─── 4. Bridge candidates in natural language ──────────────────────────

  test("bridge candidates render as natural language with titles", () => {
    const { markdown } = buildKnowledgeMapReport(makeAnalysis());
    expect(markdown).toContain("实体C");
    expect(markdown).toContain("桥");
  });

  // ─── 5. Isolates / weak nodes drive suggested actions ──────────────────

  test("high-mention isolates and weak nodes surface in actions", () => {
    const { markdown } = buildKnowledgeMapReport(makeAnalysis());
    expect(markdown).toContain("实体X"); // high-mention isolate
    expect(markdown).toContain("实体Y"); // weak node
    expect(markdown).toContain("建议");
  });

  // ─── 6. Empty / tiny graph renders gracefully ──────────────────────────

  test("empty graph renders a graceful report", () => {
    const empty: KnowledgeMapAnalysis = {
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
      bridgeCandidates: [],
      highMentionIsolates: [],
      weaklyConnectedNodes: [],
    };
    const { markdown, summary } = buildKnowledgeMapReport(empty);
    expect(summary.length).toBeGreaterThan(0);
    expect(markdown.length).toBeGreaterThan(0);
    // No crash, no phantom domains.
    expect(markdown).not.toContain("实体A");
  });

  // ─── 7. Default Markdown privacy (no internals) ────────────────────────

  test("default Markdown excludes slugs and internal terms", () => {
    const { markdown } = buildKnowledgeMapReport(makeAnalysis());
    // Slugs / slug prefixes.
    expect(markdown).not.toContain("entity/");
    expect(markdown).not.toContain("concept/");
    expect(markdown).not.toContain("entity/c");
    // Internal algorithm terms.
    for (const banned of ["source_type", "modularity", "confidence", "weightedDegree", "weighted_degree"]) {
      expect(markdown, `${banned} leaked`).not.toContain(banned);
    }
    // But the human title IS shown.
    expect(markdown).toContain("实体A");
  });

  // ─── 8. Debug mode is opt-in and does not touch default output ─────────

  test("debug/raw mode is opt-in and strictly additive", () => {
    const analysis = makeAnalysis();
    const def = buildKnowledgeMapReport(analysis);
    const dbg = buildKnowledgeMapReport(analysis, { includeDebug: true });

    // Default has no raw; debug carries it.
    expect(def.raw).toBeUndefined();
    expect(dbg.raw).toBe(analysis);

    // Debug Markdown = default body + appendix, so default is a prefix and is
    // itself unchanged (no internals leak into the default body).
    expect(dbg.markdown.startsWith(def.markdown)).toBe(true);
    expect(dbg.markdown).toContain("entity/"); // appendix carries internals
    expect(def.markdown).not.toContain("entity/");
  });
});
