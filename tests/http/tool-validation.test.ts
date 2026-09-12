import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../../src/http/server.js";
import { buildContext, type ToolContext } from "../../src/mcp/context.js";
import { DeterministicEmbeddingProvider } from "../../src/embedding/deterministic.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager } from "../../src/storage/lancedb.js";

describe("REST tool input validation (#449)", () => {
  let root: string;
  let ctx: ToolContext;
  let http: ReturnType<ReturnType<typeof createHttpServer>["start"]>;
  let client: Client;
  let eventId: number;
  let slug: string;
  const excerpt = "这是一条用于验证确认来源的匿名资料内容。";
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "cbrain-rest-validation-"));
    mkdirSync(join(root, "vault"));
    ctx = buildContext({ db: new CBrainDB(join(root, "brain.sqlite")), vaultPath: join(root, "vault"),
      runtimePath: join(root, "runtime"), embedding: new DeterministicEmbeddingProvider(), lance: new LanceDBManager() });
    slug = ctx.pages.create({ title: "记录A", type: "record", body: excerpt }).slug;
    eventId = ctx.db.addTimelineEntry(slug, "事件A");
    http = createHttpServer(ctx).start(0);
    client = new Client({ name: "fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)));
  });
  afterEach(async () => {
    await client.close();
    http.stop(true);
    ctx.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function rest(name: string, args: unknown) {
    return fetch(`http://127.0.0.1:${http.port}/tools/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
  }
  for (const variant of ["trusted", "missing-reason", "long-reason"] as const) {
    test(`legacy tool rejects ${variant} without trust/history mutation on both transports`, async () => {
      const args: Record<string, unknown> = { target_type: "timeline", target_id: eventId, new_state: "rejected", reason: "纠正" };
      if (variant === "trusted") args.new_state = "trusted";
      if (variant === "missing-reason") delete args.reason;
      if (variant === "long-reason") args.reason = "A".repeat(2001);
      const before = ctx.provenance.getTimelineProvenance(eventId);
      const history = ctx.provenance.getCorrectionHistory("timeline", eventId);
      const response = await rest("set_trust_state", args);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("Validation failed");
      const mcp = await client.callTool({ name: "set_trust_state", arguments: args });
      expect(mcp.isError).toBe(true);
      expect(ctx.provenance.getTimelineProvenance(eventId)).toEqual(before);
      expect(ctx.provenance.getCorrectionHistory("timeline", eventId)).toEqual(history);
    });
  }
  test("registerTool raw shape rejects missing and oversized write arguments", async () => {
    const before = ctx.pages.getBySlug(slug)!.body;
    for (const args of [{ slug }, { slug, content: "A".repeat(500001) }, { slug, content: "变更", mode: "invalid" }]) {
      expect((await rest("put_page", args)).status).toBe(400);
      expect((await client.callTool({ name: "put_page", arguments: args })).isError).toBe(true);
      expect(ctx.pages.getBySlug(slug)!.body).toBe(before);
    }
  });
  test("legacy defaults reach the handler and match MCP confirmation semantics", async () => {
    const args = { target_type: "timeline", target_id: eventId, confirmation_record_slug: slug, excerpt };
    expect((await rest("confirm_evidence", args)).status).toBe(200);
    expect(ctx.provenance.getTimelineProvenance(eventId)?.provenance.trust_state).toBe("trusted");
    const secondId = ctx.db.addTimelineEntry(slug, "事件B");
    expect((await client.callTool({ name: "confirm_evidence", arguments: { ...args, target_id: secondId } })).isError).not.toBe(true);
    expect(ctx.provenance.getTimelineProvenance(secondId)?.provenance.trust_state).toBe("trusted");
  });
});
