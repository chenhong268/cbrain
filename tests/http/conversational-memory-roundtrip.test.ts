import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { createHttpServer } from "../../src/http/server.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

const TITLE = "主题D审核记录";
const ORIGINAL = "主题D的审核口令为 amberfixture。需要两位独立审核者共同确认。审核完成后，由记录员归档确认时间与审核编号。此记录用于核对当前口令和审核要求，资料不足时应补充核实，不能自行推断或省略审批步骤。";
const CORRECTED = "主题D的审核口令为 violetfixture。需要三位独立审核者共同确认。审核完成后，由记录员归档确认时间与审核编号。此记录用于核对当前口令和审核要求，资料不足时应补充核实，不能自行推断或省略审批步骤。";
let root: string;
let ctx: ToolContext;
let server: ReturnType<ReturnType<typeof createHttpServer>["start"]>;
let client: Client;

async function start(outputMode: "legacy" | "structured" = "legacy") {
  const lance = new LanceDBManager();
  await lance.connect(join(root, "lance"));
  ctx = buildContext({ db: new CBrainDB(join(root, "brain.sqlite")), lance,
    embedding: new DeterministicEmbeddingProvider(), vaultPath: join(root, "vault"),
    runtimePath: join(root, "runtime"), nerIngestMode: "off" });
  server = createHttpServer({ ...ctx, outputMode }).start(0);
  client = new Client({ name: "anonymous-acceptance", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
}
async function stop() {
  await client?.close();
  server?.stop(true);
  await ctx?.lance.close();
  ctx?.db.close();
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
}
afterEach(async () => { await stop(); if (root) rmSync(root, { recursive: true, force: true }); });

describe("conversational memory through real HTTP/MCP and persistent indexes", () => {
  test("structured exact-title recall retains bounded source evidence at every detail level", async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-title-evidence-"));
    await start("structured");
    await call("ingest", { title: TITLE, content: CORRECTED + "补充资料。".repeat(100) + "END-OF-BODY", pageType: "record", skipNer: true });
    for (const detail of ["brief", "normal", "full"]) {
      const result = await client.callTool({ name: "cbrain_recall", arguments: { query: TITLE, detail } });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { data: { details: { entities: Array<{ title: string; snippet: string }> } } };
      const evidence = structured.data.details.entities.find(entity => entity.title === TITLE);
      expect(evidence?.snippet).toContain("需要三位独立审核者共同确认");
      expect(evidence!.snippet.length).toBeLessThanOrEqual(200);
      const visible = JSON.stringify(structured.data);
      expect(visible).not.toContain("END-OF-BODY");
      expect(visible).not.toContain('"body":');
      expect(visible).not.toContain('"slug":');
      expect(visible).not.toContain('"raw_chunks":');
    }
  });

  test("correction replaces recall evidence and survives a service restart", async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-memory-roundtrip-"));
    await start();
    const ingested = await call("ingest", { title: TITLE, content: ORIGINAL, pageType: "record", skipNer: true });
    expect(ingested.summary.status).toBe("recorded");
    const slug = ingested.raw.slug;
    const first = await call("cbrain_recall", { query: TITLE, detail: "normal" });
    expect(first.summary.status).toBe("ok");
    expect(JSON.stringify(first.raw.entities)).toContain("amberfixture");
    await call("put_page", { slug, mode: "replace", content: CORRECTED });
    // Reopening storage ensures the answer is durable, not merely an in-memory view.
    await stop();
    await start();
    const recalled = await call("cbrain_recall", { query: TITLE, detail: "normal" });
    expect(recalled.summary.status).toBe("ok");
    const evidence = recalled.raw.entities.find((entity: { title: string }) => entity.title === TITLE);
    expect(evidence).toBeDefined();
    expect(JSON.stringify(evidence)).toContain("violetfixture");
    expect(JSON.stringify(evidence)).not.toContain("amberfixture");
    expect(ctx.pages.getBySlug(slug)?.body).toBe(CORRECTED);
    expect(ctx.db.getFtsContentsByPage(slug).join("\n")).not.toContain("amberfixture");
    expect(ctx.db.ftsSearch("violetfixture", 5).map(row => row.page_slug)).toContain(slug);
    const vectors = await ctx.lance.readRawVectorRows(slug);
    expect(vectors.some(row => row.content.includes("violetfixture"))).toBe(true);
    expect(vectors.some(row => row.content.includes("amberfixture"))).toBe(false);
    expect(ctx.versions.getVersions(slug).length).toBeGreaterThan(0);
  });
});
