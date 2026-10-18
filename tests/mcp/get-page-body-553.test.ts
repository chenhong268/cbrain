import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { attachMcpTools } from "../../src/mcp/server.js";
import { TopicManager } from "../../src/core/topics/manager.js";

/**
 * #553 Candidate C regression — get_page returns the string body exactly
 * once (inside `raw.body`); the top-level `body` key is omitted when it is a
 * string (empty string included) and preserved as `null` when null. All other
 * fields keep their exact old shape. Verified through the real MCP path
 * (SDK Client + InMemoryTransport + attachMcpTools), never through handler
 * mocks. Anonymous fixtures only; temp resources under /private/tmp.
 */

const TOPIC_SENTINEL = "TOPIC_BODY_SENTINEL_A"; // old topic body — must not leak once stale
const UNIT = "主题D需要定期回顾行动进度。";
// ≥30,000 chars: large enough that a duplicated body dominates response bytes
const longBody = Array.from({ length: 1500 }, (_, i) => `第${i}段：${UNIT}`).join("\n");

const B = (s: string): number => Buffer.byteLength(s, "utf8");

describe("get_page single body copy (#553 candidate C)", () => {
  let root: string;
  let db: CBrainDB;
  let lance: LanceDBManager;
  let ctx: ToolContext;
  let manager: TopicManager;
  let legacy: Client;
  let structured: Client;
  let servers: McpServer[];
  let longSlug: string;
  let longFile: string;
  let emptySlug: string;   // page created with body:"" → file holds frontmatter only
  let zeroSlug: string;    // file truncated to true 0 bytes
  let missingSlug: string; // file deleted
  let topic: string;
  let sourcePath0: string;
  let savedEnv: Record<string, string | undefined>;

  const mkPair = async (mode: string): Promise<Client> => {
    const prev = process.env.CBRAIN_OUTPUT_BOUNDARY;
    process.env.CBRAIN_OUTPUT_BOUNDARY = mode;
    try {
      const server = new McpServer({ name: "cbrain-553-impl", version: "0.0.0" });
      attachMcpTools(server, ctx);
      servers.push(server);
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "cbrain-553-impl-probe", version: "0.0.0" });
      await client.connect(clientSide);
      return client;
    } finally {
      // R2: restore the caller's value exactly — undefined included
      if (prev === undefined) delete process.env.CBRAIN_OUTPUT_BOUNDARY;
      else process.env.CBRAIN_OUTPUT_BOUNDARY = prev;
    }
  };

  const getPage = async (client: Client, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; text: string }> => {
    const res = (await client.callTool({ name: "get_page", arguments: args })) as { content: Array<{ type: string; text: string }> };
    const item = res.content.find((c) => c.type === "text");
    if (!item) throw new Error("get_page returned no text content");
    return { data: JSON.parse(item.text) as Record<string, unknown>, text: item.text };
  };

  const rawOf = (data: Record<string, unknown>): Record<string, unknown> => data.raw as Record<string, unknown>;

  beforeAll(async () => {
    savedEnv = { CBRAIN_OUTPUT_BOUNDARY: process.env.CBRAIN_OUTPUT_BOUNDARY };
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "MOONSHOT_API_KEY", "ZHIPU_API_KEY", "XAI_API_KEY", "GROQ_API_KEY"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    root = mkdtempSync("/private/tmp/cbrain-553-impl-");
    const vaultPath = join(root, "vault");
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(join(root, "brain.sqlite"));
    lance = new LanceDBManager();
    await lance.connect(join(root, "lance"));
    const llm = {
      name: "anonymous-553-fixture",
      chat: async () => JSON.stringify({
        overview: [{ text: TOPIC_SENTINEL, kind: "observation", sourceSlug: sourceSlugs[0] ?? "s0", quote: UNIT }],
        observations: [{ text: TOPIC_SENTINEL, kind: "observation", sourceSlug: sourceSlugs[1] ?? "s1", quote: UNIT }],
        details: [],
        open_questions: [],
      }),
    };
    const sourceSlugs: string[] = [];
    ctx = buildContext({ db, lance, embedding: new DeterministicEmbeddingProvider(), vaultPath, runtimePath: join(root, "runtime"), llm });
    const mk = (title: string, body: string): { slug: string; file: string } => {
      const page = ctx.pages.create({ title, type: "record", body });
      return { slug: page.slug, file: join(vaultPath, db.getPageFilePath(page.slug)!) };
    };
    const long = mk("记录B", longBody);
    longSlug = long.slug;
    longFile = long.file;
    emptySlug = mk("空页C", "").slug;
    const zero = mk("缺失D占位", "占位正文");
    writeFileSync(zero.file, ""); // true zero-byte file
    zeroSlug = zero.slug;
    const missing = mk("缺失D", "正文将在随后删除。");
    missingSlug = missing.slug;
    unlinkSync(missing.file); // file present in DB, absent on disk
    // verified-current topic: 3 sources, deterministic LLM fixture
    const sources = sourceSlugs;
    const bodies = [`原始材料0：${UNIT}`, `原始材料1：${UNIT}`, `原始材料2：${UNIT}`];
    for (let i = 0; i < 3; i++) {
      const page = ctx.pages.create({ title: `材料${i}`, type: "record", body: bodies[i] });
      sources.push(page.slug);
      const prepared = await ctx.pipeline.embed(bodies[i]);
      await ctx.pipeline.writeIndexes(page.slug, prepared.chunks, prepared.embedResults);
    }
    sourcePath0 = join(vaultPath, db.getPageFilePath(sources[0])!);
    manager = new TopicManager({ db, lance, pages: ctx.pages, pipeline: ctx.pipeline, versions: ctx.versions, llm });
    expect((await manager.compile({ title: "主题D", sourceSlugs: sources })).status).toBe("created");
    topic = manager.resolveTopicSlug("主题D");
    servers = [];
    legacy = await mkPair("legacy");
    structured = await mkPair("structured");
  });

  afterAll(async () => {
    // close this file's own clients/servers before shared resources
    await legacy.close();
    await structured.close();
    for (const s of servers) await s.close();
    // R2: restore every saved key to its exact original value (undefined → absent)
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // R2 canary: a real run with an injected initial value observes full restoration
    expect(process.env.CBRAIN_OUTPUT_BOUNDARY).toBe(savedEnv.CBRAIN_OUTPUT_BOUNDARY);
    ctx.jobs.stop();
    await lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // ── full page ≥30,000 chars: body serialized once, metadata intact ────
  test("long full body: ≥30,000 chars asserted; no top-level body key; raw.body exact; every db row field matches on both levels", async () => {
    expect(longBody.length).toBeGreaterThanOrEqual(30_000);
    const file = readFileSync(longFile, "utf-8");
    const { data } = await getPage(legacy, { slug: longSlug, include_full_body: true });
    expect("body" in data).toBe(false);
    const raw = rawOf(data);
    expect(raw.body).toBe(file);
    expect(data.slug).toBe(longSlug);
    expect(data.title).toBe("记录B");
    expect(data.type).toBe("record");
    expect(data.body_length).toBe(file.length);
    expect(data.has_more).toBe(false);
    expect(typeof data.display).toBe("string");
    expect(data.summary).toBeDefined();
    // enumerate every db.getPage() row field and compare against actual values,
    // on the top level (minus the sanctioned body omission) and inside raw
    const row = db.getPage(longSlug)!;
    for (const [k, v] of Object.entries(row)) {
      expect(data[k]).toBe(v);
      expect(raw[k]).toBe(v);
    }
  });

  test("long full body: long string transmitted once (size bound rejects duplicated body)", async () => {
    const file = readFileSync(longFile, "utf-8");
    const { text, data } = await getPage(legacy, { slug: longSlug, include_full_body: true });
    // single-copy responses land ≈1.04× body bytes (same anonymous page measured
    // pre-fix at 2.06×: two serializations); 1.5× accepts one copy, rejects two
    const bodyBytes = B(rawOf(data).body as string);
    expect(bodyBytes).toBe(B(file));
    expect(B(text)).toBeLessThanOrEqual(1.5 * bodyBytes);
  });

  // ── default truncation: original 1500-char + "..." behavior unchanged ──
  test("default truncation: raw.body keeps 1500 chars + suffix, flags unchanged", async () => {
    const file = readFileSync(longFile, "utf-8");
    const { data } = await getPage(legacy, { slug: longSlug });
    expect("body" in data).toBe(false);
    expect(rawOf(data).body).toBe(file.slice(0, 1500) + "...");
    expect(data.body_length).toBe(file.length);
    expect(data.has_more).toBe(true);
    expect((data.summary as Record<string, unknown>).truncated).toBe(true);
  });

  // ── string body edge states ───────────────────────────────────────────
  test("true zero-byte file: raw.body is empty string, top-level key absent", async () => {
    const { data } = await getPage(legacy, { slug: zeroSlug });
    expect("body" in data).toBe(false);
    expect(rawOf(data).body).toBe("");
    expect(data.body_length).toBe(0);
    expect(data.has_more).toBe(false);
  });

  test("frontmatter-only page (non-empty string) distinct from zero-byte", async () => {
    const { data } = await getPage(legacy, { slug: emptySlug });
    expect("body" in data).toBe(false);
    const rawBody = rawOf(data).body;
    expect(typeof rawBody).toBe("string");
    expect(rawBody).not.toBe("");
  });

  test("missing file: body and raw.body both null; raw-first fallback still null", async () => {
    const { data } = await getPage(legacy, { slug: missingSlug });
    expect("body" in data).toBe(true);
    expect(data.body).toBeNull();
    expect(rawOf(data).body).toBeNull();
    // the pre-existing consumer pattern raw.body ?? page.body must stay null
    expect(rawOf(data).body ?? data.body).toBeNull();
  });

  test("not-found: error semantics and absent body unchanged", async () => {
    const { data } = await getPage(legacy, { slug: "brain/no-such-page" });
    expect(data.error).toBe("Page not found");
    expect("body" in data).toBe(false);
    expect(typeof data.display).toBe("string");
  });

  // ── verified current topic: single string copy + source metadata ──────
  test("current topic: single body copy, derived_topic and sources kept", async () => {
    const { data, text } = await getPage(legacy, { slug: topic });
    expect("body" in data).toBe(false);
    const rawBody = rawOf(data).body;
    expect(typeof rawBody).toBe("string");
    expect(rawBody as string).toContain(TOPIC_SENTINEL);
    const derived = data.derived_topic as Record<string, unknown>;
    expect(derived.available).toBe(true);
    expect(Array.isArray(derived.sources)).toBe(true);
    expect(typeof derived.generated_at).toBe("string");
    expect(typeof data.display).toBe("string");
    // exactly one serialized copy: total occurrences == occurrences inside raw.body
    const rawBodyText = rawBody as string;
    expect(text.split(TOPIC_SENTINEL).length - 1).toBe(rawBodyText.split(TOPIC_SENTINEL).length - 1);
    expect(rawBodyText.includes(TOPIC_SENTINEL)).toBe(true);
  });

  // ── stale/unavailable topic: null bodies, old body must not leak ───────
  test("stale topic: both bodies null, old sentinel absent, display fixed", async () => {
    ctx.pages.getBySlug(topic); // prime the page cache like production reads
    writeFileSync(sourcePath0, readFileSync(sourcePath0, "utf-8") + "\n用户更正：上述安排已经取消。");
    expect(manager.inspectFreshness(topic)?.state).toBe("stale");
    const { data, text } = await getPage(legacy, { slug: topic });
    expect("body" in data).toBe(true);
    expect(data.body).toBeNull();
    expect(rawOf(data).body).toBeNull();
    expect(text).not.toContain(TOPIC_SENTINEL);
    expect(data.display as string).toContain("暂不可用");
    const derived = data.derived_topic as Record<string, unknown>;
    expect(derived.available).toBe(false);
    expect(typeof derived.reason).toBe("string");
  });

  // ── legacy/structured parity + tools/list contract ─────────────────────
  test("legacy and structured identical for long page and stale topic", async () => {
    const file = readFileSync(longFile, "utf-8");
    const a = await getPage(legacy, { slug: longSlug, include_full_body: true });
    const b = await getPage(structured, { slug: longSlug, include_full_body: true });
    expect(b.text).toBe(a.text);
    expect(rawOf(b.data).body).toBe(file);
    const sa = await getPage(legacy, { slug: topic });
    const sb = await getPage(structured, { slug: topic });
    expect(sb.text).toBe(sa.text);
    expect(sb.data.body).toBeNull();
  });

  test("tools/list: get_page registration contract unchanged across modes", async () => {
    const schemaKeys = (res: { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }) => {
      const tool = res.tools.find((t) => t.name === "get_page");
      expect(tool).toBeDefined();
      expect(tool!.description).toBe("Get a page by slug. Returns frontmatter + body.");
      return JSON.stringify((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    };
    const la = schemaKeys(await legacy.listTools() as never);
    const lb = schemaKeys(await structured.listTools() as never);
    expect(lb).toBe(la);
    expect(la).toContain("slug");
    expect(la).toContain("include_full_body");
  });
});
