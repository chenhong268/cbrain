import { describe, test, expect } from "bun:test";
import { validateFacts, applyFacts } from "../../src/core/structured-facts.js";
import type { StructuredFact, EntityType } from "../../src/core/ner.js";
import type { PageManager } from "../../src/core/page.js";
import type { CBrainDB } from "../../src/storage/sqlite.js";

function makeFact(overrides: Partial<StructuredFact> = {}): StructuredFact {
  return {
    entity: "张三",
    field: "birthday",
    value: "1985-03-15",
    confidence: 0.9,
    evidence: "张三出生于1985年3月15日",
    ...overrides,
  };
}

describe("validateFacts", () => {
  test("keeps facts with all required fields", () => {
    const facts = [makeFact()];
    const result = validateFacts(
      facts,
      new Set(["张三"]),
      new Map([["张三", "person" as EntityType]])
    );
    expect(result).toHaveLength(1);
  });

  test("drops facts missing evidence", () => {
    const facts = [makeFact({ evidence: "" })];
    const result = validateFacts(
      facts,
      new Set(["张三"]),
      new Map([["张三", "person" as EntityType]])
    );
    expect(result).toHaveLength(0);
  });

  test("drops facts with unknown entity", () => {
    const facts = [makeFact({ entity: "李四" })];
    const result = validateFacts(
      facts,
      new Set(["张三"]),
      new Map([["张三", "person" as EntityType]])
    );
    expect(result).toHaveLength(0);
  });

  test("drops facts with non-whitelisted field", () => {
    const facts = [makeFact({ field: "favorite_color" })];
    const result = validateFacts(
      facts,
      new Set(["张三"]),
      new Map([["张三", "person" as EntityType]])
    );
    expect(result).toHaveLength(0);
  });

  test("deduplicates by entity|field keeping highest confidence", () => {
    const facts = [
      makeFact({ confidence: 0.7, value: "1984-01-01" }),
      makeFact({ confidence: 0.9, value: "1985-03-15" }),
    ];
    const result = validateFacts(
      facts,
      new Set(["张三"]),
      new Map([["张三", "person" as EntityType]])
    );
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("1985-03-15");
  });

  test("allows company fields for company entities", () => {
    const facts = [makeFact({ entity: "星辰科技", field: "industry", value: "AI" })];
    const result = validateFacts(
      facts,
      new Set(["星辰科技"]),
      new Map([["星辰科技", "company" as EntityType]])
    );
    expect(result).toHaveLength(1);
  });

  test("rejects person fields on company entity", () => {
    const facts = [makeFact({ entity: "星辰科技", field: "birthday" })];
    const result = validateFacts(
      facts,
      new Set(["星辰科技"]),
      new Map([["星辰科技", "company" as EntityType]])
    );
    expect(result).toHaveLength(0);
  });
});

function createMockPages(frontmatterMap: Record<string, Record<string, unknown>>) {
  const updates: Array<{ slug: string; extra: Record<string, unknown> }> = [];

  return {
    updates,
    mock: {
      getBySlug: (slug: string) => {
        const fm = frontmatterMap[slug];
        if (!fm) return null;
        return {
          slug,
          frontmatter: { ...fm },
          body: "",
          file_path: `${slug}.md`,
        };
      },
      update: (slug: string, updatesArg: { extra?: Record<string, unknown> }) => {
        updates.push({ slug, extra: updatesArg.extra ?? {} });
        if (frontmatterMap[slug] && updatesArg.extra) {
          Object.assign(frontmatterMap[slug], updatesArg.extra);
        }
        return { slug, frontmatter: frontmatterMap[slug], body: "", file_path: `${slug}.md` };
      },
    } as unknown as PageManager,
  };
}

function createMockDB() {
  return {} as CBrainDB;
}

describe("applyFacts", () => {
  test("writes fact to empty field", () => {
    const frontmatterMap: Record<string, Record<string, unknown>> = {
      "brain/entities/zhang-san": { title: "张三", type: "entity" },
    };
    const { mock: pages, updates } = createMockPages(frontmatterMap);
    const slugMap = new Map([["张三", "brain/entities/zhang-san"]]);
    const facts = [makeFact()];

    const result = applyFacts(facts, slugMap, pages, createMockDB());

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].extra).toEqual({ birthday: "1985-03-15" });
  });

  test("skips fact when field already has a value", () => {
    const frontmatterMap: Record<string, Record<string, unknown>> = {
      "brain/entities/zhang-san": { title: "张三", type: "entity", birthday: "1990-01-01" },
    };
    const { mock: pages, updates } = createMockPages(frontmatterMap);
    const slugMap = new Map([["张三", "brain/entities/zhang-san"]]);
    const facts = [makeFact()];

    const result = applyFacts(facts, slugMap, pages, createMockDB());

    expect(result.written).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].current).toBe("1990-01-01");
    expect(updates).toHaveLength(0);
  });

  test("skips fact with no slug mapping", () => {
    const { mock: pages, updates } = createMockPages({});
    const slugMap = new Map<string, string>();
    const facts = [makeFact()];

    const result = applyFacts(facts, slugMap, pages, createMockDB());

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("skips fact when page not found", () => {
    const { mock: pages } = createMockPages({});
    const slugMap = new Map([["张三", "brain/entities/zhang-san"]]);
    const facts = [makeFact()];

    const result = applyFacts(facts, slugMap, pages, createMockDB());

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
