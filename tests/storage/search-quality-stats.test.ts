import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

describe("CBrainDB.getSearchQualityStats", () => {
  const testDir = "/tmp/cbrain-test-search-quality-stats";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("separates latency warnings from retrieval-degraded searches", () => {
    db.logSearch("主题A", "smart", 3500, 5, false, {
      reason_codes: ["latency_budget_exceeded"],
    });
    // Historical rows before #250 may have degraded=1 for latency-only slow
    // searches. Health should classify them as latency warnings, not retrieval
    // failures.
    db.logSearch("主题B", "smart", 4200, 4, true, {
      reason_codes: ["latency_budget_exceeded"],
    });
    db.logSearch("主题C", "smart", 120, 0, true, {
      reason_codes: ["fts_empty"],
    });

    const stats = db.getSearchQualityStats(7);

    expect(stats.totalSearches).toBe(3);
    expect(stats.degradedCount).toBe(1);
    expect(stats.degradedRate).toBeCloseTo(1 / 3);
    expect(stats.latencyWarningCount).toBe(2);
    expect(stats.latencyWarningRate).toBeCloseTo(2 / 3);
    expect(stats.topReasonCodes.map(r => r.code)).toEqual(["fts_empty"]);
    expect(stats.topLatencyWarningCodes.map(r => r.code)).toEqual(["latency_budget_exceeded"]);
  });

  test("treats legacy empty degraded rows as retrieval degraded even without reason codes", () => {
    db.logSearch("主题空结果", "smart", 90, 0, true);
    db.logSearch("主题慢但有结果", "smart", 3000, 4, true, {
      reason_codes: ["latency_budget_exceeded"],
    });

    const stats = db.getSearchQualityStats(7);

    expect(stats.degradedCount).toBe(1);
    expect(stats.latencyWarningCount).toBe(1);
  });

  test("classifies parser fallback by result quality", () => {
    db.logSearch("主题语法降级但有结果", "smart", 120, 3, false, {
      reason_codes: ["fts_parser_fallback"],
    });
    db.logSearch("主题语法降级且空结果", "smart", 140, 0, true, {
      reason_codes: ["fts_parser_fallback"],
    });

    const stats = db.getSearchQualityStats(7);

    expect(stats.degradedCount).toBe(1);
    expect(stats.latencyWarningCount).toBe(2);
    expect(stats.topReasonCodes.map(r => r.code)).toEqual(["fts_parser_fallback"]);
    expect(stats.topLatencyWarningCodes.map(r => r.code)).toEqual(["fts_parser_fallback"]);
  });
});
