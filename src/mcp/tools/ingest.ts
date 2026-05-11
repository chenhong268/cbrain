import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DialogueIngest } from "../../core/dialogue.js";

export function registerIngestTools(server: McpServer, ctx: ToolContext): void {
  // ─── ingest ──────────────────────────────────────────────
  server.registerTool("ingest", {
    description: "Ingest content into the brain. Supports markdown (with frontmatter) and plain text. IMPORTANT: always provide title and pageType.",
    inputSchema: {
      content: z.string().describe("Content to ingest"),
      type: z.enum(["markdown", "text"]).optional().default("text").describe("Content type"),
      title: z.string().optional().describe("Title for this page — derive from content if not obvious"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
      pageType: z.enum(["entity", "concept", "record", "insight", "raw"]).optional().default("record").describe("Page type: entity (person/company), concept, record (doc/report), insight, raw (original material)"),
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
    description: "Ingest a dialogue/conversation into the brain. Extracts new entities, relations, and events via LLM, skipping already-known knowledge. Use for capturing key facts from conversations.",
    inputSchema: {
      text: z.string().describe("Dialogue text to ingest (conversation content)"),
    },
  }, async ({ text }) => {
    const dialogue = new DialogueIngest(ctx.db, ctx.embedding, ctx.lance, ctx.vaultPath, ctx.llm);
    const result = await dialogue.ingest(text);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });
}
