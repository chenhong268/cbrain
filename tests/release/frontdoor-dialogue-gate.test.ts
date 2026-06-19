/**
 * Front-door dialogue acceptance gate (#200).
 *
 * Product-level acceptance for the `cbrain_recall` natural-language front door (#199):
 *   - ordinary natural-language recall must NOT route to the low-level `query` tool,
 *   - each dialogue family lands on the expected capability,
 *   - first-round user-facing output (display + summary) never leaks internal fields,
 *   - only an explicit debug wording may route to `query`,
 *   - every fixture is anonymous — no real names, orgs, products, or vault paths.
 *
 * In-process: reuses the mock-deps pattern from tests/mcp/frontdoor.test.ts.
 * Does not exercise a real LLM — agentic routes degrade gracefully (status: degraded),
 * which is itself part of the acceptance contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createServer, type CBrainDeps } from "../../src/mcp/server.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

// ─── Mock deps (deterministic, no network, no real LLM) ──────────────────────

function createMockEmbedding(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed: async (text: string) => ({
      embedding: new Array(128).fill(0).map((_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) ?? 0) / 65536),
      tokenCount: text.length,
    }),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => ({
        embedding: new Array(128).fill(0).map((_, i) => (t.charCodeAt(i % Math.max(t.length, 1)) ?? 0) / 65536),
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

function getTools(server: unknown): Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> {
  return (server as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
}

function seedPage(db: CBrainDB, vaultPath: string, slug: string, title: string, type: string): void {
  db.upsertPage({ slug, type, title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
  const dir = join(vaultPath, ...slug.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${title}"\ntype: ${type}\nslug: ${slug}\n---\n`);
}

// ─── Acceptance contract ─────────────────────────────────────────────────────

/** Internal fields / debug words that must never appear in display or summary. */
const FORBIDDEN_VISIBLE_TERMS = [
  "raw",
  "routing",
  "slug",
  "score",
  "trace",
  "reason_codes",
  "source_id",
  "vector",
  "FTS",
];

const ALLOWED_STATUSES = ["ok", "empty", "degraded", "error", "recorded", "skipped", "needs_review"];

/** Real-world identifiers banned from every fixture (privacy). */
const REAL_WORLD_PATTERNS = [
  /张三|李四|王磊|王五|赵六/u,
  /有限公司|股份|集团|公司/u,
  /1[3-9]\d{9}/u, // phone
  /[a-z]+@[a-z]+\.(com|cn|org)/u, // email
];

interface Scenario {
  id: string;
  query: string;
  chosenRoute: string;
  nextTool: string;
  detail?: "brief" | "normal" | "full";
  /** Hierarchy route needs a seed entity to build an org tree. */
  needsHierarchySeed?: boolean;
}

/**
 * Ten anonymous natural-language scenarios. Route expectations are pinned to the
 * router's actual signal matching (see tests/core/frontdoor-router.test.ts), not
 * wishful issue prose — e.g. "有没有遗漏" would hit grounded_recall, so the gap
 * scenario uses "帮我判断...盲区" to land on reasoning as intended.
 */
const SCENARIOS: Scenario[] = [
  { id: "grounded-check", query: "主题A之前讨论过吗", chosenRoute: "grounded_recall", nextTool: "deep_recall" },
  { id: "content-design", query: "之前项目B当时怎么设计的，为什么选这个方向", chosenRoute: "content_recall", nextTool: "deep_recall" },
  { id: "episodic-person", query: "想不起名字了，去年活动C上分享主题D的那个人是谁", chosenRoute: "episodic_recall", nextTool: "recall_episode" },
  { id: "hierarchy-org", query: "实体A的下属和汇报线是什么", chosenRoute: "hierarchy", nextTool: "get_org_tree", needsHierarchySeed: true },
  { id: "relationship", query: "实体A和实体B是什么关系", chosenRoute: "relationship", nextTool: "agentic_research" },
  { id: "overview", query: "帮我总结一下主题E的全貌", chosenRoute: "overview", nextTool: "summarize" },
  { id: "reasoning-gap", query: "帮我判断这个方案有没有盲区", chosenRoute: "reasoning", nextTool: "agentic_research" },
  { id: "debug-keyword", query: "debug 一下关键词F在哪些页面出现", chosenRoute: "debug_search", nextTool: "query" },
  { id: "insufficient", query: "主题G相关内容找不到足够依据", chosenRoute: "content_recall", nextTool: "deep_recall" },
  { id: "expand-evidence", query: "给我展开更多证据", chosenRoute: "content_recall", nextTool: "deep_recall", detail: "normal" },
];

