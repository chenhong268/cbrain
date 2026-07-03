import { describe, expect, test } from "bun:test";
import {
  ACTION_CANDIDATE_TYPES,
  isActionCandidateType,
  assertSafeActionDisplay,
} from "../../src/core/maintenance/action-candidates.js";

describe("action candidate core helpers (#267)", () => {
  test("recognizes all action candidate types", () => {
    expect(ACTION_CANDIDATE_TYPES).toEqual([
      "action_review_discovery",
      "action_health_review",
      "action_repair_preview",
    ]);
    expect(isActionCandidateType("action_review_discovery")).toBe(true);
    expect(isActionCandidateType("action_health_review")).toBe(true);
    expect(isActionCandidateType("action_repair_preview")).toBe(true);
    expect(isActionCandidateType("gap")).toBe(false);
  });

  test("display guard rejects internal identifiers and debug terms", () => {
    expect(assertSafeActionDisplay("有一项健康问题需要人工确认。")).toBeUndefined();
    expect(() => assertSafeActionDisplay("score=0.9")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("dedup_key=abc")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("entity/private-a")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("/Users/example/private")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("SELECT * FROM pages")).toThrow(/unsafe display/i);
  });
});
