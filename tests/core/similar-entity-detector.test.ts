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
