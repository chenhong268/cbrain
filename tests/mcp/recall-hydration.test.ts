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
    let timelineBatchCalls = 0;
    let relatedCalls = 0;
    let currentReportsToCalls = 0;
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
        batchGetTimelineForSlugs: () => {
          timelineBatchCalls++;
          return new Map();
        },
        getHotnessWeights: () => new Map([[suppliedPage.slug, 0.8]]),
        getL1Summary: () => null,
      },
      graph: {
        getRelatedEntities: () => {
          relatedCalls++;
          return [];
        },
        getCurrentReportsToLinks: () => {
          currentReportsToCalls++;
          return [];
        },
      },
    };

    const hydrated = hydrateRecallSlugs(ctx as never, [suppliedPage.slug], {
      isBrief: true,
      preloadedPages: new Map([[suppliedPage.slug, suppliedPage as never]]),
    });

    expect(getBySlugCalls).toBe(0);
    expect(timelineBatchCalls).toBe(0);
    expect(relatedCalls).toBe(0);
    expect(currentReportsToCalls).toBe(0);
    expect(hydrated.pagesBySlug.get(suppliedPage.slug)?.title).toBe("实体A");
    expect(hydrated.tagsBySlug.get(suppliedPage.slug)).toEqual(["db-tag", "frontmatter-tag"]);
  });

  test("normal detail hydrates timeline, related entities, and hierarchy once per slug", () => {
    const slug = "entity/entity-b";
    let timelineBatchCalls = 0;
    let relatedCalls = 0;
    let currentReportsToCalls = 0;
    const ctx = {
      pages: {
        getBySlug: () => ({
          slug,
          title: "实体B",
          type: "entity/person",
          body: "实体B的匿名内容",
          frontmatter: { title: "实体B", type: "entity/person", tags: [] },
          expires_at: null,
        }),
      },
      db: {
        batchGetLinksForSlugs: () => new Map([[slug, { outgoing: [], incoming: [] }]]),
        batchGetTagsForSlugs: () => new Map([[slug, []]]),
        batchGetTimelineForSlugs: () => {
          timelineBatchCalls++;
          return new Map([[slug, [{
            id: 1,
            event_date: "2026-01-01",
            source: null,
            summary: "匿名事件",
            created_at: "2026-01-01T00:00:00Z",
          }]]]);
        },
        getHotnessWeights: () => new Map([[slug, 0.9]]),
        getL1Summary: () => null,
      },
      graph: {
        getRelatedEntities: () => {
          relatedCalls++;
          return [{ slug: "entity/entity-c", title: "实体C", type: "entity/person" }];
        },
        getCurrentReportsToLinks: () => {
          currentReportsToCalls++;
          return [];
        },
      },
    };

    const hydrated = hydrateRecallSlugs(ctx as never, [slug], { isBrief: false });

    expect(timelineBatchCalls).toBe(1);
    expect(relatedCalls).toBe(1);
    expect(currentReportsToCalls).toBe(1);
    expect(hydrated.timelineBySlug.get(slug)?.[0]?.summary).toBe("匿名事件");
    expect(hydrated.relatedBySlug.get(slug)?.[0]?.title).toBe("实体C");
    expect(hydrated.hierarchyBySlug.has(slug)).toBe(true);
    expect(hydrated.batchLinks.get(slug)).toEqual({ outgoing: [], incoming: [] });
  });

  test("normal detail filters candidate relations from display links", () => {
    const slug = "entity/entity-d";
    const currentLink = {
      id: 1,
      from_slug: slug,
      to_slug: "entity/entity-e",
      relation: "related_to",
      weight: 1,
      strength: "medium",
      context: "匿名当前关系",
      source_type: "manual",
      confidence: 0.9,
      created_at: "2026-01-01T00:00:00Z",
      last_validated_at: null,
      effective_weight: 1,
      trust_state: "current",
    };
    const candidateLink = {
      id: 2,
      from_slug: slug,
      to_slug: "entity/entity-f",
      relation: "reports_to",
      weight: 1,
      strength: "medium",
      context: "匿名候选关系",
      source_type: "agent",
      confidence: 0.6,
      created_at: "2026-01-01T00:00:00Z",
      last_validated_at: null,
      effective_weight: 1,
      trust_state: "candidate",
    };
    const ctx = {
      pages: {
        getBySlug: () => ({
          slug,
          title: "实体D",
          type: "entity/person",
          body: "实体D的匿名内容",
          frontmatter: { title: "实体D", type: "entity/person", tags: [] },
          expires_at: null,
        }),
      },
      db: {
        batchGetLinksForSlugs: () => new Map([[slug, { outgoing: [currentLink, candidateLink], incoming: [] }]]),
        batchGetTagsForSlugs: () => new Map([[slug, []]]),
        batchGetTimelineForSlugs: () => new Map([[slug, []]]),
        getHotnessWeights: () => new Map([[slug, 0.9]]),
        getL1Summary: () => null,
      },
      graph: {
        getRelatedEntities: () => [],
        getCurrentReportsToLinks: () => [],
      },
    };

    const hydrated = hydrateRecallSlugs(ctx as never, [slug], { isBrief: false });
    const outgoing = hydrated.linksBySlug.get(slug)?.outgoing ?? [];

    expect(outgoing.map(link => link.to_slug)).toEqual(["entity/entity-e"]);
    expect(outgoing.some(link => link.trust_state === "candidate")).toBe(false);
  });
});
