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
    return texts.map(text => ({ embedding: Array.from({ length: 2048 }, (_, i) => i === (text.startsWith("我") ? 1 : 0) ? 1 : 0), tokenCount: 1 }));
  },
};
type Envelope = { display: string; summary: { status: string; count: number }; raw: { entities: Array<{ title: string; snippet: string }> } };
let root: string, db: CBrainDB, ctx: ToolContext;
let recall: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
beforeEach(async () => {
  root = mkdtempSync("/tmp/cbrain-recent-meeting-");
  db = new CBrainDB(join(root, "brain.sqlite"));
  const lance = new LanceDBManager();
  await lance.connect(join(root, "lance"));
  ctx = buildContext({ db, lance, embedding, vaultPath: join(root, "vault"), runtimePath: join(root, "runtime"), nerIngestMode: "off" });
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
  return JSON.parse((await recall({ query, detail: "normal" })).content[0]!.text);
}

describe("#424 recent regional meeting recall", () => {
  test("recalls an indexed meeting when the full natural-language FTS query has no hits", async () => {
    const query = "我最近在甲区参加了什么会议？";
    await record(`${day(-2)} 实体A在城市B（属于甲区）出席主题D会议。`);
    expect(db.ftsSearch(query, 5)).toEqual([]);
    const result = await ask(query);
    expect(result.raw.entities.map(e => e.title)).toEqual(["主题D会议记录"]);
    expect(result.summary.status).not.toBe("empty");
    expect(result.raw.entities[0]!.snippet).toContain(day(-2));
  });

  test("supports recent wording and explicit record fields", async () => {
    await record(`日期：${day(-3)}\n地点：城市B（区域C）\n会议：主题D会议\n参会人：实体A、实体B`);
    expect((await ask("我近期在区域C参加了什么会议？")).raw.entities).toHaveLength(1);
  });

  for (const [name, body] of [
    ["another region", () => `${day(-2)} 实体A在区域E参加主题D会议。`],
    ["not a meeting", () => `${day(-2)} 实体A在区域C参加培训。`],
    ["another attendee", () => `${day(-2)} 实体B在区域C参加主题D会议。实体A整理了记录。`],
    ["negated participation", () => `${day(-2)} 实体A未在区域C参加主题D会议。`],
    ["future plan", () => `${day(2)} 实体A计划在区域C参加主题D会议。`],
    ["outside the recent calendar window", () => `${day(-30)} 实体A在区域C参加主题D会议。`],
    ["old event", () => `${day(-400)} 实体A在区域C参加主题D会议。`],
    ["metadata update date", () => `更新时间：${day(-2)}\n实体A在区域C参加主题D会议。`],
    ["explicit absence", () => `${day(-2)} 实体A在区域C参加主题D会议，但实际上没有到场。`],
    ["unconfirmed question", () => `${day(-2)} 实体A在区域C参加主题D会议了吗？`],
    ["metadata borrowed across meetings", () => `会议：主题D会议\n地点：区域C\n参会人：实体A\n\n会议：主题E会议\n日期：${day(-2)}\n地点：区域E\n参会人：实体B`],
    ["indented metadata borrowed across meetings", () => ` 会议：主题D会议\n 地点：区域C\n 参会人：实体A\n\n 会议：主题E会议\n 日期：${day(-2)}\n 地点：区域E\n 参会人：实体B`],
    ["no date", () => "实体A在区域C参加主题D会议。"],
    ["region merely mentioned", () => `${day(-2)} 实体A在城市B参加主题D会议，讨论区域C业务。`],
    ["date borrowed from a different event", () => `${day(-400)} 实体A在区域C参加主题D会议。\n\n${day(-2)} 实体B在区域E参加其他会议。`],
  ] as const) {
    test(`does not rescue ${name}`, async () => {
      await record(body());
      expect((await ask()).raw.entities).toEqual([]);
    });
  }

  test("does not infer city membership without source evidence", async () => {
    await record(`${day(-1)} 实体A在城市B参加主题D会议。`);
    expect((await ask()).raw.entities).toEqual([]);
  });
  test("requires configured identity", async () => {
    await record(`${day(-2)} 实体A在区域C参加主题D会议。`);
    ctx.identityPersonSlug = undefined;
    expect((await ask()).raw.entities).toEqual([]);
  });
  test("does not use an entity page as a meeting record", async () => {
    await record(`${day(-2)} 实体A在区域C参加主题D会议。`, "实体B", "entity/person");
    expect((await ask()).raw.entities).toEqual([]);
  });
  test("returns matching records newest first without borrowing unrelated record evidence", async () => {
    await record(`${day(-12)} 实体A在城市B（区域C）出席主题D会议。`, "主题D较早会议");
    await record(`${day(-2)} 实体A在城市B（区域C）出席主题E会议。`, "主题E较近会议");
    await record(`${day(-1)} 实体B在区域C参加主题F会议。`, "主题F无关会议");
    expect((await ask()).raw.entities.map(e => e.title)).toEqual(["主题E较近会议", "主题D较早会议"]);
  });
  test("keeps an explicitly unknown location out of the rescue", async () => {
    await record(`${day(-2)} 实体A在未知区域参加主题D会议。`);
    expect((await ask("我最近在未知区域参加了什么会议？")).raw.entities).toEqual([]);
  });

  test("includes the oldest day in the recent calendar window", async () => {
    await record(`${day(-29)} 实体A在甲区参加主题D会议。`);
    expect((await ask("我最近在甲区参加了什么会议？")).raw.entities).toHaveLength(1);
  });

  test("caps candidate page reads and respects the normal response limit", async () => {
    for (let i = 0; i < 21; i++) await record(`${day(-2)} 实体A在甲区参加主题D会议。`, `主题D会议记录${i}`);
    expect(db.findRecentMeetingRecordCandidates("甲区")).toHaveLength(20);
    expect((await ask("我最近在甲区参加了什么会议？")).raw.entities).toHaveLength(5);
  });

  test("non-meeting records cannot exhaust the meeting candidate window", async () => {
    const meeting = await record(`${day(-2)} 实体A在甲区参加主题D会议。`, "主题Z会议记录");
    for (let i = 0; i < 20; i++) await record("区域信息：甲区。实体B整理事项。", `主题A资料${i}`);
    expect(db.findRecentMeetingRecordCandidates("甲区")).toContain(meeting.slug);
    expect((await ask("我最近在甲区参加了什么会议？")).raw.entities.map(e => e.title)).toEqual(["主题Z会议记录"]);
  });

  test("keeps the verified source evidence visible after a long introduction", async () => {
    await record(`${"背景材料。".repeat(150)}\n${day(-2)} 实体A在区域C参加主题D会议。`);
    const result = await ask();
    expect(result.raw.entities).toHaveLength(1);
    expect(result.raw.entities[0]!.snippet).toContain(`${day(-2)} 实体A在区域C参加主题D会议。`);
  });

  test("reads meeting metadata separated by Markdown formatting and blank lines", async () => {
    await record(`## 主题D会议\n\n- **日期**：${day(-2)}\n\n- **地点**：城市B（区域C）\n\n- **参会人**：实体A、实体B`);
    expect((await ask()).raw.entities).toHaveLength(1);
  });

});
