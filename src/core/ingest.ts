import { CBrainDB } from "../storage/sqlite.js";
import { PageManager } from "./page.js";
import { generateSlug } from "../utils/slug.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import type { LLMProvider } from "../llm/provider.js";
import { ContentPipeline } from "./pipeline.js";

export interface IngestInput {
  content: string;
  type: "markdown" | "text";
  title?: string;
  tags?: string[];
  pageType?: "entity" | "concept" | "event" | "record" | "source";
  skipNer?: boolean;
}

export interface NerResult {
  entities: number;
  relations: number;
  events: number;
  stubsCreated: string[];
  details: {
    entities: Array<{ name: string; type: string; relevance: string }>;
    relations: Array<{ from: string; to: string; relation: string }>;
    events: Array<{ date: string | null; description: string }>;
    lowRelevanceSkipped: number;
  };
}

export interface IngestResult {
  slug: string;
  created: boolean;
  linksExtracted: number;
  ner?: NerResult;
}

export class IngestManager {
  private db: CBrainDB;
  private pages: PageManager;
  private vaultPath: string;
  private nerEngine: NerEngine | null;
  private pipeline: ContentPipeline;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    vaultPath: string,
    llmProvider?: LLMProvider
  ) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.pages = new PageManager(db, vaultPath);
    this.nerEngine = llmProvider ? new NerEngine(llmProvider) : null;
    this.pipeline = new ContentPipeline(db, embedding, lance, {
      pages: this.pages,
      nerEngine: this.nerEngine ?? undefined,
    });
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.type === "markdown") {
      return this.ingestMarkdown(input.content, { title: input.title, pageType: input.pageType, tags: input.tags, skipNer: input.skipNer });
    }
    return this.ingestText(input);
  }

  private async ingestMarkdown(
    content: string,
    overrides?: { title?: string; pageType?: string; tags?: string[]; skipNer?: boolean }
  ): Promise<IngestResult> {
    const parsed = parseFrontmatter(content);

    const title = parsed.frontmatter.title ?? overrides?.title ?? "Untitled";
    const type = parsed.frontmatter.type ?? overrides?.pageType ?? "record";
    const slug = parsed.frontmatter.slug ?? generateSlug(title, type);
    const body = parsed.body;
    const effectiveTags = parsed.frontmatter.tags ?? overrides?.tags ?? [];

    const { chunks, embedResults } = await this.pipeline.embed(body);

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

    // Clear old wikilink mentions then re-extract (ingest replaces links)
    this.db.prepare("DELETE FROM links WHERE from_slug = $slug AND relation = 'mentions'")
      .run({ $slug: slug });
    const linksExtracted = this.pipeline.processWikilinks(slug, body, false);

    this.pipeline.writeIndexes(slug, chunks, embedResults);
    this.pipeline.writeIngestLog(slug, "api", { chunks: chunks.length });

    // NER runs async — skip entity/concept pages
    const shouldNer = !overrides?.skipNer && type !== "entity" && type !== "concept";
    if (shouldNer) {
      this.pipeline.processNer(slug, body, type, true).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.pipeline.writeIngestLog(slug, "api", { nerError: msg });
      });
    }

    return { slug, created: !existing, linksExtracted };
  }

  private async ingestText(input: IngestInput): Promise<IngestResult> {
    const title = input.title ?? input.content.split("\n").find(l => l.trim())?.trim().slice(0, 50) ?? "Untitled";
    const type = input.pageType ?? "record";
    const slug = generateSlug(title, type);
    const body = input.content;

    const { chunks, embedResults } = await this.pipeline.embed(body);

    this.pages.create({
      title,
      type,
      body,
      tags: input.tags ?? [],
      slug,
    });

    const linksExtracted = this.pipeline.processWikilinks(slug, body, false);

    this.pipeline.writeIndexes(slug, chunks, embedResults);
    this.pipeline.writeIngestLog(slug, "api", { chunks: chunks.length });

    const shouldNer = !input.skipNer && type !== "entity" && type !== "concept";
    if (shouldNer) {
      this.pipeline.processNer(slug, body, type, true).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.pipeline.writeIngestLog(slug, "api", { nerError: msg });
      });
    }

    return { slug, created: true, linksExtracted };
  }
}
