import type { ToolContext } from "../context.js";
import type { LinkRow } from "../../storage/sqlite.js";
import type { Link } from "../../core/graph/graph.js";
import { getHierarchyContext } from "../../core/graph/hierarchy.js";
import { isCurrentFactLink } from "../../core/shared.js";
import { trimLink, trimTimeline } from "./trim.js";

type RecallPage = ReturnType<ToolContext["pages"]["getBySlug"]>;
type BatchLinks = ReturnType<ToolContext["db"]["batchGetLinksForSlugs"]>;
type TimelineRow = {
  id: number;
  event_date: string | null;
  source: string | null;
  summary: string;
  created_at: string;
  trust_state?: string;
  source_page_slug?: string;
  evidence?: string;
  source_type?: string;
};

export interface HydrateRecallOptions {
  isBrief: boolean;
  preloadedPages?: Map<string, RecallPage>;
}

export interface HydratedRecallSlugs {
  pagesBySlug: Map<string, RecallPage>;
  batchLinks: BatchLinks;
  linksBySlug: Map<string, { outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[] }>;
  tagsBySlug: Map<string, string[]>;
  timelineBySlug: Map<string, Record<string, unknown>[]>;
  relatedBySlug: Map<string, { slug: string; title: string; type: string }[]>;
  hierarchyBySlug: Map<string, ReturnType<typeof getHierarchyContext>>;
  hotnessWeights: Map<string, number>;
}

function mergeTags(dbTags: string[], page: RecallPage | undefined): string[] {
  const fmTags = (page as { frontmatter?: { tags?: string[] } } | null | undefined)?.frontmatter?.tags ?? [];
  return [...new Set([...dbTags, ...fmTags])];
}

export function hydrateRecallSlugs(
  ctx: Pick<ToolContext, "pages" | "db" | "graph">,
  slugs: string[],
  options: HydrateRecallOptions,
): HydratedRecallSlugs {
  const pagesBySlug = new Map<string, RecallPage>(options.preloadedPages ?? []);

  for (const slug of slugs) {
    if (!pagesBySlug.has(slug)) {
      pagesBySlug.set(slug, ctx.pages.getBySlug(slug));
    }
  }

  const batchLinks = ctx.db.batchGetLinksForSlugs(slugs);
  const batchTags = ctx.db.batchGetTagsForSlugs(slugs);
  const linksBySlug = new Map<string, { outgoing: Record<string, unknown>[]; incoming: Record<string, unknown>[] }>();
  const tagsBySlug = new Map<string, string[]>();
  const timelineBySlug = new Map<string, Record<string, unknown>[]>();
  const relatedBySlug = new Map<string, { slug: string; title: string; type: string }[]>();
  const hierarchyBySlug = new Map<string, ReturnType<typeof getHierarchyContext>>();

  for (const slug of slugs) {
    tagsBySlug.set(slug, mergeTags(batchTags.get(slug) ?? [], pagesBySlug.get(slug)));
  }

  if (!options.isBrief) {
    const batchTimeline = ctx.db.batchGetTimelineForSlugs(slugs);

    for (const slug of slugs) {
      const rawLinks = batchLinks.get(slug) ?? { outgoing: [], incoming: [] };
      const toLink = (link: LinkRow): Link => ({
        ...link,
        context: link.context ?? undefined,
        source_type: link.source_type ?? undefined,
        confidence: link.confidence ?? undefined,
      });
      const outgoing = rawLinks.outgoing.filter(isCurrentFactLink).map(toLink).map(trimLink).filter(Boolean) as Record<string, unknown>[];
      const incoming = rawLinks.incoming.filter(isCurrentFactLink).map(toLink).map(trimLink).filter(Boolean) as Record<string, unknown>[];
      linksBySlug.set(slug, { outgoing, incoming });

      const rawTimeline = batchTimeline.get(slug) ?? [];
      timelineBySlug.set(slug, trimTimeline(rawTimeline as TimelineRow[], 3));

      try {
        relatedBySlug.set(slug, ctx.graph.getRelatedEntities(slug, 5));
      } catch {
        relatedBySlug.set(slug, []);
      }

      try {
        hierarchyBySlug.set(slug, getHierarchyContext(slug, { pages: ctx.pages, graph: ctx.graph }));
      } catch {
        /* non-critical */
      }
    }
  }

  return {
    pagesBySlug,
    batchLinks: batchLinks as Map<string, { outgoing: LinkRow[]; incoming: LinkRow[] }>,
    linksBySlug,
    tagsBySlug,
    timelineBySlug,
    relatedBySlug,
    hierarchyBySlug,
    hotnessWeights: slugs.length > 0 ? ctx.db.getHotnessWeights(slugs) : new Map<string, number>(),
  };
}
