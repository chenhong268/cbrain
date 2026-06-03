import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DialogueIngest, DialogueMode } from "../../core/dialogue.js";

export function registerIngestTools(server: McpServer, ctx: ToolContext): void {
  // ─── ingest ──────────────────────────────────────────────
  server.registerTool("ingest", {
    description: "Ingest content into the brain. Supports markdown (with frontmatter) and plain text. IMPORTANT: always provide title and pageType.",
    inputSchema: {
      content: z.string().max(500_000).describe("Content to ingest"),
      type: z.enum(["markdown", "text"]).optional().default("text").describe("Content type"),
      title: z.string().max(500).optional().describe("Title for this page — derive from content if not obvious"),
      tags: z.array(z.string().max(200)).optional().describe("Tags to apply"),
      pageType: z.enum(["record", "insight"]).optional().default("record").describe("Page type: record (doc/report/note) or insight. Entities/concepts are auto-classified via NER."),
      skipNer: z.boolean().optional().default(false).describe("Skip LLM entity extraction — use for simple entries"),
    },
  }, async ({ content, type, title, tags, pageType, skipNer }) => {
    const effectiveTitle = title || content.split("\n").find(l => l.trim())?.trim().slice(0, 50) || "Untitled";
    const result = await ctx.ingest.ingest({ content, type: type ?? "text", title: effectiveTitle, tags, pageType, skipNer });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── ingest_dialogue ───────────────────────────────────────
  server.registerTool("ingest_dialogue", {
    description: "Ingest a dialogue/conversation into the brain. Use mode='auto' for automatic background capture (stricter filtering, only high-confidence facts). Use mode='manual' for explicit user-triggered ingestion.",
    inputSchema: {
      text: z.string().max(500_000).describe("Dialogue text to ingest (conversation content)"),
      mode: z.enum(["auto", "manual"]).optional().default("manual").describe("Ingest mode: auto (background, strict) or manual (user-triggered, normal)"),
      sessionId: z.string().max(200).describe("Session/conversation identifier for provenance tracking (required: channel/thread ID or unique conversation ID)"),
    },
  }, async ({ text, mode, sessionId }) => {
    const dialogue = new DialogueIngest(ctx.db, ctx.embedding, ctx.lance, ctx.vaultPath, ctx.llm, ctx.logger);
    const result = await dialogue.ingest(text, (mode ?? "manual") as DialogueMode, sessionId);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });
}
