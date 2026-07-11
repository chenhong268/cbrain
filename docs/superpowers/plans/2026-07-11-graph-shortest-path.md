# Deterministic Graph Shortest Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, deterministic, read-only shortest-path mode to the existing graph core and `graph_query` contract.

**Architecture:** `GraphManager.findShortestPath` performs one batched BFS query per depth and reconstructs the exact stored edges. A dedicated formatter renders direction-correct natural language, while the existing `graph_query` tool adds an optional target and a mode-specific handler branch without adding tools or changing legacy modes.

**Tech Stack:** TypeScript, Bun test, SQLite through `CBrainDB`, MCP SDK/Zod, existing CBrain envelope helpers.

## Global Constraints

- SQLite is the source of truth; this feature is fully read-only and does not write query-log rows because they feed delayed learning.
- Default shortest-path depth is 4; core clamps 1..6 and MCP accepts integer 1..6 only for `shortest_path`.
- Existing graph modes retain default depth 2 and their permissive numeric schema behavior.
- Use `isCurrentFactLink`; candidate `reports_to` is excluded, while other candidate relations are shown as “待确认关系”.
- Equal-length paths are deterministic: neighbor slug, relation, then edge id.
- Do not call `learn.bumpOnQuery` or `boostLinkConfidence` for shortest-path mode.
- Do not add a tool, schema migration, LLM call, graph cache, inferred link, or ranking change.
- Fixtures and docs use anonymous placeholders only.

---

### Task 1: Batched deterministic shortest-path core

**Files:**
- Modify: `src/core/graph/graph.ts`
- Test: `tests/core/graph.test.ts`

**Interfaces:**
- Produces: `GraphPathNode`, `GraphPath`, `ShortestPathOptions`, and `GraphManager.findShortestPath(fromSlug, toSlug, options?)`.
- Consumes: `CBrainDB.batchGetLinksForSlugs`, `getPageTitlesAndTypes`, and `isCurrentFactLink`.

- [ ] **Step 1: Add RED tests**

Add a `describe("findShortestPath (#326)")` block with explicit tests for direct, ordered two-hop, shortest-over-longer, cycle, no path, missing endpoint, same endpoint, depth boundary, candidate `reports_to`, deterministic equal-length alternatives, and a batch spy. The first and tie-break tests must include these assertions:

```ts
const direct = graph.findShortestPath("entities/a", "entities/b");
expect(direct?.nodes.map((n) => n.slug)).toEqual(["entities/a", "entities/b"]);
expect(direct?.edges.map((e) => [e.from_slug, e.to_slug])).toEqual([["entities/a", "entities/b"]]);
expect(direct?.depth).toBe(1);

// Seed A→C→D before A→B→D; lexical B must still win the equal-hop tie.
const tied = graph.findShortestPath("entities/a", "entities/d");
expect(tied?.nodes.map((n) => n.slug)).toEqual(["entities/a", "entities/b", "entities/d"]);
```

Use anonymous slugs and insert links through SQL so edge ids and trust states are explicit.

The batch spy must wrap `db.batchGetLinksForSlugs` and assert:

```ts
const originalBatch = db.batchGetLinksForSlugs.bind(db);
const frontiers: string[][] = [];
db.batchGetLinksForSlugs = ((slugs: string[], includeInactive?: boolean) => {
  frontiers.push([...slugs]);
  return originalBatch(slugs, includeInactive);
}) as typeof db.batchGetLinksForSlugs;

const path = graph.findShortestPath("entities/a", "entities/d", { maxDepth: 3 });
expect(path?.depth).toBe(3);
expect(frontiers).toEqual([
  ["entities/a"],
  ["entities/b"],
  ["entities/c"],
]);
```

Also spy `getOutgoingLinks`, `getIncomingLinks`, `getPageTitle`, `getPageTitleAndType`, and `getPage` and assert they are never called. Record `getPageTitlesAndTypes` arguments and assert one endpoint batch, one candidate-existence batch per visited depth, and one final ordered-path batch. The per-depth batch prevents a dangling shorter chain from masking a complete longer path without introducing N+1 reads.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test tests/core/graph.test.ts
```

Expected: FAIL because `findShortestPath` is not defined.

- [ ] **Step 3: Implement the minimal core**

Add:

```ts
export interface GraphPathNode {
  slug: string;
  title: string;
  type: string;
}

