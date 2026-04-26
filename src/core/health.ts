import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";
import { AuditLogger, type MetricsSnapshot } from "./audit.js";
import type { Logger } from "./logger.js";

export interface HealthDimension {
  name: string;
  status: "pass" | "warn" | "fail";
  issues: HealthIssue[];
}

export interface HealthIssue {
  severity: "low" | "medium" | "high";
  slug: string;
  title: string;
  description: string;
  suggestion?: string;
}

export interface HealthReport {
  timestamp: string;
  overallStatus: "pass" | "warn" | "fail";
  dimensions: HealthDimension[];
  metrics: MetricsSnapshot;
}

export class HealthChecker {
  private db: CBrainDB;
  private outputsDir: string;
  private audit: AuditLogger;
  private logger: Logger | null;

  constructor(db: CBrainDB, outputsDir: string, logger?: Logger) {
    this.db = db;
    this.outputsDir = outputsDir;
    this.audit = new AuditLogger(outputsDir);
    this.logger = logger ?? null;
  }

  /**
   * Run all 6 health dimensions and write report to outputs/health/.
   */
  async checkAll(): Promise<HealthReport> {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    const metrics = this.collectMetrics();
    const dimensions = [
      this.checkErrors(),
      this.checkSemanticDedup(),
      this.checkSlugCollisions(),
      this.checkConsistency(),
      this.checkCompleteness(),
      this.checkIslands(),
      this.checkNewSuggestions(),
      this.checkAttention(),
      this.checkDataReadiness(),
      this.checkSourceQuality(),
    ];

    const overallStatus = dimensions.some(d => d.status === "fail")
      ? "fail"
      : dimensions.some(d => d.status === "warn")
        ? "warn"
        : "pass";

    const report: HealthReport = {
      timestamp,
      overallStatus,
      dimensions,
      metrics,
    };

    this.writeReport(report);
    this.audit.writeMetrics(metrics);
    this.audit.log(AuditLogger.entry("health_check", overallStatus === "fail" ? "error" : "success", {
      details: {
        dimensions: dimensions.length,
        issues: dimensions.reduce((sum, d) => sum + d.issues.length, 0),
        durationMs: Date.now() - start,
      },
    }));

    return report;
  }

  // ─── Dimension 0: Error Log Check ─────────────────────────

  private checkErrors(): HealthDimension {
    const issues: HealthIssue[] = [];
    if (!this.logger) {
      return { name: "系统错误", status: "pass", issues: [] };
    }

    const recentErrors = this.logger.getRecentErrors(7);
    if (recentErrors.length > 0) {
      issues.push({
        severity: "high",
        slug: "-",
        title: `${recentErrors.length} 个系统错误`,
        description: `最近 7 天发现 ${recentErrors.length} 个错误，涉及模块：${[...new Set(recentErrors.map(e => e.module))].join("、")}`,
        suggestion: "检查 outputs/logs/系统日志-*.md 查看详情",
      });
    }

    return {
      name: "系统错误",
      status: recentErrors.length > 0 ? "fail" : "pass",
      issues,
    };
  }

  // ─── Dimension 1: Semantic Dedup ──────────────────────────

