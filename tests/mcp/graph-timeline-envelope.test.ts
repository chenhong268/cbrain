import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import { formatGraphEnvelope, formatLinksEnvelope, formatTimelineEnvelope } from "../../src/mcp/tools/format-result.js";

function createMockEmbedding() {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % text.length) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % t.length) ?? 0) / 65536),
        tokenCount: t.length,
      })),
  };
}

function createMockLanceDB() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: unknown) {
  return (server as any)._registeredTools as Record<string, any>;
}

async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}) {
  const tools = getTools(server);
  const tool = tools[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  const result = await tool.handler(args);
  return JSON.parse(result.content[0].text);
}

const BANNED_IN_DISPLAY = [
  "slug", "score", "confidence", "source_type", "weight",
  "hops", "shared_neighbors", "raw", "debug",
  "/tmp", "runtime", ".json", "reportPath",
  "entities/", "concepts/", "records/", "insights/", "brain/",
];

describe("graph_query envelope", () => {
  const testDir = "/tmp/cbrain-test-graph-envelope";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding() as any,
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath,
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function insertPage(slug: string, title: string, type: string) {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run(slug, type, title, `${slug.replace(/\//g, "_")}.md`, "h1");
  }

  function insertLink(from: string, to: string, relation = "提及", trustState = "candidate") {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, source_type, confidence, trust_state) VALUES (?, ?, ?, 'manual', 0.9, ?)"
    ).run(from, to, relation, trustState);
  }

  test("graph_query returns envelope with display/summary/raw", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/b", "entities/a"); // b→a so a has backlink

    const server = createServer(deps);
    const result = await callTool(server, "graph_query", { slug: "entities/a", mode: "backlinks" });

    expect(result.display).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBeGreaterThan(0);
  });

  test("graph_query display has no banned fields", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/b", "entities/a"); // b→a so a has backlink

    const server = createServer(deps);
    const result = await callTool(server, "graph_query", { slug: "entities/a", mode: "backlinks" });

    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("graph_query backlinks resolves both seed and source titles", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/b", "entities/a");

    const server = createServer(deps);
    const result = await callTool(server, "graph_query", { slug: "entities/a", mode: "backlinks" });

    expect(result.summary.status).toBe("ok");
    // Display should show both resolved titles, not "未知实体"
    expect(result.display).toContain("人物A");
    expect(result.display).toContain("人物B");
    expect(result.display).not.toContain("未知实体");
    expect(result.display).not.toContain("entities/");
  });

  test("graph_query empty result has natural language", async () => {
    insertPage("entities/a", "人物A", "entity/person");

    const server = createServer(deps);
    const result = await callTool(server, "graph_query", { slug: "entities/a", mode: "backlinks" });

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("未找到");
  });

  test("graph_query raw preserves full structure", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/a", "entities/b");

    const server = createServer(deps);
    const result = await callTool(server, "graph_query", { slug: "entities/a", mode: "backlinks" });

    expect(result.raw.resolvedSlug).toBe("entities/a");
    expect(result.raw.result).toBeDefined();
    expect(Array.isArray(result.raw.result)).toBe(true);
  });

  test("get_links returns envelope with display/summary/raw", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/a", "entities/b");

    const server = createServer(deps);
    const result = await callTool(server, "get_links", { slug: "entities/a" });

    expect(result.display).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.summary.status).toBe("ok");
  });

  test("get_links display has no banned fields", async () => {
    insertPage("entities/a", "人物A", "entity/person");
    insertPage("entities/b", "人物B", "entity/person");
    insertLink("entities/a", "entities/b");

    const server = createServer(deps);
    const result = await callTool(server, "get_links", { slug: "entities/a" });

    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
    // display shows relationship direction and trust label
    expect(result.display).toContain("待确认");
  });

  test("get_links empty returns natural language", async () => {
    insertPage("entities/a", "人物A", "entity/person");

    const server = createServer(deps);
    const result = await callTool(server, "get_links", { slug: "entities/a" });

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无");
  });

  test("get_links with unresolved title shows 未知实体 not slug", async () => {
    // Insert seed page but NOT the link target — target title won't resolve from DB
    insertPage("entities/a", "人物A", "entity/person");
    // Need a page row for FK but titleResolver won't find it because get_links
    // builds titleMap from link slugs, and the DB has no title for it
    // Actually getPageTitlesAndTypes queries pages table, so insert a slug-only page
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)"
    ).run("entities/unknown", "", "unknown.md", "h");
    // Clear the title so resolver gets empty string (which is falsy for the ?? fallback)
    db.rawDb.prepare("UPDATE pages SET title = '' WHERE slug = 'entities/unknown'").run();
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, source_type, confidence, trust_state) VALUES (?, ?, ?, 'manual', 0.9, 'candidate')"
    ).run("entities/a", "entities/unknown", "提及");

    const server = createServer(deps);
    const result = await callTool(server, "get_links", { slug: "entities/a" });

    expect(result.display).toContain("未知实体");
    expect(result.display).not.toContain("entities/");
  });
});

