import type { CBrainDB } from "../storage/sqlite.js";
import { PageManager, type Page } from "./page.js";
import { AuditLogger } from "./audit.js";

export type WritebackAction = "append" | "create_concept" | "create_link";

export interface WritebackInput {
  action: WritebackAction;
  /** Target page slug (for append / create_link) */
  targetSlug?: string;
  /** Content to append or concept body */
  content: string;
  /** For create_concept */
  conceptTitle?: string;
  /** For create_link */
  fromSlug?: string;
  toSlug?: string;
  relation?: string;
  /** Context — where this insight came from (e.g. "query:xyz") */
  source?: string;
}

export interface WritebackResult {
  success: boolean;
  action: WritebackAction;
  slug?: string;
  error?: string;
}

export class WritebackManager {
  private pages: PageManager;
  private db: CBrainDB;
  private audit: AuditLogger | null;

  constructor(pages: PageManager, db: CBrainDB, outputsDir?: string) {
    this.pages = pages;
    this.db = db;
    this.audit = outputsDir ? new AuditLogger(outputsDir) : null;
  }

  async execute(input: WritebackInput): Promise<WritebackResult> {
    switch (input.action) {
      case "append":
        return this.appendInsight(input);
      case "create_concept":
        return this.createConcept(input);
      case "create_link":
        return this.createLink(input);
      default:
        return { success: false, action: input.action, error: `Unknown action: ${input.action}` };
    }
  }

  private appendInsight(input: WritebackInput): WritebackResult {
    const slug = input.targetSlug;
    if (!slug) {
      return { success: false, action: input.action, error: "targetSlug required for append" };
    }

    if (slug.startsWith("raw/")) {
      return { success: false, action: input.action, error: `Cannot append to raw/ page "${slug}". Raw files are human domain — create a brain/ page instead.` };
    }

    const page = this.pages.getBySlug(slug);
    if (!page) {
      return { success: false, action: input.action, error: `Page not found: ${slug}` };
    }

    const separator = page.body.trim().length > 0 ? "\n\n---\n\n" : "";
    const sourceTag = input.source ? `\n> Source: ${input.source}` : "";
    const newBody = page.body + separator + input.content + sourceTag;

    const updated = this.pages.update(slug, {
      body: newBody,
      tags: [...(page.frontmatter.tags ?? [])],
    });

    if (!updated) {
      return { success: false, action: input.action, error: `Failed to update: ${slug}` };
    }

    this.audit?.log(AuditLogger.entry("writeback_append", "success", {
      pageSlug: slug,
      details: { source: input.source },
    }));

    return { success: true, action: input.action, slug };
  }

  private createConcept(input: WritebackInput): WritebackResult {
    const title = input.conceptTitle;
    if (!title) {
      return { success: false, action: input.action, error: "conceptTitle required for create_concept" };
    }

    const page = this.pages.create({
      title,
      type: "concept",
      body: input.content,
      tags: ["agent-derived"],
    });

    this.audit?.log(AuditLogger.entry("writeback_create_concept", "success", {
      pageSlug: page.slug,
      details: { title, source: input.source },
    }));

    return { success: true, action: input.action, slug: page.slug };
  }

  private createLink(input: WritebackInput): WritebackResult {
    const { fromSlug, toSlug, relation } = input;
    if (!fromSlug || !toSlug || !relation) {
      return { success: false, action: input.action, error: "fromSlug, toSlug, and relation required" };
    }

    const fromPage = this.pages.getBySlug(fromSlug);
    const toPage = this.pages.getBySlug(toSlug);
    if (!fromPage) {
      return { success: false, action: input.action, error: `Source page not found: ${fromSlug}` };
    }
    if (!toPage) {
      return { success: false, action: input.action, error: `Target page not found: ${toSlug}` };
    }

    this.db.prepare(
      `INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)`
    ).run({
      $from: fromSlug,
      $to: toSlug,
      $rel: relation,
      $ctx: input.source ?? "agent-writeback",
    });

    this.audit?.log(AuditLogger.entry("writeback_create_link", "success", {
      pageSlug: fromSlug,
      details: { to: toSlug, relation, source: input.source },
    }));

    return { success: true, action: input.action, slug: fromSlug };
  }
}
