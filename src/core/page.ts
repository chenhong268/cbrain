import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import {
  PageFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../utils/frontmatter.js";
import { generateSlug, slugToFilePath } from "../utils/slug.js";
import { hashContent } from "./shared.js";

export interface CreatePageInput {
  title: string;
  type: "entity" | "concept" | "event" | "record" | "source";
  body: string;
  tags?: string[];
  slug?: string;
  extra?: Record<string, unknown>;
}

export interface Page {
  slug: string;
  type: string;
  title: string;
  file_path: string;
  content_hash: string;
  tier: number;
  mention_count: number;
  frontmatter: PageFrontmatter;
  body: string;
  created_at: string;
  updated_at: string;
}

export class PageManager {
  private db: CBrainDB;
  private vaultPath: string;

  constructor(db: CBrainDB, vaultPath: string) {
    this.db = db;
    this.vaultPath = vaultPath;
  }

  create(input: CreatePageInput): Page {
    const slug = input.slug || generateSlug(input.title, input.type);
    const fileName = slugToFilePath(slug);
    const filePath = join(this.vaultPath, fileName);

    const now = new Date().toISOString();
    const frontmatter: PageFrontmatter = {
      title: input.title,
      type: input.type,
      slug,
      tags: input.tags || [],
      tier: 3,
      created_at: now,
      updated_at: now,
      ...input.extra,
    };

    const content = stringifyFrontmatter(frontmatter, input.body);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");

    const contentHash = hashContent(content);

    const insertPage = this.db.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, created_at, updated_at)
       VALUES ($slug, $type, $title, $filePath, $contentHash, $tier, $createdAt, $updatedAt)`
    );
    insertPage.run({
      $slug: slug,
      $type: input.type,
      $title: input.title,
      $filePath: relative(this.vaultPath, filePath),
      $contentHash: contentHash,
      $tier: 3,
      $createdAt: now,
      $updatedAt: now,
    });

    if (input.tags && input.tags.length > 0) {
      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)"
      );
      for (const tag of input.tags) {
        insertTag.run({ $slug: slug, $tag: tag });
      }
    }

    return this.getBySlug(slug)!;
  }

  getBySlug(slug: string): Page | null {
    const row = this.db
      .prepare("SELECT * FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as any;

    if (!row) return null;

    const filePath = join(this.vaultPath, row.file_path);
    if (!existsSync(filePath)) return null;

    const { frontmatter, body } = parseFrontmatter(
      readFileSync(filePath, "utf-8")
    );

    return {
      slug: row.slug,
      type: row.type,
      title: row.title,
      file_path: row.file_path,
      content_hash: row.content_hash,
      tier: row.tier,
      mention_count: row.mention_count,
      frontmatter,
      body,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  list(options?: {
    type?: string;
    limit?: number;
    offset?: number;
  }): Page[] {
    let sql = "SELECT slug FROM pages";
    const params: any = {};

    if (options?.type) {
      sql += " WHERE type = $type";
      params.$type = options.type;
    }

    sql += " ORDER BY updated_at DESC";

    if (options?.limit) {
      sql += " LIMIT $limit";
      params.$limit = options.limit;
    }
    if (options?.offset) {
      sql += " OFFSET $offset";
      params.$offset = options.offset;
    }

    const rows = this.db.prepare(sql).all(params) as any[];
    return rows.map((r) => this.getBySlug(r.slug)).filter(Boolean) as Page[];
  }

  update(
    slug: string,
    updates: {
      body?: string;
      tags?: string[];
      extra?: Record<string, unknown>;
    }
  ): Page | null {
    if (slug.startsWith("raw/")) {
      return null; // raw/ is human domain — read-only for CBrain
    }
    const page = this.getBySlug(slug);
    if (!page) return null;

    const now = new Date().toISOString();
    const body = updates.body ?? page.body;
    const frontmatter: PageFrontmatter = {
      ...page.frontmatter,
      updated_at: now,
      ...(updates.extra || {}),
    };

    if (updates.tags) {
      frontmatter.tags = updates.tags;
    }

    const filePath = join(this.vaultPath, page.file_path);
    const content = stringifyFrontmatter(frontmatter, body);
    writeFileSync(filePath, content, "utf-8");

    const contentHash = hashContent(content);
    this.db.prepare(
      `UPDATE pages SET content_hash = $hash, updated_at = $now WHERE slug = $slug`
    ).run({ $hash: contentHash, $now: now, $slug: slug });

    if (updates.tags) {
      this.db
        .prepare("DELETE FROM tags WHERE page_slug = $slug")
        .run({ $slug: slug });
      const insertTag = this.db.prepare(
        "INSERT OR IGNORE INTO tags (page_slug, tag) VALUES ($slug, $tag)"
      );
      for (const tag of updates.tags) {
        insertTag.run({ $slug: slug, $tag: tag });
      }
    }

    return this.getBySlug(slug);
  }

  delete(slug: string): boolean {
    const row = this.db
      .prepare("SELECT file_path FROM pages WHERE slug = $slug")
      .get({ $slug: slug }) as any;
    if (!row) return false;

    const filePath = join(this.vaultPath, row.file_path);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    this.db
      .prepare("DELETE FROM pages WHERE slug = $slug")
      .run({ $slug: slug });
    return true;
  }

  /**
   * Merge source page into target. All links, timeline entries, tags and raw data
   * are moved from source to target. Source body is appended to target body.
   * Source page is deleted after merge. Returns the merged page or null.
   */
  merge(sourceSlug: string, targetSlug: string): Page | null {
    const source = this.getBySlug(sourceSlug);
    const target = this.getBySlug(targetSlug);
    if (!source || !target) return null;
    if (sourceSlug === targetSlug) return null;

    // Create version snapshot of target before merge
    try {
      const targetFilePath = join(this.vaultPath, target.file_path);
      if (existsSync(targetFilePath)) {
        const targetContent = readFileSync(targetFilePath, "utf-8");
        this.db.createVersion(targetSlug, targetContent);
      }
    } catch { /* best-effort */ }

    // Collect everything BEFORE modifying DB
    const sourceBody = source.body || "";
    const targetBody = target.body || "";
    const sourceTags = this.db.getTags(sourceSlug);
    const targetTags = this.db.getTags(targetSlug);

    const mergeDate = new Date().toISOString().slice(0, 10);
    const mergeNote = `\n\n> 合并自 [[${sourceSlug}]] — ${mergeDate}`;
    const mergedBody = targetBody + mergeNote + "\n\n" + sourceBody;

    // Move links: update all references from source → target
    this.db.prepare(
      "UPDATE links SET from_slug = $target WHERE from_slug = $source"
    ).run({ $source: sourceSlug, $target: targetSlug });

    this.db.prepare(
      "UPDATE links SET to_slug = $target WHERE to_slug = $source"
    ).run({ $source: sourceSlug, $target: targetSlug });

    // Move timeline entries
    this.db.prepare(
      "UPDATE timeline SET page_slug = $target WHERE page_slug = $source"
    ).run({ $source: sourceSlug, $target: targetSlug });

    // Merge tags (dedup)
    const allTags = [...new Set([...targetTags, ...sourceTags])];
    // Clear and rewrite tags to avoid stale records
    this.db.prepare("DELETE FROM tags WHERE page_slug = $slug").run({ $slug: targetSlug });
    for (const tag of allTags) {
      this.db.addTag(targetSlug, tag);
    }

    // Write merged body directly (bypass update's re-read of file)
    const targetFilePath = join(this.vaultPath, target.file_path);
    const now = new Date().toISOString();
    const frontmatter = { ...target.frontmatter, updated_at: now, tags: allTags };
    const content = stringifyFrontmatter(frontmatter, mergedBody);
    writeFileSync(targetFilePath, content, "utf-8");

    const contentHash = hashContent(content);
    this.db.prepare(
      "UPDATE pages SET content_hash = $hash, updated_at = $now WHERE slug = $slug"
    ).run({ $hash: contentHash, $now: now, $slug: targetSlug });

    // Delete source page (file + index)
    this.delete(sourceSlug);

    return this.getBySlug(targetSlug);
  }

  incrementMention(slug: string): void {
    this.db
      .prepare(
        "UPDATE pages SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE slug = $slug"
      )
      .run({ $slug: slug });
  }

}
