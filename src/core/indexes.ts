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
    const rows = this.db.prepare(
      `SELECT p.slug, p.title, p.type, p.tier, p.mention_count, p.updated_at,
              (SELECT COUNT(*) FROM links l WHERE l.from_slug = p.slug OR l.to_slug = p.slug) as link_count
       FROM pages p
       WHERE p.type IN ('entity')
       ORDER BY p.tier ASC, p.mention_count DESC`
    ).all() as Array<IndexPageRow & { link_count: number }>;

    const filePath = join(dir, "All-Entities.md");
    let md = `# All Entities\n\n`;
    md += `> Auto-generated index. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `| Tier | Entity | Mentions | Links | Updated |\n|:-----|:-------|:---------|:------|:--------|\n`;

    for (const row of rows) {
      const tierLabel = row.tier <= 1 ? "⭐" : row.tier === 2 ? "📌" : "·";
      md += `| ${tierLabel} | [[${row.slug}\\|${row.title}]] | ${row.mention_count} | ${row.link_count} | ${row.updated_at.slice(0, 10)} |\n`;
    }

    md += `\n> ${rows.length} entities total\n`;
    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }

  private generateAllConcepts(dir: string): string {
    const rows = this.db.prepare(
      `SELECT p.slug, p.title, p.mention_count, p.updated_at,
              (SELECT COUNT(*) FROM links l WHERE l.from_slug = p.slug OR l.to_slug = p.slug) as link_count
       FROM pages p
       WHERE p.type = 'concept'
       ORDER BY p.mention_count DESC`
    ).all() as Array<IndexPageRow & { link_count: number }>;

    const filePath = join(dir, "All-Concepts.md");
    let md = `# All Concepts\n\n`;
    md += `> Auto-generated index. Last updated: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `| Concept | Mentions | Links | Updated |\n|:--------|:---------|:------|:--------|\n`;

    for (const row of rows) {
      md += `| [[${row.slug}\\|${row.title}]] | ${row.mention_count} | ${row.link_count} | ${row.updated_at.slice(0, 10)} |\n`;
    }

    md += `\n> ${rows.length} concepts total\n`;
    writeFileSync(filePath, md, "utf-8");
    return filePath;
  }

  private generateAllSources(dir: string): string {
    const rows = this.db.prepare(
      `SELECT slug, title, type, updated_at
       FROM pages
       WHERE type IN ('record', 'source', 'event')
       ORDER BY updated_at DESC`
    ).all() as Array<IndexPageRow>;

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
    const totalPages = (this.db.prepare("SELECT COUNT(*) as c FROM pages").get() as { c: number }).c;
    const entities = (this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'entity'").get() as { c: number }).c;
    const concepts = (this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type = 'concept'").get() as { c: number }).c;
    const sources = (this.db.prepare("SELECT COUNT(*) as c FROM pages WHERE type IN ('record', 'source', 'event')").get() as { c: number }).c;
    const links = (this.db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number }).c;

    const topEntities = this.db.prepare(
      `SELECT slug, title, mention_count FROM pages WHERE type = 'entity' ORDER BY mention_count DESC LIMIT 10`
    ).all() as Array<{ slug: string; title: string; mention_count: number }>;

    const recentPages = this.db.prepare(
      `SELECT slug, title, type, updated_at FROM pages ORDER BY updated_at DESC LIMIT 10`
    ).all() as Array<{ slug: string; title: string; type: string; updated_at: string }>;

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