// ─── Gate ────────────────────────────────────────────────────────────────────

describe("front-door dialogue acceptance gate (#200)", () => {
  const testDir = "/tmp/cbrain-test-frontdoor-gate";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let deps: CBrainDeps;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    deps = {
      db,
      embedding: createMockEmbedding(),
      lance: createMockLanceDB() as unknown as CBrainDeps["lance"],
      vaultPath,
      runtimePath: join(testDir, "runtime"),
    };
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("gate covers at least 10 anonymous natural-language scenarios", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    // Every scenario id is unique
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const s of SCENARIOS) {
    test(`${s.id}: routes to ${s.chosenRoute} / ${s.nextTool} with clean output`, async () => {
      if (s.needsHierarchySeed) {
        seedPage(db, vaultPath, "entities/entity-a", "实体A", "entity/person");
        seedPage(db, vaultPath, "entities/entity-b", "实体B", "entity/person");
        db.rawDb
          .prepare(`INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state) VALUES (?, ?, ?, ?, ?)`)
          .run("entities/entity-b", "entities/entity-a", "reports_to", "agent", "candidate");
      }

      const server = createServer(deps);
      const result = await getTools(server).cbrain_recall.handler({
        query: s.query,
        ...(s.detail ? { detail: s.detail } : {}),
      });
      const data = JSON.parse(result.content[0].text);

      // 1. Routing matches the scenario expectation.
      expect(data.raw.routing.chosen_route).toBe(s.chosenRoute);
      expect(data.raw.routing.next_tool).toBe(s.nextTool);

      // 2. summary.status is one of the allowed envelope values.
      expect(ALLOWED_STATUSES).toContain(data.summary.status);

      // 3. display is a short, user-facing string.
      expect(typeof data.display).toBe("string");
      expect(data.display.length).toBeLessThan(500);

      // 4. display + summary never leak internal/debug fields.
      const visible = `${data.display}\n${JSON.stringify(data.summary)}`;
      for (const term of FORBIDDEN_VISIBLE_TERMS) {
        expect(visible).not.toContain(term);
      }

      // 5. Routing diagnostics stay inside raw, never reach the visible layers.
      expect(data.display).not.toMatch(/chosen_route|next_tool|matched_signals|rejected_routes/);
    });
  }

  test("only explicit debug wording routes to query (every other scenario does not)", () => {
    // Asserted per-scenario above; this is the global contract restatement.
    const queryRouted = SCENARIOS.filter((s) => s.nextTool === "query");
    expect(queryRouted.length).toBe(1);
    expect(queryRouted[0].chosenRoute).toBe("debug_search");
  });

  test("every fixture is anonymous — no real-world identifiers", () => {
    const corpus = SCENARIOS.map((s) => s.query).join("\n");
    for (const pattern of REAL_WORLD_PATTERNS) {
      expect(corpus).not.toMatch(pattern);
    }
    // Anonymous placeholders are in use.
    expect(corpus).toMatch(/实体|主题|活动|项目|关键词/);
  });

  test("graceful insufficient: no evidence does not surface low-level error detail", async () => {
    // Empty mock vault → content recall finds nothing → graceful empty, not a crash.
    const server = createServer(deps);
    const result = await getTools(server).cbrain_recall.handler({ query: "主题G相关内容找不到足够依据" });
    const data = JSON.parse(result.content[0].text);

    expect(["empty", "degraded", "ok"]).toContain(data.summary.status);
    expect(data.display.length).toBeLessThan(500);
    const visible = `${data.display}\n${JSON.stringify(data.summary)}`;
    for (const term of [...FORBIDDEN_VISIBLE_TERMS, "error", "undefined", "NaN"]) {
      expect(visible).not.toContain(term);
    }
  });
});
