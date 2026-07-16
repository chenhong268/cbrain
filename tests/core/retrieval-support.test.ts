import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  computeCosineSimilarity,
  computeRootLexicalCoverage,
  CONTENT_VECTOR_EPSILON,
  CONTENT_VECTOR_MIN_COSINE,
  getRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";

function result(slug = "entity-a"): SearchResult {
  return {
    slug,
    score: 1,
    snippet: "匿名证据",
    source: "fts",
  };
}

describe("retrieval support metadata", () => {
  test("unattached results share one frozen empty null-prototype summary", () => {
    const first = getRetrievalSupport(result("entity-a"));
    const second = getRetrievalSupport(result("entity-b"));

    expect(first).toBe(second);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.ownKeys(first)).toEqual([]);
  });

  test("attachment returns the result and copies a deeply frozen null-prototype tree", () => {
    const searchResult = result();
    const input = {
      fts: {
        original: {
          rankScore: 4,
          rootLexicalCoverage: 0.8,
        },
      },
      vector: {
        derived: {
          rankScore: 2,
          vectorCosineSimilarity: 0.75,
        },
      },
    } satisfies RetrievalSupport;

    expect(attachRetrievalSupport(searchResult, input)).toBe(searchResult);
    const stored = getRetrievalSupport(searchResult);

    expect(stored).not.toBe(input);
    expect(stored.fts).not.toBe(input.fts);
    expect(stored.fts?.original).not.toBe(input.fts.original);
    expect(Object.getPrototypeOf(stored)).toBeNull();
    expect(Object.getPrototypeOf(stored.fts!)).toBeNull();
    expect(Object.getPrototypeOf(stored.fts!.original!)).toBeNull();
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.fts)).toBe(true);
    expect(Object.isFrozen(stored.fts?.original)).toBe(true);
    expect(Object.isFrozen(searchResult)).toBe(false);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.fts)).toBe(false);
    expect(Object.isFrozen(input.fts.original)).toBe(false);
  });

  test("invalid required scores drop leaves while invalid optional scalars drop only fields", () => {
    const searchResult = result();
    attachRetrievalSupport(searchResult, {
      exact: {
        original: { rankScore: Number.NaN, rootLexicalCoverage: 1 },
      },
      vector: {
        original: { rankScore: 3, vectorCosineSimilarity: 1.01 },
        derived: { rankScore: 2, vectorCosineSimilarity: Number.POSITIVE_INFINITY },
      },
      fts: {
        original: { rankScore: 4, rootLexicalCoverage: -0.01 },
        derived: { rankScore: 1, rootLexicalCoverage: Number.NaN },
      },
    });

    expect(getRetrievalSupport(searchResult)).toEqual({
      vector: {
        original: { rankScore: 3 },
        derived: { rankScore: 2 },
      },
      fts: {
        original: { rankScore: 4 },
        derived: { rankScore: 1 },
      },
    });
  });

  test("reads only own channel, origin, and evidence properties", () => {
    const inheritedEvidence = Object.create({
      rankScore: 9,
      rootLexicalCoverage: 1,
    }) as RetrievalSupport["fts"] extends infer _T ? Record<string, unknown> : never;
    const inheritedOrigin = Object.create({
      original: { rankScore: 8, rootLexicalCoverage: 1 },
    }) as Record<string, unknown>;
    const support = Object.create({
      exact: { original: { rankScore: 6, rootLexicalCoverage: 1 } },
    }) as Record<string, unknown>;
    support.fts = Object.assign(inheritedOrigin, {
      derived: Object.assign(inheritedEvidence, { rankScore: 5 }),
    });
    support.vector = Object.create({
      original: { rankScore: 4, vectorCosineSimilarity: 1 },
    });
    support.graph = {
      original: Object.create({ rankScore: 3 }),
    };

    const searchResult = result();
    attachRetrievalSupport(searchResult, support as RetrievalSupport);

    expect(getRetrievalSupport(searchResult)).toEqual({
      fts: { derived: { rankScore: 5 } },
    });
  });

  test("snapshots each scalar getter exactly once before validation", () => {
    const calls = { rank: 0, cosine: 0, coverage: 0 };
    const evidence = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(evidence, {
      rankScore: {
        enumerable: true,
        get: () => (++calls.rank === 1 ? 1 : Number.NaN),
      },
      vectorCosineSimilarity: {
        enumerable: true,
        get: () => (++calls.cosine === 1 ? 0.8 : Number.NaN),
      },
      rootLexicalCoverage: {
        enumerable: true,
        get: () => (++calls.coverage === 1 ? 0.6 : Number.NaN),
      },
    });

    const searchResult = result();
    attachRetrievalSupport(searchResult, {
      vector: { original: evidence as unknown as { rankScore: number } },
    });

    expect(calls).toEqual({ rank: 1, cosine: 1, coverage: 1 });
    expect(getRetrievalSupport(searchResult)).toEqual({
      vector: {
        original: {
          rankScore: 1,
          vectorCosineSimilarity: 0.8,
          rootLexicalCoverage: 0.6,
        },
      },
    });
  });

  test("snapshots channel and origin getters once and skips throwing getters", () => {
    const calls = { exact: 0, fts: 0, original: 0, derived: 0 };
    const support = Object.create(null) as Record<string, unknown>;
    const channel = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(support, {
      exact: {
        enumerable: true,
        get: () => {
          calls.exact++;
          throw new Error("channel sentinel");
        },
      },
      fts: {
        enumerable: true,
        get: () => {
          calls.fts++;
          return channel;
        },
      },
    });
    Object.defineProperties(channel, {
      original: {
        enumerable: true,
        get: () => {
          calls.original++;
          throw new Error("origin sentinel");
        },
      },
      derived: {
        enumerable: true,
        get: () => {
          calls.derived++;
          return { rankScore: 2, rootLexicalCoverage: 0.6 };
        },
      },
    });

    const searchResult = result();
    expect(() => attachRetrievalSupport(searchResult, support as RetrievalSupport)).not.toThrow();
    expect(calls).toEqual({ exact: 1, fts: 1, original: 1, derived: 1 });
    expect(getRetrievalSupport(searchResult)).toEqual({
      fts: { derived: { rankScore: 2, rootLexicalCoverage: 0.6 } },
    });
  });

  test("metadata never becomes a result property or serialization surface", () => {
    const searchResult = result();
    const beforeKeys = Reflect.ownKeys(searchResult);
    const beforeDescriptors = Object.getOwnPropertyDescriptors(searchResult);
    attachRetrievalSupport(searchResult, {
      fts: { original: { rankScore: 7, rootLexicalCoverage: 0.6 } },
    });

    expect(Reflect.ownKeys(searchResult)).toEqual(beforeKeys);
    expect(Object.getOwnPropertyDescriptors(searchResult)).toEqual(beforeDescriptors);
    expect(Object.keys(searchResult)).toEqual(["slug", "score", "snippet", "source"]);
    expect({ ...searchResult }).toEqual(result());
    expect(JSON.stringify(searchResult)).toBe(JSON.stringify(result()));
  });

  test("caller mutations cannot alter stored support", () => {
    const searchResult = result();
    const input = {
      fts: { original: { rankScore: 4, rootLexicalCoverage: 0.8 } },
    } satisfies RetrievalSupport;
    attachRetrievalSupport(searchResult, input);
    const stored = getRetrievalSupport(searchResult);

    input.fts.original.rootLexicalCoverage = 0.1;
    expect(stored.fts?.original?.rootLexicalCoverage).toBe(0.8);
    expect(() => {
      (stored.fts!.original as { rankScore: number }).rankScore = 99;
    }).toThrow();
    expect(() => {
      (stored as { graph?: unknown }).graph = { original: { rankScore: 9 } };
    }).toThrow();
    expect(stored.fts?.original?.rankScore).toBe(4);
    expect(stored.graph).toBeUndefined();
  });
});

