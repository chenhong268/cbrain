import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import {
  assessContentCandidate,
  filterContentCandidates,
} from "../../src/core/retrieval/content-relevance.js";

function candidate(
  slug: string,
  support?: RetrievalSupport,
  source: SearchResult["source"] = "hybrid",
): SearchResult {
  const result: SearchResult = { slug, score: 0.01, snippet: "匿名片段", source };
  return support ? attachRetrievalSupport(result, support) : result;
}

describe("content candidate honesty", () => {
  test.each([
    [
      "original exact",
      { exact: { original: { rankScore: 1 } } },
      "exact",
    ],
    [
      "vector at threshold",
      { vector: { original: { rankScore: 0.01, vectorCosineSimilarity: 0.8 } } },
      "strong_vector",
    ],
    [
      "vector within floating-point epsilon",
      { vector: { original: { rankScore: 0.01, vectorCosineSimilarity: 0.7999995 } } },
      "strong_vector",
    ],
    [
      "original FTS lexical support",
      { fts: { original: { rankScore: 1, rootLexicalCoverage: 0.6 } } },
      "strong_lexical",
    ],
    [
      "derived temporal lexical support",
      { temporal: { derived: { rankScore: 1, rootLexicalCoverage: 0.61 } } },
      "strong_lexical",
    ],
    [
      "derived exact with root-query support",
      { exact: { derived: { rankScore: 1, rootLexicalCoverage: 0.6 } } },
      "strong_lexical",
    ],
  ] as const)("accepts %s", (_label, support, expected) => {
    expect(assessContentCandidate("匿名根问题", candidate("accepted", support))).toEqual({
      accepted: true,
      reason: expected,
    });
  });

  test.each([
    ["graph only", { graph: { original: { rankScore: 99 } } }],
    ["derived vector only", { vector: { derived: { rankScore: 99, vectorCosineSimilarity: 1 } } }],
    ["weak vector", { vector: { original: { rankScore: 99, vectorCosineSimilarity: 0.79 } } }],
    ["weak FTS", { fts: { original: { rankScore: 99, rootLexicalCoverage: 0.59 } } }],
    [
      "multiple weak channels are not additive",
      {
        fts: { original: { rankScore: 99, rootLexicalCoverage: 0.59 } },
        temporal: { derived: { rankScore: 99, rootLexicalCoverage: 0.59 } },
        vector: { original: { rankScore: 99, vectorCosineSimilarity: 0.79 } },
      },
    ],
    ["derived exact without root support", { exact: { derived: { rankScore: 1 } } }],
    ["derived exact with weak root support", { exact: { derived: { rankScore: 1, rootLexicalCoverage: 0.59 } } }],
  ] as const)("rejects %s", (_label, support) => {
    expect(assessContentCandidate("匿名根问题", candidate("rejected", support))).toEqual({
      accepted: false,
      reason: "insufficient_support",
    });
  });

  test("rejects missing, invalid, and opaque hybrid support", () => {
    expect(assessContentCandidate("匿名根问题", candidate("missing"))).toEqual({ accepted: false, reason: "insufficient_support" });
    expect(assessContentCandidate("匿名根问题", candidate("opaque", undefined, "hybrid"))).toEqual({ accepted: false, reason: "insufficient_support" });
    expect(assessContentCandidate("匿名根问题", candidate("invalid", {
      vector: { original: { rankScore: 1, vectorCosineSimilarity: Number.NaN } },
      fts: { original: { rankScore: 1, rootLexicalCoverage: Number.POSITIVE_INFINITY } },
    }))).toEqual({ accepted: false, reason: "insufficient_support" });
  });

  test("ordered truth table gives original exact precedence", () => {
    const result = candidate("ordered", {
      exact: { original: { rankScore: 1 } },
      vector: { original: { rankScore: 1, vectorCosineSimilarity: 1 } },
      fts: { original: { rankScore: 1, rootLexicalCoverage: 1 } },
    });
    expect(assessContentCandidate("匿名根问题", result)).toEqual({ accepted: true, reason: "exact" });
  });

  test("vector precedes lexical and epsilon has an exact acceptance boundary", () => {
    const both = candidate("both", {
      vector: { original: { rankScore: 1, vectorCosineSimilarity: 0.8 } },
      fts: { original: { rankScore: 1, rootLexicalCoverage: 1 } },
    });
    expect(assessContentCandidate("匿名根问题", both)).toEqual({ accepted: true, reason: "strong_vector" });

    const boundary = candidate("boundary", {
      vector: { original: { rankScore: 1, vectorCosineSimilarity: 0.8 - 1e-6 } },
    });
    const below = candidate("below", {
      vector: { original: { rankScore: 1, vectorCosineSimilarity: 0.8 - 2e-6 } },
    });
    expect(assessContentCandidate("匿名根问题", boundary)).toEqual({ accepted: true, reason: "strong_vector" });
    expect(assessContentCandidate("匿名根问题", below)).toEqual({ accepted: false, reason: "insufficient_support" });
  });

  test("filter preserves relative order and keeps strong candidates at rank two and three", () => {
    const weak = candidate("rank-1-weak", {
      fts: { original: { rankScore: 100, rootLexicalCoverage: 0.2 } },
    });
    const rank2 = candidate("rank-2-vector", {
      vector: { original: { rankScore: 2, vectorCosineSimilarity: 0.9 } },
    });
    const rank3 = candidate("rank-3-fts", {
      fts: { original: { rankScore: 1, rootLexicalCoverage: 0.8 } },
    });

    expect(filterContentCandidates("匿名根问题", [weak, rank2, rank3])).toEqual([rank2, rank3]);
  });
});
