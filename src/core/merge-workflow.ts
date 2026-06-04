import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";
import type { PageManager } from "./page.js";
import { canMerge, getLayer } from "./shared.js";
import { getOntology } from "../ontology/loader.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface MergeIdentity {
  slug: string;
  title: string;
  type: string;
}

export interface MergeTags {
  source: string[];
  target: string[];
  merged: string[];
}

export interface MergeImpact {
  outgoing_links: number;
  incoming_links: number;
  timeline_entries: number;
  aliases_on_source: string[];
  tags: MergeTags;
  wikilink_rewrite_estimates: number;
}

export interface MergePlan {
  source: MergeIdentity;
  target: MergeIdentity;
  /** Target type is always retained — merge never changes the target's type. */
  target_type_retained: boolean;
  source_title_becomes_alias: boolean;
  impact: MergeImpact;
  conflicts: string[];
  warnings: string[];
  allowed: boolean;
  /** @internal Absolute vault path of source file — used by execute/verify, not exposed to Agent. */
  _source_vault_path: string;
}

export interface MergeVerification {
  source_links_clean: boolean;
  source_page_removed: boolean;
  source_file_removed: boolean;
  source_wikilinks_clean: boolean;
  target_kr_synced: boolean;
  all_passed: boolean;
  failures: string[];
}

// ── MergeWorkflow ─────────────────────────────────────────────────────

export class MergeWorkflow {
  constructor(
    private readonly db: CBrainDB,
    private readonly pages: PageManager,
    private readonly vaultPath: string,
  ) {}

  // ── Plan (dry run, zero writes) ───────────────────────────────────

  planMerge(sourceSlug: string, targetSlug: string): MergePlan | null {
    const source = this.pages.getBySlug(sourceSlug);
    const target = this.pages.getBySlug(targetSlug);

    if (!source || !target) return null;
    if (sourceSlug === targetSlug) return null;

    const ontology = getOntology();
    const sourceLayer = getLayer(source.type);
    const targetLayer = getLayer(target.type);

    const conflicts: string[] = [];
    const warnings: string[] = [];

    // 1) Cross-layer check
    if (sourceLayer !== targetLayer) {
      conflicts.push(
        `跨层级合并被禁止：source 是 ${sourceLayer} 层（${source.type}），target 是 ${targetLayer} 层（${target.type}）`,
      );
    }

    // 2) Layer-level canMerge (redundant with cross-layer, but kept for safety)
    if (!canMerge(source.type, target.type)) {
      const alreadyCrossLayer = conflicts.length > 0;
      if (!alreadyCrossLayer) {
        conflicts.push(`canMerge 拒绝：${source.type} 和 ${target.type} 不可合并`);
      }
    }

    // 3) Type affinity check — different types without shared affinity group
    if (source.type !== target.type && sourceLayer === targetLayer) {
      const affine = ontology.areTypesAffine(source.type, target.type);
      if (!affine) {
        conflicts.push(
          `类型 ${source.type} 和 ${target.type} 不在同一 affinity group，无法安全合并`,
        );
      } else {
        // Types differ but are affine — note the type difference
        warnings.push(
          `source 类型 ${source.type} 与 target 类型 ${target.type} 不同（同 affinity group），合并后 target 保留 ${target.type}`,
        );
      }
    }

    // 4) Title collision warning
    if (source.title === target.title) {
      warnings.push(`source 和 target 标题相同（"${source.title}"），合并后不会新增 alias`);
    }

    // Collect impact data (read-only queries)
    const sourceOutgoing = this.db.getOutgoingLinks(sourceSlug);
    const sourceIncoming = this.db.getIncomingLinks(sourceSlug);
    const sourceAliases = this.db.listAliases(sourceSlug);
    const sourceTags = this.db.getTags(sourceSlug);
    const targetTags = this.db.getTags(targetSlug);
    const mergedTags = [...new Set([...targetTags, ...sourceTags])];

    // Estimate wikilink rewrites via FTS
    const sourceShort = sourceSlug.split("/").pop()!;
    const affectedSlugs = this.db.findSlugsByText([
      `[[${sourceSlug}]]`,
      `[[${sourceShort}]]`,
    ]);

    // Save source vault path internally (not exposed to Agent)
    const sourceVaultPath = join(this.vaultPath, source.file_path);

    const allowed = conflicts.length === 0;

    return {
      source: { slug: sourceSlug, title: source.title, type: source.type },
      target: { slug: targetSlug, title: target.title, type: target.type },
      target_type_retained: true,
      source_title_becomes_alias: source.title !== target.title,
      _source_vault_path: sourceVaultPath,
      impact: {
        outgoing_links: sourceOutgoing.length,
        incoming_links: sourceIncoming.length,
        timeline_entries: this.db.getTimelineCountByPage(sourceSlug),
        aliases_on_source: sourceAliases,
        tags: {
          source: sourceTags,
          target: targetTags,
          merged: mergedTags,
        },
        wikilink_rewrite_estimates: affectedSlugs.length,
      },
      conflicts,
      warnings,
      allowed,
    };
  }

  // ── Migrate aliases ──────────────────────────────────────────────

  /**
   * Migrate source's aliases to target. Called AFTER PageManager.merge()
   * succeeds. plan.impact.aliases_on_source was captured before any mutation,
   * so even though source aliases were cascade-deleted, the list is still
   * available. PageManager.merge() already adds source.title as alias;
   * this method adds the remaining ones.
   */
  migrateAliases(plan: MergePlan): void {
    const targetSlug = plan.target.slug;
    for (const alias of plan.impact.aliases_on_source) {
      // Skip source title — PageManager.merge() already handles that
      if (alias === plan.source.title) continue;
      this.db.addAlias(targetSlug, alias);
    }
  }

