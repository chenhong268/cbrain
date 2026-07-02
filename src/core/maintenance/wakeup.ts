import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { Logger } from "../logger.js";

const MAX_LINES = 20;
const MAX_SNAPSHOTS = 7;
const CONFIDENCE_DECAY_THRESHOLD = 0.1;

let snapshotCounter = 0;

export interface WakeupChangeItem {
  slug: string;
  title: string;
  type: string;
}

export interface WakeupTierChange {
  slug: string;
  title: string;
  oldTier: number;
  newTier: number;
}

export interface WakeupLinkCountChange {
  slug: string;
  title: string;
  oldCount: number;
  newCount: number;
  diff: number;
}

export interface WakeupConfidenceChange {
  slug: string;
  title: string;
  oldValue: number;
  newValue: number;
}

export interface WakeupRemovedItem {
  slug: string;
  title: string;
  type: string;
}

export interface WakeupDiffResult {
  date: string;
  baselineCreated: boolean;
  previousSnapshotId: string | null;
  snapshotId: string;
  stats: {
    totalPages: number;
    totalLinks: number;
    previousPages: number;
    previousLinks: number;
  };
  changes: {
    contentUpdated: WakeupChangeItem[];
    tierChanged: WakeupTierChange[];
    linkCountChanged: WakeupLinkCountChange[];
    confidenceDecayed: WakeupConfidenceChange[];
    removed: WakeupRemovedItem[];
  };
  newItems: WakeupChangeItem[];
  truncated: boolean;
  truncationReason?: string;
  reportPath: string | null;
}

interface PageRow {
  slug: string;
  title: string;
  type: string;
  content_hash: string | null;
  tier: number;
  mention_count: number;
  confidence_decay: number;
  updated_at: string | null;
}

interface SnapshotItem {
  slug: string;
  title: string;
  content_hash: string | null;
  tier: number;
  mention_count: number;
  link_count: number;
  updated_at: string | null;
  page_type: string;
  confidence_decay: number;
}

export class WakeupDiff {
  constructor(
    private db: CBrainDB,
    private outputsDir: string,
    private logger?: Logger,
  ) {}

  async run(): Promise<WakeupDiffResult> {
    const now = new Date();
    const isoNow = now.toISOString();
    const snapshotId = `${isoNow.replace(/[:.]/g, "-")}-${++snapshotCounter}`;
    const date = isoNow.slice(0, 10);

    // 1. Find previous snapshot
    const previous = this.db.getLatestSnapshot();

    // 2. Build snapshot data
    const currentPageRows = this.getCurrentPages();
    const totalLinks = this.db.getLinkCount();
    const linkCounts = this.db.batchGetLinkCounts(currentPageRows.map(p => p.slug));

    const snapshotItems: SnapshotItem[] = currentPageRows.map(p => ({
      slug: p.slug,
      title: p.title,
      content_hash: p.content_hash,
      tier: p.tier,
      mention_count: p.mention_count,
      link_count: linkCounts.get(p.slug) ?? 0,
      updated_at: p.updated_at,
      page_type: p.type,
      confidence_decay: p.confidence_decay,
    }));

    // 3. Atomic write: header + items in single transaction
    this.db.createSnapshotAtomic(
      snapshotId,
      isoNow,
      currentPageRows.length,
      totalLinks,
      snapshotItems.map(item => ({
        slug: item.slug,
        title: item.title,
        contentHash: item.content_hash,
        tier: item.tier,
        mentionCount: item.mention_count,
        linkCount: item.link_count,
        updatedAt: item.updated_at,
        pageType: item.page_type,
        confidenceDecay: item.confidence_decay,
      })),
    );

    const emptyChanges = {
      contentUpdated: [] as WakeupChangeItem[],
      tierChanged: [] as WakeupTierChange[],
      linkCountChanged: [] as WakeupLinkCountChange[],
      confidenceDecayed: [] as WakeupConfidenceChange[],
      removed: [] as WakeupRemovedItem[],
    };

    // 3. No previous → baseline
    if (!previous) {
      this.logger?.info("wakeup", "已建立基线快照", { pageCount: currentPageRows.length });
      const baselineResult: WakeupDiffResult = {
        date,
        baselineCreated: true,
        previousSnapshotId: null,
        snapshotId,
        stats: { totalPages: currentPageRows.length, totalLinks, previousPages: 0, previousLinks: 0 },
        changes: emptyChanges,
        newItems: [],
        truncated: false,
        reportPath: null,
      };
      const reportPath = this.writeReports(baselineResult);
      baselineResult.reportPath = reportPath;
      this.cleanupOldSnapshots();
      return baselineResult;
    }

    // 4. Diff against previous
    const previousItems = this.db.getSnapshotItems(previous.id);
    const result = this.computeDiff(previousItems, snapshotItems, {
      previousPages: previous.page_count,
      previousLinks: previous.link_count,
      totalPages: currentPageRows.length,
      totalLinks,
    });

    // 5. Build report
    const fullResult: WakeupDiffResult = {
      date,
      baselineCreated: false,
      previousSnapshotId: previous.id,
      snapshotId,
      stats: result.stats,
      changes: result.changes,
      newItems: result.newItems,
      truncated: result.truncated,
      truncationReason: result.truncationReason,
      reportPath: null,
    };

    // 6. Write reports
    const reportPath = this.writeReports(fullResult);
    fullResult.reportPath = reportPath;

    // 7. Cleanup old snapshots
    this.cleanupOldSnapshots();

    this.logger?.info("wakeup", "wake-up diff 完成", {
      changes: totalChangeCount(result.changes),
      newItems: result.newItems.length,
      truncated: result.truncated,
    });

    return fullResult;
  }