export interface GraphPath {
  nodes: GraphPathNode[];
  edges: Link[];
  depth: number;
}

export interface ShortestPathOptions {
  maxDepth?: number;
}
```

Inside `findShortestPath`:

1. Normalize `maxDepth` with `Math.min(6, Math.max(1, Math.trunc(value)))`, default 4.
2. Hydrate both endpoints in one `getPageTitlesAndTypes` call; return `null` if either is absent.
3. Return the existing endpoint as `{nodes:[...], edges:[], depth:0}` when source equals target.
4. BFS with `visited`, `frontier`, and `parents: Map<string, {previous:string; edge:Link}>`.
5. For each depth, call `batchGetLinksForSlugs(frontier)` once. For each frontier slug, combine outgoing and incoming, filter with `isCurrentFactLink`, map to `{neighbor, edge}`, then sort by neighbor/relation/id.
6. Mark each neighbor visited when first encountered. Stop after completing the deterministic predecessor assignment that finds the target.
7. Reconstruct slugs and exact edges backwards, reverse both, hydrate all path nodes once, and return `null` if any path node is dangling.

Convert `LinkRow` to `Link` without exposing storage-only fields. Preserve `id`, endpoints, relation, weight, strength, nullable context as `undefined`, source/trust/provenance fields, and confidence.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test tests/core/graph.test.ts
bun run typecheck
bun run typecheck:tests
```

Expected: all graph tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/graph.ts tests/core/graph.test.ts
git commit -m "feat(graph): add deterministic shortest path core (#326)"
```

---

### Task 2: Direction-correct path envelope

**Files:**
- Modify: `src/mcp/tools/format-result.ts`
- Test: `tests/mcp/graph-timeline-envelope.test.ts`

**Interfaces:**
- Consumes: `GraphPath` from Task 1.
- Produces: `formatGraphPathEnvelope(payload)` with the existing `ToolSummary` contract.

- [ ] **Step 1: Add RED formatter tests**

Cover:

- forward direct edge renders `实体A —关系→ 实体B`;
- reverse direct edge renders `实体A ←关系— 实体B` without reversing raw endpoints;
- mixed-direction two-hop renders both arrows correctly;
- candidate non-`reports_to` includes “待确认关系”;
- found, no-path, missing-target, unresolved-source, and unresolved-target summary reasons;
- no display leakage of `entities/`, slug, source type, confidence, trust-state literals, ids, paths, or debug terms.

Use one payload type:

```ts
export interface GraphPathEnvelopePayload {
  fromTitle?: string;
  toTitle?: string;
  maxDepth: number;
  reason: "path_found" | "no_path" | "unresolved_source" | "unresolved_target" | "missing_target" | "invalid_depth";
  path: GraphPath | null;
}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test tests/mcp/graph-timeline-envelope.test.ts
```

Expected: FAIL because `formatGraphPathEnvelope` is not exported.

- [ ] **Step 3: Implement the formatter**

Use `toolEnvelope` and the existing `ToolSummary` vocabulary:

- `path_found` → `status:"ok"`, `count:path.edges.length`, `message`, `hops`, `maxDepth`;
- `no_path` → `status:"empty"`, count 0;
- invalid input reasons, including `invalid_depth` → `status:"error"`, count 0 and `hops:0`.

Because `ToolSummary` is shared, define a local intersection type for additional fixed fields instead of changing all tools:

```ts
type GraphPathSummary = ToolSummary & {
  reason: GraphPathEnvelopePayload["reason"];
  fromTitle?: string;
  toTitle?: string;
  hops: number;
  maxDepth: number;
};
```

Declare the formatter return type explicitly as `{ display: string; summary: GraphPathSummary; raw: GraphPathEnvelopePayload }`; do not let `toolEnvelope()` inference narrow the exported summary back to base `ToolSummary`.

Render each hop by checking original orientation:

```ts
const forward = edge.from_slug === from.slug && edge.to_slug === to.slug;
const relation = edge.relation || "关联";
const pending = edge.trust_state === "candidate" ? "（待确认关系）" : "";
return forward
  ? `${from.title} —${relation}${pending}→ ${to.title}`
  : `${from.title} ←${relation}${pending}— ${to.title}`;
