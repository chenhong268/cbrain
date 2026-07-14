import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { getNerJobProtection, type NerJobProtection } from "../../core/maintenance/zero-link-backfill.js";
import { retryFailedNerJob } from "../../core/ingestion/ner-backfill.js";

type JobView = ReturnType<ToolContext["jobs"]["get"]>;

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function hasManifestDiscriminator(data: unknown): boolean {
  const value = objectValue(data);
  return Boolean(value && value.version === 1 && value.repairName === "zero-link-rich-records" && typeof value.batchId === "string" && Array.isArray(value.ownership));
}

function hasRepairMarker(data: unknown): boolean {
  const value = objectValue(data);
  const repair = objectValue(value?.repair);
  return Boolean(repair && repair.name === "zero-link-rich-records");
}

function isManifestLike(name: string, data: unknown): boolean {
  return name === "zero-link-backfill-batch" || hasManifestDiscriminator(data);
}

function isReservedRepairPayload(name: string, data: unknown): boolean {
  return isManifestLike(name, data) || hasRepairMarker(data);
}

function safeProjection(job: NonNullable<JobView>, protection: NerJobProtection): Record<string, unknown> {
  const protectedRepair = isReservedRepairPayload(job.name, job.data) ||
    (job.name === "ner-backfill" && (protection.integrityUnknown || protection.protectedJobIds.has(job.id) || hasRepairMarker(job.data)));
  const base = {
    ...(protectedRepair ? { name: "protected-repair" } : { id: job.id, name: job.name }),
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
  if (job.name === "ner-backfill") {
    const data = objectValue(job.data);
    const lease = objectValue(data?.attemptLease);
    const result = objectValue(job.result);
    return {
      ...base,
      protectedRepair,
      attemptClass: result?.outcome === "commit_unknown"
        ? "commit_unknown"
        : lease?.phase === "committing" ? "committing"
          : lease?.phase === "claimed" ? "claimed" : "ordinary",
    };
  }
  if (isManifestLike(job.name, job.data)) {
    const data = objectValue(job.data);
    const result = objectValue(job.result);
    return {
      ...base,
      protectedRepair: true,
      finalized: result?.finalized === true,
      selected: Array.isArray(data?.ownership) ? data.ownership.length : 0,
    };
  }
  if (protectedRepair) return { ...base, protectedRepair: true };
  return job as unknown as Record<string, unknown>;
}

function fixedMutationError(id: number, code: "REPAIR_BATCH_OWNED" | "ATTEMPT_COMMITTING" | "NER_RETRY_REJECTED") {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, id, code }) }],
    isError: true,
  };
}

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  const submitJob = (name: string, data?: unknown, priority?: number) => {
    if (name === "ner-backfill" || isReservedRepairPayload(name, data)) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, code: "REPAIR_BATCH_RESERVED" }) }],
        isError: true,
      };
    }
    const id = ctx.jobs.submit(name, data, priority);
    return { content: [{ type: "text" as const, text: JSON.stringify({ id, name, status: "pending" }) }] };
  };

  const listJobs = (status?: string) => {
    const protection = getNerJobProtection(ctx.db);
    const list = ctx.jobs.list(status).map((job) => safeProjection(job, protection));
    return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
  };

  const getJobStatus = (id: number) => {
    const job = ctx.jobs.get(id);
    if (!job) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Job not found" }) }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(safeProjection(job, getNerJobProtection(ctx.db)), null, 2) }] };
  };

  const mutationPolicy = (id: number): "allow" | "REPAIR_BATCH_OWNED" | "ATTEMPT_COMMITTING" => {
    const job = ctx.jobs.get(id);
    if (!job) return "allow";
    if (isReservedRepairPayload(job.name, job.data)) return "REPAIR_BATCH_OWNED";
    if (job.name !== "ner-backfill") return "allow";
    const protection = getNerJobProtection(ctx.db);
    if (protection.integrityUnknown || protection.protectedJobIds.has(id)) return "REPAIR_BATCH_OWNED";
    const data = objectValue(job.data);
    const result = objectValue(job.result);
    if (result?.outcome === "commit_unknown") return "REPAIR_BATCH_OWNED";
    if (objectValue(data?.attemptLease)?.phase === "committing") return "ATTEMPT_COMMITTING";
    return "allow";
  };

  const cancelJob = (id: number) => {
    const policy = mutationPolicy(id);
    if (policy !== "allow") return fixedMutationError(id, policy);
    const ok = ctx.jobs.cancel(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ success: ok, id }) }] };
  };

  const retryJob = (id: number) => {
    const policy = mutationPolicy(id);
    if (policy !== "allow") return fixedMutationError(id, policy);
    const job = ctx.jobs.get(id);
    if (job?.name === "ner-backfill") {
      const ok = retryFailedNerJob(ctx.db, id);
      if (!ok) return fixedMutationError(id, "NER_RETRY_REJECTED");
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, id }) }] };
    }
    const ok = ctx.jobs.retry(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ success: ok, id }) }] };
  };

  server.registerTool("job", {
    description: "Unified job queue operations. Use action=submit/list/status/cancel/retry. Compatibility aliases remain available.",
    inputSchema: {
      action: z.enum(["submit", "list", "status", "cancel", "retry"]),
      name: z.string().max(200).optional(),
      data: z.any().optional(),
      priority: z.number().optional(),
      status: z.string().max(50).optional(),
      id: z.number().optional(),
    },
  }, async ({ action, name, data, priority, status, id }) => {
    if (action === "submit") {
      if (!name) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name is required for job action=submit" }) }], isError: true };
      return submitJob(name, data, priority);
    }
    if (action === "list") return listJobs(status);
    if (id === undefined) return { content: [{ type: "text" as const, text: JSON.stringify({ error: `id is required for job action=${action}` }) }], isError: true };
    if (action === "status") return getJobStatus(id);
    if (action === "cancel") return cancelJob(id);
    return retryJob(id);
  });

  server.registerTool("job_submit", {
    description: "Submit a new job to the queue",
    inputSchema: { name: z.string().max(200), data: z.any().optional(), priority: z.number().optional() },
  }, async ({ name, data, priority }) => submitJob(name, data, priority));

  server.registerTool("job_list", {
    description: "List jobs, optionally filtered by status",
    inputSchema: { status: z.string().max(50).optional() },
  }, async ({ status }) => listJobs(status));

  server.registerTool("job_status", {
    description: "Get detailed status of a specific job",
    inputSchema: { id: z.number() },
  }, async ({ id }) => getJobStatus(id));

  server.registerTool("job_cancel", {
    description: "Cancel a pending or running job",
    inputSchema: { id: z.number() },
  }, async ({ id }) => cancelJob(id));

  server.registerTool("job_retry", {
    description: "Retry a failed job",
    inputSchema: { id: z.number() },
  }, async ({ id }) => retryJob(id));
}
