import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { HealthChecker } from "../../core/health.js";
import { IndexGenerator } from "../../core/indexes.js";
import { normalizeRelation, CANONICAL_RELATION_TYPES, REVERSE_RELATIONS } from "../../core/shared.js";

export function registerOpsTools(server: McpServer, ctx: ToolContext): void {
  // ─── health ────────────────────────────────────────────
  server.registerTool("health", {
    description: "Run a 10-dimension health check (errors, dedup, slug collisions, consistency, completeness, islands, suggestions, attention, data readiness, source quality). Returns issues and writes a report file.",
    inputSchema: {},
  }, async () => {
    const checker = new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger);
    const report = await checker.checkAll();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  });

  // ─── enrich ──────────────────────────────────────────────
  server.registerTool("enrich", {
    description: "Run entity enrichment. Upgrades entity tiers based on mention counts.",
    inputSchema: {
      slug: z.string().optional().describe("Specific entity slug (omit for all)"),
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
      targetSlug: z.string().optional().describe("Target page slug (for append)"),
      content: z.string().describe("Content to write"),
      conceptTitle: z.string().optional().describe("Title for new concept (for create_concept)"),
      fromSlug: z.string().optional().describe("Source page slug (for create_link)"),
      toSlug: z.string().optional().describe("Target page slug (for create_link)"),
      relation: z.string().optional().describe("Relation type (for create_link, e.g. 'works_at')"),
      source: z.string().optional().describe("Origin of this insight (e.g. 'query:xyz')"),
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
    description: "Get brain status: page counts, sync info, etc.",
    inputSchema: {},
  }, async () => {
    const totalPages = ctx.db.getPageCount();
    const byType = ctx.db.getPageTypeCounts();
    const totalLinks = ctx.db.getLinkCount();
    const totalChunks = ctx.db.getChunkCount();
    const recentNerErrors = ctx.db.getRecentNerErrorCount();
    const topHotnessEntities = ctx.db.getTopHotnessEntities(10);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ totalPages, byType, totalLinks, totalChunks, recentNerErrors, topHotnessEntities, vaultPath: ctx.vaultPath }, null, 2),
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

  // ─── dream ──────────────────────────────────────────────────
  server.registerTool("dream", {
    description: "Run full nightly pipeline: sync → enrich → cleanup → health → insight archive. Reflect and discovery run independently. Use for scheduled daily maintenance. Has cycle lock to prevent overlapping runs.",
    inputSchema: {},
  }, async () => {
    const { runDream } = await import("../../core/dream.js");
    const report = await runDream(ctx.vaultPath, ctx.db, ctx.sync, ctx.enrich, new HealthChecker(ctx.db, ctx.outputsDir, ctx.logger), ctx.outputsDir, ctx.logger);
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: report.locked,
        brief: report.brief,
        locked: report.locked,
        stages: report.stages,
        timestamp: report.timestamp,
        duration_ms: report.duration_ms,
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
        if (CANONICAL_RELATION_TYPES.has(row.relation)) {
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
    const nonStandard = dist.filter(r => !CANONICAL_RELATION_TYPES.has(r.relation) && r.relation !== "reports_to");
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

    for (const [fwd, rev] of Object.entries(REVERSE_RELATIONS)) {
      // Only process each pair once (skip the second direction)
      if (fwd > rev) continue;
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
