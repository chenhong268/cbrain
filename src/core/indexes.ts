import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../storage/sqlite.js";

interface IndexPageRow {
  slug: string;
  title: string;
  type: string;
  tier: number;
  mention_count: number;
  updated_at: string;
}

export class IndexGenerator {
  private db: CBrainDB;
  private outputsDir: string;

  constructor(db: CBrainDB, outputsDir: string) {
    this.db = db;
    this.outputsDir = outputsDir;
  }

  generateAll(): string[] {
    const indexDir = join(this.outputsDir, "indexes");
    mkdirSync(indexDir, { recursive: true });

    const files: string[] = [];

    files.push(this.generateAllEntities(indexDir));
    files.push(this.generateAllConcepts(indexDir));
    files.push(this.generateAllSources(indexDir));
    files.push(this.generateDashboard(indexDir));

    return files;
  }

  private generateAllEntities(dir: string): string {
    const rows = this.db.getPagesWithLinkCount(
      ["entity"],
      "tier ASC, mention_count DESC"
    );

    const filePath = join(dir, "All-Entities.md");
    let md = `# All Entities\n\n`;
    md += `> Auto-generated index. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `| Tier | Entity | Mentions | Links | Updated |\n|:-----|:-------|:---------|:------|:--------|\n`;

    // Need tier/mention_count/updated_at — fetch full page rows
    const slugs = rows.map(r => r.slug);
    const pageMap = new Map(this.db.getPagesBySlugs(slugs).map(p => [p.slug, p]));

    for (const row of rows) {
      const page = pageMap.get(row.slug);
      const tier = page?.tier ?? 3;
      const mentions = page?.mention_count ?? 0;
      const updated = page?.updated_at?.slice(0, 10) ?? "-";
      const tierLabel = tier <= 1 ? "⭐" : tier === 2 ? "📌" : "·";
      md += `| ${tierLabel} | [[${row.slug}\\|${row.title}]] | ${mentions} | ${row.link_count} | ${updated} |\n`;
    }

    md += `\n> ${rows.length} entities total\n`;
    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }

  private generateAllConcepts(dir: string): string {
    const rows = this.db.getPagesWithLinkCount(
      ["concept"],
      "mention_count DESC"
    );

    const filePath = join(dir, "All-Concepts.md");
    let md = `# All Concepts\n\n`;
    md += `> Auto-generated index. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `| Concept | Mentions | Links | Updated |\n|:--------|:---------|:------|:--------|\n`;

    const slugs = rows.map(r => r.slug);
    const pageMap = new Map(this.db.getPagesBySlugs(slugs).map(p => [p.slug, p]));

    for (const row of rows) {
      const page = pageMap.get(row.slug);
      const mentions = page?.mention_count ?? 0;
      const updated = page?.updated_at?.slice(0, 10) ?? "-";
      md += `| [[${row.slug}\\|${row.title}]] | ${mentions} | ${row.link_count} | ${updated} |\n`;
    }

    md += `\n> ${rows.length} concepts total\n`;
    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }

  private generateAllSources(dir: string): string {
    const rows = this.db.listPages({
      types: ["record", "source", "event"],
      orderBy: "updated_at DESC",
    });

    const filePath = join(dir, "All-Sources.md");
    let md = `# All Sources\n\n`;
    md += `> Auto-generated index. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `| Type | Title | Updated |\n|:-----|:------|:--------|\n`;

    for (const row of rows) {
      const typeLabel = row.type === "event" ? "📅" : row.type === "source" ? "📄" : "📝";
      md += `| ${typeLabel} ${row.type} | [[${row.slug}\\|${row.title}]] | ${row.updated_at.slice(0, 10)} |\n`;
    }

    md += `\n> ${rows.length} sources total\n`;
    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }

  private generateDashboard(dir: string): string {
    const totalPages = this.db.getPageCount();
    const entities = this.db.getPageCountByType("entity");
    const concepts = this.db.getPageCountByType("concept");
    const sources = this.db.getPageCountByTypes(["record", "source", "event"]);
    const links = this.db.getLinkCount();

    const topEntities = this.db.getTopMentionedEntities(10);

    const recentPages = this.db.listPages({
      orderBy: "updated_at DESC",
      limit: 10,
    });

    const filePath = join(dir, "Dashboard.md");
    let md = `# CBrain Dashboard\n\n`;
    md += `> Auto-generated. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;

    md += `## Overview\n\n`;
    md += `| Metric | Count |\n|:-------|:------|\n`;
    md += `| Total Pages | ${totalPages} |\n`;
    md += `| Entities | ${entities} |\n`;
    md += `| Concepts | ${concepts} |\n`;
    md += `| Sources | ${sources} |\n`;
    md += `| Links | ${links} |\n\n`;

    md += `## Top Entities\n\n`;
    for (const e of topEntities) {
      md += `- [[${e.slug}\\|${e.title}]] (${e.mention_count} mentions)\n`;
    }

    md += `\n## Recent Updates\n\n`;
    for (const p of recentPages) {
      md += `- [[${p.slug}\\|${p.title}]] — ${p.type} — ${p.updated_at.slice(0, 10)}\n`;
    }

    md += `\n---\n\n`;
    md += `## Indexes\n\n`;
    md += `- [[All-Entities]]\n`;
    md += `- [[All-Concepts]]\n`;
    md += `- [[All-Sources]]\n`;

    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }
}
