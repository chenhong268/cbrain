import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { HealthChecker } from "../../core/health.js";
import { IndexGenerator } from "../../core/indexes.js";
import { normalizeRelation, getCanonicalRelationTypes, getReverseRelation } from "../../core/shared.js";
import { WatcherLock } from "../../utils/watcher-lock.js";

export function registerOpsTools(server: McpServer, ctx: ToolContext): void {
  // ─── health ────────────────────────────────────────────
  server.registerTool("health", {
    description: "Run a 14-dimension health check (errors, dedup, slug collisions, consistency, structural consistency, completeness, islands, suggestions, attention, data readiness, source quality, etc.). Returns issues and writes a report file.",
    inputSchema: {},
  }, async () => {
    const checker = new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger, ctx.vaultPath);
    const report = await checker.checkAll();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  });

  // ─── enrich ──────────────────────────────────────────────
  server.registerTool("enrich", {
    description: "Run entity enrichment. Upgrades entity tiers based on mention counts.",
    inputSchema: {
      slug: z.string().max(500).optional().describe("Specific entity slug (omit for all)"),
    },
  }, async ({ slug }) => {
    const result = slug
      ? [ctx.enrich.enrichEntity(slug)]
      : ctx.enrich.enrichAll();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── writeback ────────────────────────────────────────────
  server.registerTool("writeback", {
    description: "Write insights back to the knowledge base. Actions: 'append' (add content to existing page), 'create_concept' (create new concept page), 'create_link' (add relation between two pages). All operations are logged.",
    inputSchema: {
      action: z.enum(["append", "create_concept", "create_link"]).describe("Writeback action"),
      targetSlug: z.string().max(500).optional().describe("Target page slug (for append)"),
      content: z.string().max(100_000).describe("Content to write"),
      conceptTitle: z.string().max(500).optional().describe("Title for new concept (for create_concept)"),
      fromSlug: z.string().max(500).optional().describe("Source page slug (for create_link)"),
      toSlug: z.string().max(500).optional().describe("Target page slug (for create_link)"),
      relation: z.string().max(100).optional().describe("Relation type (for create_link, e.g. 'works_at')"),
      source: z.string().max(500).optional().describe("Origin of this insight (e.g. 'query:xyz')"),
    },
  }, async (params) => {
    const result = await ctx.writeback.execute(params);

    // Auto-feedback: successful writeback = strong engagement signal
    if (result.success) {
      if (result.slug) ctx.learn.bumpOnWriteback(result.slug);
      if (params.action === "create_link" && params.toSlug) {
        ctx.learn.bumpOnWriteback(params.toSlug);
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  // ─── generate_indexes ───────────────────────────────────
  server.registerTool("generate_indexes", {
    description: "Generate Obsidian-readable index files: All-Entities, All-Concepts, All-Sources, Dashboard.",
    inputSchema: {},
  }, async () => {
    const gen = new IndexGenerator(ctx.db, ctx.outputsDir);
    const files = gen.generateAll();
    return {
      content: [{ type: "text", text: JSON.stringify({ generated: files.length, files }, null, 2) }],
    };
  });

  // ─── status ──────────────────────────────────────────────
  server.registerTool("status", {
    description: "Get brain status: page counts, sync info, watcher state, quarantine, etc.",
    inputSchema: {},
  }, async () => {
    const totalPages = ctx.db.getPageCount();
    const byType = ctx.db.getPageTypeCounts();
    const totalLinks = ctx.db.getLinkCount();
    const totalChunks = ctx.db.getChunkCount();
    const recentNerErrors = ctx.db.getRecentNerErrorCount();
    const topHotnessEntities = ctx.db.getTopHotnessEntities(10);

    const watcherLock = new WatcherLock(ctx.profileDir ?? ".");
    const watcherOwner = watcherLock.readOwner();
    const quarantineRaw = ctx.db.getConfig("watcher.quarantine");
    let quarantine: Array<{ slug: string; failCount: number; lastError: string; quarantinedAt: string }> = [];
    if (quarantineRaw) {
      try {
        const parsed = JSON.parse(quarantineRaw) as Record<string, { failCount: number; lastError: string; quarantinedAt: string }>;
        quarantine = Object.entries(parsed).map(([slug, entry]) => ({ slug, ...entry }));
      } catch { /* */ }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          totalPages, byType, totalLinks, totalChunks, recentNerErrors, topHotnessEntities,
          vaultPath: ctx.vaultPath,
          watcher: watcherOwner ? { pid: watcherOwner.pid, transport: watcherOwner.transport, startedAt: watcherOwner.startedAt } : null,
          quarantineCount: quarantine.length,
          quarantine,
        }, null, 2),
      }],
    };
  });

  // ─── get_ingest_log ──────────────────────────────────────────
  server.registerTool("get_ingest_log", {
    description: "Get recent ingest log entries.",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Max entries to return"),
    },
  }, async ({ limit }) => {
    const log = ctx.db.getIngestLog(limit);
    return {
      content: [{ type: "text", text: JSON.stringify(log, null, 2) }],
    };
  });

  // ─── dream (async) ────────────────────────────────────────
  server.registerTool("dream", {
    description: "异步执行完整夜间维护流程（sync → enrich → seal → cleanup → health → insight archive）。立即返回 job_id，后台执行。使用 dream_status 查询进度。有循环锁防止重叠执行。",
    inputSchema: {},
  }, async () => {
    // Fast lock check before submitting job
    const lockValue = ctx.db.getConfig("dream.lock");
    if (lockValue) {
      const lockedAt = parseInt(lockValue, 10);
      if (Date.now() - lockedAt < 30 * 60 * 1000) {
        // Create a skipped job so it's trackable via dream_status
        const jobId = ctx.jobs.submit("dream", { locked_skip: true });
        // Immediately mark as done with locked info
        ctx.db.completeJob(jobId, { locked: true, skipped: true, message: "上次 dream 仍在执行中，已跳过" });
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            job_id: jobId,
            status: "done",
            locked: true,
            message: "上次 dream 仍在执行中（或锁未释放），已跳过。使用 dream_status 查询状态。",
          }) }],
        };
      }
    }

    const jobId = ctx.jobs.submit("dream", { vaultPath: ctx.vaultPath, dbPath: ctx.dbPath });
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: true,
        job_id: jobId,
        status: "pending",
        message: "Dream 已提交，后台执行中。使用 dream_status 查询进度。",
      }) }],
    };
  });

  // ─── dream_status ──────────────────────────────────────────
  server.registerTool("dream_status", {
    description: "查询最近一次 dream 任务的状态和阶段进度。",
    inputSchema: {
      job_id: z.number().optional().describe("Job ID（省略则查询最近一次 dream）"),
    },
  }, async ({ job_id }) => {
    let job: Awaited<ReturnType<typeof ctx.jobs.get>>;
    if (job_id) {
      job = ctx.jobs.get(job_id);
    } else {
      const dreamJobs = ctx.db.listJobs().filter(j => j.name === "dream");
      job = dreamJobs.length > 0 ? dreamJobs[0] : null;
    }

    if (!job) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No dream job found" }) }],
      };
    }

    let progress: Record<string, unknown> = {};
    try { if (job.result) progress = JSON.parse(job.result) as Record<string, unknown>; } catch { /* corrupted result */ }
    return {
      content: [{ type: "text", text: JSON.stringify({
        job_id: job.id,
        status: job.status,
        current_stage: progress.current_stage ?? null,
        stages: progress,
        error: job.error,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
      }, null, 2) }],
    };
  });

  // ─── dream_reset ────────────────────────────────────────────
  server.registerTool("dream_reset", {
    description: "Clear the dream cycle lock. Use when a previous dream didn't finish and you need to force a new one.",
    inputSchema: {},
  }, async () => {
    ctx.db.deleteConfig("dream.lock");
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, message: "Dream lock cleared. Ready to run again." }) }],
    };
  });

  // ─── watcher_quarantine ──────────────────────────────────────
  server.registerTool("watcher_quarantine", {
    description: "Manage watcher quarantine. 'list' shows quarantined files with reasons. 'release' removes a file from quarantine so it will re-sync on next scan. 'release_all' clears entire quarantine.",
    inputSchema: {
      action: z.enum(["list", "release", "release_all"]).describe("'list' = show quarantined files, 'release' = un-quarantine one file, 'release_all' = clear all"),
      slug: z.string().max(500).optional().describe("Slug to release (required for action='release')"),
    },
  }, async ({ action, slug }) => {
    const quarantineRaw = ctx.db.getConfig("watcher.quarantine");
    const quarantineMap: Record<string, { failCount: number; lastError: string; quarantinedAt: string }> = quarantineRaw
      ? JSON.parse(quarantineRaw)
      : {};

    if (action === "list") {
      const entries = Object.entries(quarantineMap).map(([s, e]) => ({ slug: s, ...e }));
      return {
        content: [{ type: "text", text: JSON.stringify({ count: entries.length, entries }, null, 2) }],
      };
    }

    if (action === "release") {
      if (!slug) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "slug required for release" }) }] };
      }
      if (!(slug in quarantineMap)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `${slug} is not quarantined` }) }] };
      }
      // Sync with live watcher memory state
      if (ctx.watcher) {
        ctx.watcher.releaseEntry(slug);
      } else {
        delete quarantineMap[slug];
        ctx.db.setConfig("watcher.quarantine", JSON.stringify(quarantineMap));
      }
      // Re-read DB to get accurate remaining count
      const afterRaw = ctx.db.getConfig("watcher.quarantine");
      const remaining = afterRaw ? Object.keys(JSON.parse(afterRaw)).length : 0;
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, released: slug, remaining }) }],
      };
    }

    // release_all
    if (ctx.watcher) {
      const count = ctx.watcher.releaseAllEntries();
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, released: count }) }],
      };
    }
    ctx.db.deleteConfig("watcher.quarantine");
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, released: Object.keys(quarantineMap).length }) }],
    };
  });

  // ─── relation_audit ─────────────────────────────────────────
  server.registerTool("relation_audit", {
    description: "Audit and fix non-standard relation types. Modes: 'report' shows distribution, 'fix' migrates non-standard relations to canonical types. Use dry_run=true to preview changes before applying.",
    inputSchema: {
      mode: z.enum(["report", "fix"]).describe("'report' = show distribution, 'fix' = migrate non-standard relations"),
      dry_run: z.boolean().default(true).describe("Preview only. Set false to apply changes."),
    },
  }, async ({ mode, dry_run }) => {
    const dist = ctx.db.getRelationDistribution();

    if (mode === "report") {
      const canonical: Record<string, number> = {};
      const nonStandard: Array<{ relation: string; count: number; mapsTo: string }> = [];
      for (const row of dist) {
        if (getCanonicalRelationTypes().has(row.relation)) {
          canonical[row.relation] = row.count;
        } else if (row.relation === "reports_to") {
          canonical["reports_to"] = row.count;
        } else {
          nonStandard.push({ relation: row.relation, count: row.count, mapsTo: normalizeRelation(row.relation) });
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          canonical,
          nonStandardCount: nonStandard.reduce((s, r) => s + r.count, 0),
          nonStandardTypes: nonStandard.length,
          nonStandard: nonStandard.slice(0, 50),
          truncated: nonStandard.length > 50,
        }, null, 2) }],
      };
    }

    // mode === "fix"
    const nonStandard = dist.filter(r => !getCanonicalRelationTypes().has(r.relation) && r.relation !== "reports_to");
    if (nonStandard.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, message: "All relations are canonical. Nothing to fix." }) }],
      };
    }

    const preview: Array<{ from: string; relation: string; to: string; mapsTo: string; action: string }> = [];
    let totalFixed = 0;
    let totalDeduped = 0;
    const affectedSlugs = new Set<string>();

    for (const { relation } of nonStandard) {
      const links = ctx.db.getAllLinksByRelation(relation);
      const target = normalizeRelation(relation);
      for (const link of links) {
        affectedSlugs.add(link.from_slug);
        affectedSlugs.add(link.to_slug);

        const duplicate = ctx.db.linkExists(link.from_slug, link.to_slug, target);
        if (duplicate) {
          preview.push({ from: link.from_slug, relation, to: link.to_slug, mapsTo: target, action: "dedup: delete old" });
          if (!dry_run) {
            ctx.db.deleteLinkById(link.id);
            totalDeduped++;
          }
        } else {
          preview.push({ from: link.from_slug, relation, to: link.to_slug, mapsTo: target, action: "migrate" });
          if (!dry_run) {
            ctx.db.updateLinkRelation(link.id, target);
            totalFixed++;
          }
        }
      }
    }

    if (!dry_run) {
      // Sync OB markdown for all affected slugs
      for (const slug of affectedSlugs) {
        try { ctx.pages.syncLinksToMarkdown(slug); } catch { /* non-critical */ }
      }
    }

    // ── Ensure bidirectional pairs ──
    const bidirPreview: Array<{ from: string; relation: string; to: string; action: string }> = [];
    let bidirFixed = 0;
    const bidirSlugs = new Set<string>();

    const processedPairs = new Set<string>();
    for (const fwd of getCanonicalRelationTypes()) {
      const rev = getReverseRelation(fwd);
      if (!rev) continue;
      const pairKey = [fwd, rev].sort().join("|");
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);
      const links = ctx.db.getAllLinksByRelation(fwd);
      for (const link of links) {
        const hasReverse = ctx.db.linkExists(link.to_slug, link.from_slug, rev);
        if (!hasReverse) {
          bidirPreview.push({ from: link.from_slug, relation: fwd, to: link.to_slug, action: `add reverse: ${link.to_slug} → ${rev} → ${link.from_slug}` });
          bidirSlugs.add(link.from_slug);
          bidirSlugs.add(link.to_slug);
          if (!dry_run) {
            ctx.db.insertLink(link.to_slug, link.from_slug, rev, null, 1.0, "strong", "bidir-fix", 1.0, true);
            bidirFixed++;
          }
        }
      }
    }

    if (!dry_run) {
      for (const slug of bidirSlugs) {
        try { ctx.pages.syncLinksToMarkdown(slug); } catch { /* non-critical */ }
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        dry_run,
        affectedRelations: nonStandard.length,
        affectedLinks: preview.length,
        affectedSlugs: affectedSlugs.size,
        fixed: dry_run ? 0 : totalFixed,
        deduped: dry_run ? 0 : totalDeduped,
        obSynced: dry_run ? 0 : affectedSlugs.size + bidirSlugs.size,
        bidirMissing: bidirPreview.length,
        bidirFixed: dry_run ? 0 : bidirFixed,
        preview: preview.slice(0, 100),
        truncated: preview.length > 100,
      }, null, 2) }],
    };
  });
}
