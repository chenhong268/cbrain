import { describe, test, expect, beforeEach, mock } from "bun:test";
import { structuredFactsBackfill } from "../../src/core/structured-facts-backfill.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { CBrainDB, PageRow } from "../../src/storage/sqlite.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockDB(pages: PageRow[]): CBrainDB {
  const pageMap = new Map(pages.map(p => [p.slug, p]));
  return {
    getPage: (slug: string) => pageMap.get(slug) ?? null,
    listPages: (opts?: { type?: string; typePrefix?: string; orderBy?: string }) => {
      let result = pages;
      if (opts?.typePrefix) result = result.filter(p => p.type.startsWith(opts.typePrefix!));
      else if (opts?.type) result = result.filter(p => p.type === opts.type);
      return result;
    },
  } as unknown as CBrainDB;
}

function createMockLLM(responses: string[]): LLMProvider {
  let idx = 0;
  return {
    name: "mock",
    chat: async () => responses[idx++] ?? '{"facts":[]}',
  };
}

function makePage(overrides: Partial<PageRow> = {}): PageRow {
  return {
    slug: "brain/entities/test-entity",
    type: "entity/person",
    title: "张三",
    file_path: "brain/entities/test-entity.md",
    content_hash: null,
    tier: 1,
    mention_count: 10,
    expires_at: null,
    confidence_decay: 1,
    hotness_score: 0,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    ...overrides,
  };
}

describe("structuredFactsBackfill", () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), "cbrain-backfill-test-"));
  });

  // Cleanup handled implicitly — temp dirs get cleaned eventually

  test("dryRun mode scans but does not write", async () => {
    const page = makePage();
    const filePath = join(vaultPath, page.file_path);
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(filePath, "---\ntitle: 张三\ntype: entity\n---\n\n张三是上海人，1985年出生。");

    const db = createMockDB([page]);
    const llm = createMockLLM([
      JSON.stringify({
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三是上海人" },
          { entity: "张三", field: "birthday", value: "1985", confidence: 0.8, evidence: "1985年出生" },
        ],
      }),
    ]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, { apply: false });

    expect(report.scanned).toBe(1);
    expect(report.wouldApply).toBe(2);
    expect(report.examples).toHaveLength(2);

    // Verify file was NOT modified
    const content = await Bun.file(filePath).text();
    expect(content).not.toContain("birthplace");
  });

  test("apply mode writes empty fields", async () => {
    const page = makePage();
    const filePath = join(vaultPath, page.file_path);
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(filePath, "---\ntitle: 张三\ntype: entity\n---\n\n张三是上海人，1985年出生。");

    const db = createMockDB([page]);
    const llm = createMockLLM([
      JSON.stringify({
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三是上海人" },
        ],
      }),
    ]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, { apply: true });

    expect(report.wouldApply).toBe(1);
    expect(report.scanned).toBe(1);

    // Verify file WAS modified
    const content = await Bun.file(filePath).text();
    expect(content).toContain("birthplace: 上海");
  });

  test("does not overwrite existing fields", async () => {
    const page = makePage();
    const filePath = join(vaultPath, page.file_path);
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(filePath, "---\ntitle: 张三\ntype: entity\nbirthplace: 北京\n---\n\n张三是上海人。");

    const db = createMockDB([page]);
    const llm = createMockLLM([
      JSON.stringify({
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三是上海人" },
        ],
      }),
    ]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, { apply: true });

    expect(report.conflicts).toBe(1);
    expect(report.wouldApply).toBe(0);

    const content = await Bun.file(filePath).text();
    expect(content).toContain("birthplace: 北京");
  });

  test("respects limit option", async () => {
    const pages = [
      makePage({ slug: "brain/entities/a", title: "A", file_path: "brain/entities/a.md", mention_count: 5 }),
      makePage({ slug: "brain/entities/b", title: "B", file_path: "brain/entities/b.md", mention_count: 3 }),
    ];
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    for (const p of pages) {
      writeFileSync(join(vaultPath, p.file_path), `---\ntitle: ${p.title}\ntype: entity\n---\n\nContent about ${p.title}.`);
    }

    const db = createMockDB(pages);
    const llm = createMockLLM([
      JSON.stringify({ facts: [] }),
    ]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, { limit: 1 });
    expect(report.scanned).toBe(1);
  });

  test("filters by slug", async () => {
    const page = makePage();
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(join(vaultPath, page.file_path), "---\ntitle: 张三\ntype: entity\n---\n\nContent.");

    const db = createMockDB([page]);
    const llm = createMockLLM([JSON.stringify({ facts: [] })]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, { slug: page.slug });
    expect(report.scanned).toBe(1);
  });

  test("skips non-existent files", async () => {
    const page = makePage();
    // Don't create the file

    const db = createMockDB([page]);
    const llm = createMockLLM([]);

    const report = await structuredFactsBackfill(db, vaultPath, llm);
    expect(report.skipped).toBe(1);
    expect(report.scanned).toBe(1);
  });

  test("skips empty content", async () => {
    const page = makePage();
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(join(vaultPath, page.file_path), "---\ntitle: 张三\ntype: entity\n---\n\n");

    const db = createMockDB([page]);
    const llm = createMockLLM([]);

    const report = await structuredFactsBackfill(db, vaultPath, llm);
    expect(report.skipped).toBe(1);
  });

  test("filters by onlyFields", async () => {
    const page = makePage();
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(join(vaultPath, page.file_path), "---\ntitle: 张三\ntype: entity\n---\n\n张三是上海人，1985年出生。");

    const db = createMockDB([page]);
    const llm = createMockLLM([
      JSON.stringify({
        facts: [
          { entity: "张三", field: "birthplace", value: "上海", confidence: 0.9, evidence: "张三是上海人" },
          { entity: "张三", field: "birthday", value: "1985", confidence: 0.8, evidence: "1985年出生" },
        ],
      }),
    ]);

    const report = await structuredFactsBackfill(db, vaultPath, llm, {
      apply: false,
      onlyFields: ["birthday"],
    });

    expect(report.wouldApply).toBe(1);
    expect(report.examples[0].field).toBe("birthday");
  });

  test("handles malformed LLM response gracefully", async () => {
    const page = makePage();
    mkdirSync(join(vaultPath, "brain/entities"), { recursive: true });
    writeFileSync(join(vaultPath, page.file_path), "---\ntitle: 张三\ntype: entity\n---\n\nContent.");

    const db = createMockDB([page]);
    const llm = createMockLLM(["not valid json"]);

    const report = await structuredFactsBackfill(db, vaultPath, llm);
    expect(report.skipped).toBe(1);
  });
});
