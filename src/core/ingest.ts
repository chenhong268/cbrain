import { CBrainDB } from "../storage/sqlite.js";
import { PageManager } from "./page.js";
import { SyncManager } from "./sync.js";
import { generateSlug } from "../utils/slug.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import type { LLMProvider } from "../llm/provider.js";
import {
  chunkContent,
  mapEntityType,
  buildStubBody,
  findEntitySlug,
  resolveEntityName,
} from "./shared.js";

export interface IngestInput {
  content: string;
  type: "markdown" | "text";
  title?: string;
  tags?: string[];
  pageType?: "entity" | "concept" | "event" | "record" | "source";
}

export interface NerResult {
  entities: number;
  relations: number;
  events: number;
  stubsCreated: string[];
  details: {
    entities: Array<{ name: string; type: string }>;
    relations: Array<{ from: string; to: string; relation: string }>;
    events: Array<{ date: string | null; description: string }>;
  };
}

export interface IngestResult {
  slug: string;
  created: boolean;
  linksExtracted: number;
  ner?: NerResult;
}

const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

export class IngestManager {
  private db: CBrainDB;
  private pages: PageManager;
  private sync: SyncManager;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private vaultPath: string;
  private nerEngine: NerEngine | null;

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
    this.sync = new SyncManager(db, embedding, lance);
    this.embedding = embedding;
    this.lance = lance;
    this.nerEngine = llmProvider ? new NerEngine(llmProvider) : null;
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

    const nerResult = await this.runNer(slug, body);

    return {
      slug,
      created: !existing,
      linksExtracted: links.length,
      ner: nerResult,
    };
  }

  private async ingestText(input: IngestInput): Promise<IngestResult> {
    const title = input.title ?? input.content.split("\n").find(l => l.trim())?.trim().slice(0, 50) ?? "Untitled";
    const type = input.pageType ?? "record";
    const slug = generateSlug(title, type);
    const body = input.content;

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

    const nerResult = await this.runNer(slug, body);

    return {
      slug,
      created: true,
      linksExtracted: links.length,
      ner: nerResult,
    };
  }

  private async embedChunks(
    body: string
  ): Promise<{ chunks: Array<{ index: number; content: string }>; embedResults: Array<{ embedding: number[]; tokenCount: number }> }> {
    const chunks = chunkContent(body);
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

  private async runNer(
    fromSlug: string,
    text: string
  ): Promise<IngestResult["ner"]> {
    if (!this.nerEngine) return undefined;

    const extraction = await this.nerEngine.extract(text);
    if (extraction.entities.length === 0 && extraction.relations.length === 0) {
      return {
        entities: 0, relations: 0, events: 0, stubsCreated: [],
        details: { entities: [], relations: [], events: [] },
      };
    }

    const stubsCreated: string[] = [];
    const entitySlugMap = new Map<string, string>();

    for (const entity of extraction.entities) {
      const existingSlug = findEntitySlug(this.db, entity.name);
      if (existingSlug) {
        entitySlugMap.set(entity.name, existingSlug);
        this.pages.incrementMention(existingSlug);
      } else {
        const entityType = mapEntityType(entity.type);
        const stub = this.pages.create({
          title: entity.name,
          type: entityType,
          body: `> Auto-extracted from [[${fromSlug}]]`,
          tags: ["auto-extracted"],
        });
        entitySlugMap.set(entity.name, stub.slug);
        stubsCreated.push(stub.slug);
      }
    }

    const writtenRelations: Array<{ from: string; to: string; relation: string }> = [];
    for (const rel of extraction.relations) {
      const fromSlugResolved = resolveEntityName(rel.from, entitySlugMap, this.db);
      const toSlugResolved = resolveEntityName(rel.to, entitySlugMap, this.db);
      if (fromSlugResolved && toSlugResolved && fromSlugResolved !== toSlugResolved) {
        this.db.prepare(
          `INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)`
        ).run({ $from: fromSlugResolved, $to: toSlugResolved, $rel: rel.relation, $ctx: rel.context });

        const fromTitle = this.pages.getBySlug(fromSlugResolved)?.title ?? rel.from;
        const toTitle = this.pages.getBySlug(toSlugResolved)?.title ?? rel.to;
        writtenRelations.push({ from: fromTitle, to: toTitle, relation: rel.relation });
      }
    }

    for (const [name, slug] of entitySlugMap) {
      if (!stubsCreated.includes(slug)) continue;
      const rels = writtenRelations.filter(r => r.from === name || r.to === name);
      if (rels.length > 0) {
        const body = buildStubBody(name, rels, fromSlug);
        this.pages.update(slug, { body });
      }
    }

    for (const event of extraction.events) {
      if (!event.date) continue;
      this.db.prepare(
        `INSERT INTO timeline (page_slug, event_date, source, summary) VALUES ($slug, $date, $source, $summary)`
      ).run({
        $slug: fromSlug,
        $date: event.date,
        $source: "ner",
        $summary: event.description,
      });
    }

    return {
      entities: extraction.entities.length,
      relations: extraction.relations.length,
      events: extraction.events.length,
      stubsCreated,
      details: {
        entities: extraction.entities.map(e => ({ name: e.name, type: e.type })),
        relations: writtenRelations,
        events: extraction.events.map(e => ({ date: e.date, description: e.description })),
      },
    };
  }
}