describe("root lexical coverage", () => {
  test("pins the four canonical matrix phrase shapes", () => {
    expect(computeRootLexicalCoverage(
      "上次 系统 恢复 边界",
      "系统 恢复 边界 明确 责任",
    )).toBe(0.8);
    expect(computeRootLexicalCoverage(
      "上次 近似 噪声 未知 线索",
      "近似 噪声 背景 主题 说明",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "抽象 近似 噪声 未知 线索",
      "近似 噪声 背景 主题 说明",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "上次 为什么 需要 未知 线索",
      "抽象 治理 稳定 原因 约束",
    )).toBeLessThan(0.6);
  });

  test("treats spaced and unspaced Han forms equivalently", () => {
    const compact = computeRootLexicalCoverage("系统恢复边界", "系统恢复边界明确责任");
    const spaced = computeRootLexicalCoverage("系统 恢复 边界", "系统 恢复 边界 明确 责任");
    expect(spaced).toBe(compact);
    expect(spaced).toBe(1);
  });

  test("accepts a bounded exact compact phrase without fuzzy edits", () => {
    expect(computeRootLexicalCoverage(
      "实体D 上次活动",
      "实体D 上次活动的记录",
    )).toBeGreaterThanOrEqual(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      "系统恢复的边界",
    )).toBe(1);
  });

  test("bounded compact-phrase matching keeps semantic and structural controls", () => {
    expect(computeRootLexicalCoverage("甲方合同", "乙方合同")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage("四季度目标", "三季度目标")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage("RFC7231规范", "RFC7232规范")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage("版本V2说明", "版本V3说明")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "实体甲系统恢复边界",
      "实体乙系统恢复边界",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "实体甲 系统 恢复 边界",
      "实体乙 系统 恢复 边界",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "甲方合同管理方案",
      "乙方合同管理方案",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "四季度年度目标方案",
      "三季度年度目标方案",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "四季度 年度 目标 方案",
      "三季度 年度 目标 方案",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复责任边界",
      "系统恢复职责边界",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "未完成任务审核记录",
      "完成任务未审核记录",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "未批准数据删除方案",
      "批准数据未删除方案",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "不允许自动覆盖文件",
      "允许自动不覆盖文件",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统 不允许 自动 覆盖 文件",
      "系统 允许 自动 覆盖 文件",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "RFC7231 系统 恢复 规范",
      "RFC7232 系统 恢复 规范",
    )).toBeLessThan(0.6);
    for (const query of [
      "RFC7231上次 系统恢复边界",
      "实体甲上次 系统恢复边界",
      "V2之前 系统恢复边界",
      "不允许之前 系统恢复边界",
      "四季度变化 系统恢复边界",
      "甲方最近 系统恢复边界",
      "上次实体甲 系统恢复边界",
      "以前甲方 合同管理方案",
      "上次不允许 自动覆盖文件",
      "曾经四季度 年度目标方案",
      "上次系统 恢复边界",
      "上次 为什么 系统恢复边界",
    ]) {
      expect(computeRootLexicalCoverage(query, "系统恢复边界")).toBeLessThan(0.6);
    }
    for (const [query, evidence] of [
      ["实体甲，系统恢复责任边界", "实体乙，系统恢复责任边界"],
      ["实体甲：系统恢复责任边界", "实体乙：系统恢复责任边界"],
      ["甲方-系统恢复责任边界", "乙方-系统恢复责任边界"],
      ["RFC-7231 系统 恢复 规范", "RFC-7232 系统 恢复 规范"],
      ["V2/系统恢复责任边界", "V3/系统恢复责任边界"],
      ["实体甲。系统恢复边界", "实体乙系统恢复边界"],
      ["系统不允许。自动覆盖文件", "系统允许自动覆盖文件"],
      ["四季度\n年度目标方案", "三季度年度目标方案"],
      ["上次。系统恢复边界", "系统恢复边界"],
      [`${"背景".repeat(30)}系统 不允许 自动 覆盖 文件`, "系统 允许 自动 覆盖 文件"],
      [`${"背景".repeat(30)}RFC7231 系统 恢复 规范`, "RFC7232 系统 恢复 规范"],
      [`${"说明".repeat(30)}实体甲 系统 恢复 边界`, "实体乙 系统 恢复 边界"],
    ]) {
      expect(computeRootLexicalCoverage(query, evidence)).toBeLessThan(0.6);
    }
    expect(computeRootLexicalCoverage(
      "仅允许管理员删除记录",
      "允许管理员删除记录仅",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复责任边界",
      "系统恢复职责边界。系统恢复责任边界",
    )).toBe(1);
    expect(computeRootLexicalCoverage(
      "甲方合同管理方案",
      "乙方合同管理方案。甲方合同管理方案",
    )).toBe(1);
    expect(computeRootLexicalCoverage("目的管理方案", "管理方案")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage("打的费用记录", "费用记录")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统的恢复的责任的边界",
      "系统恢复责任边界",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      "系统恢复。边界",
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      `系统${"填".repeat(161)}恢复边界`,
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      `系统${" ".repeat(161)}恢复边界`,
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      `系统${" ".repeat(161)}恢复的边界`,
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "系统恢复的边界",
      `系统${" ".repeat(10_000)}恢复边界`,
    )).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(
      "实体甲系统恢复边界",
      `实体乙系统恢复边界${"背景".repeat(50_000)}`,
    )).toBeLessThan(0.6);
    expect(() => computeRootLexicalCoverage(
      "实体甲系统恢复边界",
      "背景".repeat(400_000),
    )).not.toThrow();
  });

  test("one-to-three query units require complete support", () => {
    expect(computeRootLexicalCoverage("alpha", "alpha")).toBe(1);
    expect(computeRootLexicalCoverage("alpha beta", "alpha")).toBe(0);
    expect(computeRootLexicalCoverage("alpha beta", "alpha beta")).toBe(1);
    expect(computeRootLexicalCoverage("alpha beta gamma", "alpha beta")).toBe(0);
    expect(computeRootLexicalCoverage("alpha beta gamma", "alpha beta gamma")).toBe(1);
  });

  test("uses a fixed five-unit denominator for long queries", () => {
    expect(computeRootLexicalCoverage(
      "alpha beta gamma delta epsilon zeta",
      "alpha",
    )).toBe(0.2);
    expect(computeRootLexicalCoverage(
      "alpha beta gamma delta epsilon zeta",
      "alpha beta gamma",
    )).toBe(0.6);
  });

  test("accepts a long English question with three locally coherent topic units", () => {
    expect(computeRootLexicalCoverage(
      "why does system recovery require explicit ownership boundaries today",
      "system recovery clarifies ownership",
    )).toBe(0.6);
  });

  test("accepts three local topic units out of five", () => {
    expect(computeRootLexicalCoverage(
      "alpha beta gamma delta epsilon",
      "prefix alpha beta gamma suffix",
    )).toBe(0.6);
  });

  test("does not combine terms across hard boundaries, excessive span, or gap slots", () => {
    const query = "alpha beta gamma delta epsilon";
    expect(computeRootLexicalCoverage(query, "alpha. beta. gamma")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(query, "alpha\n\nbeta\n\ngamma")).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(query, `alpha${" ".repeat(161)}beta gamma`)).toBeLessThan(0.6);
    expect(computeRootLexicalCoverage(query, "alpha x beta y z gamma")).toBeLessThan(0.6);
  });

  test("uses normalized Unicode code-point span with an inclusive 160 boundary", () => {
    const query = "alpha beta gamma delta epsilon";
    const span160 = `alpha${" ".repeat(145)}beta gamma`;
    const span161 = `alpha${" ".repeat(146)}beta gamma`;

    expect(Array.from(span160.normalize("NFKC")).length).toBe(160);
    expect(Array.from(span161.normalize("NFKC")).length).toBe(161);
    expect(computeRootLexicalCoverage(query, span160)).toBe(0.6);
    expect(computeRootLexicalCoverage(query, span161)).toBeLessThan(0.6);
  });

  test("repeated evidence units do not inflate distinct coverage", () => {
    expect(computeRootLexicalCoverage(
      "alpha beta gamma delta epsilon",
      "alpha alpha alpha alpha alpha",
    )).toBe(0.2);
  });

  test("canonicalizes RFC identifiers across separators", () => {
    for (const evidence of ["RFC 7231", "RFC-7231", "RFC7231"]) {
      expect(computeRootLexicalCoverage("RFC 7231", evidence)).toBe(1);
    }
  });

  test("normalizes NFKC, full-width identifiers, and case", () => {
    expect(computeRootLexicalCoverage("ＲＦＣ ７２３１", "rfc-7231")).toBe(1);
    expect(computeRootLexicalCoverage("ALPHA BETA", "alpha beta")).toBe(1);
  });

  test("forms Han n-grams by Unicode code point", () => {
    expect(computeRootLexicalCoverage("甲𠀀乙丙丁戊", "甲𠀀乙丙丁戊")).toBe(1);
  });

  test("returns zero for empty or malformed inputs", () => {
    expect(computeRootLexicalCoverage("", "alpha")).toBe(0);
    expect(computeRootLexicalCoverage("alpha", "")).toBe(0);
    expect(computeRootLexicalCoverage(undefined as unknown as string, "alpha")).toBe(0);
    expect(computeRootLexicalCoverage("alpha", null as unknown as string)).toBe(0);
  });
});

