# Knowledge Map as Optional Recall Context — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off `knowledge_map_context` option to `deep_recall` that appends same-domain nodes as supplemental exploration context — without touching main ranking, evidence, or the compact/raw response contract.

**Architecture:** A pure function `buildKnowledgeMapContext(analysis, primarySlugs)` selects same-mature-domain supplemental nodes from a `KnowledgeMapAnalysis`. A small spyable `kmContextApi` object wraps `analyzeKnowledgeMap` + the pure function + graceful degradation, so `recall.ts` calls one method and tests can prove the off path never analyzes. Trace goes to `raw.knowledge_map_context`; a natural-language title line goes to `display` + a new compact `related_context` field. No DB writes, no LLM, no cache (Phase 1).

**Tech Stack:** Bun, TypeScript (strict, ESNext), `bun:test`, Zod, existing `analyzeKnowledgeMap` + `isCommunityMature`.

**Spec:** `docs/superpowers/specs/2026-06-29-km-recall-context-design.md`

**Execution:** M-level worktree, inline TDD (per 宏哥). No subagents — the compact/raw boundary and the off-invariant are too easy to get wrong across handoffs.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/recall/km-context.ts` | Create | Pure `buildKnowledgeMapContext` + types + spyable `kmContextApi` (analyze/computeForRecall/degrade). Zero DB writes, zero LLM. |
| `src/mcp/tools/recall.ts` | Modify | Add `knowledge_map_context` schema param; call `kmContextApi` only when `on`; inject trace into `raw`, natural-language line into `display`, and `related_context` into compact. |
| `src/mcp/tools/recall-compact.ts` | Modify | Add optional top-level `related_context` to `CompactRecallResponse`/`Input`; thread through budget `fits()`. |
| `tests/core/recall/km-context.test.ts` | Create | Pure-function unit tests (anonymous fixtures). |
| `tests/mcp/recall-km-context.test.ts` | Create | Integration: off zero-call spy, on supplemental, no leak, exact/grounded unchanged. |

**Reuse (do NOT reimplement):**
- `analyzeKnowledgeMap(db, options?)` — `src/core/knowledge-map.ts:59`
- `isCommunityMature(c)` — `src/core/knowledge-map-report.ts:180` (SINGLE source of maturity thresholds)
- Types `KnowledgeMapAnalysis`, `KnowledgeMapNode`, `CommunitySummary` — `src/core/knowledge-map-types.ts`

---

## Task 1: Pure `buildKnowledgeMapContext` + types

**Files:**
- Create: `src/core/recall/km-context.ts`
- Test: `tests/core/recall/km-context.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/core/recall/km-context.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { buildKnowledgeMapContext } from "../../../src/core/recall/km-context.js";
import type { KnowledgeMapAnalysis, KnowledgeMapNode, CommunitySummary } from "../../../src/core/knowledge-map-types.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recall/km-context.test.ts`
Expected: FAIL — `Cannot find module "../../../src/core/recall/km-context.js"`.

- [ ] **Step 3: Write minimal implementation**

`src/core/recall/km-context.ts`:

```ts
import { analyzeKnowledgeMap } from "../knowledge-map.js";
import { isCommunityMature } from "../knowledge-map-report.js";
import type {
  CBrainDB,
} from "../knowledge-map.js"; // placeholder — see note below
import type {
  CommunitySummary,
  KnowledgeMapAnalysis,
  KnowledgeMapNode,
} from "../knowledge-map-types.js";

// NOTE: `CBrainDB` is imported from storage, not knowledge-map. Fix in Step 3b.
```

> **Step 3b (type import fix):** `CBrainDB` lives in `src/storage/sqlite.ts`. Replace the placeholder import with:
> ```ts
> import type { CBrainDB } from "../../storage/sqlite.js";
> import { analyzeKnowledgeMap } from "../knowledge-map.js";
> import { isCommunityMature } from "../knowledge-map-report.js";
> import type { CommunitySummary, KnowledgeMapNode } from "../knowledge-map-types.js";
> ```

