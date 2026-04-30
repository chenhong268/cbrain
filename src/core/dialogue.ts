import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import {
  ExtractionResult,
  ExtractedEntity,
  ExtractedRelation,
  ExtractedEvent,
} from "./ner.js";
import { findEntitySlug, mapEntityType, buildStubBody, hashContent } from "./shared.js";
import { generateSlug, slugToFilePath } from "../utils/slug.js";
import { stringifyFrontmatter } from "../utils/frontmatter.js";

export interface DialogueIngestResult {
  newEntities: number;
  newRelations: number;
  newEvents: number;
  skipped: number;
}

const DIALOGUE_PROMPT = `You are extracting knowledge from a conversation (dialogue between user and assistant). Extract ONLY concrete, verifiable facts that are worth remembering long-term.

## What to extract
- Named people, companies, products — with concrete facts (roles, relationships, events)
- Explicit relationships between entities (works_at, knows, founded, etc.)
- Events with specific dates or clear timeframes

## What NOT to extract
- Chit-chat, greetings, acknowledgments
- Opinions, preferences without facts
- Vague references without specific details
- Entities already mentioned in passing with no new information

## Output Schema (strict JSON)
{
  "entities": [{ "name": "实体名", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文片段" }],
  "relations": [{ "from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据" }],
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }]
}

## Rules
1. Only extract information explicitly stated — no inference
2. High relevance only: the main subjects and key facts
3. Skip entities without meaningful context
4. Return empty arrays if nothing worth extracting
5. Return ONLY JSON, no explanation`;

export class DialogueIngest {
  private db: CBrainDB;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private vaultPath: string;
  private llm?: LLMProvider;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    vaultPath: string,
    llm?: LLMProvider
  ) {
    this.db = db;
    this.embedding = embedding;
    this.lance = lance;
    this.vaultPath = vaultPath;
    this.llm = llm;
  }

  async ingest(text: string): Promise<DialogueIngestResult> {
    const empty: DialogueIngestResult = { newEntities: 0, newRelations: 0, newEvents: 0, skipped: 0 };

    if (!this.llm || !text.trim()) return empty;

    // Step 1: LLM extraction
    const truncated = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    let response: string;
    try {
      response = await this.llm.chat([
        { role: "system", content: DIALOGUE_PROMPT },
        { role: "user", content: truncated },
      ]);
    } catch {
      return empty;
    }

    const result = this.parseResponse(response);
    if (!result) return empty;

    // Step 2: Incremental filter + write
    const { newEntities, newRelations, newEvents, skipped } = this.applyIncremental(result);

    // Step 3: Write ingest_log
    this.writeLog(newEntities, newRelations, newEvents, skipped);

    return { newEntities, newRelations, newEvents, skipped };
  }

  private parseResponse(raw: string): ExtractionResult | null {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      return {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return null;
    }
  }

  private applyIncremental(result: ExtractionResult): {
    newEntities: number;
    newRelations: number;
    newEvents: number;
    skipped: number;
  } {
    let newEntities = 0;
    let newRelations = 0;
    let newEvents = 0;
    let skipped = 0;

    // Track which entities are new (name → slug) so relations can reference them
    const entitySlugMap = new Map<string, string>();

    // Entities
    for (const entity of result.entities) {
      const existing = findEntitySlug(this.db, entity.name);
      if (existing) {
        // Already known — increment mention count
        this.db.prepare(
          "UPDATE pages SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE slug = $slug"
        ).run({ $slug: existing });
        entitySlugMap.set(entity.name, existing);
        skipped++;
        continue;
      }

      // New entity — create stub
      const pageType = mapEntityType(entity.type);
      const slug = generateSlug(entity.name, pageType);
      const fileName = slugToFilePath(slug);
      const filePath = join(this.vaultPath, fileName);
      const now = new Date().toISOString();
      const body = `> Extracted from dialogue\n\n## Context\n\n${entity.context}`;
      const frontmatter = {
        title: entity.name,
        type: pageType,
        slug,
        tags: [] as string[],
        tier: 3,
        created_at: now,
        updated_at: now,
      };

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, stringifyFrontmatter(frontmatter, body), "utf-8");

      const contentHash = hashContent(stringifyFrontmatter(frontmatter, body));
      this.db.prepare(
        `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, created_at, updated_at)
         VALUES ($slug, $type, $title, $filePath, $contentHash, $tier, $createdAt, $updatedAt)`
      ).run({
        $slug: slug,
        $type: pageType,
        $title: entity.name,
        $filePath: relative(this.vaultPath, filePath),
        $contentHash: contentHash,
        $tier: 3,
        $createdAt: now,
        $updatedAt: now,
      });

      entitySlugMap.set(entity.name, slug);
      newEntities++;
    }

    // Relations
    for (const rel of result.relations) {
      const fromSlug = entitySlugMap.get(rel.from) ?? findEntitySlug(this.db, rel.from);
      const toSlug = entitySlugMap.get(rel.to) ?? findEntitySlug(this.db, rel.to);
      if (!fromSlug || !toSlug) continue;

      // Check if relation already exists
      const existing = this.db.prepare(
        "SELECT 1 FROM links WHERE from_slug = $from AND to_slug = $to AND relation = $rel"
      ).get({ $from: fromSlug, $to: toSlug, $rel: rel.relation });

      if (existing) continue;

      this.db.prepare(
        "INSERT OR IGNORE INTO links (from_slug, to_slug, relation, context) VALUES ($from, $to, $rel, $ctx)"
      ).run({ $from: fromSlug, $to: toSlug, $rel: rel.relation, $ctx: rel.context ?? null });

      newRelations++;
    }

    // Events — only those with dates
    for (const event of result.events) {
      if (!event.date) continue;

      // Find a participant slug to attach the event to
      const participantSlug = event.participants
        .map((p) => entitySlugMap.get(p) ?? findEntitySlug(this.db, p))
        .find(Boolean);

      if (participantSlug) {
        this.db.addTimelineEntry(participantSlug, event.description, event.date, "dialogue");
      } else {
        // No known participant — write to a generic dialogue log
        this.db.addTimelineEntry("brain/dialogue-events", event.description, event.date, "dialogue");
      }

      newEvents++;
    }

    return { newEntities, newRelations, newEvents, skipped };
  }

  private writeLog(
    newEntities: number,
    newRelations: number,
    newEvents: number,
    skipped: number
  ): void {
    this.db.prepare(
      `INSERT INTO ingest_log (source_type, action, page_slug, details, created_at)
       VALUES ($sourceType, $action, $slug, $details, datetime('now'))`
    ).run({
      $sourceType: "dialogue",
      $action: "dialogue",
      $slug: "dialogue",
      $details: JSON.stringify({ newEntities, newRelations, newEvents, skipped }),
    });
  }
}
