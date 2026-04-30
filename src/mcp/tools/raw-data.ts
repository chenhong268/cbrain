import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerRawDataTools(server: McpServer, ctx: ToolContext): void {
  // ─── put_raw_data ───────────────────────────────────────────
  server.registerTool("put_raw_data", {
    description: "Store raw binary data (base64-encoded) attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key (unique per page)"),
      data_base64: z.string().describe("Base64-encoded binary data"),
      mime_type: z.string().optional().describe("MIME type, defaults to application/octet-stream"),
    },
  }, async ({ slug, key, data_base64, mime_type }) => {
    ctx.db.putRawData(slug, key, Buffer.from(data_base64, "base64"), mime_type);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, slug, key }) }],
    };
  });

  // ─── get_raw_data ───────────────────────────────────────────
  server.registerTool("get_raw_data", {
    description: "Retrieve raw data attached to a page. Returns base64-encoded data.",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key"),
    },
  }, async ({ slug, key }) => {
    const row = ctx.db.getRawData(slug, key);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Raw data not found" }) }] };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          slug,
          key,
          mime_type: row.mime_type,
          data_base64: Buffer.from(row.data).toString("base64"),
          created_at: row.created_at,
        }),
      }],
    };
  });

  // ─── list_raw_data ──────────────────────────────────────────
  server.registerTool("list_raw_data", {
    description: "List all raw data keys attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
    },
  }, async ({ slug }) => {
    const keys = ctx.db.listRawDataKeys(slug);
    return {
      content: [{ type: "text", text: JSON.stringify(keys) }],
    };
  });

  // ─── delete_raw_data ────────────────────────────────────────
  server.registerTool("delete_raw_data", {
    description: "Delete raw data attached to a page",
    inputSchema: {
      slug: z.string().describe("Page slug"),
      key: z.string().describe("Data key"),
    },
  }, async ({ slug, key }) => {
    const ok = ctx.db.deleteRawData(slug, key);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, slug, key }) }],
    };
  });
}
