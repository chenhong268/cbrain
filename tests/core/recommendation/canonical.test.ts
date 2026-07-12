import { describe, expect, test } from "bun:test";
import { assertJsonSafe, canonicalJson, normalizeProse, serializeNumber, sha256Hex } from "../../../src/core/recommendation/canonical.js";

describe("serializeNumber", () => {
  test("golden bytes", () => {
    expect(serializeNumber(1)).toBe("1");
    expect(serializeNumber(1.0)).toBe("1");
    expect(serializeNumber(-0)).toBe("0");
    expect(serializeNumber(0.1)).toBe("0.1");
    expect(serializeNumber(1e-7)).toBe("1e-7");
    expect(serializeNumber(1e21)).toBe("1e+21");
  });
  test("non-finite fail-closed", () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(() => serializeNumber(n)).toThrow(/finite/);
  });
});

describe("assertJsonSafe", () => {
  test("accepts plain JSON", () => {
    expect(() => assertJsonSafe({ a: 1, b: [null, "x", true] })).not.toThrow();
  });
  test("rejects undefined/function/symbol", () => {
    expect(() => assertJsonSafe({ x: undefined })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: () => 1 })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: Symbol("s") })).toThrow(/JSON-safe/);
  });
  test("rejects Date/Map/Set/class", () => {
    expect(() => assertJsonSafe({ x: new Date() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Map() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new Set() })).toThrow(/JSON-safe/);
    expect(() => assertJsonSafe({ x: new (class C {})() })).toThrow(/JSON-safe/);
  });
  test("rejects cyclic object/array", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => assertJsonSafe(o)).toThrow(/cycle/);
    const a: unknown[] = [];
    a.push(a);
    expect(() => assertJsonSafe(a)).toThrow(/cycle/);
  });
  test("rejects lone surrogate", () => {
    expect(() => assertJsonSafe({ x: "ab\uD800cd" })).toThrow(/surrogate/);
  });
});

describe("canonicalJson", () => {
  test("keys sorted", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });
  test("array sorted by full element", () => {
    const a = { source: "link", ref: "x", trust_state: "trusted" };
    const b = { source: "link", ref: "x", trust_state: "candidate" };
    expect(canonicalJson({ m: [a, b] })).toBe(canonicalJson({ m: [b, a] }));
  });
  test("absent optional omitted", () => {
    expect(canonicalJson({ type: "dry_run", target_ref: "r", reason: "x" })).not.toContain("rollback_note");
  });
  test("identifier byte-exact", () => {
    expect(canonicalJson({ ref: "entityA－1" })).not.toBe(canonicalJson({ ref: "entityA-1" }));
  });
});

describe("normalizeProse", () => {
  test("NFKC + fold", () => {
    expect(normalizeProse("ｓｃｏｒｅ   高")).toBe("score 高");
  });
});

describe("sha256Hex", () => {
  test("64 hex", () => {
    expect(sha256Hex('{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
  });
});
