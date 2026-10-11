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

/**
 * #552 — the FTS rescue floor alone admitted a lead whose evidence only
 * repeated the question's topic words. Query and evidence text below is the
 * frozen corpus wording; each ratio is the measured adjacent-Han-bigram
 * coverage of that question against that snippet.
 */
describe("FTS rescue requires a shared character run", () => {
  /** Every rejected lead below carries the same coverage the floor accepted. */
  const FTS_FLOOR_COVERAGE = 0.4;
  const PAGES = {
    issueRhythm: "新版本上线前要走三轮验证，先小范围内测，再逐步扩大范围，最后才全量发布。每一轮都必须保留一个随时可用的回退开关，回退动作不需要重新构建，也不需要重新审批。三轮验证之间至少间隔一个完整的观察周期，观察周期内只收集指标，不做任何新的变更。如果任一环节的指标超出预期阈值，当轮验证立即停止，并由值班人决定是否触发回退开关。",
    backupRetention: "备份数据保存三十天，每周做一次抽样恢复验证。超过保留期的备份按批次清理，清理前先确认没有未完成的恢复任务。抽样恢复验证只恢复到隔离环境，不接触在线数据。验证结果需要记录恢复耗时和数据校验结论，结论不合格时立即停止后续清理并上报。",
    batchWindow: "批量重建只在夜间窗口执行，白天保持只读。窗口长度固定为四小时，超过窗口的批次会被取消，而不是延长窗口时间。窗口开始前先检查上游数据是否就绪，未就绪则跳过本次批次并记录原因。批次执行期间不接收人工提交的重建请求，人工请求统一排到下一个窗口。每次批次结束后记录实际耗时和数据量，供下一个窗口参考。",
    review: "变更评审要求两名评审人共同签字，并且必须附带回滚演练记录。缺少演练记录的变更不能进入发布队列。评审人不能是变更的实现人，也不能是同一个小组的成员。演练记录需要包含回滚触发条件、回滚步骤和验证方式三部分，任意一部分缺失都视为无效记录，需要重新提交。",
    boardRefresh: "指标看板每小时刷新一次，异常指标在刷新时标红。看板只读，不提供任何写入口。刷新失败时保留上一版数据并标记为过期，不使用空白数据覆盖。看板的指标口径变更需要提前一个周期公告，公告期内新旧口径并列展示，避免解读混乱。",
    terms: "本轮统一术语：窗口指固定长度的执行时间段，开关指预先配置的回退入口，批次指一次完整的执行单位。三个术语在所有文档和评审记录里必须保持一致，禁止用同义词交替表达。术语需要调整时，先更新这份约定，再更新引用它的文档，最后再更新自动化脚本里的命名。",
    // #552 counterexample facts: topic words only, no answering sentence.
    drillInspection: "巡检在每个观察周期开始时执行一次，只核对回退开关是否可用，巡检过程不涉及任何配置变更。",
    archiveCheck: "归档备份批次在每月末执行一次，归档只处理已经完成核对的记录，归档过程不删除任何在线数据。",
  } as const;

  const ftsLead = (slug: string, snippet: string): SearchResult =>
    attachRetrievalSupport(
      { slug, score: 1, snippet, source: "fts" },
      { fts: { original: { rankScore: 1, rootLexicalCoverage: FTS_FLOOR_COVERAGE } } },
    );

  const topicOnlyLeads = [
    ["asks for a fact the page never states", "回退开关的触发与备份清理都需要事先报备吗", "records/匿名节奏", PAGES.issueRhythm], // 5/19
    ["asks for a value the page never states", "发布回退开关的默认超时时间是多久", "records/匿名节奏", PAGES.issueRhythm], // 4/15
    ["asks for parameters the page never lists", "回退开关支持哪些配置参数", "records/匿名节奏", PAGES.issueRhythm], // 3/11
    ["asks for a headcount the page never gives", "抽样恢复演练需要几个人一起参加", "records/匿名保留", PAGES.backupRetention], // 4/14
    ["asks for a mode the page never names", "回退开关的复位方式是自动还是人工", "records/匿名节奏", PAGES.issueRhythm], // 3/15
    ["asks for a retention period the new fact never states", "回退开关的巡检结果需要保留多长时间", "records/匿名巡检", PAGES.drillInspection], // 4/16
    ["asks who keeps a result the new fact never assigns", "归档备份的核对结果需要由谁保存", "records/匿名归档", PAGES.archiveCheck], // 4/14
  ] as const;

  test.each(topicOnlyLeads)("drops a lead that only repeats topic words when the question %s", (
    _label,
    query,
    slug,
    snippet,
  ) => {
    expect(filterContentFtsFallbackCandidates(query, [ftsLead(slug, snippet)])).toEqual([]);
  });

  const answeringLeads = [
    ["orders the documents it names", "术语要调整时按什么顺序更新文档", "records/匿名术语", PAGES.terms], // 6/14
    ["states the retention period it asks for", "组织C 的备份保留期是多少天", "records/匿名保留", PAGES.backupRetention], // 4/10
    ["states when the rebuild is allowed to run", "批量重建在什么时间才允许跑", "records/匿名时段", PAGES.batchWindow], // 4/12, exactly at the threshold
    ["names the record the review must attach", "变更评审必须附带什么记录", "records/匿名评审", PAGES.review], // 7/11
    ["states the refresh cadence it asks for", "主题D 的指标看板多久刷新一次", "records/匿名看板", PAGES.boardRefresh], // 7/11
    ["answers whether the run must stop", "指标没有超出阈值也要停止当轮验证吗", "records/匿名节奏", PAGES.issueRhythm], // 7/16
  ] as const;

  test.each(answeringLeads)("keeps a lead whose evidence %s", (_label, query, slug, snippet) => {
    expect(filterContentFtsFallbackCandidates(query, [ftsLead(slug, snippet)]).map((item) => item.slug))
      .toEqual([slug]);
  });

  test("a question without a single Han bigram keeps the coverage floor alone", () => {
    expect(filterContentFtsFallbackCandidates("ABC 123", [ftsLead("records/匿名页", "ABC 123")])
      .map((item) => item.slug)).toEqual(["records/匿名页"]);
  });
});