  private checkSemanticDedup(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Find entities with identical or very similar titles (case-insensitive)
    const rows = this.db.prepare(
      `SELECT slug, title, type FROM pages WHERE type IN ('entity', 'concept') ORDER BY title`
    ).all() as Array<{ slug: string; title: string; type: string }>;

    const seen = new Map<string, { slug: string; title: string }>();
    for (const row of rows) {
      const normalized = row.title.toLowerCase().trim();
      const existing = seen.get(normalized);
      if (existing) {
        issues.push({
          severity: "high",
          slug: row.slug,
          title: row.title,
          description: `Duplicate of [[${existing.title}]] (${existing.slug})`,
          suggestion: `Merge into [[${existing.slug}]] or delete duplicate`,
        });
      } else {
        seen.set(normalized, { slug: row.slug, title: row.title });
      }
    }

    // Also check for titles that differ only by punctuation/whitespace
    const strippedMap = new Map<string, { slug: string; title: string }>();
    for (const row of rows) {
      const stripped = row.title.replace(/[\s\-_·.]/g, "").toLowerCase();
      const existing = strippedMap.get(stripped);
      if (existing && existing.slug !== row.slug) {
        const alreadyFlagged = issues.some(i => i.slug === row.slug);
        if (!alreadyFlagged) {
          issues.push({
            severity: "medium",
            slug: row.slug,
            title: row.title,
            description: `Near-duplicate of [[${existing.title}]] (${existing.slug})`,
            suggestion: `Review and merge if same entity`,
          });
        }
      } else {
        strippedMap.set(stripped, { slug: row.slug, title: row.title });
      }
    }

    return {
      name: "语义去重",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 1b: Slug Collision Detection ─────────────────

  private checkSlugCollisions(): HealthDimension {
    const issues: HealthIssue[] = [];

    const entities = this.db.prepare(
      `SELECT slug, title FROM pages WHERE type = 'entity' ORDER BY slug`
    ).all() as Array<{ slug: string; title: string }>;

    // Group slugs by base name (strip numbered suffix like -1, -2)
    const groups = new Map<string, Array<{ slug: string; title: string }>>();
    for (const row of entities) {
      const base = row.slug.replace(/-\d+$/, "");
      const list = groups.get(base) || [];
      list.push(row);
      groups.set(base, list);
    }

    for (const [base, items] of groups) {
      if (items.length <= 1) continue;
      for (const item of items) {
        const others = items.filter(i => i.slug !== item.slug).map(i => `[[${i.slug}]]`).join(", ");
        issues.push({
          severity: "high",
          slug: item.slug,
          title: item.title,
          description: `Potential duplicate — same base slug as ${others}`,
          suggestion: `Use merge_pages to merge duplicates into the canonical page, or verify they are different entities`,
        });
      }
    }

    return {
      name: "疑似重复",
      status: issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 2: Consistency ─────────────────────────────

  private checkConsistency(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Check for relation types that are not in the standard English list
    const standardRelations = new Set([
      "任职于", "认识", "投资了", "创立了", "参加了",
      "提及", "竞争对手", "合作伙伴", "子公司",
      "成员", "指导", "创建者", "影响", "其他",
      // Employment & education
      "下级", "汇报给", "负责", "职位",
      "就读于", "毕业于", "专业", "专业为",
      // Family
      "配偶关系",
      // Organization
      "条线",
    ]);

    const links = this.db.prepare(
      `SELECT from_slug, to_slug, relation FROM links`
    ).all() as Array<{ from_slug: string; to_slug: string; relation: string }>;

    const nonStandardRels = new Set<string>();
    for (const link of links) {
      if (!standardRelations.has(link.relation)) {
        nonStandardRels.add(link.relation);
      }
    }

    if (nonStandardRels.size > 0) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Non-standard relation types",
        description: `Found ${nonStandardRels.size} non-standard relation types: ${[...nonStandardRels].slice(0, 10).join(", ")}`,
        suggestion: "Map to standard English relation types",
      });
    }

    // Check for pages missing frontmatter fields
    const pagesMissingType = this.db.prepare(
      `SELECT slug, title FROM pages WHERE type IS NULL OR type = ''`
    ).all() as Array<{ slug: string; title: string }>;

    for (const p of pagesMissingType) {
      issues.push({
        severity: "high",
        slug: p.slug,
        title: p.title,
        description: "Missing type in frontmatter",
        suggestion: "Add type field to frontmatter",
      });
    }

    return {
      name: "一致性",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 3: Completeness ────────────────────────────

  private checkCompleteness(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Bare stubs: pages with only auto-extracted body and no additional content
    const bareStubs = this.db.prepare(
      `SELECT p.slug, p.title, p.type
       FROM pages p
       WHERE p.type IN ('entity', 'concept')
         AND p.mention_count <= 1
         AND (SELECT COUNT(*) FROM links l WHERE l.from_slug = p.slug OR l.to_slug = p.slug) <= 1`
    ).all() as Array<{ slug: string; title: string; type: string }>;

    for (const stub of bareStubs) {
      issues.push({
        severity: "low",
        slug: stub.slug,
        title: stub.title,
        description: `Bare ${stub.type} stub with minimal content`,
        suggestion: "Enrich with more context or merge into related page",
      });
    }

    return {
      name: "完整性",
      status: bareStubs.length > 20 ? "warn" : bareStubs.length > 0 ? "pass" : "pass",
      issues,
    };
  }

  // ─── Dimension 4: Island Detection ────────────────────────

  private checkIslands(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Pages with no incoming or outgoing links (islands)
    const islands = this.db.prepare(
      `SELECT p.slug, p.title, p.type
       FROM pages p
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.from_slug = p.slug)
         AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_slug = p.slug)
         AND p.type IN ('entity', 'concept')`
    ).all() as Array<{ slug: string; title: string; type: string }>;

    for (const island of islands) {
      issues.push({
        severity: "medium",
        slug: island.slug,
        title: island.title,
        description: `Disconnected ${island.type} — no links in or out`,
        suggestion: "Add links to related pages or verify relevance",
      });
    }

    return {
      name: "孤岛检测",
      status: islands.length > 10 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 5: New Entity Suggestions ──────────────────

  private checkNewSuggestions(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Detect concept inflation: too many concepts relative to sources
    const sourceCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM pages WHERE type IN ('record', 'source', 'event')`
    ).get() as { cnt: number };

    const conceptCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM pages WHERE type = 'concept'`
    ).get() as { cnt: number };

    const ratio = sourceCount.cnt > 0 ? conceptCount.cnt / sourceCount.cnt : 0;

    if (ratio > 5) {
      issues.push({
        severity: "high",
        slug: "-",
        title: "Concept inflation",
        description: `${conceptCount.cnt} concepts from ${sourceCount.cnt} sources (ratio: ${ratio.toFixed(1)}:1). Threshold is ~3:1.`,
        suggestion: "Review and prune low-value concepts. Focus on named frameworks and methodologies.",
      });
    } else if (ratio > 3) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "High concept ratio",
        description: `${conceptCount.cnt} concepts from ${sourceCount.cnt} sources (ratio: ${ratio.toFixed(1)}:1).`,
        suggestion: "Consider reviewing concepts for relevance.",
      });
    }

    return {
      name: "新增建议",
      status: issues.some(i => i.severity === "high") ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 6: Attention Analysis ─────────────────────

  private checkAttention(): HealthDimension {
    const issues: HealthIssue[] = [];

    // High-value pages (tier 1-2) with no recent updates
    const stale = this.db.prepare(
      `SELECT slug, title, type, updated_at
       FROM pages
       WHERE tier <= 2
         AND updated_at < datetime('now', '-30 days')
       ORDER BY updated_at ASC
       LIMIT 20`
    ).all() as Array<{ slug: string; title: string; type: string; updated_at: string }>;

    for (const page of stale) {
      issues.push({
        severity: "low",
        slug: page.slug,
        title: page.title,
        description: `Tier ${page.type} page not updated since ${page.updated_at}`,
        suggestion: "Review and update if needed",
      });
    }

    // Pages with high mention count but low content (popular but thin)
    const popularThin = this.db.prepare(
      `SELECT slug, title, mention_count, type
       FROM pages
       WHERE mention_count >= 3
         AND type IN ('entity', 'concept')
       ORDER BY mention_count DESC
       LIMIT 20`
    ).all() as Array<{ slug: string; title: string; mention_count: number; type: string }>;

    for (const page of popularThin) {
      // Check if it has substantial content (more than just auto-extracted stub)
      const chunkCount = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM chunks WHERE page_slug = $slug`
      ).get({ $slug: page.slug }) as { cnt: number };

      if (chunkCount.cnt <= 1) {
        issues.push({
          severity: "medium",
          slug: page.slug,
          title: page.title,
          description: `Highly mentioned (${page.mention_count}x) but thin content (${chunkCount.cnt} chunk)`,
          suggestion: "Enrich this popular page with more content",
        });
      }
    }

    return {
      name: "关注度分析",
      status: issues.some(i => i.severity === "high") ? "warn" : issues.length > 5 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 7: Data Readiness ────────────────────────

  private checkDataReadiness(): HealthDimension {
    const issues: HealthIssue[] = [];

    const totalPages = this.db.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    if (totalPages.c < 10) {
      issues.push({
        severity: "high",
        slug: "-",
        title: "Insufficient data",
        description: `Only ${totalPages.c} pages indexed. Need at least 10 for meaningful knowledge retrieval.`,
        suggestion: "Ingest more content before expecting quality results. Use `cbrain ingest` or `cbrain sync`.",
      });
    }

    const entityCount = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'entity'").get() as { c: number };
    if (entityCount.c < 3 && totalPages.c >= 10) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Few entities",
        description: `Only ${entityCount.c} entities from ${totalPages.c} pages. NER may not be extracting enough.`,
        suggestion: "Check NER configuration and run `cbrain sync` with NER enabled.",
      });
    }

    const linkCount = this.db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };
    if (linkCount.c < 5 && totalPages.c >= 10) {
      issues.push({
        severity: "medium",
        slug: "-",
        title: "Sparse graph",
        description: `Only ${linkCount.c} links between ${totalPages.c} pages. Knowledge graph is under-connected.`,
        suggestion: "Run `cbrain enrich` to extract more relations, or ingest richer source material.",
      });
    }

    return {
      name: "数据就绪度",
      status: issues.some(i => i.severity === "high") ? "fail" : issues.length > 0 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Dimension 8: Source Quality ────────────────────────

  private checkSourceQuality(): HealthDimension {
    const issues: HealthIssue[] = [];

    // Check for pages with very short content (likely poor quality)
    const thinPages = this.db.prepare(
      `SELECT p.slug, p.title, p.type
       FROM pages p
       WHERE p.type IN ('record', 'source')
         AND (SELECT COUNT(*) FROM chunks c WHERE c.page_slug = p.slug) = 0`
    ).all() as Array<{ slug: string; title: string; type: string }>;

    for (const page of thinPages) {
      issues.push({
        severity: "medium",
        slug: page.slug,
        title: page.title,
        description: `${page.type} page has no indexed content chunks`,
        suggestion: "Re-sync this page or check source file",
      });
    }

    // Check for pages with missing essential frontmatter
    const missingTitle = this.db.prepare(
      `SELECT slug, title FROM pages WHERE title IS NULL OR title = '' OR title = slug`
    ).all() as Array<{ slug: string; title: string }>;

    for (const page of missingTitle) {
      issues.push({
        severity: "low",
        slug: page.slug,
        title: page.title,
        description: "Page has no meaningful title (falls back to slug)",
        suggestion: "Add a descriptive title in frontmatter",
      });
    }

    return {
      name: "原材料质量",
      status: thinPages.length > 10 ? "warn" : "pass",
      issues,
    };
  }

  // ─── Metrics ───────────────────────────────────────────────

  private collectMetrics(): MetricsSnapshot {
    const totalPages = this.db.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number };
    const entities = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'entity'").get() as { c: number };
    const concepts = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'concept'").get() as { c: number };
    const events = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'event'").get() as { c: number };
    const records = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'record'").get() as { c: number };
    const sources = this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'source'").get() as { c: number };
    const totalLinks = this.db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number };
    const avgMentions = this.db.prepare("SELECT AVG(mention_count) as a FROM pages").get() as { a: number };

    const orphans = this.db.prepare(
      `SELECT COUNT(*) as c FROM pages p
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.from_slug = p.slug)
         AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_slug = p.slug)
         AND p.type IN ('entity', 'concept')`
    ).get() as { c: number };

    const bareStubs = this.db.prepare(
      `SELECT COUNT(*) as c FROM pages p
       WHERE p.type IN ('entity', 'concept')
         AND p.mention_count <= 1
         AND (SELECT COUNT(*) FROM links l WHERE l.from_slug = p.slug OR l.to_slug = p.slug) <= 1`
    ).get() as { c: number };

    const sourceCount = records.c + sources.c + events.c;
    const conceptsPerSource = sourceCount > 0 ? concepts.c / sourceCount : 0;

    return {
      timestamp: new Date().toISOString(),
      totalPages: totalPages.c,
      entities: entities.c,
      concepts: concepts.c,
      events: events.c,
      records: records.c,
      sources: sources.c,
      totalLinks: totalLinks.c,
      avgMentionsPerPage: avgMentions.a ?? 0,
      orphans: orphans.c,
      bareStubs: bareStubs.c,
      conceptsPerSource,
      indexSizeKB: 0,
    };
  }

  // ─── Report Writer ────────────────────────────────────────

  private writeReport(report: HealthReport): void {
    const healthDir = join(this.outputsDir, "health");
    mkdirSync(healthDir, { recursive: true });

    const date = report.timestamp.slice(0, 10);
    const filePath = join(healthDir, `健康检查-${date}.md`);

    const statusIcon = (s: string) =>
      s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌";

    const STATUS_CN: Record<string, string> = { pass: "通过", warn: "警告", fail: "失败" };

    let md = `# 健康检查 — ${date}\n\n`;
    md += `**总体状态**: ${statusIcon(report.overallStatus)} ${STATUS_CN[report.overallStatus] ?? report.overallStatus}\n\n`;

    md += `## 指标总览\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| 总页面数 | ${report.metrics.totalPages} |\n`;
    md += `| 实体 | ${report.metrics.entities} |\n`;
    md += `| 概念 | ${report.metrics.concepts} |\n`;
    md += `| 事件 / 记录 / 来源 | ${report.metrics.events} / ${report.metrics.records} / ${report.metrics.sources} |\n`;
    md += `| 总链接数 | ${report.metrics.totalLinks} |\n`;
    md += `| 平均提及次数 | ${report.metrics.avgMentionsPerPage.toFixed(1)} |\n`;
    md += `| 孤岛页面 | ${report.metrics.orphans} |\n`;
    md += `| 空壳 stub | ${report.metrics.bareStubs} |\n`;
    md += `| 概念/来源比 | ${report.metrics.conceptsPerSource.toFixed(2)} |\n\n`;

    for (const dim of report.dimensions) {
      md += `## ${dim.name} ${statusIcon(dim.status)}\n\n`;
      if (dim.issues.length === 0) {
        md += `未发现问题。\n\n`;
        continue;
      }
      md += `| 严重程度 | 页面 | 问题 | 建议 |\n|----------|------|------|------|\n`;
      for (const issue of dim.issues) {
        const pageRef = issue.slug === "-" ? "-" : `[[${issue.slug}]]`;
        md += `| ${issue.severity} | ${pageRef} | ${issue.description} | ${issue.suggestion ?? "-"} |\n`;
      }
      md += `\n`;
    }

    writeFileSync(filePath, md, "utf-8");
  }
}
