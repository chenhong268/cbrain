import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { DialogueIngest, DialogueMode } from "../../core/ingestion/dialogue.js";
import { formatIngestResult, formatDialogueResult } from "./format-result.js";
import { classifyContentType } from "../../core/ingestion/content-classifier.js";

// (#205) MCP ingest does NOT expand @file references (unlike the CLI). A
// standalone @<path> in content is rejected loudly — otherwise Hermes passes
// "见 @vault/x.md" and CBrain silently writes that literal as the body, leaving
// NER to mint shell entities. The CLI `cbrain ingest @file` path is separate
// (src/cli/commands/content.ts) and keeps working.
//
// Matches a standalone @ (start-of-string or after whitespace) followed by a
// path containing "/": covers @/abs/path, @vault/..., @brain/..., "见 @vault/...".
// Does NOT match test@example.com (@ mid-token) or @username (no separator).
const FILE_REFERENCE_RE = /(^|\s)@[^\s@]*\//;
export const MCP_INGEST_PAGE_TYPES = ["record", "insight"] as const;

function assertNoFileReference(content: string): void {
  if (FILE_REFERENCE_RE.test(content)) {
    throw new Error(
      "VALIDATION_ERROR: MCP ingest does not accept @file references. Read the file first and pass the full content.",
    );
  }
}

export function registerIngestTools(server: McpServer, ctx: ToolContext): void {
  // ─── ingest ──────────────────────────────────────────────
  server.registerTool("ingest", {
    description: "Ingest content into the brain. Supports markdown (with frontmatter) and plain text. IMPORTANT: always provide title and pageType.",
    inputSchema: {
      content: z.string().max(500_000).describe("Content to ingest"),
      type: z.enum(["markdown", "text"]).optional().describe("Content type (auto-detected from frontmatter if omitted)"),
      title: z.string().max(500).optional().describe("Title for this page — derive from content if not obvious"),
      tags: z.array(z.string().max(200)).optional().describe("Tags to apply"),
      pageType: z.enum(MCP_INGEST_PAGE_TYPES).optional().default("record").describe("Page type: record (doc/report/note) or insight. Entities/concepts are auto-classified via NER."),
      skipNer: z.boolean().optional().default(false).describe("Skip LLM entity extraction — use for simple entries"),
      allowDuplicate: z.boolean().optional().default(false).describe("允许重复内容（正常会被去重跳过）"),
      nerMode: z.enum(["sync", "defer", "off"]).optional().describe("覆盖 NER 模式（默认走 config/env）。一般无需设置。"),
    },
  }, async ({ content, type, title, tags, pageType, skipNer, allowDuplicate, nerMode }) => {
    assertNoFileReference(content); // (#205) reject @file refs — MCP never reads local files
    const classifiedType = classifyContentType(content, type);
    const result = await ctx.ingest.ingest({ content, type: classifiedType, title, tags, pageType, skipNer, allowDuplicate, nerMode, writer: { actorClass: "agent" } });

    // Use actual page title from DB for display; fall back to caller title, then slug
    const page = result.slug ? ctx.db.getPage(result.slug) : null;
    const displayTitle = page?.title ?? title ?? result.slug.split("/").pop() ?? "已存入内容";

    return {
      content: [{ type: "text", text: JSON.stringify(formatIngestResult(result, displayTitle), null, 2) }],
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
    const dialogue = new DialogueIngest(ctx.db, ctx.embedding, ctx.lance, ctx.vaultPath, ctx.llm, ctx.logger, ctx.pages);
    const result = await dialogue.ingest(text, (mode ?? "manual") as DialogueMode, sessionId);
    return {
      content: [{ type: "text", text: JSON.stringify(formatDialogueResult(result), null, 2) }],
    };
  });
}
