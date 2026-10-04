import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import {
  assessContentCandidate,
  filterContentCandidates,
  filterContentFtsFallbackCandidates,
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

  test("admits only the exact candidate certified by deterministic identity resolution", () => {
    const certified = candidate("record/certified", {
      exact: { derived: { rankScore: 1, rootLexicalCoverage: 0 } },
    }, "exact");
    const unrelated = candidate("record/unrelated", {
      exact: { derived: { rankScore: 1, rootLexicalCoverage: 0 } },
    }, "exact");
    const nonExact = candidate("record/non-exact", undefined, "hybrid");

    expect(filterContentCandidates("人物甲是谁", [certified, unrelated, nonExact], {
      deterministicIdentitySlugs: new Set(["record/certified", "record/non-exact"]),
    })).toEqual([certified]);
  });
});

describe("closed keyword cause admission", () => {
  const query = "实体A 季度二 收入 下滑 原因";
  const verified = new Map([["records/source-a", "实体A在季度二收入下滑，原因为竞争加剧。"]]);
  const unsupported: RetrievalSupport = {
    exact: { original: { rankScore: 1 } },
    vector: { original: { rankScore: 1, vectorCosineSimilarity: 0.99 } },
    fts: { original: { rankScore: 1, rootLexicalCoverage: 1 } },
  };

  test("a verified sentence admits the candidate and names the proof", () => {
    expect(assessContentCandidate(query, candidate("records/source-a"), { causeEvidenceBySlug: verified }))
      .toEqual({ accepted: true, reason: "cause_evidence" });
  });

  test("no channel or identity shortcut bypasses the rule without evidence", () => {
    const result = candidate("records/source-a", unsupported, "exact");
    const options = {
      causeEvidenceBySlug: new Map<string, string>(),
      deterministicIdentitySlugs: new Set(["records/source-a"]),
    };
    expect(assessContentCandidate(query, result, options))
      .toEqual({ accepted: false, reason: "insufficient_support" });
    expect(filterContentCandidates(query, [result], options)).toEqual([]);
  });

  test("evidence recorded for another slug does not admit this candidate", () => {
    const options = { causeEvidenceBySlug: new Map([["records/source-b", "实体A在季度二收入下滑，原因为竞争加剧。"]]) };
    expect(assessContentCandidate(query, candidate("records/source-a", unsupported), options))
      .toEqual({ accepted: false, reason: "insufficient_support" });
  });

  test("outside the closed cause grammar the map changes nothing", () => {
    const result = candidate("records/source-a", unsupported);
    expect(assessContentCandidate("实体A 季度二 收入 情况", result, { causeEvidenceBySlug: new Map() }))
      .toEqual({ accepted: true, reason: "exact" });
  });

  const anchorQuery = "组织甲方 季度二 收入 下滑 原因";
  const anchorCandidate = (score: number, coverage: number): SearchResult => {
    const item: SearchResult = {
      slug: "records/source-a",
      score,
      snippet: "组织甲方在季度三收入下滑，原因为竞争加剧。",
      source: "fts",
    };
    return attachRetrievalSupport(item, { fts: { original: { rankScore: score, rootLexicalCoverage: coverage } } });
  };

  test("FTS rescue branches still need a verified sentence", () => {
    const anchorPair = [anchorCandidate(0.5, 0), anchorCandidate(0.4, 0)];
    expect(filterContentFtsFallbackCandidates(anchorQuery, anchorPair).map((item) => item.slug))
      .toEqual(["records/source-a"]);
    expect(filterContentFtsFallbackCandidates(anchorQuery, anchorPair, { causeEvidenceBySlug: new Map() }))
      .toEqual([]);
    // With evidence the shared rule admits both chunks of the verified slug;
    // the caller dedupes them by slug.
    expect(new Set(filterContentFtsFallbackCandidates(anchorQuery, anchorPair, { causeEvidenceBySlug: verified })
      .map((item) => item.slug)).size).toBe(1);

    const coverageLead = [anchorCandidate(0.5, 0.6)];
    expect(filterContentFtsFallbackCandidates(anchorQuery, coverageLead).map((item) => item.slug))
      .toEqual(["records/source-a"]);
    expect(filterContentFtsFallbackCandidates(anchorQuery, coverageLead, { causeEvidenceBySlug: new Map() }))
      .toEqual([]);
    expect(filterContentFtsFallbackCandidates(anchorQuery, coverageLead, { causeEvidenceBySlug: verified })
      .map((item) => item.slug)).toEqual(["records/source-a"]);
  });
});
