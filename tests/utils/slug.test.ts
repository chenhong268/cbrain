import { describe, test, expect } from "bun:test";
import {
  generateSlug,
  extractSlugFromWikiLink,
} from "../../src/utils/slug.js";

describe("slug", () => {
  test("generates Chinese entity slug with brain prefix", () => {
    expect(generateSlug("张三", "entity")).toBe("brain/entities/张三");
  });

  test("generates English concept slug with brain prefix", () => {
    expect(generateSlug("First Principles", "concept")).toBe(
      "brain/concepts/first-principles"
    );
  });

  test("generates record slug at root level", () => {
    expect(generateSlug("Weekly Sync", "record")).toBe(
      "records/weekly-sync"
    );
  });

  test("generates record slug with records prefix", () => {
    expect(generateSlug("Meeting Notes", "record")).toBe(
      "records/meeting-notes"
    );
  });

  test("handles mixed content entity", () => {
    const slug = generateSlug("OpenAI GPT-4o", "entity");
    expect(slug).toMatch(/^brain\/(entities|concepts)\//);
  });

  test("extracts slug from wiki link", () => {
    expect(extractSlugFromWikiLink("[[张三]]")).toBe("张三");
    expect(extractSlugFromWikiLink("[[第一性原理]]")).toBe("第一性原理");
  });
});