Full file content:

```ts
import { analyzeKnowledgeMap } from "../knowledge-map.js";
import { isCommunityMature } from "../knowledge-map-report.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { CommunitySummary, KnowledgeMapNode } from "../knowledge-map-types.js";

export interface KmSupplementalNode {
  slug: string;
  title: string;
  type: string;
  communityId: string;
  weightedDegree: number;
}

export type KmContextReason = "same_domain_context" | "no_mature_domain" | "km_unavailable";

export interface KmContextResult {
  matchedDomains: CommunitySummary[];
  supplemental: KmSupplementalNode[];
  excludedIsolatesCount: number;
  reason: KmContextReason;
}

export interface KmContextOptions {
  maxPerDomain?: number;
  totalCap?: number;
}

const DEFAULT_MAX_PER_DOMAIN = 3;
const DEFAULT_TOTAL_CAP = 5;

/**
 * #245 — Pure selection of same-mature-domain supplemental nodes for recall.
 * Community membership is NAVIGATION CONTEXT, never evidence or ranking. Reuses
 * isCommunityMature (single source of maturity thresholds). Does not mutate.
 */
export function buildKnowledgeMapContext(
  analysis: KnowledgeMapAnalysis,
  primarySlugs: string[],
  options?: KmContextOptions,
): KmContextResult {
  const maxPerDomain = options?.maxPerDomain ?? DEFAULT_MAX_PER_DOMAIN;
  const totalCap = options?.totalCap ?? DEFAULT_TOTAL_CAP;
  const primarySet = new Set(primarySlugs);

  const nodeBySlug = new Map<string, KnowledgeMapNode>();
  for (const n of analysis.nodes) nodeBySlug.set(n.slug, n);

  // Communities that at least one primary result belongs to AND are mature.
  const matchedIds = new Set<string>();
  for (const slug of primarySlugs) {
    const cid = nodeBySlug.get(slug)?.communityId;
    if (cid) matchedIds.add(cid);
  }
  const matchedDomains = analysis.communities.filter(
    (c) => matchedIds.has(c.id) && isCommunityMature(c),
  );

  if (matchedDomains.length === 0) {
    return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "no_mature_domain" };
  }

  // Isolates = degree-0 (health.isolatedNodes) ∪ high-mention isolates. Excluded
  // from supplemental AND counted. The count is WHOLE-GRAPH (isolates carry no
  // communityId by definition), not per matched-domain — matches spec "孤立节点
  // 排除并计数".
  const isolateSlugs = new Set<string>();
  for (const n of analysis.health.isolatedNodes) isolateSlugs.add(n.slug);
  for (const n of analysis.highMentionIsolates) isolateSlugs.add(n.slug);
  const excludedIsolatesCount = [...isolateSlugs].filter((s) => !primarySet.has(s)).length;

  const pooled: KmSupplementalNode[] = [];
  for (const c of matchedDomains) {
    const candidates = analysis.nodes
      .filter(
        (n) =>
          n.communityId === c.id &&
          !primarySet.has(n.slug) &&
          !isolateSlugs.has(n.slug),
      )
      .sort((a, b) => b.weightedDegree - a.weightedDegree)
      .slice(0, maxPerDomain);
    for (const n of candidates) {
      pooled.push({ slug: n.slug, title: n.title, type: n.type, communityId: c.id, weightedDegree: n.weightedDegree });
    }
  }

  const supplemental = pooled.sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, totalCap);
  return { matchedDomains, supplemental, excludedIsolatesCount, reason: "same_domain_context" };
}
```

