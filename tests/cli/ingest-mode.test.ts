import { describe, test, expect } from "bun:test";
import { resolveIngestNerMode } from "../../src/cli/context";

describe("resolveIngestNerMode (#252)", () => {
  test("defaults to sync when nothing set", () => {
    expect(resolveIngestNerMode(undefined, undefined)).toBe("sync");
  });
  test("config value wins when no env", () => {
    expect(resolveIngestNerMode(undefined, "defer")).toBe("defer");
    expect(resolveIngestNerMode(undefined, "off")).toBe("off");
  });
  test("env overrides config", () => {
    expect(resolveIngestNerMode("defer", "sync")).toBe("defer");
  });
  test("invalid value falls back to sync", () => {
    expect(resolveIngestNerMode("garbage", undefined)).toBe("sync");
    expect(resolveIngestNerMode(undefined, "async")).toBe("sync");
  });
  test("mixed-case/whitespace values are normalized", () => {
    expect(resolveIngestNerMode("  Defer  ", undefined)).toBe("defer");
    expect(resolveIngestNerMode("OFF", undefined)).toBe("off");
  });
});
