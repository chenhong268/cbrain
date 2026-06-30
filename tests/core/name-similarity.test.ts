import { describe, test, expect } from "bun:test";
import {
  normalizeForComparison, isSignificantSubstring, hasCjk,
  boundedLevenshtein, tokenizeForBlocking, titleCanonicalScore,
} from "../../src/core/name-similarity.js";

describe("name-similarity", () => {
  test("normalizeForComparison strips case/space/punct/parentheticals", () => {
    expect(normalizeForComparison("实体 A")).toBe("实体a");
    expect(normalizeForComparison("A.I. Helper")).toBe("aihelper");
    expect(normalizeForComparison("Foo (bar)")).toBe("foo");
    expect(normalizeForComparison("  Co., Ltd. ")).toBe("coltd");
  });

  test("isSignificantSubstring guards", () => {
    expect(isSignificantSubstring("claude", "claude code")).toBe(true);
    expect(isSignificantSubstring("数字化", "数字化转型")).toBe(true);
    expect(isSignificantSubstring("a", "ab")).toBe(false);
  });

  test("hasCjk", () => {
    expect(hasCjk("实体A")).toBe(true);
    expect(hasCjk("Alpha")).toBe(false);
  });

  test("boundedLevenshtein early-exits beyond maxDistance", () => {
    expect(boundedLevenshtein("实体a", "实体b", 2)).toBe(1);
    expect(boundedLevenshtein("abc", "axc", 2)).toBe(1);
    expect(boundedLevenshtein("abc", "abcdef", 2)).toBe(null);
    expect(boundedLevenshtein("alpha", "zmxqb", 2)).toBe(null);
    expect(boundedLevenshtein("same", "same", 2)).toBe(0);
  });

  test("tokenizeForBlocking emits normalized, word tokens, CJK bigrams", () => {
    const keys = tokenizeForBlocking("实体Alpha");
    expect(keys.has("实体alpha")).toBe(true);
    expect(keys.has("alpha")).toBe(true);
    expect(keys.has("实体")).toBe(true);
    const en = tokenizeForBlocking("Claude Code");
    expect(en.has("claude")).toBe(true);
    expect(en.has("code")).toBe(true);
  });

  test("titleCanonicalScore: shorter, fewer parens, shallower slug scores higher", () => {
    const shortClean = titleCanonicalScore("Alpha", "entity/alpha");
    const longParens = titleCanonicalScore("Alpha (Beta Corp)", "entity/alpha-beta-corp");
    expect(shortClean).toBeGreaterThan(longParens);
  });
});