(`kmContextApi` is added in Task 2.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recall/km-context.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/recall/km-context.ts tests/core/recall/km-context.test.ts
git commit -m "feat(recall): pure buildKnowledgeMapContext for KM domain context (#245)"
```

---

## Task 2: Spyable `kmContextApi` (analyze + degrade)

**Files:**
- Modify: `src/core/recall/km-context.ts` (append `kmContextApi`)
- Test: `tests/core/recall/km-context.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/core/recall/km-context.test.ts`:

```ts
import { kmContextApi } from "../../../src/core/recall/km-context.js";
import { spyOn } from "bun:test";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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
```

Add `beforeEach`/`afterEach` imports to the top imports if not present.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/recall/km-context.test.ts`
Expected: FAIL — `kmContextApi` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/recall/km-context.ts`:

```ts
/**
 * #245 — Spyable entry point for recall. recall.ts calls ONLY computeForRecall.
 * Tests spyOn(kmContextApi, "analyze"|"computeForRecall") to prove the off path
 * never analyzes. Arrow functions + explicit `kmContextApi.analyze(db)` (no `this`)
 * so spies stay stable regardless of call-site binding.
 */
export const kmContextApi = {
  analyze: (db: CBrainDB): KnowledgeMapAnalysis => analyzeKnowledgeMap(db),
  computeForRecall: (
    db: CBrainDB,
    primarySlugs: string[],
    options?: KmContextOptions,
  ): KmContextResult => {
    try {
      const analysis = kmContextApi.analyze(db);
      if (analysis.nodes.length === 0) {
        return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "no_mature_domain" };
      }
      return buildKnowledgeMapContext(analysis, primarySlugs, options);
    } catch {
      return { matchedDomains: [], supplemental: [], excludedIsolatesCount: 0, reason: "km_unavailable" };
    }
  },
};
```

Also add `import type { KnowledgeMapAnalysis } from "../knowledge-map-types.js";` to the type imports (needed for the `analyze` return type).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/recall/km-context.test.ts`
Expected: PASS — 8 tests. (Empty graph → `no_mature_domain`: no communities match, so `buildKnowledgeMapContext` returns `no_mature_domain`. `km_unavailable` is reserved for the `catch` path only.)

- [ ] **Step 5: Commit**

```bash
git add src/core/recall/km-context.ts tests/core/recall/km-context.test.ts
git commit -m "feat(recall): spyable kmContextApi with graceful degradation (#245)"
```

---

## Task 3: `recall.ts` schema param + off-path zero-call proof

