import { describe, test, expect } from "bun:test";
import { resolveUserSlug, SLUG_PREFIXES } from "../../src/cli/commands/slug-resolver.js";

describe("resolveUserSlug", () => {
  const store = new Set<string>();
  const getBySlug = (slug: string) => (store.has(slug) ? slug : null);

  const reset = () => store.clear();

  // ── P1: Core resolution ──────────────────────────────────

  test("exact match returns immediately", () => {
    reset();
    store.add("brain/entities/person/test");
    const result = resolveUserSlug("brain/entities/person/test", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("brain/entities/person/test");
    expect(result!.ambiguous).toBeUndefined();
  });

  test("adds brain/ prefix when input has no prefix", () => {
    reset();
    store.add("brain/entities/person/test");
    const result = resolveUserSlug("entities/person/test", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("brain/entities/person/test");
  });

  test("adds records/ prefix when input has no prefix", () => {
    reset();
    store.add("records/my-note");
    const result = resolveUserSlug("my-note", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("records/my-note");
  });

  // ── P1 #1: Ambiguity detection ───────────────────────────

  test("detects ambiguity when brain/x and records/x both exist", () => {
    reset();
    store.add("brain/test-page");
    store.add("records/test-page");
    const result = resolveUserSlug("test-page", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.ambiguous).toBeDefined();
    expect(result!.ambiguous!.length).toBe(2);
    expect(result!.ambiguous).toContain("brain/test-page");
    expect(result!.ambiguous).toContain("records/test-page");
  });

  // ── P1 #2: Prefix swap for misused prefix ────────────────

  test("swaps records/ → brain/ when records/ input fails", () => {
    reset();
    store.add("brain/entities/person/test");
    // User types records/entities/person/test but page is in brain/
    const result = resolveUserSlug("records/entities/person/test", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("brain/entities/person/test");
  });

  test("swaps brain/ → records/ when brain/ input fails", () => {
    reset();
    store.add("records/my-note");
    // User types brain/my-note but page is in records/
    const result = resolveUserSlug("brain/my-note", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("records/my-note");
  });

  // ── P2 #4: Empty input early exit ─────────────────────────

  test("returns null for empty input (no DB query)", () => {
    reset();
    store.add("brain/entities/person/test");
    const result = resolveUserSlug("", getBySlug);
    expect(result).toBeNull();
  });

  test("returns null for whitespace-only input (no DB query)", () => {
    reset();
    store.add("brain/entities/person/test");
    const result = resolveUserSlug("   ", getBySlug);
    expect(result).toBeNull();
  });

  // ── Edge cases ────────────────────────────────────────────

  test("returns null for completely unknown slug", () => {
    reset();
    store.add("brain/entities/person/test");
    const result = resolveUserSlug("does-not-exist", getBySlug);
    expect(result).toBeNull();
  });

  test("brain/brain/ double prefix does not create false match", () => {
    reset();
    store.add("brain/entities/person/test");
    // brain/ is a known prefix → swap to records/brain/entities/person/test — won't match
    // No stacking of brain/brain/...
    const result = resolveUserSlug("brain/brain/entities/person/test", getBySlug);
    expect(result).toBeNull();
  });

  test("records/records/ double prefix does not create false match", () => {
    reset();
    store.add("records/my-note");
    const result = resolveUserSlug("records/records/my-note", getBySlug);
    expect(result).toBeNull();
  });

  test("exact match takes priority even when prefix-added also exists", () => {
    reset();
    store.add("brain/test");
    store.add("records/brain/test");
    // Input "brain/test" is exact match — should resolve directly
    const result = resolveUserSlug("brain/test", getBySlug);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("brain/test");
  });

  // ── Constants ─────────────────────────────────────────────

  test("SLUG_PREFIXES contains expected values", () => {
    expect(SLUG_PREFIXES).toContain("brain/");
    expect(SLUG_PREFIXES).toContain("records/");
    expect(SLUG_PREFIXES.length).toBe(2);
  });
});
