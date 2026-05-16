import type { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import type { ExtractionResult } from "./ner.js";
import { PageManager } from "./page.js";
import { extractWikiLinks, isValidEntityName } from "./extract.js";
import type { Logger } from "./logger.js";
import {
  chunkContent,
  mapEntityType,
  buildStubBody,
  findEntitySlug,
  resolveEntityName,
  buildLowercaseIndex,
  DEFAULT_CHUNK_SIZE,
  normalizeRelation,
  getRelationStrength,
} from "./shared.js";

export interface PipelineInput {
  slug: string;
  type: string;
  title: string;
  body: string;
  contentHash: string;
  chunks: Array<{ index: number; content: string }>;
  embedResults: Array<{ embedding: number[]; tokenCount: number }>;
  source: "vault" | "api";
}

export interface NerPipelineResult {
  entities: number;
  relations: number;
  events: number;
  stubsCreated: string[];
  lowRelevanceSkipped: number;
  details: {
    entities: Array<{ name: string; type: string; relevance: string }>;
    relations: Array<{ from: string; to: string; relation: string }>;
    events: Array<{ date: string | null; description: string }>;
  };
}

/**
 * Unified write pipeline — single source of truth for indexing, wikilinks, and NER.
 * Used by SyncManager (vault path) and IngestManager (agent API path).
 */
export class ContentPipeline {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private pages: PageManager | null;
  private nerEngine: NerEngine | null;
  private logger: Logger | null;
  private chunkSize: number;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    opts?: {
      pages?: PageManager;
      nerEngine?: NerEngine;
      logger?: Logger;
      chunkSize?: number;
    }
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.pages = opts?.pages ?? null;
    this.nerEngine = opts?.nerEngine ?? null;
    this.logger = opts?.logger ?? null;
    this.chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /** Embed a body into chunks + vectors. Used before calling write() or writeIndexes(). */
  async embed(body: string): Promise<{
    chunks: Array<{ index: number; content: string }>;
    embedResults: Array<{ embedding: number[]; tokenCount: number }>;
  }> {
    const chunks = chunkContent(body, this.chunkSize);
    if (chunks.length === 0) return { chunks: [], embedResults: [] };
    const embedResults = await this.embedding.embedBatch(chunks.map(c => c.content));
    return { chunks, embedResults };
  }

  /**
   * Write indexes for a page. Pre-embedded chunks must be provided.
   * This is the ONE place LanceDB + chunks table + FTS are written.
   */
  writeIndexes(
    slug: string,
    chunks: Array<{ index: number; content: string }>,
    embedResults: Array<{ embedding: number[]; tokenCount: number }>
  ): void {
    if (chunks.length === 0) return;

    this.lance.deleteByPageSlug(slug);
    this.lance.addChunks(
      chunks.map((c, i) => ({
        pageSlug: slug,
        chunkIndex: c.index,
        content: c.content,
        vector: new Float32Array(embedResults[i].embedding),
      }))
    );

    this.db.transaction(() => {
      this.db.deleteChunksByPage(slug);
      this.db.ftsDeleteByPage(slug);
      for (const chunk of chunks) {
        this.db.insertChunk(slug, chunk.index, chunk.content);
      }

      const fullContent = chunks.map(c => c.content).join("\n\n");
      this.db.ftsInsert(slug, fullContent);
    });
  }

  /** Write ingest_log entry for sync/ingest audit trail. */
  writeIngestLog(slug: string, source: "vault" | "api", details: Record<string, unknown>): void {
    this.db.addIngestLog(
      source,
      source === "vault" ? "sync" : "ingest",
      slug,
      JSON.stringify(details)
    );
  }

  /**
   * Extract wikilinks from body and create links. Auto-creates stubs when createStubs=true (sync).
   * Returns the number of links created.
   */
  processWikilinks(fromSlug: string, body: string, createStubs: boolean): number {
    if (!this.pages || !body.trim()) return 0;

    const wikiLinks = extractWikiLinks(body);
    const writtenRelations = new Set<string>();
    let count = 0;

    for (const link of wikiLinks) {
      const targetName = link.display ?? link.target;
      if (link.target.includes("/")) continue;
      if (!isValidEntityName(targetName)) continue;

      const targetSlug = findEntitySlug(this.db, targetName);

      if (!targetSlug && createStubs && link.target.length >= 2) {
        this.pages.create({
          title: targetName,
          type: "entity",
          body: `> Auto-extracted from [[${fromSlug}]]`,
          tags: ["auto-extracted", "wikilink"],
        });
        const newSlug = findEntitySlug(this.db, targetName);
        if (newSlug) {
          const key = `${fromSlug}\x00${newSlug}`;
          if (!writtenRelations.has(key)) {
            writtenRelations.add(key);
            this.db.insertLink(fromSlug, newSlug, "提及", null, 0.3, "weak", "wikilink", 0.9);
            count++;
          }
        }
      } else if (targetSlug && targetSlug !== fromSlug) {
        this.pages.incrementMention(targetSlug);
        const key = `${fromSlug}\x00${targetSlug}`;
        if (!writtenRelations.has(key)) {
          writtenRelations.add(key);
          this.db.insertLink(fromSlug, targetSlug, "提及", null, 0.3, "weak", "wikilink", 0.9);
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Run NER on a page body. Returns structured result or null.
   *
   * @param skipDatelessEvents — ingest skips events without dates (agent content),
   *   sync preserves all events (human-written, dates may be in context).
   */
  async processNer(
    fromSlug: string,
    body: string,
    type: string,
    skipDatelessEvents: boolean,
    precomputed?: ExtractionResult
  ): Promise<NerPipelineResult | null> {
    if (!this.nerEngine) return null;
    if (!body.trim()) return null;
    if (type === "entity" || type === "concept" || type === "insight") return null;

    const extraction = precomputed ?? await this.nerEngine.extract(body);
    if (extraction.entities.length === 0 && extraction.relations.length === 0) {
      return null;
    }

    return this.applyExtraction(fromSlug, extraction, skipDatelessEvents);
  }

  // ─── Private ────────────────────────────────────────────────

  private applyExtraction(
    fromSlug: string,
    extraction: ExtractionResult,
    skipDatelessEvents: boolean
  ): NerPipelineResult {
    const entitySlugMap = new Map<string, string>();
    const stubsCreated = new Set<string>();
    let lowRelevanceSkipped = 0;

    for (const entity of extraction.entities) {
      const existingSlug = findEntitySlug(this.db, entity.name);
      if (existingSlug) {
        entitySlugMap.set(entity.name, existingSlug);
        this.db.incrementMentionCount(existingSlug);
      } else if (this.pages && entity.relevance !== "low" && entity.name.length <= 20) {
        const entityType = mapEntityType(entity.type);
        const stub = this.pages.create({
          title: entity.name,
          type: entityType,
          body: `> Auto-extracted from [[${fromSlug}]]`,
          tags: ["auto-extracted"],
        });
        entitySlugMap.set(entity.name, stub.slug);
        stubsCreated.add(stub.slug);
        this.db.incrementMentionCount(stub.slug);
        this.db.insertLink(fromSlug, stub.slug, "提及", null, 0.3, "weak", "ner", 0.5);
      } else if (entity.relevance === "low") {
        lowRelevanceSkipped++;
      }
    }

    const writtenRelations: Array<{ from: string; to: string; relation: string }> = [];
    const lowerIndex = buildLowercaseIndex(entitySlugMap);
    for (const rel of extraction.relations) {
      const from = resolveEntityName(rel.from, entitySlugMap, this.db, lowerIndex);
      const to = resolveEntityName(rel.to, entitySlugMap, this.db, lowerIndex);
      if (from && to && from !== to) {
        const normRel = normalizeRelation(rel.relation);
        const rw = getRelationStrength(normRel);
        this.db.insertLink(from, to, normRel, rel.context, rw.weight, rw.strength, "ner", 0.5);

        const fromTitle = this.pages?.getBySlug(from)?.title ?? rel.from;
        const toTitle = this.pages?.getBySlug(to)?.title ?? rel.to;
        writtenRelations.push({ from: fromTitle, to: toTitle, relation: normRel });
      }
    }

    if (this.pages) {
      for (const [name, slug] of entitySlugMap) {
        if (!stubsCreated.has(slug)) continue;
        const rels = writtenRelations.filter(r => r.from === name || r.to === name);
        if (rels.length > 0) {
          const body = buildStubBody(name, rels, fromSlug);
          this.pages.update(slug, { body });
        }
      }
    }

    for (const event of extraction.events) {
      if (skipDatelessEvents && !event.date) continue;
      this.db.addTimelineEntry(fromSlug, event.description, event.date ?? undefined, "ner");
    }

    return {
      entities: extraction.entities.length,
      relations: extraction.relations.length,
      events: extraction.events.length,
      stubsCreated: [...stubsCreated],
      lowRelevanceSkipped,
      details: {
        entities: extraction.entities.map(e => ({ name: e.name, type: e.type, relevance: e.relevance })),
        relations: writtenRelations,
        events: extraction.events.map(e => ({ date: e.date, description: e.description })),
      },
    };
  }
}