/**
 * Round 2 (#552 R2): the FTS rescue needs a front-door positive for the
 * content-sufficient version of the B4/B5 pairs. Normal admission rejects a
 * lead that stays under the coverage floor, so the FTS rescue is the only path
 * that can admit it. The pair proves that path still admits the correct page,
 * and the negative control proves the same question keeps the insufficient
 * page rejected.
 *
 * Snippet wording is frozen corpus text from the private anonymous store
 * (`<pair root>/env/vault/records`); each ratio is the measured
 * adjacent-Han-bigram coverage of that question against that snippet.
 */
describe("FTS rescue positive pair", () => {
  const FTS_FLOOR_COVERAGE = 0.4;
  const PAGES = {
    // records/主题g-回退开关超时 — states the timeout the question asks for.
    timeoutFact: "回退开关启用后默认超时十五分钟，未确认时自动恢复为启用状态，超时事件会写进日志。",
    // records/主题h-回退开关报备 — states the reporting duty the question asks about.
    reportingFact: "回退开关启用和备份数据清理都必须报备，报备情况会记入当班的登记本。",
    // records/主题d-发布节奏 — shares the topic wording only, states no asked fact.
    topicOnly: "新版本上线前要走三轮验证，先小范围内测，再逐步扩大范围，最后才全量发布。每一轮都必须保留一个随时可用的回退开关，回退动作不需要重新构建，也不需要重新审批。三轮验证之间至少间隔一个完整的观察周期，观察周期内只收集指标，不做任何新的变更。如果任一环节的指标超出预期阈值，当轮验证立即停止，并由值班人决定是否触发回退开关。",
    // records/实体a-批次窗口 — states how an unready upstream is handled.
    batchWindowFact: "批量重建只在夜间窗口执行，白天保持只读。窗口长度固定为四小时，超过窗口的批次会被取消，而不是延长窗口时间。窗口开始前先检查上游数据是否就绪，未就绪则跳过本次批次并记录原因。批次执行期间不接收人工提交的重建请求，人工请求统一排到下一个窗口。每次批次结束后记录实际耗时和数据量，供下一个窗口参考。",
  } as const;

  const ftsLead = (slug: string, snippet: string): SearchResult =>
    attachRetrievalSupport(
      { slug, score: 1, snippet, source: "fts" },
      { fts: { original: { rankScore: 1, rootLexicalCoverage: FTS_FLOOR_COVERAGE } } },
    );

  const pairs = [
    ["reports the duty it asks about", "回退开关的触发与备份清理都需要事先报备吗", "records/匿名报备", PAGES.reportingFact], // 7/19
    ["states the timeout it asks for", "发布回退开关的默认超时时间是多久", "records/匿名超时", PAGES.timeoutFact], // 6/15
  ] as const;

  test("normal admission rejects every pair lead before the FTS rescue sees", () => {
    for (const [, query, slug, snippet] of pairs) {
      expect(filterContentCandidates(query, [ftsLead(slug, snippet)])).toEqual([]);
    }
  });

  test.each(pairs)("FTS rescue alone admits the page that %s", (_label, query, slug, snippet) => {
    expect(filterContentFtsFallbackCandidates(query, [ftsLead(slug, snippet)]).map((item) => item.slug))
      .toEqual([slug]);
  });

  test("the same questions keep the insufficient page rejected", () => {
    for (const [, query] of pairs) {
      expect(filterContentFtsFallbackCandidates(query, [ftsLead("records/匿名节奏", PAGES.topicOnly)]))
        .toEqual([]);
    }
  });

  /**
   * Codex round-1 replay, no-Qwen eligibility (#552 R1): the question asks how
   * an unready upstream is handled and the page states it, so the FTS rescue is
   * the only channel that can return it once the vector path is unavailable.
   * Its measured coverage is 4/14, below the 1/3 floor the rest of this suite
   * requires; no local lexical rule was found that admits this row while still
   * rejecting the same-topic rows above. This test records the required
   * behavior and stays expected-to-fail until that trade-off is decided.
   * See `.handoff/result-552-r2.md` §R1 trade-off.
   */
  test.failing("no-Qwen replay keeps the unready-upstream answer", () => {
    expect(filterContentFtsFallbackCandidates("上游数据没准备好时批次怎么处理", [
      ftsLead("records/匿名批次", PAGES.batchWindowFact),
    ]).map((item) => item.slug)).toEqual(["records/匿名批次"]);
  });
});
