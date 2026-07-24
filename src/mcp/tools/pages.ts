import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { canMerge, getLayer } from "../../core/shared.js";
import { indexPage } from "../context.js";
import { trimPageBody } from "./trim.js";
import { formatGetPageEnvelope, formatGetPagesEnvelope, formatAppendEnvelope } from "./format-result.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import {
  resolveNerAction,
  shouldProcessNerForWritePath,
  submitDeferredNerForWritePath,
} from "../../core/ingestion/ner-write-path.js";
import { forPutPage } from "../../core/page-write-provenance.js";

function syncWikilinkRelations(ctx: ToolContext, slug: string, affectedSlugs: Set<string>): void {
  for (const s of new Set([slug, ...affectedSlugs])) {
    try { ctx.pages.syncLinksToMarkdown(s); } catch { /* non-critical */ }
  }
}

function schedulePageToolNer(
  ctx: ToolContext,
  slug: string,
  body: string,
  pageType: string,
  mentionedSlugs: Set<string>,
): void {
  if (!body.trim()) return;
  const action = resolveNerAction(false, ctx.nerIngestMode, ctx.deferredNerSubmitter);
  if (pageType.startsWith("entity/")) {
    if (action === "defer") {
      submitDeferredNerForWritePath(ctx.deferredNerSubmitter, {
        slug,
        pageType,
        kind: "entity_facts",
      });
    }
    return;
  }
  if (!shouldProcessNerForWritePath(body, pageType)) return;
  if (action === "defer") {
    submitDeferredNerForWritePath(ctx.deferredNerSubmitter, { slug, pageType });
    return;
  }
  if (action === "sync") {
    ctx.pipeline.processNer(slug, body, pageType, false, undefined, mentionedSlugs).catch(() => {});
  }
}

type AliasAction = "add" | "remove";

function aliasJson(payload: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function addAlias(ctx: ToolContext, slug: string, alias: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const page = ctx.db.getPage(slug);
  if (!page) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }], isError: true };
  }
  ctx.db.addAlias(slug, alias);
  return aliasJson({ success: true, slug, alias });
}

async function removeAlias(ctx: ToolContext, slug: string, alias: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  ctx.db.removeAlias(slug, alias);
  return aliasJson({ success: true, slug, aliasRemoved: alias });
}

