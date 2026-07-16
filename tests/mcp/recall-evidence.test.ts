import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

function createMockEmbedding(): EmbeddingProvider {
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
    connect: async () => {}, addChunks: async () => {}, search: async () => [], fullTextSearch: async () => [],
    deleteByPageSlug: async () => {}, deleteRawChunksByPageSlug: async () => {}, close: async () => {}, createFTSIndex: async () => {},
  };
}
function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<unknown> }> })._registeredTools;
}

const TEST_DIR = "/tmp/cbrain-test-recall-evidence";
const dbPath = join(TEST_DIR, "t.sqlite");
const vaultPath = join(TEST_DIR, "vault");
let db: CBrainDB;
let deps: CBrainDeps;

/** Seed a page findable by FTS, with optional timeline/chunks/links/sealed.
 *  FTS discovery (chunks_fts) is decoupled from evidence chunks (chunks table),
 *  so a low-coverage fixture can still be found by search but yield chunk_hits=0. */
function seed(slug: string, title: string, fts: string, opts: { timeline?: number; chunks?: number; linkTo?: string; sealed?: boolean; tier?: number } = {}) {
  db.rawDb.prepare(
    "INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, 'entity', ?, ?, ?, ?, ?)",
  ).run(slug, title, `${slug}.md`, `h-${slug}`, opts.tier ?? 1, 5);
  if (opts.timeline) {
    for (let i = 0; i < opts.timeline; i++) {
      db.rawDb.prepare(
        "INSERT INTO timeline (page_slug, summary, event_date, source, trust_state) VALUES (?, ?, ?, ?, ?)",
      ).run(slug, `${title}的时间线事件${i}`, `2026-01-0${(i % 9) + 1}`, "dialogue", "trusted");
    }
  }
  if (opts.chunks) {
    for (let i = 0; i < opts.chunks; i++) {
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)").run(slug, i, `${title}的原始决策片段${i}`);
    }
  }
  if (opts.sealed) {
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, -1, ?, 1)").run(slug, `${title}的L1摘要`);
  }
  // FTS index only — search discovers the slug via chunks_fts regardless of the chunks table.
  db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, fts);
  if (opts.linkTo) {
    db.rawDb.prepare("INSERT OR IGNORE INTO pages (slug, type, title, file_path, content_hash) VALUES (?, 'entity', ?, ?, ?)").run(opts.linkTo, opts.linkTo, `${opts.linkTo}.md`, `h-${opts.linkTo}`);
    db.rawDb.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, confidence) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(slug, opts.linkTo, "合作", "wikilink", "trusted", 0.9);
  }
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  db = new CBrainDB(dbPath);
  deps = { db, embedding: createMockEmbedding(), lance: createMockLanceDB() as never, vaultPath, runtimePath: join(dirname(dbPath), "runtime") };
});
afterEach(() => {
  db.close();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

async function recall(query: string, opts: { include_raw?: boolean; tool?: "deep_recall" | "cbrain_recall" } = {}) {
  const server = createServer(deps);
  const tool = opts.tool ?? "deep_recall";
  const handler = getTools(server)[tool].handler;
  const args = opts.tool === "cbrain_recall" ? { query } : { query, ...(opts.include_raw ? { include_raw: true } : {}) };
  const result = await handler(args) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

describe("deep_recall evidence completion (#232)", () => {
  test("1. temporal query pulls a timeline evidence pack", async () => {
    seed("entity/a", "实体A", "实体A 上次活动的完整记录", { timeline: 3, chunks: 2 });
    const data = await recall("实体A 上次的活动", { include_raw: true });
    expect(data.raw.evidence_pack).toBeDefined();
    expect(data.raw.evidence_pack.timeline.length).toBeGreaterThan(0);
    expect(data.raw.evidence_pack.coverage.coverage_status).toBe("sufficient");
  });

  test("2. historical 'why was this decided' query yields chunks + timeline", async () => {
    seed("entity/b", "实体B", "方案B 当时设计决策的关键内容", { timeline: 2, chunks: 2 });
    const data = await recall("方案B 当时为什么这么定", { include_raw: true });
    expect(data.raw.evidence_pack.chunks.length).toBeGreaterThan(0);
    expect(data.raw.evidence_pack.timeline.length).toBeGreaterThan(0);
  });

  test("3. former/current relationship query yields links + timeline (not vector-only)", async () => {
    seed("entity/c", "实体C", "实体C 之前和现在的关系变化", { timeline: 2, linkTo: "entity/partner" });
    const data = await recall("实体C 之前和现在的关系", { include_raw: true });
    expect(data.raw.evidence_pack.timeline.length).toBeGreaterThan(0);
    expect(data.raw.evidence_pack.links.length).toBeGreaterThan(0);
  });

  test("4. sealed page surfaces raw chunks (sealed:true)", async () => {
    seed("entity/sealed", "已归档实体", "已归档实体 当时的设计细节", { timeline: 1, chunks: 2, sealed: true });
    const data = await recall("已归档实体 当时的设计细节", { include_raw: true });
    expect(data.raw.evidence_pack.chunks.length).toBeGreaterThan(0);
    expect(data.raw.evidence_pack.chunks.every((c: { sealed: boolean }) => c.sealed === true)).toBe(true);
  });

  test("4b. sealed page 后段 raw detail surfaces via include_raw (query-aware, #232 amend)", async () => {
    // Detail the query asks for is in raw chunk 3 — BEYOND the first-3 default.
    const slug = "entity/sealed-late";
    seed(slug, "已归档后段实体", "已归档后段实体 当时的后段关键决策细节", { timeline: 1, sealed: true });
    for (let i = 0; i < 3; i++) {
      db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, ?, ?, 0)").run(slug, i, `普通前置片段${i}`);
    }
    db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content, summary_level) VALUES (?, 3, ?, 0)").run(slug, "后段关键决策细节的完整展开内容");
    const data = await recall("已归档后段实体 当时的后段关键决策细节", { include_raw: true });
    expect(data.raw.evidence_pack).toBeDefined();
    expect(data.raw.evidence_pack.chunks.some((c: { excerpt: string }) => c.excerpt.includes("后段关键决策细节"))).toBe(true);
    expect(data.raw.evidence_pack.chunks.every((c: { sealed: boolean }) => c.sealed === true)).toBe(true);
  });

  test("5. low coverage → partial display + insufficient coverage in raw only", async () => {
    // Findable but has NO timeline/chunks/links → insufficient coverage.
    seed("entity/empty", "空实体", "空实体 上次的记录仅一行", { timeline: 0, chunks: 0 });
    const data = await recall("空实体 上次的记录");  // default compact
    expect(data.display).toContain("只找到部分线索");
    expect(data.summary.status).toBe("degraded");
    // compact response must NOT carry the raw evidence internals
    const blob = JSON.stringify(data);
    expect(blob).not.toContain("coverage_status");
    expect(blob).not.toContain("timeline_hits");
    // include_raw carries the insufficient coverage meta in raw
    const raw = await recall("空实体 上次的记录", { include_raw: true });
    expect(raw.raw.evidence_pack.coverage.coverage_status).toBe("insufficient");
  });

  test("6. non-temporal query does not fire evidence completion (no overhead)", async () => {
    seed("entity/plain", "普通实体", "普通实体 的简介内容", { timeline: 3, chunks: 3 });
    const data = await recall("普通实体 的简介", { include_raw: true });
    expect(data.raw.evidence_pack).toBeUndefined();
  });

  test("7. cbrain_recall temporal route reuses the same evidence pack", async () => {
    seed("entity/d", "实体D", "实体D 上次活动的记录", { timeline: 2, chunks: 2 });
    const data = await recall("实体D 上次活动", { tool: "cbrain_recall" });
    expect(data.raw.evidence_pack).toBeDefined();
    expect(data.raw.evidence_pack.timeline.length).toBeGreaterThan(0);
  });

  test("8. display/summary never leak coverage internals", async () => {
    seed("entity/leak", "实体E", "实体E 上次的活动记录", { timeline: 2, chunks: 2 });
    const data = await recall("实体E 上次的活动", { include_raw: true });
    for (const term of ["coverage_status", "timeline_hits", "chunk_hits", "link_hits", "evidence_pack"]) {
      expect(data.display, `display leaked ${term}`).not.toContain(term);
      expect(JSON.stringify(data.summary), `summary leaked ${term}`).not.toContain(term);
    }
  });
});