  private getCurrentPages(): PageRow[] {
    return this.db.rawDb.prepare(
      "SELECT slug, title, type, content_hash, tier, mention_count, confidence_decay, updated_at FROM pages"
    ).all() as PageRow[];
  }

  private computeDiff(
    oldItems: SnapshotItem[],
    newItems: SnapshotItem[],
    stats: { previousPages: number; previousLinks: number; totalPages: number; totalLinks: number },
  ): Omit<WakeupDiffResult, "date" | "baselineCreated" | "previousSnapshotId" | "snapshotId" | "reportPath"> {
    const oldMap = new Map(oldItems.map(i => [i.slug, i]));
    const newMap = new Map(newItems.map(i => [i.slug, i]));

    const contentUpdated: WakeupChangeItem[] = [];
    const tierChanged: WakeupTierChange[] = [];
    const linkCountChanged: WakeupLinkCountChange[] = [];
    const confidenceDecayed: WakeupConfidenceChange[] = [];
    const added: WakeupChangeItem[] = [];

    // Detect new items and changes in existing items
    for (const item of newItems) {
      const old = oldMap.get(item.slug);
      if (!old) {
        added.push({ slug: item.slug, title: item.title, type: item.page_type });
        continue;
      }
      if (item.content_hash !== old.content_hash) {
        contentUpdated.push({ slug: item.slug, title: item.title, type: item.page_type });
      }
      if (item.tier !== old.tier) {
        tierChanged.push({ slug: item.slug, title: item.title, oldTier: old.tier, newTier: item.tier });
      }
      if (item.link_count !== old.link_count) {
        linkCountChanged.push({
          slug: item.slug, title: item.title,
          oldCount: old.link_count, newCount: item.link_count,
          diff: item.link_count - old.link_count,
        });
      }
      if (old.confidence_decay - item.confidence_decay > CONFIDENCE_DECAY_THRESHOLD) {
        confidenceDecayed.push({ slug: item.slug, title: item.title, oldValue: old.confidence_decay, newValue: item.confidence_decay });
      }
    }

    // Detect removed items
    const removed: WakeupRemovedItem[] = [];
    for (const old of oldItems) {
      if (!newMap.has(old.slug)) {
        removed.push({ slug: old.slug, title: old.title, type: old.page_type });
      }
    }

    // Build summary lines and check truncation
    const lines = this.buildSummaryLines(contentUpdated, tierChanged, linkCountChanged, confidenceDecayed, added, removed);
    const truncated = lines.length > MAX_LINES;
    const truncationReason = truncated ? `共 ${lines.length} 项变化，截断至 ${MAX_LINES} 行` : undefined;

    return {
      stats,
      changes: { contentUpdated, tierChanged, linkCountChanged, confidenceDecayed, removed },
      newItems: added,
      truncated,
      truncationReason,
    };
  }