**Files:**
- Modify: `src/mcp/tools/recall.ts:70-73` (schema + destructure) and `:300` (KM call site, guarded)
- Test: `tests/mcp/recall-km-context.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/mcp/recall-km-context.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";
import { kmContextApi } from "../../src/core/recall/km-context.js";

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({ embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536), tokenCount: text.length }),
    embedBatch: async (texts: string[]) => texts.map((t) => ({ embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536), tokenCount: t.length })),
  };
}
function createMockLanceDB() {
  return { connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [], deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {} };
}
function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

describe("deep_recall knowledge_map_context (#245)", () => {
  const testDir = "/tmp/cbrain-test-recall-km";
  const dbPath = join(testDir, "t.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath: join(dirname(dbPath), "runtime") };
  });
  afterEach(() => { db.close(); if (existsSync(testDir)) rmSync(testDir, { recursive: true }); });

  // Seed a mature triad (3 nodes + triangle links, density 1.0 → isCommunityMature
  // true). CRITICAL for test validity: ONLY node A carries the query token; B and C
  // share no token with the query. So a query for `token` returns A as the SOLE
  // primary hit, and KM must surface B/C as same-domain supplemental — proving
  // #245's value rather than an FTS artifact that already returned all three.
  function seedMatureTriad(prefix: string): { slugs: string[]; query: string } {
    const slugs = [`${prefix}/a`, `${prefix}/b`, `${prefix}/c`];
    const token = `${prefix.replace(/\//g, "-")}-alpha`; // FTS-safe unique token (no slash)
    const chunks = [
      `${token} domain anchor`, // A: the only node the query token matches
      `domain sibling beta`,    // B: no token shared with the query
      `domain sibling gamma`,   // C: no token shared with the query
    ];
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(slugs[i], "entity/person", slugs[i], `${slugs[i]}.md`, "h1", 2, 3);
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run(slugs[i], 0, chunks[i]);
      db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slugs[i], chunks[i]);
    }
    // Fully-connected triangle (3 edges). Columns verified vs sqlite.ts: links
    // gains source_type/confidence/trust_state via migration; KM effective weight
    // = weight * confidence * reliabilityFor(source_type) at knowledge-map.ts:205
    // (manual→1.0). activeFilter (sqlite.ts:1865) admits non-rejected trust_state.
    const pairs = [[0,1],[0,2],[1,2]];
    for (const [i,j] of pairs) {
      db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, weight, confidence, source_type, trust_state) VALUES (?, ?, 'mentions', 1.0, 0.9, 'manual', 'trusted')")
        .run(slugs[i], slugs[j]);
    }
    return { slugs, query: token };
  }

  test("off (default): analyzeKnowledgeMap is never called", async () => {
    const { query } = seedMatureTriad("entity/triad");
    const spy = spyOn(kmContextApi, "computeForRecall");
    const server = createServer(deps);
    await getTools(server).deep_recall.handler({ query });
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });

  test("off (default): response has no knowledge_map_context trace", async () => {
    const { query } = seedMatureTriad("entity/triad2");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.raw?.knowledge_map_context).toBeUndefined();
    expect(payload.related_context).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/recall-km-context.test.ts`
Expected: first test passes as a **baseline guard** (KM isn't wired yet, so the spy is trivially 0). It becomes meaningful once Task 4 wires the on-path — it must keep passing (stay 0) after wiring, proving the off path never analyzes.

- [ ] **Step 3: Write minimal implementation**

Edit `src/mcp/tools/recall.ts`:

(a) Add schema param after `evidence` (after line 71):

```ts
      knowledge_map_context: z.enum(["on", "off"]).optional().default("off")
        .describe("【探索线索，非主召回】开启后在主结果之外补充同一知识域的相关节点，帮 Agent 决定下一步探索什么。不改变主结果排序，不作为事实依据。默认 off。"),
```

(b) Add to destructure (line 73):

```ts
  }, async ({ query, limit, strategy, session_id, detail: detailLevel, multiStep, grounded, include_raw, evidence, knowledge_map_context }) => {
```

(c) Add the guarded call after `const topSlugs = searchResults.map(r => r.slug);` (after line 300):

```ts
    // #245 — Knowledge Map domain context. Supplemental navigation ONLY; never
    // affects main ranking/score/projection. Off path short-circuits before the
    // call, so analyzeKnowledgeMap is never invoked (proven by spy in tests).
    const kmResult = knowledge_map_context === "on" && topSlugs.length > 0
      ? kmContextApi.computeForRecall(ctx.db, topSlugs)
      : null;
```

(d) Add import at top of file:

```ts
import { kmContextApi } from "../../core/recall/km-context.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/recall-km-context.test.ts`
Expected: PASS — 2 tests (off zero-call + no trace).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall.ts tests/mcp/recall-km-context.test.ts
git commit -m "feat(recall): knowledge_map_context schema param + off-path guard (#245)"
```

---

## Task 4: On-path `raw.knowledge_map_context` trace

**Files:**
- Modify: `src/mcp/tools/recall.ts` (inject into `raw` on the include_raw branch, ~line 528-537)
- Test: `tests/mcp/recall-km-context.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
  test("on + include_raw: raw.knowledge_map_context carries matched domains + supplemental", async () => {
    const { slugs, query } = seedMatureTriad("entity/triad3");
    const server = createServer(deps);
    // Query token is on A only → primary = [A]; KM MUST surface B and C as
    // same-domain supplemental. This is #245's core value, not an FTS artifact.
    const r = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    const km = payload.raw?.knowledge_map_context;
    expect(km).toBeDefined();
    expect(km.reason).toBe("same_domain_context");
    // Strong: the two non-primary triad members MUST be exactly the supplemental
    // (order-independent — weightedDegree is symmetric across the triangle).
    expect(km.supplemental_slugs).toEqual(expect.arrayContaining([slugs[1], slugs[2]]));
    expect(km.supplemental_slugs.length).toBe(2);
    expect(km.excluded_isolates_count).toBe(0); // no isolates seeded in this triad
  });

  test("on: main result order is unchanged by KM context", async () => {
    const { query } = seedMatureTriad("entity/triad4");
    const server = createServer(deps);
    const without = await getTools(server).deep_recall.handler({ query, include_raw: true }) as { content: Array<{ text: string }> };
    const withKm = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const orderWithout = JSON.parse(without.content[0].text).entities.map((e: { slug: string }) => e.slug);
    const orderWith = JSON.parse(withKm.content[0].text).entities.map((e: { slug: string }) => e.slug);
    expect(orderWith).toEqual(orderWithout);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/recall-km-context.test.ts -t "raw.knowledge_map_context"`
Expected: FAIL — `payload.raw.knowledge_map_context` is undefined.

- [ ] **Step 3: Write minimal implementation**

Edit `src/mcp/tools/recall.ts` include_raw branch (around line 528-537). Build a raw-only trace object and merge into `raw`:

```ts
    // #245 — KM context trace. raw-only: never display/summary. Carries only
    // structural signals; titles stay out (display/summary get the natural line).
    const kmTrace = kmResult
      ? {
          matched_domains: kmResult.matchedDomains.map((c) => c.id),
          supplemental_slugs: kmResult.supplemental.map((s) => s.slug),
          excluded_isolates_count: kmResult.excludedIsolatesCount,
          reason: kmResult.reason,
        }
      : undefined;
```

Then in the include_raw branch, merge it into `fullRaw`:

```ts
    if (include_raw) {
      const fullRaw = {
        ...raw,
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
        ...(kmTrace ? { knowledge_map_context: kmTrace } : {}),
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ display, summary: envelopeSummary, raw: fullRaw, result_summary: legacySummary, ...payloadRest }, null, 2),
        }],
      };
    }
