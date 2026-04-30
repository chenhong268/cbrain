import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  // ─── job_submit ────────────────────────────────────────────
  server.registerTool("job_submit", {
    description: "Submit a new job to the queue",
    inputSchema: {
      name: z.string().describe("Job name (e.g. sync, embed, ner)"),
      data: z.any().optional().describe("Job payload"),
      priority: z.number().optional().describe("Priority (higher = sooner)"),
    },
  }, async ({ name, data, priority }) => {
    const id = ctx.jobs.submit(name, data, priority);
    return {
      content: [{ type: "text", text: JSON.stringify({ id, name, status: "pending" }) }],
    };
  });

  // ─── job_list ──────────────────────────────────────────────
  server.registerTool("job_list", {
    description: "List jobs, optionally filtered by status",
    inputSchema: {
      status: z.string().optional().describe("Filter by status: pending, running, done, failed, cancelled"),
    },
  }, async ({ status }) => {
    const list = ctx.jobs.list(status);
    return {
      content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
    };
  });

  // ─── job_status ────────────────────────────────────────────
  server.registerTool("job_status", {
    description: "Get detailed status of a specific job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const job = ctx.jobs.get(id);
    if (!job) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Job not found" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
  });

  // ─── job_cancel ────────────────────────────────────────────
  server.registerTool("job_cancel", {
    description: "Cancel a pending or running job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const ok = ctx.jobs.cancel(id);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, id }) }],
    };
  });

  // ─── job_retry ─────────────────────────────────────────────
  server.registerTool("job_retry", {
    description: "Retry a failed job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    const ok = ctx.jobs.retry(id);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: ok, id }) }],
    };
  });
}