describe("cosine similarity", () => {
  test("is scale invariant", () => {
    expect(computeCosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 12);
    expect(computeCosineSimilarity([10, 20], [0.2, 0.4])).toBeCloseTo(1, 12);
  });

  test("is stable for extremely large and small finite scales", () => {
    expect(computeCosineSimilarity([1e160, 2e160], [2e160, 4e160])).toBeCloseTo(1, 12);
    expect(computeCosineSimilarity([1e-160, 2e-160], [2e-160, 4e-160])).toBeCloseTo(1, 12);
    expect(computeCosineSimilarity([1e100, -2e100], [3e100, -6e100])).toBeCloseTo(1, 12);
  });

  test("pins the acceptance boundary and tolerance", () => {
    const atBoundary = computeCosineSimilarity([1, 0], [0.8, 0.6])!;
    const withinTarget = CONTENT_VECTOR_MIN_COSINE - CONTENT_VECTOR_EPSILON;
    const outsideTarget = CONTENT_VECTOR_MIN_COSINE - CONTENT_VECTOR_EPSILON * 2;
    const withinTolerance = computeCosineSimilarity(
      [1, 0],
      [withinTarget, Math.sqrt(1 - withinTarget ** 2)],
    )!;
    const outsideTolerance = computeCosineSimilarity(
      [1, 0],
      [outsideTarget, Math.sqrt(1 - outsideTarget ** 2)],
    )!;

    expect(atBoundary).toBeCloseTo(CONTENT_VECTOR_MIN_COSINE, 12);
    expect(withinTolerance + CONTENT_VECTOR_EPSILON).toBeGreaterThanOrEqual(CONTENT_VECTOR_MIN_COSINE);
    expect(outsideTolerance + CONTENT_VECTOR_EPSILON).toBeLessThan(CONTENT_VECTOR_MIN_COSINE);
  });

  test("fails closed for zero norm, mismatch, and non-finite values", () => {
    expect(computeCosineSimilarity([0, 0], [1, 0])).toBeUndefined();
    expect(computeCosineSimilarity([1], [1, 0])).toBeUndefined();
    expect(computeCosineSimilarity([], [])).toBeUndefined();
    expect(computeCosineSimilarity([Number.NaN, 0], [1, 0])).toBeUndefined();
    expect(computeCosineSimilarity([Number.POSITIVE_INFINITY, 0], [1, 0])).toBeUndefined();
  });
});
