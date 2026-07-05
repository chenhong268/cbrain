import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  const submitJob = (name: string, data?: unknown, priority?: number) => {
    const id = ctx.jobs.submit(name, data, priority);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id, name, status: "pending" }) }],
    };
  };

  const listJobs = (status?: string) => {
    const list = ctx.jobs.list(status);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }],
    };
  };

  const getJobStatus = (id: number) => {
    const job = ctx.jobs.get(id);
    if (!job) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Job not found" }) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
  };

  const cancelJob = (id: number) => {
    const ok = ctx.jobs.cancel(id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: ok, id }) }],
    };
  };

  const retryJob = (id: number) => {
    const ok = ctx.jobs.retry(id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: ok, id }) }],
    };
  };

  // ─── job ───────────────────────────────────────────────────
  server.registerTool("job", {
    description: "Unified job queue operations. Use action=submit/list/status/cancel/retry. Compatibility aliases job_submit/job_list/job_status/job_cancel/job_retry remain available.",
    inputSchema: {
      action: z.enum(["submit", "list", "status", "cancel", "retry"]).describe("Job action to run"),
      name: z.string().max(200).optional().describe("Job name for action=submit"),
      data: z.any().optional().describe("Job payload for action=submit"),
      priority: z.number().optional().describe("Priority for action=submit (higher = sooner)"),
      status: z.string().max(50).optional().describe("Filter for action=list: pending, running, done, failed, cancelled"),
      id: z.number().optional().describe("Job ID for action=status/cancel/retry"),
    },
  }, async ({ action, name, data, priority, status, id }) => {
    if (action === "submit") {
      if (!name) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name is required for job action=submit" }) }], isError: true };
      return submitJob(name, data, priority);
    }
    if (action === "list") return listJobs(status);
    if (id === undefined) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `id is required for job action=${action}` }) }], isError: true };
    }
    if (action === "status") return getJobStatus(id);
    if (action === "cancel") return cancelJob(id);
    return retryJob(id);
  });

  // ─── job_submit ────────────────────────────────────────────
  server.registerTool("job_submit", {
    description: "Submit a new job to the queue",
    inputSchema: {
      name: z.string().max(200).describe("Job name (e.g. sync, embed, ner)"),
      data: z.any().optional().describe("Job payload"),
      priority: z.number().optional().describe("Priority (higher = sooner)"),
    },
  }, async ({ name, data, priority }) => {
    return submitJob(name, data, priority);
  });

  // ─── job_list ──────────────────────────────────────────────
  server.registerTool("job_list", {
    description: "List jobs, optionally filtered by status",
    inputSchema: {
      status: z.string().max(50).optional().describe("Filter by status: pending, running, done, failed, cancelled"),
    },
  }, async ({ status }) => {
    return listJobs(status);
  });

  // ─── job_status ────────────────────────────────────────────
  server.registerTool("job_status", {
    description: "Get detailed status of a specific job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    return getJobStatus(id);
  });

  // ─── job_cancel ────────────────────────────────────────────
  server.registerTool("job_cancel", {
    description: "Cancel a pending or running job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    return cancelJob(id);
  });

  // ─── job_retry ─────────────────────────────────────────────
  server.registerTool("job_retry", {
    description: "Retry a failed job",
    inputSchema: {
      id: z.number().describe("Job ID"),
    },
  }, async ({ id }) => {
    return retryJob(id);
  });
}
