import { describe, test, expect } from "bun:test";
import { extractDetailTerms } from "../../src/core/search.js";

describe("extractDetailTerms", () => {
  test("extracts IDs, dates, numbers+units, latin tokens", () => {
    expect(extractDetailTerms("编号 ALPHA-123 是什么")).toContain("ALPHA-123");
    expect(extractDetailTerms("2026-06-26 那天的记录")).toContain("2026-06-26");
    expect(extractDetailTerms("那笔 120万 的预算")).toContain("120万");
    expect(extractDetailTerms("QXR9876 这个标识")).toContain("QXR9876");
    expect(extractDetailTerms("用到了 API 和 HTTP")).toEqual(
      expect.arrayContaining(["API", "HTTP"])
    );
  });

  test("extracts pure multi-digit numbers", () => {
    expect(extractDetailTerms("订单 12345 的状态")).toContain("12345");
  });

  test("extracts CJK n-grams so non-substring queries still yield usable terms", () => {
    // "审批编号" is a 4-char run; query contains it inside a longer sentence.
    const terms = extractDetailTerms("这个项目的审批编号是多少");
    // A 3-gram substring of 审批编号 must be present so LIKE can hit "审批编号".
    expect(terms.some((t) => "审批编号".includes(t))).toBe(true);
    // Length-desc ordering keeps higher-signal (longer) tokens first.
    const lengths = terms.map((t) => t.length);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
  });

  test("no usable tokens → empty array (caller skips enrichment)", () => {
    expect(extractDetailTerms("")).toEqual([]);
    expect(extractDetailTerms("   ")).toEqual([]);
    // Single throwaway chars / punctuation only.
    expect(extractDetailTerms("？ ！ 。")).toEqual([]);
  });

  test("bounded: very long query yields a capped term list", () => {
    const long = "项目".repeat(50) + " ALPHA-9999"; // 100 CJK chars + 1 ID
    const terms = extractDetailTerms(long);
    expect(terms.length).toBeLessThanOrEqual(12);
    expect(terms[0]).toBe("ALPHA-9999"); // highest signal, longest, first
  });

  test("terms are unique", () => {
    const terms = extractDetailTerms("ALPHA-123 ALPHA-123 123");
    expect(new Set(terms).size).toBe(terms.length);
  });
});
