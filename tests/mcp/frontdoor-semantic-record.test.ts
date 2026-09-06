import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";
import { buildContext, indexPage, type ToolContext } from "../../src/mcp/context.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import type { EmbeddingProvider } from "../../src/embedding/provider.js";

const QUERY = "我最近在区域C参加了什么会议？";
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
// The external semantic provider supplies no similarity; SQL, FTS, vault and
// frontdoor remain real. This catches fallback gaps hidden by strong vectors.
const embedding: EmbeddingProvider = {
  dimensions: 2048,
  async embed(text) { return (await this.embedBatch([text]))[0]!; },
  async embedBatch(texts) {
    return texts.map(text => ({ embedding: Array.from({ length: 2048 }, (_, i) => i === (text.includes("\n") ? 0 : 1) ? 1 : 0), tokenCount: 1 }));
  },
};
type Envelope = { display: string; summary: { status: string; count: number }; raw: { entities: Array<{ title: string; snippet: string }> } };
let root: string, db: CBrainDB, ctx: ToolContext;
let recall: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
beforeEach(async () => {
  root = mkdtempSync("/tmp/cbrain-semantic-record-");
  db = new CBrainDB(join(root, "brain.sqlite"));
  const lance = new LanceDBManager();
  await lance.connect(join(root, "lance"));
  ctx = buildContext({ db, lance, embedding, vaultPath: join(root, "vault"), runtimePath: join(root, "runtime"), nerIngestMode: "off", llm: { name: "search-fixture", async chat(messages, options) { return ctx.llm!.chat(messages, options); } } });
  const self = ctx.pages.create({ title: "实体A", type: "entity/person", body: "本人身份" });
  ctx.identityPersonSlug = self.slug;
  registerFrontdoorTools({ registerTool(_name: string, _def: unknown, handler: typeof recall) { recall = handler; } } as unknown as McpServer, ctx);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
async function record(body: string, title = "主题D会议记录", type = "record") {
  const page = ctx.pages.create({ title, type, body });
  expect((await indexPage(ctx.pipeline, page.slug, body)).ok).toBe(true);
  expect(db.getChunksByPage(page.slug).length).toBeGreaterThan(0);
  return page;
}
async function ask(query = QUERY): Promise<Envelope> {
  return JSON.parse((await recall({ query, detail: "brief" })).content[0]!.text);
}

describe("#424 semantic personal record recall", () => {
  for (const [query, body, quote] of [
    ["最近在看哪些书", `# 《主题D》阅读笔记\n阅读状态：在读\n${day(-2)} 实体A的读书笔记。`, "阅读状态：在读"],
    ["最近拜访了谁", `# 访问记录\n${day(-2)} 实体A到访实体B，商谈主题D。`, "实体A到访实体B，商谈主题D。"],
    ["近期参加过哪些活动", `# 活动记录\n${day(-2)} 实体A出席主题D研讨会。`, "实体A出席主题D研讨会。"],
    ["我最近学了什么", `# 学习记录\n${day(-2)} 实体A完成主题D课程。`, "实体A完成主题D课程。"],
  ]) test(`recovers ${query} from actual indexes with verbatim evidence`, async () => {
    await record(body!, "主题D记录");
    expect(db.ftsSearch(query!, 5)).toEqual([]);
    let calls = 0;
    ctx.llm = { name: "fixture", async chat(messages) {
      calls++;
      const data = JSON.parse(messages.at(-1)!.content);
      if (!data.records) return "[]";
      const page = data.records.find((r: { lines: Array<{ text: string }> }) => r.lines.some(line => line.text.includes(quote!)));
      return JSON.stringify({ matches: [{ id: page.id, evidence_lines: [page.lines.find((line: { text: string }) => line.text.includes(quote!)).line] }] });
    }};
    const result = await ask(query!);
    expect(result.raw.entities.map(e => e.title)).toEqual(["主题D记录"]);
    expect(result.raw.entities[0]!.snippet).toContain(quote!);
    expect(calls).toBe(1);
  });

  for (const [name, response] of [
    ["invented source line", { matches: [{ id: 0, evidence_lines: [999] }] }],
    ["unknown ID", { matches: [{ id: 99, evidence_lines: [0] }] }],
    ["no relevance", { matches: [] }],
    ["malformed response", { books: ["主题D"] }],
  ]) test(`does not admit ${name}`, async () => {
    await record(`# 《主题D》笔记\n阅读状态：在读\n${day(-2)} 实体A的记录。`);
    ctx.llm = { name: "fixture", async chat() { return JSON.stringify(response); }};
    expect((await ask("最近在看哪些书")).raw.entities).toEqual([]);
  });

  test("does not claim no memories when verification fails", async () => {
    await record(`# 《主题D》笔记\n阅读状态：在读\n${day(-2)} 实体A的记录。`);
    ctx.llm = { name: "fixture", async chat() { throw new Error("provider failure"); }};
    const result = await ask("最近在看哪些书");
    expect(result.summary.status).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain("暂时没找到相关记忆");
    expect(JSON.stringify(result)).not.toContain("换关键词");
    expect(result.raw.entities).toEqual([]);
  });

  test("includes later status corrections instead of truncating the record", async () => {
    const correction = "更新：实体A已经停止阅读，之前的在读状态失效。";
    await record(`阅读状态：在读\n${"背景内容。".repeat(140)}\n${correction}`);
    ctx.llm = { name: "fixture", async chat(messages) {
      const data = JSON.parse(messages.at(-1)!.content);
      expect(data.records[0].lines.some((line: { text: string }) => line.text === correction)).toBe(true);
      return '{"matches":[]}';
    }};
    expect((await ask("最近在看哪些书")).raw.entities).toEqual([]);
  });

  test("over-budget sources produce incomplete evidence rather than fabricated absence", async () => {
    await record(`阅读状态：在读\n${"背景内容。".repeat(700)}\n已停止阅读。`);
    let calls = 0;
    ctx.llm = { name: "fixture", async chat() { calls++; return '{"matches":[]}'; }};
    const result = await ask("最近在看哪些书");
    expect(result.summary.status).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain("暂时没找到相关记忆");
    expect(calls).toBe(0);
  });

  test("verification has a bounded timeout", async () => {
    await record("阅读状态：在读\n实体A的阅读笔记。");
    ctx.llm = { name: "fixture", async chat() { return new Promise<string>(() => {}); }};
    const start = Date.now();
    const result = await ask("最近在看哪些书");
    expect(result.summary.status).toBe("degraded");
    expect(Date.now() - start).toBeLessThan(6000);
  }, 7000);

  test("direct title recall needs no verification call", async () => {
    await record(`# 主题D记录\n${day(-2)} 实体A的阅读笔记。`, "主题D记录");
    let calls = 0;
    ctx.llm = { name: "fixture", async chat() { calls++; return "{}"; }};
    expect((await ask("主题D记录")).raw.entities).toHaveLength(1);
    expect(calls).toBe(0);
  });
});