  private buildSummaryLines(
    contentUpdated: WakeupChangeItem[],
    tierChanged: WakeupTierChange[],
    linkCountChanged: WakeupLinkCountChange[],
    confidenceDecayed: WakeupConfidenceChange[],
    _newItems: WakeupChangeItem[],
    removed: WakeupRemovedItem[],
  ): string[] {
    const lines: string[] = [];

    // Priority order: tier changes > content updates > link changes > confidence decay
    for (const t of tierChanged) {
      const dir = t.newTier < t.oldTier ? "升级" : "降级";
      lines.push(`${t.title}：Tier ${t.oldTier} → ${t.newTier}（${dir}）`);
    }
    for (const c of contentUpdated) {
      lines.push(`${c.title}：内容已更新`);
    }
    for (const l of linkCountChanged) {
      const sign = l.diff > 0 ? "+" : "";
      lines.push(`${l.title}：${sign}${l.diff} 条关系`);
    }
    for (const d of confidenceDecayed) {
      lines.push(`${d.title}：置信度 ${d.oldValue.toFixed(2)} → ${d.newValue.toFixed(2)}`);
    }
    for (const r of removed) {
      lines.push(`${r.title}：已移除`);
    }

    return lines;
  }

  private writeReports(result: WakeupDiffResult): string | null {
    const dir = join(this.outputsDir, "wakeup");
    mkdirSync(dir, { recursive: true });

    const date = result.date;
    const mdPath = join(dir, `wakeup-${date}.md`);
    const jsonPath = join(dir, `wakeup-${date}.json`);
    const latestMd = join(dir, "latest.md");
    const latestJson = join(dir, "latest.json");

    // Build markdown
    const totalChanges = totalChangeCount(result.changes) + result.newItems.length;
    const mdLines: string[] = [`CBrain Wake-up Diff · ${date}`, ""];

    if (totalChanges === 0) {
      mdLines.push(result.baselineCreated ? "已建立基线，暂无变化摘要" : "无认知变化");
    } else {
      // Cognitive changes section
      const changeLines = this.buildSummaryLines(
        result.changes.contentUpdated,
        result.changes.tierChanged,
        result.changes.linkCountChanged,
        result.changes.confidenceDecayed,
        [],
        result.changes.removed,
      );
      if (changeLines.length > 0) {
        const displayed = changeLines.slice(0, MAX_LINES);
        mdLines.push(`认知变化（${changeLines.length} 项）：`);
        for (const line of displayed) {
          mdLines.push(`- ${line}`);
        }
        if (result.truncated) {
          mdLines.push(`- ...（${changeLines.length - MAX_LINES} 项已截断）`);
        }
        mdLines.push("");
      }

      // New items section
      if (result.newItems.length > 0) {
        mdLines.push(`新增记忆项（${result.newItems.length} 个）：`);
        for (const item of result.newItems.slice(0, 10)) {
          mdLines.push(`- ${item.title}（${item.type}）`);
        }
        if (result.newItems.length > 10) {
          mdLines.push(`- ...（${result.newItems.length - 10} 个已截断）`);
        }
      }
    }

    const mdContent = mdLines.join("\n");
    writeFileSync(mdPath, mdContent, "utf-8");
    writeFileSync(latestMd, mdContent, "utf-8");

    // JSON
    const jsonContent = JSON.stringify(result, null, 2);
    writeFileSync(jsonPath, jsonContent, "utf-8");
    writeFileSync(latestJson, jsonContent, "utf-8");

    return mdPath;
  }

  private cleanupOldSnapshots(): void {
    const ids = this.db.getSnapshotIds();
    if (ids.length <= MAX_SNAPSHOTS) return;
    const toDelete = ids.slice(MAX_SNAPSHOTS);
    for (const id of toDelete) {
      this.db.deleteSnapshot(id);
    }
    this.logger?.info("wakeup", "清理旧快照", { deleted: toDelete.length, kept: ids.length - toDelete.length });
  }
}

function totalChangeCount(changes: WakeupDiffResult["changes"]): number {
  return changes.contentUpdated.length + changes.tierChanged.length +
    changes.linkCountChanged.length + changes.confidenceDecayed.length +
    changes.removed.length;
}