describe("get_timeline envelope", () => {
  const testDir = "/tmp/cbrain-test-timeline-envelope";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  const runtimePath = join(testDir, "runtime");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding() as any,
      lance: createMockLanceDB() as any,
      vaultPath,
      runtimePath,
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function insertPage(slug: string, title: string) {
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"
    ).run(slug, "entity/person", title, `${slug.replace(/\//g, "_")}.md`, "h1");
  }

  function insertTimeline(slug: string, summary: string, eventDate?: string, trustState = "candidate") {
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, 'manual', ?)"
    ).run(slug, summary, eventDate ?? null, trustState);
  }

  test("get_timeline returns envelope with display/summary/raw", async () => {
    insertPage("entities/a", "人物A");
    insertTimeline("entities/a", "加入了组织B", "2025-01-15");

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/a" });

    expect(result.display).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.raw).toBeDefined();
    expect(result.summary.status).toBe("ok");
    expect(result.summary.count).toBe(1);
  });

  test("get_timeline display has no banned fields", async () => {
    insertPage("entities/a", "人物A");
    insertTimeline("entities/a", "加入了组织B", "2025-01-15");

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/a" });

    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("get_timeline empty has natural language", async () => {
    insertPage("entities/a", "人物A");

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/a" });

    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无时间线");
  });

  test("get_timeline raw preserves full structure", async () => {
    insertPage("entities/a", "人物A");
    insertTimeline("entities/a", "加入了组织B", "2025-01-15");

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/a" });

    expect(result.raw.slug).toBe("entities/a");
    // title falls back to slug when vault file doesn't exist
    expect(typeof result.raw.title).toBe("string");
    expect(result.raw.events).toHaveLength(1);
  });

  test("get_timeline truncates at 5 events", async () => {
    insertPage("entities/a", "人物A");
    for (let i = 0; i < 8; i++) {
      insertTimeline("entities/a", `事件${i}`, `2025-01-${String(i + 1).padStart(2, "0")}`);
    }

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/a" });

    expect(result.summary.count).toBe(8);
    expect(result.summary.truncated).toBe(true);
    expect(result.display).toContain("还有 3 个事件");
  });

  test("get_timeline missing page shows safe label not slug", async () => {
    // Insert page with empty title — DB has row but no usable title
    db.rawDb.prepare(
      "INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', '', ?, ?)"
    ).run("entities/ghost", "ghost.md", "h");
    db.rawDb.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, 'manual', 'candidate')"
    ).run("entities/ghost", "幽灵事件", "2025-01-01");

    const server = createServer(deps);
    const result = await callTool(server, "get_timeline", { slug: "entities/ghost" });

    expect(result.summary.status).toBe("ok");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("ghost");
    // raw still has the slug for audit
    expect(result.raw.slug).toBe("entities/ghost");
  });
});

describe("formatGraphEnvelope unit tests", () => {
  const noTitle = (_s: string) => null;

  test("empty links result", () => {
    const result = formatGraphEnvelope({ resolvedSlug: "entities/a", result: [] }, noTitle);
    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("未找到");
  });

  test("confirmed link shows no prefix", () => {
    const result = formatGraphEnvelope({
      resolvedSlug: "entities/a",
      result: [{ id: 1, from_slug: "entities/a", to_slug: "entities/b", relation: "提及", weight: 0.9, strength: "strong", trust_state: "confirmed" }],
    }, noTitle);
    expect(result.display).not.toContain("待确认");
  });

  test("candidate link shows 待确认 prefix", () => {
    const result = formatGraphEnvelope({
      resolvedSlug: "entities/a",
      result: [{ id: 1, from_slug: "entities/a", to_slug: "entities/b", relation: "提及", weight: 0.5, strength: "weak", trust_state: "candidate" }],
    }, noTitle);
    expect(result.display).toContain("待确认");
  });

  test("resolves titles via titleResolver", () => {
    const result = formatGraphEnvelope({
      resolvedSlug: "entities/a",
      result: [{ id: 1, from_slug: "entities/a", to_slug: "entities/b", relation: "同事", weight: 0.8, strength: "medium" }],
    }, (s) => s === "entities/b" ? "人物B" : null);
    expect(result.display).toContain("人物B");
    expect(result.display).toContain("同事");
  });
});

describe("formatTimelineEnvelope unit tests", () => {
  test("prefers dated events and sorts by date", () => {
    const result = formatTimelineEnvelope({
      slug: "entities/a",
      title: "人物A",
      events: [
        { summary: "无日期事件", trust_state: "candidate" },
        { summary: "早期事件", date: "2024-01-01", trust_state: "confirmed" },
        { summary: "晚期事件", date: "2025-06-01", trust_state: "candidate" },
      ],
    });
    expect(result.summary.count).toBe(3);
    // Dated events should come before undated
    const lines = result.display.split("\n");
    const earlyIdx = lines.findIndex(l => l.includes("早期事件"));
    const lateIdx = lines.findIndex(l => l.includes("晚期事件"));
    const noDateIdx = lines.findIndex(l => l.includes("无日期事件"));
    expect(earlyIdx).toBeLessThan(lateIdx);
    expect(lateIdx).toBeLessThan(noDateIdx);
  });
});

describe("formatLinksEnvelope unit tests", () => {
  const noTitle = (_s: string) => null;

  test("empty links", () => {
    const result = formatLinksEnvelope([], "entities/a", noTitle);
    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无");
  });

  test("shows known vs pending trust", () => {
    const result = formatLinksEnvelope([
      { id: 1, from_slug: "entities/a", to_slug: "entities/b", relation: "提及", weight: 0.9, strength: "strong", trust_state: "confirmed" },
      { id: 2, from_slug: "entities/c", to_slug: "entities/a", relation: "合作", weight: 0.5, strength: "weak", trust_state: "candidate" },
    ], "entities/a", noTitle);
    expect(result.display).toContain("已知");
    expect(result.display).toContain("待确认");
  });
});