```

(Compute `kmTrace` before the `if (include_raw)` block so both branches can see it; only the raw branch uses it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/recall-km-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall.ts tests/mcp/recall-km-context.test.ts
git commit -m "feat(recall): raw.knowledge_map_context trace on flag-on path (#245)"
```

---

## Task 5: Compact `related_context` natural-language field

**Files:**
- Modify: `src/mcp/tools/recall-compact.ts` (add `related_context` to Input/Response + budget)
- Modify: `src/mcp/tools/recall.ts` (format line + pass to compact)
- Test: `tests/mcp/recall-km-context.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
  test("on (compact): related_context is natural-language titles, no slug/community_id/weight", async () => {
    const { query } = seedMatureTriad("entity/triad5");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    // compact default (no include_raw) — no raw audit at all
    expect(payload.raw).toBeUndefined();
    // Strong: mature triad seeded, query hit A → B/C supplemental must exist.
    expect(typeof payload.related_context).toBe("string");
    const rc = payload.related_context as string;
    expect(rc).toMatch(/同知识域还涉及/);
    // privacy: no internal identifiers leak into the Agent-facing field
    expect(rc).not.toMatch(/community-\d|entity\/|slug|weight/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/recall-km-context.test.ts -t "related_context"`
Expected: FAIL — `related_context` is never set.

- [ ] **Step 3: Write minimal implementation**

(a) `src/mcp/tools/recall-compact.ts` — add fields and thread through budget:

