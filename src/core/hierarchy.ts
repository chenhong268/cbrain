import type { PageManager } from "./page.js";
import type { GraphManager } from "./graph.js";

export interface HierarchyDeps {
  pages: PageManager;
  graph: GraphManager;
}

export interface HierarchyContext {
  reports_to: string | null;
  reports_to_title: string | null;
  subordinates: Array<{ slug: string; title: string }>;
  peers: Array<{ slug: string; title: string }>;
}

const REPORTS_TO_RELATION = "reports_to";

/**
 * Set the direct manager (reports_to) for an entity.
 * Writes to frontmatter + graph link (dual write).
 */
export function setHierarchy(
  slug: string,
  reportsToSlug: string,
  deps: HierarchyDeps,
): void {
  const { pages, graph } = deps;

  if (slug === reportsToSlug) {
    throw new Error("不能将自己设为上级");
  }

  const page = pages.getBySlug(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  const manager = pages.getBySlug(reportsToSlug);
  if (!manager) throw new Error(`上级实体不存在: ${reportsToSlug}`);

  // Clean up old graph link if reports_to changed
  const oldReportsTo = page.frontmatter.reports_to as string | undefined;
  if (oldReportsTo && oldReportsTo !== reportsToSlug) {
    graph.removeLink(slug, oldReportsTo, REPORTS_TO_RELATION);
  }

  // Write frontmatter
  pages.update(slug, { extra: { reports_to: reportsToSlug } });

  // Write graph link (skip if already exists — INSERT OR IGNORE)
  graph.addLink(slug, reportsToSlug, REPORTS_TO_RELATION, undefined, 1.0, "strong", "manual", 0.95);
}

/**
 * Remove the reports_to hierarchy for an entity.
 * Returns the old reports_to slug, or null if none was set.
 */
export function removeHierarchy(
  slug: string,
  deps: HierarchyDeps,
): string | null {
  const { pages, graph } = deps;

  const page = pages.getBySlug(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  const oldReportsTo = (page.frontmatter.reports_to as string) ?? null;
  if (!oldReportsTo) return null;

  // Remove from graph
  graph.removeLink(slug, oldReportsTo, REPORTS_TO_RELATION);

  // Remove from frontmatter by rebuilding without reports_to
  const { reports_to: _, ...rest } = page.frontmatter as Record<string, unknown>;
  // Use extra with undefined to strip the key
  pages.update(slug, {
    body: page.body ?? "",
    extra: { reports_to: undefined },
  });

  return oldReportsTo;
}

/**
 * Get full hierarchy context for an entity: manager, subordinates, peers.
 */
export function getHierarchyContext(
  slug: string,
  deps: HierarchyDeps,
): HierarchyContext {
  const { pages, graph } = deps;

  const page = pages.getBySlug(slug);
  if (!page) {
    return { reports_to: null, reports_to_title: null, subordinates: [], peers: [] };
  }

  // Direct manager
  const reportsToSlug = (page.frontmatter.reports_to as string) ?? null;
  let reportsToTitle: string | null = null;
  if (reportsToSlug) {
    const managerPage = pages.getBySlug(reportsToSlug);
    reportsToTitle = managerPage?.title ?? null;
  }

  // Subordinates: incoming links with relation "reports_to"
  const subordinates = graph.getLinks(slug, "incoming")
    .filter(l => l.relation === REPORTS_TO_RELATION)
    .map(l => {
      const p = pages.getBySlug(l.from_slug);
      return { slug: l.from_slug, title: p?.title ?? l.from_slug };
    });

  // Peers: others who report to the same manager
  let peers: Array<{ slug: string; title: string }> = [];
  if (reportsToSlug) {
    peers = graph.getLinks(reportsToSlug, "incoming")
      .filter(l => l.relation === REPORTS_TO_RELATION && l.from_slug !== slug)
      .map(l => {
        const p = pages.getBySlug(l.from_slug);
        return { slug: l.from_slug, title: p?.title ?? l.from_slug };
      });
  }

  return { reports_to: reportsToSlug, reports_to_title: reportsToTitle, subordinates, peers };
}
