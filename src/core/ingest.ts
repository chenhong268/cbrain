import { CBrainDB } from "../storage/sqlite.js";
import { PageManager } from "./page.js";
import { SyncManager } from "./sync.js";
import { generateSlug } from "../utils/slug.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";

export interface IngestInput {
  content: string;
  type: "markdown" | "text";
  title?: string;
  tags?: string[];
  pageType?: "entity" | "concept" | "event" | "record" | "source";
}

export interface IngestResult {
  slug: string;
  created: boolean;
  linksExtracted: number;
}

const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

export class IngestManager {
  private db: CBrainDB;
  private pages: PageManager;
  private sync: SyncManager;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private vaultPath: string;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    vaultPath: string
  ) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.pages = new PageManager(db, vaultPath);
    this.sync = new SyncManager(db, embedding, lance);
    this.embedding = embedding;
    this.lance = lance;
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.type === "markdown") {
      return this.ingestMarkdown(input.content, { title: input.title, pageType: input.pageType, tags: input.tags });
    }
    return this.ingestText(input);
  }

  private async ingestMarkdown(
    content: string,
    overrides?: { title?: string; pageType?: string; tags?: string[] }
  ): Promise<IngestResult> {
    const parsed = parseFrontmatter(content);

    const title = parsed.frontmatter.title ?? overrides?.title ?? "Untitled";
    const type = parsed.frontmatter.type ?? overrides?.pageType ?? "record";
    const slug = parsed.frontmatter.slug ?? generateSlug(title, type);
    const body = parsed.body;
    const effectiveTags = parsed.frontmatter.tags ?? overrides?.tags ?? [];

    // Embed first — fail fast before writing anything
    const { chunks, embedResults } = await this.embedChunks(body);

    const existing = this.pages.getBySlug(slug);
    if (existing) {
      this.pages.update(slug, { body, tags: effectiveTags });
    } else {
      this.pages.create({
        title,
        type,
        body,
        tags: effectiveTags,
        slug,
      });
    }

    const links = this.extractWikiLinks(body);
    this.upsertLinks(slug, links);

    await this.writeIndexes(slug, chunks, embedResults);

    return {
      slug,
      created: !existing,
      linksExtracted: links.length,
    };
  }

  private async ingestText(input: IngestInput): Promise<IngestResult> {
    const title = input.title ?? input.content.split("\n").find(l => l.trim())?.trim().slice(0, 50) ?? "Untitled";
    const type = input.pageType ?? "record";
    const slug = generateSlug(title, type);
    const body = input.content;

    // Embed first — fail fast before writing anything
    const { chunks, embedResults } = await this.embedChunks(body);

    this.pages.create({
      title,
      type,
      body,
      tags: input.tags ?? [],
      slug,
    });

    const links = this.extractWikiLinks(body);
    this.upsertLinks(slug, links);

    await this.writeIndexes(slug, chunks, embedResults);

    return {
      slug,
      created: true,
      linksExtracted: links.length,
    };
  }

  private async embedChunks(
    body: string
  ): Promise<{ chunks: Array<{ index: number; content: string }>; embedResults: Array<{ embedding: number[]; tokenCount: number }> }> {
    const chunks = this.chunkContent(body);
    if (chunks.length === 0) {
      return { chunks: [], embedResults: [] };
    }
    const embedResults = await this.embedding.embedBatch(
      chunks.map((c) => c.content)
    );
    return { chunks, embedResults };
  }

  private async writeIndexes(
    slug: string,
    chunks: Array<{ index: number; content: string }>,
    embedResults: Array<{ embedding: number[]; tokenCount: number }>
  ): Promise<void> {
    if (chunks.length === 0) return;

    await this.lance.deleteByPageSlug(slug);
    await this.lance.addChunks(
      chunks.map((c, i) => ({
        pageSlug: slug,
        chunkIndex: c.index,
        content: c.content,
        vector: new Float32Array(embedResults[i].embedding),
      }))
    );

    this.db.prepare("DELETE FROM chunks WHERE page_slug = $slug").run({
      $slug: slug,
    });
    this.db.ftsDeleteByPage(slug);
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (page_slug, chunk_index, content) VALUES ($slug, $idx, $content)"
    );
    for (const chunk of chunks) {
      insertChunk.run({ $slug: slug, $idx: chunk.index, $content: chunk.content });
    }

    const fullContent = chunks.map((c) => c.content).join("\n\n");
    this.db.ftsInsert(slug, fullContent);

    this.db.prepare(
      `INSERT INTO ingest_log (source_type, action, page_slug, details) VALUES ($source, $action, $slug, $details)`
    ).run({
      $source: "vault",
      $action: "sync",
      $slug: slug,
      $details: JSON.stringify({ chunks: chunks.length }),
    });
  }

  private chunkContent(body: string): Array<{ index: number; content: string }> {
    if (!body.trim()) return [];

    const paragraphs = body.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks: Array<{ index: number; content: string }> = [];
    let current = "";
    let index = 0;

    for (const para of paragraphs) {
      if (current.length + para.length > 500 && current.length > 0) {
        chunks.push({ index, content: current.trim() });
        index++;
        current = para;
      } else {
        current = current.length > 0 ? current + "\n\n" + para : para;
      }
    }

    if (current.trim()) {
      chunks.push({ index, content: current.trim() });
    }

    return chunks;
  }

  extractWikiLinks(text: string): string[] {
    const links = new Set<string>();
    let match: RegExpExecArray | null;
    const re = new RegExp(WIKI_LINK_RE.source, WIKI_LINK_RE.flags);

    while ((match = re.exec(text)) !== null) {
      links.add(match[1]);
    }

    return Array.from(links);
  }

  private upsertLinks(fromSlug: string, linkTargets: string[]): void {
    this.db
      .prepare("DELETE FROM links WHERE from_slug = $slug")
      .run({ $slug: fromSlug });

    const insertLink = this.db.prepare(
      `INSERT OR IGNORE INTO links (from_slug, to_slug, relation) VALUES ($from, $to, $rel)`
    );

    for (const target of linkTargets) {
      const toSlug = this.resolveLinkTarget(target);
      if (toSlug && toSlug !== fromSlug) {
        insertLink.run({ $from: fromSlug, $to: toSlug, $rel: "mentions" });
        this.pages.incrementMention(toSlug);
      }
    }
  }

  private resolveLinkTarget(linkText: string): string | null {
    const bySlug = this.db
      .prepare("SELECT slug FROM pages WHERE slug = $text")
      .get({ $text: linkText }) as { slug: string } | null;
    if (bySlug) return bySlug.slug;

    const byTitle = this.db
      .prepare("SELECT slug FROM pages WHERE title = $text")
      .get({ $text: linkText }) as { slug: string } | null;
    if (byTitle) return byTitle.slug;

    return null;
  }
}