```

Pass final display through `sanitizeDisplay`, but use natural “待确认关系”; do not emit raw `candidate`. Add separate assertions proving `trusted`, `user_thought`, and legacy null are not marked pending.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test tests/mcp/graph-timeline-envelope.test.ts
bun run typecheck
bun run typecheck:tests
```

Expected: all formatter tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/format-result.ts tests/mcp/graph-timeline-envelope.test.ts
git commit -m "feat(graph): format explainable shortest paths (#326)"
```

---

### Task 3: MCP shortest-path mode without write side effects

**Files:**
- Modify: `src/mcp/tools/graph.ts`
- Test: `tests/mcp/graph-timeline-envelope.test.ts`

**Interfaces:**
- Consumes: `findShortestPath` and `formatGraphPathEnvelope`.
- Produces: additive `graph_query(mode="shortest_path", target=...)` contract.

- [ ] **Step 1: Add RED MCP tests**

Add integration tests for:

- title and slug endpoint resolution;
- default shortest depth 4 while legacy traverse default remains 2;
- missing target, unknown source, and unknown target reasons;
- shortest-path rejects 0, negative, fractional, and >6 depth through a structured error envelope;
- legacy mode still accepts its historical numeric values;
- no path returns `empty/no_path`;
- spies and a delayed `LearnManager.recomputeAll()` check prove `logQuery`, `learn.bumpOnQuery`, and `db.boostLinkConfidence` do not change activity or link state.

The side-effect test must build and patch the actual `ToolContext` before registration:

```ts
const ctx = buildContext(deps);
let bumps = 0;
let boosts = 0;
ctx.learn.bumpOnQuery = () => { bumps++; };
ctx.db.boostLinkConfidence = (() => { boosts++; }) as typeof ctx.db.boostLinkConfidence;
const server = new McpServer({ name: "test", version: "0" });
attachMcpTools(server, ctx);
await callTool(server, "graph_query", {
  slug: "entities/a",
  mode: "shortest_path",
  target: "entities/b",
});
expect(bumps).toBe(0);
expect(boosts).toBe(0);
```

Import `buildContext`, `attachMcpTools`, and `McpServer` from their existing modules. This avoids guessing at the context hidden by `createServer()`.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test tests/mcp/graph-timeline-envelope.test.ts
```

Expected: FAIL because the schema does not accept `shortest_path`.

- [ ] **Step 3: Implement the handler branch**

- Change `mode` enum to include `shortest_path`.
- Add optional `target`.
- Remove `.default(2)` from shared `depth`; compute `effectiveDepth = depth ?? (mode === "shortest_path" ? 4 : 2)`.
- Before legacy result processing, handle `shortest_path` in a dedicated early-return branch.
- Validate only this branch with `Number.isInteger(effectiveDepth) && effectiveDepth >= 1 && effectiveDepth <= 6`.
- Resolve source and target separately. Do not treat an unknown name as a valid raw slug.
- Build and return `formatGraphPathEnvelope`.
- Return before `db.logQuery`, `learn.bumpOnQuery`, and `boostLinkConfidence`; query-log rows are intentionally skipped because they participate in delayed learning.

Do not alter the legacy switch or its post-processing beyond supplying `effectiveDepth` to `traverse`.

- [ ] **Step 4: Verify GREEN and legacy compatibility**

Run:

```bash
bun test tests/mcp/graph-timeline-envelope.test.ts tests/mcp/server.test.ts tests/core/search.test.ts tests/core/hierarchy.test.ts
bun run typecheck
bun run typecheck:tests
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/graph.ts tests/mcp/graph-timeline-envelope.test.ts
git commit -m "feat(mcp): expose shortest path graph query (#326)"
```

---

### Task 4: Agent routing contract and documentation

**Files:**
- Modify: `skills/connect.md`
- Modify: `skills/agent-facing.routing-eval.jsonl`
- Modify: `bin/check-resolver-pilot.sh`

**Interfaces:**
- Documents the Task 3 MCP schema; no runtime code change.

- [ ] **Step 1: Add the focused gate assertion first**

In `bin/check-resolver-pilot.sh`, add a deterministic JSON contract check after the agent-facing eval block:

