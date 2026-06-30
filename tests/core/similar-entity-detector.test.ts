import { describe, test, expect } from "bun:test";
import {
  detectSimilarEntities,
  type DetectorInput, type DetectorPage, type PageQuality,
} from "../../src/core/similar-entity-detector.js";

function page(slug: string, title: string, type = "entity/company"): DetectorPage {
  return { slug, title, type };
}
function quality(opts: Partial<PageQuality> = {}): PageQuality {
  return { isStub: false, bodyChars: 0, chunkCount: 0, mentionCount: 0, aliasCount: 0, tagCount: 0, ...opts };
}
function input(pages: DetectorPage[], opts: Partial<{ aliases: Map<string, Set<string>>; quality: Map<string, PageQuality>; affine: (a: string, b: string) => boolean }> = {}): DetectorInput {
  const qualityBySlug = new Map<string, PageQuality>();
  for (const p of pages) qualityBySlug.set(p.slug, opts.quality?.get(p.slug) ?? quality());
  return {
    pages,
    registeredAliasesBySlug: opts.aliases ?? new Map(),
    linkDegree: new Map(),
    qualityBySlug,
    areTypesAffine: opts.affine ?? ((a, b) => a === b),
  };
}

describe("similar-entity-detector scaffolding", () => {
  test("identical-title same-type pages → one name_exact high candidate", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ]));
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.matchKind).toBe("name_exact");
    expect(c.typeGate).toBe("same_type");
    expect(c.actionable).toBe("high");
    expect(r.truncated).toBe(false);
  });

  test("non-affine types are dropped (type gate)", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A", "entity/person"), page("entity/b", "实体A", "entity/company"),
    ], { affine: () => false }));
    expect(r.candidates).toHaveLength(0);
  });

  test("truncated=true when pairs exceed maxPairsEvaluated", () => {
    const pages: DetectorPage[] = [];
    for (let i = 0; i < 30; i++) pages.push(page(`entity/p${i}`, "共享Token"));
    const r = detectSimilarEntities(input(pages), { maxPairsEvaluated: 5, maxBucketSize: 100 });
    expect(r.truncated).toBe(true);
    expect(r.pairsEvaluated).toBe(5);
  });

  test("maxBucketSize skips non-discriminative keys", () => {
    const pages: DetectorPage[] = [];
    for (let i = 0; i < 60; i++) pages.push(page(`entity/p${i}`, `共享${i}号`));
    const r = detectSimilarEntities(input(pages), { maxBucketSize: 50, maxPairsEvaluated: 5000 });
    expect(r.pairsEvaluated).toBeLessThan(60);
  });
});

describe("similar-entity-detector strategies", () => {
  test("name_normalized: punctuation/case variants → high", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体 A"), page("entity/b", "实体A"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("name_normalized");
    expect(r.candidates[0].actionable).toBe("high");
  });

  test("name_substring: significant containment → high", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体甲"), page("entity/b", "实体甲公司"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("name_substring");
    expect(r.candidates[0].actionable).toBe("high");
  });

  test("edit_distance: typo-like variant → medium", () => {
    const r = detectSimilarEntities(input([
      page("entity/a", "实体甲乙"), page("entity/b", "实体甲丙"),
    ]));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("edit_distance");
    expect(r.candidates[0].actionable).toBe("medium");
  });

  test("alias_shadow_page: A.title is B's registered alias → high, target=B", () => {
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/b", new Set(["实体甲"]));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体甲"), page("entity/b", "组织C"),
    ], { aliases }));
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.matchKind).toBe("alias_shadow_page");
    expect(c.actionable).toBe("high");
    expect(c.recommendedTarget).toBe("entity/b");
  });

  test("HIGH fix: identical titles are name_exact, NOT alias_shadow_page", () => {
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/b", new Set(["whatever"]));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { aliases }));
    expect(r.candidates[0].matchKind).toBe("name_exact");
  });

  test("shared_alias: two pages share a registered alias → high (same type)", () => {
    const aliases = new Map<string, Set<string>>();
    aliases.set("entity/a", new Set(["共享别名"]));
    aliases.set("entity/b", new Set(["共享别名"]));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体B"),
    ], { aliases }));
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].matchKind).toBe("shared_alias");
    expect(r.candidates[0].sharedAlias).toContain("共享别名");
    expect(r.candidates[0].actionable).toBe("high");
  });
});

describe("similar-entity-detector canonical target", () => {
  test("non-stub beats stub as merge target", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality({ isStub: true }));
    q.set("entity/b", quality({ isStub: false, mentionCount: 5 }));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].recommendedTarget).toBe("entity/b");
  });

  test("completeness (bodyChars) breaks stub-tie", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality({ bodyChars: 10 }));
    q.set("entity/b", quality({ bodyChars: 500 }));
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].recommendedTarget).toBe("entity/b");
  });

  test("ambiguous_target when discriminators 1-5 tie", () => {
    const q = new Map<string, PageQuality>();
    q.set("entity/a", quality());
    q.set("entity/b", quality());
    const r = detectSimilarEntities(input([
      page("entity/a", "实体A"), page("entity/b", "实体A"),
    ], { quality: q }));
    expect(r.candidates[0].ambiguousTarget).toBe(true);
    expect(r.candidates[0].recommendedTarget).toBeUndefined();
  });
});
