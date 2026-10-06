import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import {
  QWEN_CONTENT_FALLBACK_MIN_COSINE,
  QWEN_CONTENT_FALLBACK_MIN_MARGIN_RATIO,
  isQwenContentFallbackIdentity,
  selectQwenContentFallbackCandidate,
} from "../../src/core/retrieval/content-relevance.js";
import type { VectorIndexIdentity } from "../../src/storage/lance-identity.js";

const VERIFIED_IDENTITY: VectorIndexIdentity = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
  documentEncoding: 1,
  modelDigest: "ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d",
};

function page(slug: string, cosine: number, origin: "original" | "derived" = "original"): SearchResult {
  const support: RetrievalSupport = {
    vector: origin === "original"
      ? { original: { rankScore: 1, vectorCosineSimilarity: cosine } }
      : { derived: { rankScore: 1, vectorCosineSimilarity: cosine } },
  };
  return attachRetrievalSupport({ slug, score: 0.01, snippet: "匿名片段", source: "hybrid" }, support);
}

describe("#550 local Qwen content fallback identity", () => {
  test("accepts exactly the measured identity", () => {
    expect(isQwenContentFallbackIdentity(VERIFIED_IDENTITY)).toBe(true);
    expect(isQwenContentFallbackIdentity({ ...VERIFIED_IDENTITY, privateField: "x" } as VectorIndexIdentity)).toBe(true);
  });

  test.each([
    ["missing snapshot", null],
    ["missing digest", { ...VERIFIED_IDENTITY, modelDigest: undefined }],
    ["other digest", { ...VERIFIED_IDENTITY, modelDigest: "b".repeat(64) }],
    ["other model", { ...VERIFIED_IDENTITY, model: "qwen3-embedding:4b" }],
    ["other provider", { ...VERIFIED_IDENTITY, provider: "zhipu" }],
    ["dimension-only match", { ...VERIFIED_IDENTITY, dimensions: 2048 }],
    ["other encoding", { ...VERIFIED_IDENTITY, documentEncoding: 2 }],
  ])("refuses %s", (_label, identity) => {
    expect(isQwenContentFallbackIdentity(identity as VectorIndexIdentity | null)).toBe(false);
  });
});

describe("#550 local Qwen content fallback selection", () => {
  test("returns the leading page when it is clear", () => {
    const top = page("records/alpha", 0.7);
    const selected = selectQwenContentFallbackCandidate([top, page("records/beta", 0.5)]);
    expect(selected).toBe(top);
  });

  test("returns nothing when the leading page is below the measured floor", () => {
    const justBelow = QWEN_CONTENT_FALLBACK_MIN_COSINE - 0.0001;
    expect(selectQwenContentFallbackCandidate([page("records/alpha", justBelow), page("records/beta", 0.2)])).toBeNull();
    expect(selectQwenContentFallbackCandidate([page("records/alpha", QWEN_CONTENT_FALLBACK_MIN_COSINE), page("records/beta", 0.2)])?.slug)
      .toBe("records/alpha");
  });

  test("returns nothing when the lead is too small to be a decision", () => {
    const margin = QWEN_CONTENT_FALLBACK_MIN_MARGIN_RATIO;
    expect(selectQwenContentFallbackCandidate([page("records/alpha", 0.6 * margin), page("records/beta", 0.6)])?.slug)
      .toBe("records/alpha");
    expect(selectQwenContentFallbackCandidate([page("records/alpha", 0.6 * margin - 0.001), page("records/beta", 0.6)])).toBeNull();
  });

  test("returns nothing for a single candidate page, however strong", () => {
    expect(selectQwenContentFallbackCandidate([page("records/alpha", 0.99)])).toBeNull();
    expect(selectQwenContentFallbackCandidate([])).toBeNull();
  });

  test("a repeated page cannot invent its own competitor or its own margin", () => {
    const top = page("records/alpha", 0.75);
    const selected = selectQwenContentFallbackCandidate([
      top,
      page("records/alpha", 0.5),
      page("records/beta", 0.7),
    ]);
    expect(selected).toBe(top);

    // The duplicate's weaker row must not be treated as a separate competitor:
    // the real runner-up (0.72) is close enough to suppress the fallback.
    expect(selectQwenContentFallbackCandidate([
      page("records/alpha", 0.75),
      page("records/alpha", 0.2),
      page("records/beta", 0.72),
    ])).toBeNull();
  });

  test("keeps the strongest valid score per page when a row is unusable", () => {
    const valid = page("records/alpha", 0.8);
    const unusable = attachRetrievalSupport(
      { slug: "records/alpha", score: 0.01, snippet: "匿名片段", source: "hybrid" },
      { vector: { original: { rankScore: 1, vectorCosineSimilarity: Number.NaN } } },
    );
    expect(selectQwenContentFallbackCandidate([unusable, valid, page("records/beta", 0.5)])).toBe(valid);
  });

  test("ignores every score that is not the original query's finite page cosine", () => {
    expect(selectQwenContentFallbackCandidate([page("records/alpha", 0.9, "derived"), page("records/beta", 0.4)])).toBeNull();

    const ftsOnly = attachRetrievalSupport(
      { slug: "records/alpha", score: 0.9, snippet: "匿名片段", source: "fts" },
      { fts: { original: { rankScore: 1, rootLexicalCoverage: 1 } } },
    );
    const noSupport: SearchResult = { slug: "records/beta", score: 0.9, snippet: "匿名片段", source: "hybrid" };
    expect(selectQwenContentFallbackCandidate([ftsOnly, noSupport])).toBeNull();

    for (const cosine of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -2]) {
      const broken = page("records/alpha", cosine);
      expect(selectQwenContentFallbackCandidate([broken, page("records/beta", 0.1)])).toBeNull();
    }
  });

  test("a negative but finite cosine is a real competitor, not a rescue", () => {
    expect(selectQwenContentFallbackCandidate([page("records/alpha", 0.61), page("records/beta", -0.4)])?.slug)
      .toBe("records/alpha");
  });

  test("does not reorder or mutate the candidate list it was given", () => {
    const candidates = [page("records/alpha", 0.7), page("records/beta", 0.5)];
    const snapshot = candidates.map((item) => item.slug);
    selectQwenContentFallbackCandidate(candidates);
    expect(candidates.map((item) => item.slug)).toEqual(snapshot);
  });
});
