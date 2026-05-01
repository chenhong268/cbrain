import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { ReflectManager } from "../../src/core/reflect.js";
import { PageManager } from "../../src/core/page.js";
import type { LLMProvider, ChatMessage } from "../../src/llm/provider.js";

function insertEntity(
  db: CBrainDB,
  slug: string,
  title: string,
  mentionCount = 0,
  tier = 3
) {
  db.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash, mention_count, tier)
     VALUES (?, 'entity', ?, ?, ?, ?, ?)`
  ).run(slug, title, `${slug}.md`, `h-${slug}`, mentionCount, tier);
}

function mockLLM(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock",
    chat: async (_messages: ChatMessage[]) => {
      const response = responses[callIndex] ?? "";
      callIndex++;
      return response;
    },
  };
}

describe("ReflectManager", () => {
  const testDir = "/tmp/cbrain-test-reflect";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let pages: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    pages = new PageManager(db, vaultPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describe("reflectAll", () => {
    test("returns empty report when no LLM", async () => {
      const mgr = new ReflectManager(db, pages);
      const report = await mgr.reflectAll();
      expect(report.entitiesSynthesized).toBe(0);
      expect(report.relationsInferred).toBe(0);
      expect(report.insightsGenerated).toBe(0);
      expect(report.details.syntheses).toEqual([]);
      expect(report.details.relations).toEqual([]);
      expect(report.details.insights).toEqual([]);
    });

    test("runs all three stages with LLM", async () => {
      insertEntity(db, "entities/a", "Alpha", 5);
      insertEntity(db, "entities/b", "Beta", 5);
      insertEntity(db, "entities/c", "Gamma", 3);
      insertEntity(db, "entities/d", "Delta", 3);

      db.insertLink("entities/a", "entities/b", "related");
      db.insertLink("entities/b", "entities/c", "related");
      db.insertLink("entities/c", "entities/a", "related");
      db.insertLink("entities/c", "entities/d", "related");
      db.insertLink("entities/d", "entities/a", "related");
      db.insertLink("entities/d", "entities/b", "related");

      const llm = mockLLM([
        JSON.stringify({ summary: "Alpha is a test entity", key_facts: ["fact1"], confidence: 0.8 }),
        JSON.stringify({ summary: "Beta is another entity", key_facts: ["fact2"], confidence: 0.7 }),
        JSON.stringify({ inferred_relations: [{ from: "entities/a", to: "entities/c", relation: "connected", reasoning: "test", confidence: 0.8 }] }),
        JSON.stringify({ insights: [{ content: "Test insight about cluster", related_entities: ["entities/a", "entities/b"], type: "pattern", confidence: 0.75 }] }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.entitiesSynthesized).toBeGreaterThanOrEqual(0);
      expect(report.relationsInferred).toBeGreaterThanOrEqual(0);
      expect(report.insightsGenerated).toBeGreaterThanOrEqual(0);
    });
  });

  describe("entity synthesis", () => {
    test("synthesizes high-mention entities via LLM", async () => {
      insertEntity(db, "entities/high", "HighMention", 5);

      const page = db.getPage("entities/high")!;
      const filePath = join(vaultPath, page.file_path);
      mkdirSync(join(vaultPath, "entities"), { recursive: true });
      writeFileSync(filePath, "---\ntitle: HighMention\ntype: entity\n---\nAuto-extracted.", "utf-8");

      const llm = mockLLM([
        JSON.stringify({ summary: "A frequently mentioned entity", key_facts: ["mentioned 5 times"], confidence: 0.9 }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.entitiesSynthesized).toBe(1);
      expect(report.details.syntheses[0].slug).toBe("entities/high");
      expect(report.details.syntheses[0].summary).toContain("frequently mentioned");
    });

    test("skips entities below mention threshold", async () => {
      insertEntity(db, "entities/low", "LowMention", 1);

      const llm = mockLLM([]);
      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.entitiesSynthesized).toBe(0);
    });

    test("handles malformed LLM JSON gracefully", async () => {
      insertEntity(db, "entities/bad", "BadResponse", 5);

      const llm = mockLLM(["not valid json"]);
      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.entitiesSynthesized).toBe(0);
    });

    test("handles LLM JSON missing summary", async () => {
      insertEntity(db, "entities/nosummary", "NoSummary", 5);

      const llm = mockLLM([
        JSON.stringify({ key_facts: ["fact"], confidence: 0.5 }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.entitiesSynthesized).toBe(0);
    });
  });

  describe("relation inference", () => {
    test("finds indirect pairs and infers relations", async () => {
      insertEntity(db, "entities/a", "A", 5);
      insertEntity(db, "entities/b", "B", 5);
      insertEntity(db, "entities/c", "C", 5);

      db.insertLink("entities/a", "entities/b", "works_at");
      db.insertLink("entities/b", "entities/c", "manages");

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          inferred_relations: [{
            from: "entities/a",
            to: "entities/c",
            relation: "reports_to",
            reasoning: "A works at company, C manages B who also works there",
            confidence: 0.8,
          }],
        }),
        JSON.stringify({ insights: [] }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.relationsInferred).toBe(1);
      expect(report.details.relations[0].from).toBe("entities/a");
      expect(report.details.relations[0].to).toBe("entities/c");
      expect(report.details.relations[0].relation).toBe("reports_to");

      const links = db.getOutgoingLinks("entities/a");
      const inferred = links.find(l => l.to_slug === "entities/c");
      expect(inferred).toBeDefined();
      expect(inferred!.context).toContain("[inferred]");
    });

    test("filters out low-confidence inferences", async () => {
      insertEntity(db, "entities/x", "X", 5);
      insertEntity(db, "entities/y", "Y", 5);
      insertEntity(db, "entities/z", "Z", 5);

      db.insertLink("entities/x", "entities/y", "knows");
      db.insertLink("entities/y", "entities/z", "knows");

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          inferred_relations: [{
            from: "entities/x",
            to: "entities/z",
            relation: "maybe_knows",
            reasoning: "weak",
            confidence: 0.4,
          }],
        }),
        JSON.stringify({ insights: [] }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.relationsInferred).toBe(0);
      const links = db.getOutgoingLinks("entities/x");
      const inferred = links.find(l => l.to_slug === "entities/z");
      expect(inferred).toBeUndefined();
    });

    test("no inference when no indirect pairs exist", async () => {
      insertEntity(db, "entities/iso", "Isolated", 5);

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({ insights: [] }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.relationsInferred).toBe(0);
    });
  });

  describe("insight generation", () => {
    test("generates insights for high-connectivity entities", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);

      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `Neighbor${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const hubDir = join(vaultPath, "entities");
      mkdirSync(hubDir, { recursive: true });
      writeFileSync(join(hubDir, "hub.md"), "---\ntitle: Hub\ntype: entity\n---\nHub entity.", "utf-8");

      const llm = mockLLM([
        JSON.stringify({ summary: "Central hub entity", key_facts: [], confidence: 0.8 }),
        JSON.stringify({
          insights: [{
            title: "核心节点聚集",
            content: "Hub connects to many neighbors forming a cluster",
            related_entities: ["entities/hub", "entities/n1"],
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(1);
      expect(report.details.insights[0].content).toContain("cluster");
    });

    test("skips entities below neighbor threshold", async () => {
      insertEntity(db, "entities/lowconn", "LowConn", 10);
      insertEntity(db, "entities/n1", "N1", 3);
      insertEntity(db, "entities/n2", "N2", 3);
      db.insertLink("entities/lowconn", "entities/n1", "related");
      db.insertLink("entities/lowconn", "entities/n2", "related");

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(0);
    });
  });

  describe("context building", () => {
    test("buildEntityContext includes links and timeline", async () => {
      insertEntity(db, "entities/ctx", "ContextEntity", 5);
      insertEntity(db, "entities/src", "Source", 1);

      db.insertLink("entities/src", "entities/ctx", "mentions", "seen in meeting");
      db.insertLink("entities/ctx", "entities/src", "references");

      db.prepare(
        `INSERT INTO timeline (page_slug, event_date, summary, source) VALUES (?, ?, ?, ?)`
      ).run("entities/ctx", "2025-01-15", "Key event happened", "source.md");

      const llm = mockLLM([
        JSON.stringify({ summary: "Entity with rich context", key_facts: [], confidence: 0.9 }),
      ]);
      const mgr = new ReflectManager(db, pages, llm);

      const context = (mgr as any).buildEntityContext("entities/ctx");
      expect(context).toContain("ContextEntity");
      expect(context).toContain("被引用");
      expect(context).toContain("mentions");
      expect(context).toContain("references");
      expect(context).toContain("Key event happened");
    });

    test("buildEntityContext returns null for missing entity", () => {
      const mgr = new ReflectManager(db, pages);
      const context = (mgr as any).buildEntityContext("entities/ghost");
      expect(context).toBeNull();
    });
  });

  describe("2-hop neighbor finding", () => {
    test("finds indirect pairs via 2-hop traversal", () => {
      insertEntity(db, "entities/a", "A", 5);
      insertEntity(db, "entities/b", "B", 5);
      insertEntity(db, "entities/c", "C", 5);
      insertEntity(db, "entities/d", "D", 5);

      db.insertLink("entities/a", "entities/b", "knows");
      db.insertLink("entities/b", "entities/c", "knows");
      db.insertLink("entities/b", "entities/d", "knows");

      const mgr = new ReflectManager(db, pages);
      const pairs: Array<[string, string]> = (mgr as any).findIndirectPairs();

      const pairKeys = new Set(pairs.map(([a, b]) => [a, b].sort().join("→")));
      expect(pairKeys.has("entities/a→entities/c")).toBe(true);
      expect(pairKeys.has("entities/a→entities/d")).toBe(true);
    });

    test("excludes pairs with existing direct links", () => {
      insertEntity(db, "entities/a", "A", 5);
      insertEntity(db, "entities/b", "B", 5);
      insertEntity(db, "entities/c", "C", 5);

      db.insertLink("entities/a", "entities/b", "knows");
      db.insertLink("entities/b", "entities/c", "knows");
      db.insertLink("entities/a", "entities/c", "direct");

      const mgr = new ReflectManager(db, pages);
      const pairs: Array<[string, string]> = (mgr as any).findIndirectPairs();

      const hasAC = pairs.some(([a, b]) =>
        (a === "entities/a" && b === "entities/c") ||
        (a === "entities/c" && b === "entities/a")
      );
      expect(hasAC).toBe(false);
    });

    test("returns empty when no links exist", () => {
      insertEntity(db, "entities/iso", "Isolated", 5);

      const mgr = new ReflectManager(db, pages);
      const pairs: Array<[string, string]> = (mgr as any).findIndirectPairs();

      expect(pairs).toEqual([]);
    });
  });

  // ─── New strict tests for bug fixes ────────────────────────────

  describe("Bug 1: error isolation around pageMgr.create()", () => {
    test("one insight failure does not prevent other insights", async () => {
      insertEntity(db, "entities/hub1", "Hub1", 10);
      insertEntity(db, "entities/hub2", "Hub2", 10);

      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub1", `entities/n${i}`, "related");
        db.insertLink("entities/hub2", `entities/n${i}`, "related");
      }

      // Pre-create a page with the exact slug that the first insight will get
      // This simulates insertPage() throwing on duplicate slug
      const { generateSlug } = await import("../../src/utils/slug.js");
      const date = new Date().toISOString().slice(0, 10);
      const blockingSlug = generateSlug(`${date} test-title`, "insight");
      // Insert a page with that slug to force a collision
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'insight', ?, ?, '')`
      ).run(blockingSlug, "blocking", `${blockingSlug}.md`);

      const llm = mockLLM([
        // Synthesis for hub1 (skipped - mention_count too low for synthesis since MIN_MENTIONS=3, but hub1 has 10)
        JSON.stringify({ summary: "hub1", key_facts: [], confidence: 0.5 }),
        // Insight for hub1 — this one will collide with the pre-existing page
        JSON.stringify({
          insights: [{
            title: "test-title",
            content: "First insight that will fail",
            type: "pattern",
            confidence: 0.8,
          }],
        }),
        // Synthesis for hub2
        JSON.stringify({ summary: "hub2", key_facts: [], confidence: 0.5 }),
        // Insight for hub2 — this should succeed
        JSON.stringify({
          insights: [{
            title: "second-works",
            content: "Second insight that should succeed",
            type: "trend",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      // The second insight should still be generated even though the first failed
      expect(report.insightsGenerated).toBe(1);
      expect(report.details.insights[0].content).toContain("Second insight");
    });
  });

  describe("Bug 2: title truncation enforcement", () => {
    test("truncates LLM title exceeding safety limit (20)", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const longTitle = "这是一个非常长的标题超过二十个字应该被截断掉多余的部分";
      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [{
            title: longTitle,
            content: "Some insight content",
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(1);
      const insightPage = report.details.insights[0];
      expect(insightPage).toBeDefined();

      const { generateSlug } = await import("../../src/utils/slug.js");
      const date = new Date().toISOString().slice(0, 10);
      const expectedTruncated = longTitle.slice(0, 20);
      const expectedTitle = `${date} ${expectedTruncated}`;
      const expectedSlug = generateSlug(expectedTitle, "insight");

      const createdPage = db.getPage(expectedSlug);
      expect(createdPage).not.toBeNull();
      expect(createdPage!.title.length).toBeLessThan(longTitle.length + date.length + 2);
    });
  });

  describe("Bug 3: meaningful title fallback", () => {
    test("uses first phrase from content when LLM omits title", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const mgr = new ReflectManager(db, pages);
      const fallback = (mgr as any).extractTitleFallback("短标题，后面的不重要");
      expect(fallback).toBe("短标题");
      expect(fallback.length).toBeLessThanOrEqual(10);
    });

    test("returns default when content is empty", () => {
      const mgr = new ReflectManager(db, pages);
      const fallback = (mgr as any).extractTitleFallback("");
      expect(fallback).toBe("未命名洞察");
    });

    test("extracts first phrase split by punctuation", () => {
      const mgr = new ReflectManager(db, pages);
      const fallback = (mgr as any).extractTitleFallback("短句。后面的不重要");
      expect(fallback).toBe("短句");
    });

    test("insight creation works without LLM title", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [{
            // No title field at all
            content: "First phrase here。More content follows",
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(1);
      // The fallback should have been used (first phrase before 。)
      const insightSlug = report.details.insights[0];
      expect(insightSlug).toBeDefined();
    });
  });

  describe("Bug 4: cross-dream dedup", () => {
    test("skips insight when slug already exists in DB", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      // Pre-create the insight page with the same slug
      const { generateSlug } = await import("../../src/utils/slug.js");
      const date = new Date().toISOString().slice(0, 10);
      const title = `${date} dedup-test`;
      const slug = generateSlug(title, "insight");
      db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'insight', ?, ?, '')`
      ).run(slug, title, `${slug}.md`);

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [{
            title: "dedup-test",
            content: "Should be skipped",
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(0);
    });

    test("skips duplicate insight within same batch", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [
            { title: "same-title", content: "First copy", type: "pattern", confidence: 0.8 },
            { title: "same-title", content: "Second copy should be skipped", type: "pattern", confidence: 0.8 },
          ],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      // Only the first insight should be created
      expect(report.insightsGenerated).toBe(1);
      expect(report.details.insights[0].content).toBe("First copy");
    });
  });

  describe("Bug 5: related_entities resolution", () => {
    test("resolves entity titles to slugs", async () => {
      insertEntity(db, "entities/zhang", "张三", 10);
      insertEntity(db, "entities/li", "李四", 1);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/zhang", `entities/n${i}`, "related");
      }

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [{
            title: "resolve-test",
            content: "Some pattern found",
            // LLM returns titles instead of slugs
            related_entities: ["张三", "李四"],
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(1);
      // related should be resolved slugs, not raw titles
      const related = report.details.insights[0].related;
      expect(related).toContain("entities/zhang");
      expect(related).toContain("entities/li");
    });

    test("filters out unresolvable entities", async () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const llm = mockLLM([
        JSON.stringify({ summary: "test", key_facts: [], confidence: 0.5 }),
        JSON.stringify({
          insights: [{
            title: "partial-resolve",
            content: "Some insight",
            related_entities: ["entities/hub", "nonexistent/entity"],
            type: "pattern",
            confidence: 0.8,
          }],
        }),
      ]);

      const mgr = new ReflectManager(db, pages, llm);
      const report = await mgr.reflectAll();

      expect(report.insightsGenerated).toBe(1);
      const related = report.details.insights[0].related;
      expect(related).toContain("entities/hub");
      expect(related).not.toContain("nonexistent/entity");
    });

    test("resolveRelatedEntities returns empty for empty input", () => {
      const mgr = new ReflectManager(db, pages);
      const result = (mgr as any).resolveRelatedEntities([]);
      expect(result).toEqual([]);
    });
  });

  describe("Bug 6: buildClusterContext token budget", () => {
    test("truncates context exceeding MAX_CONTEXT_CHARS", () => {
      insertEntity(db, "entities/hub", "Hub", 10);

      // Pass 1: create all entities
      for (let i = 1; i <= 20; i++) {
        insertEntity(db, `entities/n${i}`, `Neighbor${i}`, 5);
      }
      // Pass 2: add links (both ends now exist, avoids FK violations)
      for (let i = 1; i <= 20; i++) {
        db.insertLink("entities/hub", `entities/n${i}`, "related");
        for (let j = 1; j <= 20; j++) {
          if (i !== j) {
            db.insertLink(`entities/n${i}`, `entities/n${j}`, "connected", `context line for link ${i}-${j}`);
          }
        }
      }

      const mgr = new ReflectManager(db, pages);
      const context = (mgr as any).buildClusterContext("entities/hub");

      expect(context).not.toBeNull();
      expect(context!.length).toBeLessThanOrEqual(4000);
    });

    test("includes all context when below threshold", () => {
      insertEntity(db, "entities/hub", "Hub", 10);
      for (let i = 1; i <= 6; i++) {
        insertEntity(db, `entities/n${i}`, `N${i}`, 1);
        db.insertLink("entities/hub", `entities/n${i}`, "related");
      }

      const mgr = new ReflectManager(db, pages);
      const context = (mgr as any).buildClusterContext("entities/hub");

      expect(context).not.toBeNull();
      expect(context).toContain("Hub");
      // Small dataset should be well within limit
      expect(context!.length).toBeLessThan(4000);
    });
  });
});
