import type { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import type { ExtractionResult } from "./ner.js";
import { validateFacts, applyFacts } from "./structured-facts.js";
import { PageManager } from "./page.js";
import { extractWikiLinks, isValidEntityName, stripKnownRelationsSection } from "./extract.js";
import type { Logger } from "./logger.js";
import { EntityResolver } from "./entity-resolver.js";
import { getOntology } from "../ontology/loader.js";
import {
  chunkContent,
  mapEntityType,
  normalizePageType,
  buildStubBody,
  findEntitySlug,
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
  factsWritten: number;
  stubsCreated: string[];
  lowRelevanceSkipped: number;
  filtered: Array<{ name: string; reason: string }>;
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
  async writeIndexes(
    slug: string,
    chunks: Array<{ index: number; content: string }>,
    embedResults: Array<{ embedding: number[]; tokenCount: number }>
  ): Promise<void> {
    if (chunks.length === 0) {
      await this.lance.deleteRawChunksByPageSlug(slug);
      await this.lance.deleteL1VectorByPageSlug(slug);
      this.db.transaction(() => {
        this.db.deleteChunksByPage(slug);
        this.db.ftsDeleteByPage(slug);
        this.db.deleteL1Summary(slug);
      });
      return;
    }
    if (chunks.length !== embedResults.length) {
      throw new Error(`writeIndexes: chunks(${chunks.length}) and embeddings(${embedResults.length}) count mismatch for ${slug}`);
    }

    await this.lance.deleteRawChunksByPageSlug(slug);
    await this.lance.addChunks(
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

      const l1 = this.db.getL1Summary(slug);
      if (l1) this.db.ftsInsert(slug, l1.content);
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
   * Extract wikilinks from body and create links to existing entities.
   * Does NOT create stubs — wikilinks carry no type information, so entity
   * creation is left to NER which classifies properly.
   * Returns the number of links created.
   */
  processWikilinks(fromSlug: string, body: string): { count: number; mentionedSlugs: Set<string> } {
    if (!this.pages || !body.trim()) return { count: 0, mentionedSlugs: new Set() };

    // Strip KR section — it's generated FROM links, parsing it back would create circular writes
    const wikiLinks = extractWikiLinks(stripKnownRelationsSection(body));
    const writtenRelations = new Set<string>();
    const mentionedSlugs = new Set<string>();
    let count = 0;

    for (const link of wikiLinks) {
      // Resolve path-style wikilinks: [[entity/company/xxx]] → leaf name "xxx"
      let lookupName = link.target;
      if (link.target.includes("/")) {
        lookupName = link.target.split("/").pop()!;
      }
      const targetName = link.display ?? lookupName;
      if (!isValidEntityName(targetName)) continue;

      const targetSlug = findEntitySlug(this.db, lookupName);

      if (targetSlug && targetSlug !== fromSlug) {
        this.pages.incrementMention(targetSlug);
        mentionedSlugs.add(targetSlug);
        const key = `${fromSlug}\x00${targetSlug}`;
        if (!writtenRelations.has(key)) {
          writtenRelations.add(key);
          this.db.insertLink(fromSlug, targetSlug, "提及", null, 0.3, "weak", "wikilink", 0.9, undefined, { source_page_slug: fromSlug });
          count++;
        }
      }
    }

    return { count, mentionedSlugs };
  }

  /**
   * Create a graph link from frontmatter `reports_to` field.
   * Mirror of setHierarchy() but triggered by sync instead of agent action.
   */
  processReportsTo(fromSlug: string, frontmatter: Record<string, unknown>): void {
    const reportsTo = frontmatter.reports_to;
    if (!reportsTo || typeof reportsTo !== "string") return;

    const targetSlug = reportsTo.trim();
    if (!targetSlug || targetSlug === fromSlug) return;

    // Only create link if the target page exists
    const target = this.db.getPage(targetSlug);
    if (!target) {
      this.logger?.warn("pipeline", "reports_to target not found", { from: fromSlug, target: targetSlug });
      return;
    }

    // Remove stale links if reports_to changed — filter all, not just first
    const staleLinks = this.db.getOutgoingLinks(fromSlug)
      .filter(l => l.relation === "reports_to" && l.to_slug !== targetSlug);
    for (const link of staleLinks) {
      this.db.deleteLink(fromSlug, link.to_slug, "reports_to");
    }

    // INSERT OR IGNORE — same params as setHierarchy() in hierarchy.ts
    this.db.insertLink(fromSlug, targetSlug, "reports_to", undefined, 1.0, "strong", "agent", 0.95);
    this.logger?.info("pipeline", "reports_to graph link synced", { from: fromSlug, to: targetSlug });
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
    precomputed?: ExtractionResult,
    skipMentionSlugs?: Set<string>
  ): Promise<NerPipelineResult | null> {
    if (!this.nerEngine) return null;
    if (!body.trim()) return null;
    if (getOntology().isDerivedPageType(type)) return null;

    const extraction = precomputed ?? await this.nerEngine.extract(body);
    if (extraction.entities.length === 0 && extraction.relations.length === 0) {
      return null;
    }

    return this.applyExtraction(fromSlug, extraction, skipDatelessEvents, skipMentionSlugs);
  }

  // ─── Private ────────────────────────────────────────────────

  private async applyExtraction(
    fromSlug: string,
    extraction: ExtractionResult,
    skipDatelessEvents: boolean,
    skipMentionSlugs?: Set<string>
  ): Promise<NerPipelineResult> {
    const entitySlugMap = new Map<string, string>();
    const stubsCreated = new Set<string>();

    const resolver = new EntityResolver(this.db, this.nerEngine?.provider);
    const candidates = extraction.entities
      .map(e => ({ name: e.name, type: e.type, relevance: e.relevance }));
    const resolutionMap = resolver.resolveAll(candidates);
    await resolver.semanticResolve(resolutionMap, candidates);

    for (const entity of extraction.entities) {
      const result = resolutionMap.get(entity.name);
      if (!result) continue;

      if (result.action === "resolved_to_existing" || result.action === "alias_added") {
        entitySlugMap.set(entity.name, result.slug);
        if (!skipMentionSlugs?.has(result.slug)) {
          this.db.incrementMentionCount(result.slug);
        }
        // Correct type if NER classification differs from existing stub
        const nerType = mapEntityType(entity.type);
        const existingType = this.db.getEntityType(result.slug);
        if (existingType && existingType !== nerType && this.pages) {
          const ontology = getOntology();
          const winner = ontology.resolveTypePriority(existingType, normalizePageType(nerType));
          if (winner !== existingType) {
            this.pages.updateType(result.slug, winner);
          }
        }
      } else if (result.action === "duplicate_candidate") {
        entitySlugMap.set(entity.name, result.slug);
        if (!skipMentionSlugs?.has(result.slug)) {
          this.db.incrementMentionCount(result.slug);
        }
        this.db.insertLink(fromSlug, result.slug, "提及", null, 0.3, "weak", "ner", 0.5, undefined, { source_page_slug: fromSlug });
      } else if (result.action === "stub_created" && this.pages && entity.name.length <= 20) {
        const entityType = mapEntityType(entity.type);
        const stub = this.pages.create({
          title: entity.name,
          type: entityType,
          body: `> Auto-extracted from [[${fromSlug}]]`,
          tags: ["auto-extracted"],
        });
        entitySlugMap.set(entity.name, stub.slug);
        stubsCreated.add(stub.slug);
        if (!skipMentionSlugs?.has(stub.slug)) {
          this.db.incrementMentionCount(stub.slug);
        }
        this.db.insertLink(fromSlug, stub.slug, "提及", null, 0.3, "weak", "ner", 0.5, undefined, { source_page_slug: fromSlug });
      }
    }

    // Structured facts: validate and write to frontmatter
    let factsWritten = 0;
    if (extraction.facts.length > 0 && this.pages) {
      const validEntityNames = new Set(extraction.entities.map(e => e.name));
      const entityTypeMap = new Map(extraction.entities.map(e => [e.name, e.type]));
      const resolvedForFacts = new Map<string, string>();
      for (const entity of extraction.entities) {
        const result = resolutionMap.get(entity.name);
        if (result && (result.action === "resolved_to_existing" || result.action === "alias_added")) {
          resolvedForFacts.set(entity.name, result.slug);
        }
      }
      const valid = validateFacts(extraction.facts, validEntityNames, entityTypeMap);
      const factResult = applyFacts(valid, resolvedForFacts, this.pages, this.db);
      factsWritten = factResult.written;
      if (factResult.conflicts.length > 0) {
        this.logger?.info("pipeline", "facts skipped (fields already set)", { conflicts: factResult.conflicts });
      }
    }

    const writtenRelations: Array<{ from: string; to: string; relation: string }> = [];
    for (const rel of extraction.relations) {
      const from = entitySlugMap.get(rel.from) ?? findEntitySlug(this.db, rel.from);
      const to = entitySlugMap.get(rel.to) ?? findEntitySlug(this.db, rel.to);
      if (from && to && from !== to) {
        const normRel = normalizeRelation(rel.relation);
        const rw = getRelationStrength(normRel);
        this.db.insertLink(from, to, normRel, rel.context, rw.weight, rw.strength, "ner", 0.5, undefined, { source_page_slug: fromSlug, evidence: rel.context });

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
      this.db.addTimelineEntry(fromSlug, event.description, event.date ?? undefined, "ner", { source_page_slug: fromSlug });
    }

    return {
      entities: extraction.entities.length,
      relations: extraction.relations.length,
      events: extraction.events.length,
      factsWritten,
      stubsCreated: [...stubsCreated],
      lowRelevanceSkipped: 0,
      filtered: extraction.filtered ?? [],
      details: {
        entities: extraction.entities.map(e => ({ name: e.name, type: e.type, relevance: e.relevance })),
        relations: writtenRelations,
        events: extraction.events.map(e => ({ date: e.date, description: e.description })),
      },
    };
  }
}
