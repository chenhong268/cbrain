# Recall Hydration Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the per-slug hydration part of `deep_recall` into a focused helper while preserving all public recall behavior.

**Architecture:** Add `src/mcp/tools/recall-hydration.ts` as an internal helper used only by `recall.ts`. The helper owns batch fetches for tags, links, timeline, related entities, hierarchy, hotness weights, and reusable page maps; `recall.ts` keeps routing, search, quality gate, response envelopes, and evidence assembly.

**Tech Stack:** TypeScript, Bun tests, existing CBrain SQLite/PageManager/GraphManager APIs.

---

## Files

- Create: `src/mcp/tools/recall-hydration.ts`
- Modify: `src/mcp/tools/recall.ts`
- Create: `tests/mcp/recall-hydration.test.ts`
- Existing regression suites: `tests/mcp/recall-payload-budget.test.ts`, `tests/mcp/recall-evidence.test.ts`, `tests/mcp/recall-quality.test.ts`

## Task 1: Helper Contract And Page Reuse

- [ ] **Step 1: Write the failing helper test**

Create `tests/mcp/recall-hydration.test.ts` with a focused test that supplies one preloaded page and verifies hydration reuses it instead of requiring a second page read for title/body/frontmatter data.

Expected test shape:

```ts
import { describe, expect, test } from "bun:test";
import { hydrateRecallSlugs } from "../../src/mcp/tools/recall-hydration";

describe("hydrateRecallSlugs (#282)", () => {
  test("reuses supplied page rows for entity data and still batch-loads tags/links", () => {
    const suppliedPage = {
      slug: "entity/entity-a",
      title: "实体A",
      type: "entity/person",
      body: "实体A的匿名内容",
      frontmatter: { title: "实体A", type: "entity/person", tags: ["frontmatter-tag"], tier: 2 },
      tier: 2,
      expires_at: null,
    };
    let getBySlugCalls = 0;
    const ctx = {
      pages: {
        getBySlug: (slug: string) => {
          getBySlugCalls++;
          return slug === suppliedPage.slug ? suppliedPage : null;
        },
      },
      db: {
        batchGetLinksForSlugs: () => new Map([[suppliedPage.slug, { outgoing: [], incoming: [] }]]),
        batchGetTagsForSlugs: () => new Map([[suppliedPage.slug, ["db-tag"]]]),
        batchGetTimelineForSlugs: () => new Map(),
        getHotnessWeights: () => new Map([[suppliedPage.slug, 0.8]]),
        getL1Summary: () => null,
      },
      graph: {
        getRelatedEntities: () => [],
      },
    };

    const hydrated = hydrateRecallSlugs(ctx as never, [suppliedPage.slug], {
      isBrief: true,
      preloadedPages: new Map([[suppliedPage.slug, suppliedPage as never]]),
    });

    expect(getBySlugCalls).toBe(0);
    expect(hydrated.pagesBySlug.get(suppliedPage.slug)?.title).toBe("实体A");
    expect(hydrated.tagsBySlug.get(suppliedPage.slug)).toEqual(["db-tag", "frontmatter-tag"]);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test tests/mcp/recall-hydration.test.ts
```

Expected: FAIL because `src/mcp/tools/recall-hydration.ts` does not exist.

- [ ] **Step 3: Implement minimal helper**

Create `src/mcp/tools/recall-hydration.ts` exporting:

```ts
export interface HydrateRecallOptions {
  isBrief: boolean;
  preloadedPages?: Map<string, ReturnType<ToolContext["pages"]["getBySlug"]>>;
}

export interface HydratedRecallSlugs {
  pagesBySlug: Map<string, ReturnType<ToolContext["pages"]["getBySlug"]>>;
  batchLinks: ReturnType<ToolContext["db"]["batchGetLinksForSlugs"]>;
  tagsBySlug: Map<string, string[]>;
  timelineBySlug: Map<string, Record<string, unknown>[]>;
  relatedBySlug: Map<string, { slug: string; title: string; type: string }[]>;
  hierarchyBySlug: Map<string, ReturnType<typeof getHierarchyContext>>;
  hotnessWeights: Map<string, number>;
}
```

The first implementation should:

- copy `preloadedPages` into `pagesBySlug`;
- call `ctx.pages.getBySlug(slug)` only for missing slugs;
- call `batchGetLinksForSlugs`, `batchGetTagsForSlugs`, and `getHotnessWeights`;
- merge DB tags with frontmatter tags using a stable set union;
- in brief mode, skip timeline/related/hierarchy.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test tests/mcp/recall-hydration.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Normal Detail Enrichment

- [ ] **Step 1: Add failing normal-mode test**

Extend `tests/mcp/recall-hydration.test.ts` with a test where `isBrief: false` verifies:

- `batchGetTimelineForSlugs` is called once;
- `graph.getRelatedEntities` is called once per slug;
- hierarchy is attempted once per slug;
- link rows are available through `batchLinks`.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test tests/mcp/recall-hydration.test.ts
```

Expected: FAIL if the helper does not yet populate normal-mode maps.

- [ ] **Step 3: Implement normal-mode hydration**

Update the helper so non-brief mode:

- calls `ctx.db.batchGetTimelineForSlugs(slugs)`;
- trims timeline rows with existing `trimTimeline`;
- calls `ctx.graph.getRelatedEntities(slug, 5)` inside a fail-open `try/catch`;
- calls `getHierarchyContext(slug, { pages: ctx.pages, graph: ctx.graph })` inside a fail-open `try/catch`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test tests/mcp/recall-hydration.test.ts
bun run typecheck
```

Expected: PASS.

## Task 3: Wire `recall.ts` To Helper

- [ ] **Step 1: Replace local hydration maps**

In `src/mcp/tools/recall.ts`, replace the local declarations and batch-fetch setup for `pagesBySlug`, `linksBySlug`, `timelineBySlug`, `tagsBySlug`, `relatedBySlug`, `hierarchyBySlug`, `batchLinks`, and `hotnessWeights` with `hydrateRecallSlugs(...)`.

Keep these responsibilities in `recall.ts`:

- search and exact match;
- quality gate;
- entity object shaping;
- dossier/birthday/L1/memory skeleton;
- evidence summary;
- cross refs;
- proactive hints;
- envelopes.

- [ ] **Step 2: Run focused recall suites**

Run:

```bash
bun test tests/mcp/recall-hydration.test.ts tests/mcp/recall-payload-budget.test.ts tests/mcp/recall-evidence.test.ts tests/mcp/recall-quality.test.ts
```

Expected: PASS.

## Task 4: Adversarial Review And Full Gate

- [ ] **Step 1: Run adversarial checks**

Manually inspect and record:

1. Entity order and score are unchanged.
2. Brief mode still avoids timeline/related/hierarchy calls.
3. Normal mode still includes links/timeline/hierarchy when requested.
4. Candidate `reports_to` remains filtered by existing current-fact filtering in `recall.ts`.
5. No new per-slug DB reads were introduced for data already batch-loaded or preloaded.

- [ ] **Step 2: Run full verification**

Run:

```bash
git diff --check
bun run lint
bun run typecheck
bun run check
```

Expected: all PASS.

- [ ] **Step 3: Commit**

Commit message:

```bash
git add src/mcp/tools/recall-hydration.ts src/mcp/tools/recall.ts tests/mcp/recall-hydration.test.ts docs/superpowers/plans/2026-07-05-recall-hydration.md
git commit -m "refactor(recall): extract slug hydration helper"
```

