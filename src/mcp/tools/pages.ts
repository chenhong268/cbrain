import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { canMerge, getLayer } from "../../core/shared.js";
import { indexPage } from "../context.js";
import { trimPageBody } from "./trim.js";

function syncWikilinkRelations(ctx: ToolContext, slug: string, affectedSlugs: Set<string>): void {
  for (const s of new Set([slug, ...affectedSlugs])) {
    try { ctx.pages.syncLinksToMarkdown(s); } catch { /* non-critical */ }
  }
}

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  // ─── get_page ────────────────────────────────────────────
  server.registerTool("get_page", {
    description: "Get a page by slug. Returns frontmatter + body.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug (e.g. brain/entities/zhangsan)"),
      include_full_body: z.boolean().optional().default(false).describe("Return full body instead of truncated (default: truncated to 1500 chars)"),
    },
  }, async ({ slug, include_full_body }) => {
    const row = ctx.db.getPage(slug);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }] };
    }

    const filePath = row.file_path as string | undefined;
    const fullPath = filePath ? join(ctx.vaultPath, filePath) : undefined;

    // Prevent path traversal — only read files inside vault
    let body: string | null = null;
    if (fullPath) {
      const resolved = resolve(fullPath);
      const rel = relative(ctx.vaultPath, resolved);
      if (!rel.startsWith("..") && !resolved.startsWith("..")) {
        if (existsSync(resolved)) body = readFileSync(resolved, "utf-8");
      }
    }

    const bodyLength = body?.length ?? 0;
    if (include_full_body || bodyLength === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ...row, body, body_length: bodyLength, has_more: false }, null, 2) }],
      };
    }

    const { body: trimmedBody, has_more } = trimPageBody(body ?? "");
    return {
      content: [{ type: "text", text: JSON.stringify({ ...row, body: trimmedBody, body_length: bodyLength, has_more }, null, 2) }],
    };
  });

  // ─── list_pages ──────────────────────────────────────────
  server.registerTool("list_pages", {
    description: "List pages in the brain. Optional type filter.",
    inputSchema: {
      type: z.string().max(200).optional().describe("Filter by type"),
      limit: z.number().optional().default(20).describe("Max results"),
      offset: z.number().optional().default(0).describe("Offset for pagination"),
    },
  }, async ({ type, limit, offset }) => {
    const rows = ctx.db.listPages({ type, limit: limit ?? 20, offset: offset ?? 0 });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  });

  // ─── put_page ──────────────────────────────────────────────
  server.registerTool("put_page", {
    description:
      "Create or update a page. For existing pages, defaults to patch mode (append body, merge tags, preserve content). " +
      "Use mode='replace' to explicitly overwrite (creates a version snapshot first). " +
      "For new pages, mode is ignored.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug (e.g. brain/entities/zhangsan)"),
      content: z.string().max(500_000).describe("Page body content (markdown). In patch mode: appended. In replace mode: replaces body."),
      mode: z.enum(["patch", "replace"]).optional().describe("patch=append+merge (default for existing), replace=full overwrite (explicit opt-in)"),
      title: z.string().max(500).optional().describe("Page title (required for new pages)"),
      type: z.string().max(200).optional().default("record").describe("Page type (required for new pages)"),
      tags: z.array(z.string().max(200)).optional().describe("Tags. patch: merged (union). replace: replaced."),
      extra: z.record(z.string().max(200), z.unknown()).optional().describe("Frontmatter fields to set (e.g. reports_to, confidence). Works in all modes including new pages."),
    },
  }, async ({ slug, content, mode, title, type, tags, extra }) => {
    const existing = ctx.pages.getBySlug(slug);
    if (existing) {
      const effectiveMode = mode ?? "patch";
      let updated: import("../../core/page.js").Page | null = null;
      let previousVersion: number | null = null;
      let finalBody: string;

      // Capture old reports_to before mutation for KR sync
      const oldReportsTo = existing.frontmatter.reports_to as string | undefined;

      if (effectiveMode === "replace") {
        // Explicit full overwrite — snapshot first
        previousVersion = ctx.versions.createVersion(slug);
        updated = ctx.pages.update(slug, { body: content, tags, extra });
        finalBody = content;
      } else {
        // Patch mode (default) — append body, merge tags, update frontmatter fields
        updated = ctx.pages.patch(slug, { body_append: content, tags_merge: tags, extra });
        finalBody = updated?.body ?? content;
      }

      if (updated) {
        await indexPage(ctx.pipeline, slug, finalBody, ctx.logger);
        const pageType = existing.type;
        const wlResult = ctx.pipeline.processWikilinks(slug, finalBody);
        if (!pageType.startsWith("entity/") && !pageType.startsWith("concept/") && !pageType.startsWith("insight/")) {
          ctx.pipeline.processNer(slug, finalBody, pageType, false, undefined, wlResult.mentionedSlugs).catch(() => {});
        }
        // Sync reports_to graph edge if frontmatter has it
        ctx.pipeline.processReportsTo(slug, updated.frontmatter);
        // Sync KR for self, wikilink targets, old manager, new manager
        const newReportsTo = updated.frontmatter.reports_to as string | undefined;
        const affectedSlugs = new Set([slug, ...wlResult.mentionedSlugs]);
        if (oldReportsTo) affectedSlugs.add(oldReportsTo);
        if (newReportsTo) affectedSlugs.add(newReportsTo);
        syncWikilinkRelations(ctx, slug, affectedSlugs);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          action: "updated",
          mode: effectiveMode,
          ...(previousVersion !== null ? { previous_version: previousVersion } : {}),
          page: updated ? { slug: updated.slug, title: updated.title } : null,
        }, null, 2) }],
      };
    }

    // ── New page path ──
    // Check for same-title-different-person before creating
    if (title) {
      const dup = ctx.db.getPageByTitleExcluding(title, slug);
      if (dup) {
        const context = tags?.join("-") || type || "entity";
        const suggestedSlug = slug.replace(/\/[^/]+$/, `/${title}-${context}`);
        return {
          content: [{ type: "text", text: JSON.stringify({
            action: "duplicate_title",
            title,
            message: `同名人物警告: "${title}" 已存在 (${dup.slug})。如果这是不同的人，请用不同的 slug，例如 "${suggestedSlug}"。如果是同一个人，直接用现有 slug "${dup.slug}" 更新。`,
            existingSlug: dup.slug,
            suggestedSlug,
          }) }],
        };
      }
    }
    if (!title) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "title is required for new pages" }) }] };
    }
    const created = ctx.pages.create({ slug, title, type: type ?? "record", body: content, tags, extra });
    await indexPage(ctx.pipeline, created.slug, content, ctx.logger);
    const pageType = created.type;
    const wlResult = ctx.pipeline.processWikilinks(created.slug, content);
    if (!pageType.startsWith("entity/") && !pageType.startsWith("concept/") && !pageType.startsWith("insight/")) {
      ctx.pipeline.processNer(created.slug, content, pageType, false, undefined, wlResult.mentionedSlugs).catch(() => {});
    }
    // Sync reports_to graph edge if extra provided it
    ctx.pipeline.processReportsTo(created.slug, created.frontmatter);
    // Sync KR for self, wikilink targets, and reports_to manager
    const createdReportsTo = created.frontmatter.reports_to as string | undefined;
    const createdAffected = new Set([created.slug, ...wlResult.mentionedSlugs]);
    if (createdReportsTo) createdAffected.add(createdReportsTo);
    syncWikilinkRelations(ctx, created.slug, createdAffected);
    return {
      content: [{ type: "text", text: JSON.stringify({ action: "created", page: { slug: created.slug, title: created.title } }, null, 2) }],
    };
  });

  // ─── append_page ─────────────────────────────────────────────
  server.registerTool("append_page", {
    description: "Append content to an existing page's body. Does NOT overwrite existing content. Triggers re-index and NER/wikilink extraction.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug to append to"),
      content: z.string().max(500_000).describe("Content to append"),
      separator: z.string().max(50).optional().default("\n\n").describe("Separator between existing body and new content (default: double newline)"),
    },
  }, async ({ slug, content, separator }) => {
    const page = ctx.pages.getBySlug(slug);
    if (!page) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }] };
    }
    ctx.versions.createVersion(slug);
    const newBody = page.body + (separator ?? "\n\n") + content;
    const updated = ctx.pages.update(slug, { body: newBody });
    if (updated) {
      await indexPage(ctx.pipeline, slug, newBody, ctx.logger);
      const pageType = updated.type;
      const wlResult = ctx.pipeline.processWikilinks(slug, newBody);
      if (!pageType.startsWith("entity/") && !pageType.startsWith("concept/") && !pageType.startsWith("insight/")) {
        ctx.pipeline.processNer(slug, newBody, pageType, false, undefined, wlResult.mentionedSlugs).catch(() => {});
      }
      syncWikilinkRelations(ctx, slug, wlResult.mentionedSlugs);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ action: "appended", slug, new_length: newBody.length }) }],
    };
  });

  // ─── delete_page ─────────────────────────────────────────────
  server.registerTool("delete_page", {
    description: "Delete a page by slug. Removes both the vault file and database entry.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug to delete"),
    },
  }, async ({ slug }) => {
    const success = await ctx.pages.delete(slug);
    return {
      content: [{ type: "text", text: JSON.stringify({ success, slug }) }],
    };
  });

  // ─── resolve_slugs ───────────────────────────────────────────
  server.registerTool("resolve_slugs", {
    description: "Resolve page titles or partial names to slugs. Returns best match for each query.",
    inputSchema: {
      queries: z.array(z.string().max(500)).describe("List of page names or slugs to resolve"),
    },
  }, async ({ queries }) => {
    const results = ctx.db.resolveSlugs(queries);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  });

  // ─── merge_pages ────────────────────────────────────────────
  server.registerTool("merge_pages", {
    description: "Merge a source page into a target page. All links, timeline entries, tags and raw data are moved from source to target. Source body is appended to target body. Source page is deleted after merge. Use dryRun=true to preview without executing.",
    inputSchema: {
      source: z.string().max(500).describe("Slug of the source page to merge and delete"),
      target: z.string().max(500).describe("Slug of the target page to merge into"),
      dryRun: z.boolean().optional().default(false).describe("Preview merge without executing"),
    },
  }, async ({ source, target, dryRun }) => {
    const sourcePage = ctx.pages.getBySlug(source);
    const targetPage = ctx.pages.getBySlug(target);
    if (!sourcePage || !targetPage) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: `Page not found: ${!sourcePage ? source : target}` }) }],
        isError: true,
      };
    }
    if (source === target) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: "Cannot merge page into itself" }) }],
        isError: true,
      };
    }

    if (!canMerge(sourcePage.type, targetPage.type)) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          success: false,
          error: `Cannot merge across layers: source is "${sourcePage.type}" (${getLayer(sourcePage.type)}) and target is "${targetPage.type}" (${getLayer(targetPage.type)}). Source layer (record) cannot merge with derived layer (entity, concept, insight).`,
        }) }],
        isError: true,
      };
    }

    if (dryRun) {
      const sourceTags = ctx.db.getTags(source);
      const targetTags = ctx.db.getTags(target);
      const mergedTags = [...new Set([...targetTags, ...sourceTags])];
      const sourceLinks = ctx.db.getLinkCountBySlug(source);
      const timelineEntries = ctx.db.getTimelineCountByPage(source);

      return {
        content: [{ type: "text", text: JSON.stringify({
          dryRun: true,
          source: { slug: source, title: sourcePage.title, type: sourcePage.type, tags: sourceTags },
          target: { slug: target, title: targetPage.title, type: targetPage.type, tags: targetTags },
          preview: {
            mergedTags,
            linksToMove: sourceLinks,
            timelineToMove: timelineEntries,
            sourceDeleted: true,
          },
        }, null, 2) }],
      };
    }

    const result = await ctx.pages.merge(source, target);
    if (!result) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: "Merge failed — check that both slugs exist and are different" }) }],
        isError: true,
      };
    }
    // Sync Known Relations for target and all its graph neighbors
    const neighbors = ctx.db.getLinkNeighborSlugs(target);
    const warnings = ctx.pages.syncAffectedSlugs([target, ...neighbors]);
    return {
      content: [{ type: "text", text: JSON.stringify({ success: true, merged: result.slug, title: result.title, type: result.type, ...(warnings.length > 0 ? { sync_warnings: warnings } : {}) }) }],
    };
  });

  // ─── add_alias ────────────────────────────────────────────
  server.registerTool("add_alias", {
    description: "Add an alias to a page. NER will resolve the alias to this page instead of creating a new entity.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug to add alias to"),
      alias: z.string().max(500).describe("Alias name (e.g. a person's alternative name)"),
    },
  }, async ({ slug, alias }) => {
    const page = ctx.db.getPage(slug);
    if (!page) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }], isError: true };
    }
    ctx.db.addAlias(slug, alias);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, slug, alias }) }] };
  });

  // ─── remove_alias ─────────────────────────────────────────
  server.registerTool("remove_alias", {
    description: "Remove an alias from a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      alias: z.string().max(500).describe("Alias to remove"),
    },
  }, async ({ slug, alias }) => {
    ctx.db.removeAlias(slug, alias);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, slug, aliasRemoved: alias }) }] };
  });
}