  // ── Verify (post-merge residual check) ───────────────────────────

  /**
   * @param sourceSlug  The source entity's slug (already deleted from DB).
   * @param targetSlug  The target entity's slug (still exists).
   * @param sourceVaultPath  Absolute path to source's vault file BEFORE merge.
   *                          Must be provided because source DB row is gone.
   */
  verifyMerge(sourceSlug: string, targetSlug: string, sourceVaultPath: string): MergeVerification {
    const failures: string[] = [];

    // 1) Source links clean
    const linkCount = this.db.getLinkCountBySlug(sourceSlug);
    const sourceLinksClean = linkCount === 0;
    if (!sourceLinksClean) {
      failures.push(`links 表仍有 ${linkCount} 条引用指向 ${sourceSlug}`);
    }

    // 2) Source page removed from DB
    const sourcePage = this.db.getPage(sourceSlug);
    const sourcePageRemoved = sourcePage === null || sourcePage === undefined;
    if (!sourcePageRemoved) {
      failures.push(`pages 表仍有 ${sourceSlug} 行`);
    }

    // 3) Source vault file removed — uses the explicitly provided path
    //    (can't read from DB because source row is already deleted)
    const sourceFileRemoved = !existsSync(sourceVaultPath);
    if (!sourceFileRemoved) {
      failures.push(`vault 仍有文件 ${sourceVaultPath}`);
    }

    // 4) Source wikilinks clean — scan ALL vault files including target.
    //    Merge note uses plain text (not wikilink), so [[source]] in any file is a residual.
    const sourceShort = sourceSlug.split("/").pop()!;
    const fullPattern = `[[${sourceSlug}]]`;
    const shortPattern = `[[${sourceShort}]]`;
    const wikilinkHits = this.scanVaultForWikilinks(fullPattern, shortPattern);
    const sourceWikilinksClean = wikilinkHits === 0;
    if (!sourceWikilinksClean) {
      failures.push(
        `vault 仍有 ${wikilinkHits} 处 wikilink 引用 ${sourceSlug}`,
      );
    }

    // 5) Target KR synced
    const targetKrSynced = this.checkTargetKrSync(targetSlug);
    if (!targetKrSynced) {
      failures.push(`target ${targetSlug} 的 Known Relations 与 DB graph 不同步`);
    }

    const allPassed =
      sourceLinksClean &&
      sourcePageRemoved &&
      sourceFileRemoved &&
      sourceWikilinksClean &&
      targetKrSynced;

    return {
      source_links_clean: sourceLinksClean,
      source_page_removed: sourcePageRemoved,
      source_file_removed: sourceFileRemoved,
      source_wikilinks_clean: sourceWikilinksClean,
      target_kr_synced: targetKrSynced,
      all_passed: allPassed,
      failures,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Check if target's Known Relations section matches DB graph.
   * - No links in DB → KR absent or empty → pass
   * - Links in DB → KR section must exist and contain all link targets
   */
  private checkTargetKrSync(targetSlug: string): boolean {
    const targetPage = this.pages.getBySlug(targetSlug);
    if (!targetPage) return false;

    const filePath = join(this.vaultPath, targetPage.file_path);
    if (!existsSync(filePath)) return false;

    const raw = readFileSync(filePath, "utf-8");
    const krSection = this.extractKnownRelations(raw);

    const outgoing = this.db.getOutgoingLinks(targetSlug);
    const incoming = this.db.getIncomingLinks(targetSlug);

    // If no links in DB, KR absent or empty is fine
    if (outgoing.length === 0 && incoming.length === 0) {
      if (krSection === null) return true;
      // Empty KR section (just the header) is also acceptable
      const trimmed = krSection.replace(/## Known Relations\n*/g, "").trim();
      return trimmed.length === 0;
    }

    // Links exist in DB → KR section must exist and contain them
    if (krSection === null) return false;

    // Check that all DB links appear in KR section
    for (const link of outgoing) {
      const expected = `→ [[${link.to_slug}]]`;
      if (!krSection.includes(expected) && !krSection.includes(link.to_slug)) {
        return false;
      }
    }
    for (const link of incoming) {
      const expected = `← ${link.relation} from [[${link.from_slug}]]`;
      if (!krSection.includes(expected) && !krSection.includes(link.from_slug)) {
        return false;
      }
    }

    return true;
  }

  private extractKnownRelations(content: string): string | null {
    const marker = "## Known Relations";
    const idx = content.indexOf(marker);
    if (idx === -1) return null;
    return content.substring(idx);
  }

  /**
   * Scan all vault .md files for wikilink patterns. Returns hit count.
   * Optionally excludes a file (e.g., target whose merge note intentionally references source).
   */
  private scanVaultForWikilinks(pattern1: string, pattern2: string, excludeFilePath?: string | null): number {
    let hits = 0;
    const scanDir = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          // Skip excluded file (e.g., target with intentional merge note)
          if (excludeFilePath && fullPath === join(this.vaultPath, excludeFilePath)) continue;
          try {
            const content = readFileSync(fullPath, "utf-8");
            if (content.includes(pattern1) || content.includes(pattern2)) {
              hits++;
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    };
    scanDir(this.vaultPath);
    return hits;
  }
}