In `CompactRecallInput` add:
```ts
  /** #245 — natural-language same-domain titles; Agent-facing, no internals. */
  relatedContext?: string;
```
In `CompactRecallResponse` add:
```ts
  /** #245 — same-domain exploration hint, titles only. Omitted when empty. */
  related_context?: string;
```
In `buildCompactRecallResponse`, capture it and include in `assemble` + `fits`:
```ts
  const relatedContext = input.relatedContext;
  // ...inside assemble():
  const base: CompactRecallResponse = {
    display: input.display,
    summary: input.summary,
    result_summary: input.resultSummary,
    query: input.query,
    entities: ents,
    search_meta: safeSearchMeta(input.searchMeta, hasMore),
  };
  const withRelated = relatedContext ? { ...base, related_context: relatedContext } : base;
  return withHints && hints.length > 0 ? { ...withRelated, proactive_hints: hints } : withRelated;
```
(Both `fits` calls measure via `assemble`, so `related_context` is automatically inside the budget.)

(b) `src/mcp/tools/recall.ts` — format the line and pass to compact. Add a helper near the kmTrace computation:

```ts
    const kmRelatedLine = kmResult && kmResult.supplemental.length > 0
      ? `同知识域还涉及：${kmResult.supplemental.map((s) => s.title).join("、")}`
      : undefined;
```

Pass it into the compact call (around line 544-552):
```ts
    const compact = buildCompactRecallResponse({
      display,
      summary: envelopeSummary,
      resultSummary: legacySummary,
      query,
      entities: entities as Array<Record<string, unknown>>,
      searchMeta: diagnosticMeta,
      proactiveHints: compactProactiveHints,
      relatedContext: kmRelatedLine,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/recall-km-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall-compact.ts src/mcp/tools/recall.ts tests/mcp/recall-km-context.test.ts
git commit -m "feat(recall): compact related_context natural-language field (#245)"
```

---

## Task 6: `display` natural-language line + no-leak + exact/grounded invariants

