import { describe, test, expect } from "bun:test";
import { sanitizeDisplayText } from "../../../src/core/safety/display-safety.js";

describe("sanitizeDisplayText", () => {
  test("returns text when safe", () => {
    expect(sanitizeDisplayText("2026-06-01", "")).toBe("2026-06-01");
    expect(sanitizeDisplayText("正常文本", "fallback")).toBe("正常文本");
  });
  test("returns fallback when a hostile pattern matches", () => {
    expect(sanitizeDisplayText("DROP TABLE pages; --", "X")).toBe("X");
    expect(sanitizeDisplayText("/etc/passwd", "X")).toBe("X");
    expect(sanitizeDisplayText("score: 0.9 dedup_key", "X")).toBe("X");
  });
});
