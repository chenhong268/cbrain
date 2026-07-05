# Graph Prefetch Batch Implementation Plan

Issue: #283
Parent: #277 Slice 2

Goal: make `HybridSearch.graphPrefetch()` use batched link and title/type reads without changing `GraphContext` behavior.

## Tasks

1. Add RED spy test in `tests/core/search.decompose.test.ts`:
   - seed anonymous entities and links;
   - spy on `getOutgoingLinks`, `getIncomingLinks`, `getPageTitleAndType`, `batchGetLinksForSlugs`, `getPageTitlesAndTypes`;
   - assert graphPrefetch uses batch APIs and not per-slug/per-neighbor APIs.

2. Add/confirm candidate `reports_to` regression:
   - current relation appears;
   - candidate `reports_to` does not appear in neighbor/chains.

3. Refactor `src/core/retrieval/search.ts::graphPrefetch()`:
   - resolve known slugs as today;
   - call `batchGetLinksForSlugs(knownSlugs)` once;
   - filter each link with `isCurrentFactLink`;
   - collect capped neighbors per entity in existing outgoing then incoming order;
   - call `getPageTitlesAndTypes([...knownSlugs, ...neighborSlugs])` once;
   - skip missing neighbor page rows;
   - build chains unchanged.

4. Verification:
   - `bun test tests/core/search.decompose.test.ts tests/core/search-latency-gate.test.ts tests/core/search.escalation-budget.test.ts`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run check`
   - adversarial review checklist from issue #283.
