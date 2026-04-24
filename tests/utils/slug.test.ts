import { describe, test, expect } from "bun:test";
import {
  generateSlug,
  extractSlugFromWikiLink,
} from "../../src/utils/slug.js";

describe("slug", () => {
  test("generates Chinese slug", () => {
    expect(generateSlug("张三", "entity")).toBe("entities/张三");
  });

  test("generates English slug", () => {
    expect(generateSlug("First Principles", "concept")).toBe(
      "concepts/first-principles"
    );
  });

  test("handles mixed content", () => {
    const slug = generateSlug("OpenAI GPT-4o", "entity");
    expect(slug).toMatch(/^entities\//);
  });

  test("extracts slug from wiki link", () => {
    expect(extractSlugFromWikiLink("[[张三]]")).toBe("张三");
    expect(extractSlugFromWikiLink("[[第一性原理]]")).toBe("第一性原理");
  });
});
