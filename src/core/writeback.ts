import type { CBrainDB } from "../storage/sqlite.js";
import { PageManager, } from "./page.js";
import { normalizeRelation } from "./shared.js";

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

  constructor(pages: PageManager, db: CBrainDB, _outputsDir?: string) {
    this.pages = pages;
    this.db = db;
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

    // records/ pages are human domain — writeback should target brain/ pages
    // But we allow append to records for timeline events, so no guard needed here

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

    return { success: true, action: input.action, slug };
  }

  private createConcept(input: WritebackInput): WritebackResult {
    const title = input.conceptTitle;
    if (!title) {
      return { success: false, action: input.action, error: "conceptTitle required for create_concept" };
    }

    const page = this.pages.create({
      title,
      type: "concept/concept",
      body: input.content,
      tags: ["agent-derived"],
    });

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

    this.db.insertLink(fromSlug, toSlug, normalizeRelation(relation), input.source ?? "agent-writeback", undefined, undefined, "writeback", 0.6);

    return { success: true, action: input.action, slug: fromSlug };
  }
}
