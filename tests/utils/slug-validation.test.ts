import { describe, test, expect } from "bun:test";
import { generateSlug, isValidSlugName } from "../../src/utils/slug.js";

describe("isValidSlugName", () => {
  test("accepts valid names", () => {
    expect(isValidSlugName("zhang-san")).toBe(true);
    expect(isValidSlugName("张三")).toBe(true);
    expect(isValidSlugName("abc123")).toBe(true);
    expect(isValidSlugName("a")).toBe(true);
  });

  test("rejects empty", () => {
    expect(isValidSlugName("")).toBe(false);
  });

  test("rejects only hyphens", () => {
    expect(isValidSlugName("-")).toBe(false);
    expect(isValidSlugName("---")).toBe(false);
  });

  test("rejects only special characters", () => {
    expect(isValidSlugName("!!!")).toBe(false);
    expect(isValidSlugName("===")).toBe(false);
  });
});

describe("generateSlug fallback", () => {
  test("normal title produces valid slug", () => {
    const slug = generateSlug("hello world", "record");
    expect(slug).toMatch(/^records\//);
    expect(slug).not.toBe("records/-");
    expect(slug).not.toBe("records/");
  });

  test("dash-only title falls back to untitled", () => {
    const slug = generateSlug("---", "record");
    expect(slug).toMatch(/^records\/untitled-\d+$/);
    expect(slug).not.toBe("records/-");
  });

  test("empty title falls back to untitled", () => {
    const slug = generateSlug("", "record");
    expect(slug).toMatch(/^records\/untitled-\d+$/);
    expect(slug).not.toBe("records/");
  });

  test("special-chars-only title falls back to untitled", () => {
    const slug = generateSlug("===", "record");
    expect(slug).toMatch(/^records\/untitled-\d+$/);
  });

  test("CJK title with valid chars works normally", () => {
    const slug = generateSlug("人物甲", "entity/person");
    expect(slug).toContain("人物甲");
    expect(isValidSlugName(slug.split("/").pop()!)).toBe(true);
  });
});
