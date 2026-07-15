import { describe, expect, test } from "bun:test";
import { LLMTimeoutError, isLLMTimeoutError } from "../../src/llm/provider.js";

describe("LLMTimeoutError", () => {
  test("carries a stable code and a finite positive timeout", () => {
    const error = new LLMTimeoutError("Provider", 30_000);

    expect(error.code).toBe("LLM_TIMEOUT");
    expect(error.timeoutMs).toBe(30_000);
    expect(isLLMTimeoutError(error)).toBe(true);
  });

  test("recognizes a cross-realm-compatible timeout record", () => {
    const record = {
      name: "LLMTimeoutError",
      message: "provider request timed out",
      code: "LLM_TIMEOUT",
      isLLMTimeout: true,
      timeoutMs: 30_000,
    };

    expect(isLLMTimeoutError(record)).toBe(true);
  });

  test("rejects spoofed or invalid timeout shapes", () => {
    const invalid = [
      Object.assign(new Error("ordinary"), { isLLMTimeout: true, timeoutMs: 30_000 }),
      { code: "LLM_TIMEOUT", isLLMTimeout: true, timeoutMs: Number.NaN },
      { code: "LLM_TIMEOUT", isLLMTimeout: true, timeoutMs: Number.POSITIVE_INFINITY },
      { code: "LLM_TIMEOUT", isLLMTimeout: true, timeoutMs: 0 },
      { code: "LLM_TIMEOUT", isLLMTimeout: true, timeoutMs: -1 },
      { code: "OTHER", isLLMTimeout: true, timeoutMs: 30_000 },
    ];

    for (const candidate of invalid) expect(isLLMTimeoutError(candidate)).toBe(false);
  });
});