async function runAliasAction(ctx: ToolContext, action: AliasAction, slug: string, alias: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return action === "add" ? addAlias(ctx, slug, alias) : removeAlias(ctx, slug, alias);
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
      const { display, summary, raw } = formatGetPageEnvelope({ error: "Page not found" });
      return { content: [{ type: "text", text: JSON.stringify({ display, summary, raw, error: "Page not found" }) }] };
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
      const payload = { ...row, body, body_length: bodyLength, has_more: false };
      const { display, summary, raw } = formatGetPageEnvelope(payload);
      return {
        content: [{ type: "text", text: JSON.stringify({ display, summary, raw, ...payload }, null, 2) }],
      };
    }

    const { body: trimmedBody, has_more } = trimPageBody(body ?? "");
    const payload = { ...row, body: trimmedBody, body_length: bodyLength, has_more };
    const { display, summary, raw } = formatGetPageEnvelope(payload);
    return {
      content: [{ type: "text", text: JSON.stringify({ display, summary, raw, ...payload }, null, 2) }],
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
        schedulePageToolNer(ctx, slug, finalBody, pageType, wlResult.mentionedSlugs);
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
    const created = ctx.pages.create({
      slug,
      title,
      type: type ?? "record",
      body: content,
      tags,
      extra,
      // #386: MCP put_page is always an agent write. Actor is decided here by
      // the adapter — never accepted from the tool's inputSchema (anti-forgery).
      provenance: forPutPage({ actorClass: "agent" }),
    });
    await indexPage(ctx.pipeline, created.slug, content, ctx.logger);
    const pageType = created.type;
    const wlResult = ctx.pipeline.processWikilinks(created.slug, content);
    schedulePageToolNer(ctx, created.slug, content, pageType, wlResult.mentionedSlugs);
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
      return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found" }) }], isError: true };
    }
    ctx.versions.createVersion(slug);

    // ── #195: parse deterministic frontmatter from appended content ──
    // An agent may prepend a narrow YAML block (e.g. reports_to) to convey safe
    // deterministic structure. Only whitelisted fields are honored; existing
    // frontmatter is never overwritten — conflicts become warnings + needs_review.
    // Body uses the frontmatter-stripped remainder; content without a YAML block
    // is appended whole (back-compat with plain-text appends).
    const APPEND_SAFE_FIELDS = ["reports_to", "reports_to_type"] as const;
    const { frontmatter: appendedFm, body: appendedBody } = parseFrontmatter(content);
    const fieldsUpdated: string[] = [];
    const fieldsConflicted: string[] = [];
    const extraToMerge: Record<string, unknown> = {};
    for (const field of APPEND_SAFE_FIELDS) {
      const val = (appendedFm as Record<string, unknown>)[field];
      if (val == null) continue;
      const existing = (page.frontmatter as Record<string, unknown>)[field];
      if (existing != null && existing !== val) {
        fieldsConflicted.push(field);
      } else {
        extraToMerge[field] = val;
        fieldsUpdated.push(field);
      }
    }
    const needsReview = fieldsConflicted.length > 0;

    const updated = ctx.pages.patch(slug, {
      body_append: appendedBody,
      separator: separator ?? "\n\n",
      ...(Object.keys(extraToMerge).length > 0 ? { extra: extraToMerge } : {}),
    });
    if (!updated) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Append failed" }) }], isError: true };
    }

    // Track degradation signals
    const warnings: string[] = [];
    for (const f of fieldsConflicted) warnings.push(`field_conflict:${f}`);
    const finalBody = updated.body;

    // 1. Index — returns structured result
    const indexResult = await indexPage(ctx.pipeline, slug, finalBody, ctx.logger);
    if (!indexResult.ok) {
      warnings.push("index_sync_failed");
    }

    // 2. Wikilinks — track failure + count edges added
    const pageType = updated.type;
    let affectedSlugs = new Set<string>();
    let wikiCount = 0;
    try {
      const wlResult = ctx.pipeline.processWikilinks(slug, finalBody);
      wikiCount = wlResult.count;
      affectedSlugs = wlResult.mentionedSlugs;
      schedulePageToolNer(ctx, slug, finalBody, pageType, wlResult.mentionedSlugs);
    } catch {
      warnings.push("wikilink_sync_failed");
    }

    // 2b. #195/#233: deterministic hierarchy sync — reports_to becomes a trusted
    // active edge (processReportsTo → upsertActiveReportsTo, source_type="agent"
    // → trust_state="trusted"; supersedes any stale active reports_to edge).
    // Mirrors put_page; entity/* only.
    let reportsToAdded = 0;
    if (pageType.startsWith("entity/")) {
      try {
        const before = ctx.db.getCurrentReportsToLinks(slug, "outgoing").length;
        ctx.pipeline.processReportsTo(slug, updated.frontmatter);
        const after = ctx.db.getCurrentReportsToLinks(slug, "outgoing").length;
        reportsToAdded = Math.max(0, after - before);
        // The reports_to target gains an incoming edge — it must run through
        // syncAffectedSlugs so its markdown Known Relations stays consistent with
        // the DB graph. Uses the EFFECTIVE frontmatter value (post-merge), so a
        // rejected conflict target is never synced. Only when an edge was actually
        // written (processReportsTo no-ops when the target page is missing).
        if (reportsToAdded > 0) {
          const effectiveTarget = (updated.frontmatter as Record<string, unknown>).reports_to;
          if (typeof effectiveTarget === "string" && effectiveTarget.trim()) {
            affectedSlugs.add(effectiveTarget.trim());
          }
        }
      } catch {
        warnings.push("hierarchy_sync_failed");
      }
    }
    const relationsAdded = wikiCount + reportsToAdded;

    // 3. KR sync — uses structured syncAffectedSlugs to capture per-slug errors
    const allAffected = new Set([slug, ...affectedSlugs]);
    const syncWarnings = ctx.pages.syncAffectedSlugs(allAffected);
    if (syncWarnings.length > 0) {
      warnings.push("relation_sync_failed");
    }

    // 4. Verify the persisted body exactly matches what patch() produced.
    // Forces a cache-busted disk read, strips auto-generated KR from both sides,
    // and compares precisely — catches reverts where the appended text is silently
    // dropped back to the old body (a naive includes() check would miss this).
    const finalPage = ctx.pages.verifyPersistedBody(slug, finalBody);
    if (!finalPage) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Append verification failed" }) }],
        isError: true,
      };
    }

    // 5. #195: envelope-friendly structured result. Legacy fields (action/slug/
    // new_length/warnings/needs_sync) stay at top level for back-compat; new
    // safe summary fields (relations_added/fields_updated/needs_review) are
    // surfaced alongside. display/summary never expose slugs or trust internals.
    const payload = {
      action: "appended" as const,
      slug,
      title: finalPage.title,
      new_length: finalPage.body.length,
      relations_added: relationsAdded,
      fields_updated: fieldsUpdated,
      ...(needsReview ? { needs_review: true } : {}),
      ...(warnings.length > 0 ? { warnings, needs_sync: true } : {}),
    };
    const { display, summary, raw } = formatAppendEnvelope(payload);
    return {
      content: [{ type: "text", text: JSON.stringify({ display, summary, raw, ...payload }, null, 2) }],
    };
  });

  // ─── delete_page ─────────────────────────────────────────────
  server.registerTool("delete_page", {
    description: "Delete a page by slug. Removes both the vault file and database entry.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug to delete"),
    },
  }, async ({ slug }) => {
    const result = await ctx.pages.deleteDetailed(slug);
    const payload: { success: boolean; slug: string; lance_repair_required?: boolean; warning?: string } = {
      success: result.committed,
      slug,
    };
    if (result.lanceRepairRequired) {
      payload.lance_repair_required = true;
      payload.warning = "page deleted from vault+DB, but vector cleanup failed — repair required (reindex)";
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
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

  // ─── alias (unified action tool) ──────────────────────────
  server.registerTool("alias", {
    description: "Unified alias operations. Use action=add/remove. Compatibility aliases add_alias/remove_alias remain available.",
    inputSchema: {
      action: z.enum(["add", "remove"]).describe("Alias operation"),
      slug: z.string().max(500).describe("Page slug"),
      alias: z.string().max(500).describe("Alias name"),
    },
  }, async ({ action, slug, alias }) => runAliasAction(ctx, action, slug, alias));

  // ─── add_alias ────────────────────────────────────────────
  server.registerTool("add_alias", {
    description: "Add an alias to a page. NER will resolve the alias to this page instead of creating a new entity.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug to add alias to"),
      alias: z.string().max(500).describe("Alias name (e.g. a person's alternative name)"),
    },
  }, async ({ slug, alias }) => addAlias(ctx, slug, alias));

  // ─── remove_alias ─────────────────────────────────────────
  server.registerTool("remove_alias", {
    description: "Remove an alias from a page.",
    inputSchema: {
      slug: z.string().max(500).describe("Page slug"),
      alias: z.string().max(500).describe("Alias to remove"),
    },
  }, async ({ slug, alias }) => removeAlias(ctx, slug, alias));

  // ─── get_pages ────────────────────────────────────────────
  server.registerTool("get_pages", {
    description:
      "批量获取多个页面的摘要信息。用于 get_org_tree / deep_recall 后批量补详情。" +
      "返回 compact 格式，默认不含长正文。连续多次 get_page → 改用本工具一次搞定。" +
      "缺失的 slug 按 missing 返回，不会让整个请求失败。",
    inputSchema: {
      slugs: z.array(z.string().max(500)).min(1).max(20)
        .describe("要查询的 slug 列表，最多 20 个"),
      detail: z.enum(["brief", "normal"]).optional().default("brief")
        .describe("brief=200字摘要+基本信息（默认）；normal=500字摘要+tags+link统计"),
    },
  }, async ({ slugs, detail }) => {
    const actualDetail = detail ?? "brief";
    const rows = ctx.db.getPagesBySlugs(slugs);
    const rowBySlug = new Map(rows.map(r => [r.slug, r]));
    const missing = slugs.filter(s => !rowBySlug.has(s));
    const foundSlugs = slugs.filter(s => rowBySlug.has(s));

    // Build items in input slug order (SQLite IN() returns arbitrary order)
    const maxChars = actualDetail === "normal" ? 500 : 200;
    // #214: parallel async file reads (was N serial readFileSync — up to 1-4s on iCloud
    // vault, the deep_recall/get_org_tree hot path). Promise.all preserves order, so
    // bodies[i] aligns with foundSlugs[i]; behavior is identical to the old serial loop.
    const bodies = await Promise.all(foundSlugs.map(async (slug) => {
      const row = rowBySlug.get(slug)!;
      const filePath = row.file_path as string | undefined;
      const fullPath = filePath ? join(ctx.vaultPath, filePath) : undefined;
      if (!fullPath) return null;
      const resolved = resolve(fullPath);
      const rel = relative(ctx.vaultPath, resolved);
      if (rel.startsWith("..") || resolved.startsWith("..")) return null;
      try {
        return await readFile(resolved, "utf-8");
      } catch {
        return null; // missing or unreadable file
      }
    }));

    const items = foundSlugs.map((slug, i) => {
      const row = rowBySlug.get(slug)!;
      const body = bodies[i];

      // Strip frontmatter from body for excerpt
      const bodyContent = stripFrontmatter(body ?? "");
      const { body: excerpt, has_more } = trimPageBody(bodyContent, maxChars);

      const item: Record<string, unknown> = {
        slug: row.slug,
        title: row.title,
        type: row.type,
        tier: row.tier,
        excerpt,
        has_more,
        updated_at: row.updated_at,
      };

      if (actualDetail === "normal") {
        item.mention_count = row.mention_count;
      }

      return item;
    });

    // Enrich with tags and link counts for normal detail
    if (actualDetail === "normal" && foundSlugs.length > 0) {
      const tagsMap = ctx.db.batchGetTagsForSlugs(foundSlugs);
      const linksMap = ctx.db.getLinksForSlugs(foundSlugs);

      for (const item of items) {
        const slug = item.slug as string;
        item.tags = tagsMap.get(slug) ?? [];
        const links = linksMap.get(slug);
        item.link_count = {
          outgoing: links?.outgoing?.length ?? 0,
          incoming: links?.incoming?.length ?? 0,
        };
      }
    }

    // Learning: log query + bump activity weights
    try {
      ctx.db.logQuery("get_pages", slugs.join(","), foundSlugs, 0, undefined);
    } catch { /* non-critical */ }
    for (let i = 0; i < foundSlugs.length; i++) {
      try { ctx.learn.bumpOnQuery(foundSlugs[i], i, "get_pages"); } catch { /* non-critical */ }
    }

    const envelopePayload = {
      slugs,
      detail: actualDetail,
      found: foundSlugs.length,
      missing: missing.length,
      items,
      missingSlugs: missing,
    };
    const { display, summary, raw } = formatGetPagesEnvelope(envelopePayload);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ display, summary, raw, items, missing }, null, 2),
      }],
    };
  });
}

/** Strip YAML frontmatter (---...---) from markdown body. */
function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("---", 3);
  if (end === -1) return body;
  return body.slice(end + 3).trimStart();
}