```bash
if python3 - "$AF_EVAL" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
pairwise = [r for r in rows if r.get("category") == "relationship" and r.get("expected_tool") == "graph_query"]
assert any(
    r.get("expected_args", {}).get("mode") == "shortest_path"
    and isinstance(r.get("expected_args", {}).get("slug"), str)
    and isinstance(r.get("expected_args", {}).get("target"), str)
    for r in pairwise
)
assert any(
    r.get("category") == "relationship_single"
    and r.get("expected_tool") == "graph_query"
    and r.get("expected_args", {}).get("mode") == "traverse"
    and "target" not in r.get("expected_args", {})
    for r in rows
)
PY
then
  eval_contract=true
else
  eval_contract=false
fi

if $eval_contract \
  && grep -q 'mode: "shortest_path"' "$SKILLS_DIR/connect.md" \
  && grep -q 'target:' "$SKILLS_DIR/connect.md" \
  && grep -q 'empty/no_path' "$SKILLS_DIR/connect.md"; then
  pass "pairwise relationship contract uses graph shortest_path"
else
  fail "pairwise relationship contract must use graph shortest_path"
fi
```

Run `bash bin/check-resolver-pilot.sh`. Expected: FAIL because the current skill and fixture still use traverse.

- [ ] **Step 2: Update the anonymous routing fixture**

Change the pairwise relation case to:

```json
{"input":"人物A和组织B是什么关系","category":"relationship","expected_tool":"graph_query","expected_args":{"slug":"人物A","mode":"shortest_path","target":"组织B"},"forbidden_tools":["agentic_research"],"forbidden_output_terms":[],"rationale":"双实体关系先走确定性最短路径"}
```

Add a `relationship_single` anonymous case such as “人物A认识谁” expecting `graph_query` with `{"slug":"人物A","mode":"traverse","depth":2}` and no target, so the new route does not swallow all graph questions.

- [ ] **Step 3: Update `connect.md` and anonymize it**

Replace Step 2's manual seed traversal with the additive MCP contract:

```text
graph_query({ slug: <slugA>, mode: "shortest_path", target: <slugB>, depth: 4 })
```

State that any found path stops fallback. Only `empty/no_path` proceeds to dual traversal for shared neighbors. Keep timeline and full-context steps unchanged.

Replace every real-looking example in `connect.md` with “人物A、人物B、组织C、项目D”. This is mandatory even though the current privacy gate does not scan that file. Do not broaden this into a full skill rewrite.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bash bin/check-resolver-pilot.sh
bun run check:docs
```

Expected: both gates pass.

- [ ] **Step 5: Commit**

```bash
git add skills/connect.md skills/agent-facing.routing-eval.jsonl bin/check-resolver-pilot.sh
git commit -m "docs(agent): route pairwise relations through shortest path (#326)"
```

---

### Task 5: Adversarial review and release gates

**Files:**
- Modify only files already in scope when fixing confirmed findings.

- [ ] **Step 1: Run focused tests and static gates**

```bash
git diff --check main...HEAD
bun run typecheck
bun run typecheck:tests
bun run lint
bun test tests/core/graph.test.ts tests/core/search.test.ts tests/core/hierarchy.test.ts tests/mcp/graph-timeline-envelope.test.ts tests/mcp/server.test.ts
bash bin/check-resolver-pilot.sh
bun run check:docs
```

- [ ] **Step 2: Run independent adversarial attacks**

Each reviewer must return PASS/FAIL with a concrete test or file/line evidence for:

1. candidate/superseded edge leakage, including candidate `reports_to` and ordinary candidate relations;
2. cycles, self paths, max-depth bypass, fractional/invalid MCP depth;
3. deterministic equal-hop selection under reversed insertion order;
4. N+1 reads by visited node rather than one batch per depth;
5. display direction reversal and internal-field/privacy leakage;
6. `bumpOnQuery`, confidence boost, or any other unexpected write;
7. legacy graph, hierarchy, search, and tool-profile regression.

- [ ] **Step 3: Fix every confirmed CRITICAL/HIGH/MEDIUM finding with RED→GREEN evidence**

Do not waive a finding by weakening an assertion. If a finding changes public behavior or scope, stop and return to the spec.

- [ ] **Step 4: Run the full gate fresh**

```bash
bun run check
git diff --check main...HEAD
git status --short
```

Expected: all tests pass, no whitespace errors, and only intentional commits/files are present.

- [ ] **Step 5: Final review commit if needed**

```bash
git add <only-reviewed-files>
git commit -m "fix(graph): harden shortest path review findings (#326)"
```

Do not create an empty commit when no fixes were needed.