**Files:**
- Modify: `src/mcp/tools/recall.ts` (append `kmRelatedLine` to `display`)
- Test: `tests/mcp/recall-km-context.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```ts
  test("on: display mentions same-domain titles and leaks no internals", async () => {
    const { query } = seedMatureTriad("entity/triad6");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on" }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    // Strong: supplemental exists, so the display line MUST be present.
    expect(payload.display).toContain("同知识域还涉及");
    // FORBIDDEN_VISIBLE_TERMS guard (mirrors frontdoor-dialogue-gate)
    expect(payload.display).not.toMatch(/community-\d|source_type|modularity|weightedDegree|confidence/i);
    expect(payload.summary).not.toMatch(/community-\d|source_type|modularity/i);
  });

  test("on: exact-match order is unchanged (exact match still first)", async () => {
    db.rawDb.prepare("INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("entity/exact-km", "entity/person", "精确域桩", "entity-exact-km.md", "h1", 2, 5);
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query: "精确域桩", knowledge_map_context: "on", include_raw: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    const firstSlug = payload.entities[0]?.slug;
    expect(firstSlug).toBe("entity/exact-km");
  });

  test("on: grounded mode is unaffected (no related_context, no display line)", async () => {
    const { query } = seedMatureTriad("entity/triad7");
    const server = createServer(deps);
    const r = await getTools(server).deep_recall.handler({ query, knowledge_map_context: "on", grounded: true }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0].text);
    expect(payload.related_context).toBeUndefined();
    expect(payload.grounded_answer).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp/recall-km-context.test.ts -t "display mentions"`
Expected: FAIL — display does not yet contain the line.

- [ ] **Step 3: Write minimal implementation**

Edit `src/mcp/tools/recall.ts`. After the `display`/`envelopeSummary` computation (around line 524-527), append the natural-language line:

```ts
    const display = (surfaceInsufficient ? `只找到部分线索：${baseDisplay}` : baseDisplay) +
      (kmRelatedLine ? `\n${kmRelatedLine}` : "");
```

(Rewire the existing `const display = surfaceInsufficient ? ... : baseDisplay;` line to the appended form above so there is exactly one `display` binding.)

The grounded early-returns (line 259-285) happen **before** `kmResult` is computed, so grounded mode never gets a line — satisfying the grounded test without extra guards.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp/recall-km-context.test.ts`
Expected: PASS — all integration tests green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/recall.ts tests/mcp/recall-km-context.test.ts
git commit -m "feat(recall): display same-domain line + exact/grounded invariants (#245)"
```

---

## Task 7: Regression guard + lint

**Files:** none (verification only)

- [ ] **Step 1: Run full recall + release-gate suite**

Run:
```bash
bun test tests/core/recall/km-context.test.ts tests/mcp/recall-km-context.test.ts tests/mcp/recall-quality.test.ts tests/mcp/recall-payload-budget.test.ts tests/mcp/recall-evidence.test.ts tests/release/frontdoor-dialogue-gate.test.ts tests/release/first-recall-gate.test.ts
```
Expected: ALL PASS. Any failure here is a contract regression — fix before proceeding.

- [ ] **Step 2: Run lint gate**

Run: `bun run lint`
Expected: PASS (tsc + biome). Fix any type/lint errors introduced.

- [ ] **Step 3: Run full check**

Run: `bun run check`
Expected: PASS (lint + full test suite).

- [ ] **Step 4: Commit if any fixups were needed**

```bash
git add -A
git commit -m "test(recall): KM context regression guard green (#245)"
```
(If nothing changed, skip — the prior tasks already committed.)

---

## Self-Review

**1. Spec coverage:**
- Default-off explicit option `knowledge_map_context` → Task 3 ✓
- Same-mature-domain supplemental → Task 1 (pure) + Task 4 (wired) ✓
- Isolate exclusion + whole-graph count (degree-0 ∪ high-mention, NOT per-community since isolates have no communityId) → Task 1 (`excludedIsolatesCount`) + Task 4 (trace) ✓
- `isCommunityMature` reuse, no threshold copy → Task 1 imports it ✓
- Trace in raw only → Task 4 (`raw.knowledge_map_context`) ✓
- Natural-language titles in display/compact, no internals → Task 5 + Task 6 ✓
- Off-path zero-call proof (spy) → Task 3 ✓
- Main ranking / exact / grounded unchanged → Task 4 (order) + Task 6 (exact, grounded) ✓
- No cache (Phase 1) → no cache code present; `analyzeKnowledgeMap` called per flag-on ✓
- No DB writes, no LLM → `buildKnowledgeMapContext` pure; recall.ts only reads ✓
- Guardrail: context ≠ truth → display wording "同知识域还涉及" (not "因为同域所以为真") ✓

**2. Placeholder scan:** Step 3b in Task 1 explicitly resolves the `CBrainDB` import (avoided a wrong-module placeholder). Task 3's DB seed columns are verified against sqlite.ts: links gains `source_type`/`confidence`/`trust_state` via migration; KM reads `weight * confidence * reliabilityFor(source_type)` at knowledge-map.ts:205; `activeFilter` at sqlite.ts:1865 admits any non-rejected `trust_state`. No "TBD"/"add error handling"/"similar to" remains.

**3. Type consistency:**
- `KmContextResult` shape (`matchedDomains`, `supplemental`, `excludedIsolatesCount`, `reason`) is identical across Task 1 (definition), Task 2 (`kmContextApi` return), Task 4 (trace mapping `supplemental_slugs`/`excluded_isolates_count`), Task 5 (`kmRelatedLine` reads `supplemental[].title`).
- `kmContextApi.computeForRecall` name is consistent in Task 2 (def), Task 3 (spy + call), Task 4 (call site already added in Task 3).
- `related_context` (snake_case response field) vs `relatedContext` (camelCase input/options) — matches existing `proactive_hints`/`proactiveHints` convention in recall-compact.ts.

**Output contract alignment:** spec and plan agree — compact exposes a **top-level** `related_context` (mirrors `proactive_hints`); it does NOT live on the shared `ToolSummary`. `raw.knowledge_map_context` returns only with `include_raw=true`.
