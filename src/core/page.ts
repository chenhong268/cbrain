import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { CBrainDB } from "../storage/sqlite.js";
import {
  PageFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../utils/frontmatter.js";
import { generateSlug, slugToFilePath } from "../utils/slug.js";

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

    const contentHash = this.hashContent(content);

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

    const contentHash = this.hashContent(content);
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

  incrementMention(slug: string): void {
    this.db
      .prepare(
        "UPDATE pages SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE slug = $slug"
      )
      .run({ $slug: slug });
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
}
