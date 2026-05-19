import { mkdirSync, writeFileSync } from "node:fs";
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
import { findEntitySlug, mapEntityType, buildStubBody, hashContent, normalizeRelation } from "./shared.js";
import { EntityResolver } from "./entity-resolver.js";
import { generateSlug, slugToFilePath } from "../utils/slug.js";
import { stringifyFrontmatter } from "../utils/frontmatter.js";

export type DialogueMode = "auto" | "manual";

export interface DialogueIngestResult {
  decision: "recorded" | "needs_review" | "skipped";
  reason?: string;
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

const AUTO_DIALOGUE_PROMPT = `You are an automatic knowledge extractor for a personal brain system. A conversation snippet has been captured. Your job is to determine if it contains any long-term memorable facts.

## First: Should this be ingested at all?
If the text is chit-chat, greetings, commands, code debugging, opinions without facts, or vague statements → return should_ingest: false with empty arrays.

## If yes, extract ONLY concrete, verifiable facts:
- Named people/companies with SPECIFIC roles, relationships, or events
- Explicit relationships between known entities
- Events with specific dates

## Strictly SKIP:
- Greetings, acknowledgments, thanks
- Commands and instructions
- Opinions, feelings, preferences without concrete facts
- Speculation, guesses, "maybe/perhaps/probably" statements
- Entities mentioned in passing with no new information
- Code, technical debugging content

## Relevance rules (stricter than manual mode):
- "high" = clear, specific, verifiable fact about a named entity
- "medium" = plausible but needs verification
- "low" = incidental mention → ALWAYS skipped in auto mode

## Output Schema (strict JSON):
{"should_ingest": boolean, "entities": [{"name": "实体名", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文片段"}], "relations": [{"from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据"}], "events": [{"date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"]}]}

## Rules
1. Only extract information explicitly stated — no inference
2. When in doubt, set should_ingest: false
3. Return ONLY JSON, no explanation`;

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

  async ingest(text: string, mode: DialogueMode = "manual"): Promise<DialogueIngestResult> {
    const empty: DialogueIngestResult = { decision: "skipped", reason: "empty input", newEntities: 0, newRelations: 0, newEvents: 0, skipped: 0 };

    if (!this.llm || !text.trim()) return empty;

    // Step 1: LLM extraction
    const prompt = mode === "auto" ? AUTO_DIALOGUE_PROMPT : DIALOGUE_PROMPT;
    const truncated = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    let response: string;
    try {
      response = await this.llm.chat([
        { role: "system", content: prompt },
        { role: "user", content: truncated },
      ]);
    } catch (e) {
      console.error("[dialogue] LLM 调用失败", e);
      return { ...empty, reason: "llm error" };
    }

    const result = this.parseResponse(response);
    if (!result) return { ...empty, reason: "parse failed" };

    // Auto mode: check should_ingest flag
    if (mode === "auto" && result.shouldIngest === false) {
      this.writeLog(mode, 0, 0, 0, 0);
      return { ...empty, reason: "no actionable facts" };
    }

    // Step 2: Incremental filter + write
    const { newEntities, newRelations, newEvents, skipped } = this.applyIncremental(result, mode);

    // Step 3: Determine decision
    const hasNew = (newEntities + newRelations + newEvents) > 0;
    const decision = hasNew ? "recorded" : "skipped";

    // Step 4: Write ingest_log
    this.writeLog(mode, newEntities, newRelations, newEvents, skipped);

    return { decision, newEntities, newRelations, newEvents, skipped };
  }

  private parseResponse(raw: string): (ExtractionResult & { shouldIngest?: boolean }) | null {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      return {
        shouldIngest: parsed.should_ingest !== false,
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (e) {
      console.error("[dialogue] LLM 响应 JSON 解析失败", e);
      return null;
    }
  }

  private applyIncremental(result: ExtractionResult, mode: DialogueMode = "manual"): {
    newEntities: number;
    newRelations: number;
    newEvents: number;
    skipped: number;
  } {
    let newEntities = 0;
    let newRelations = 0;
    let newEvents = 0;
    let skipped = 0;

    const entitySlugMap = new Map<string, string>();

    // Resolve all entities through EntityResolver
    const resolver = new EntityResolver(this.db);
    const candidates = result.entities
      .filter(e => {
        if (e.relevance === "low") { skipped++; return false; }
        return true;
      })
      .map(e => ({ name: e.name, type: e.type, relevance: e.relevance }));
    const resolutionMap = resolver.resolveAll(candidates);

    for (const entity of result.entities) {
      if (entity.relevance === "low") continue;

      // Auto mode: medium relevance → candidate log only, no stub file
      if (mode === "auto" && entity.relevance === "medium") {
        this.db.addIngestLog("dialogue", "candidate", "", JSON.stringify({ name: entity.name, type: entity.type }));
        skipped++;
        continue;
      }

      const resolution = resolutionMap.get(entity.name);
      if (!resolution) continue;

      if (resolution.action === "resolved_to_existing" || resolution.action === "alias_added") {
        entitySlugMap.set(entity.name, resolution.slug);
        this.db.incrementMentionCount(resolution.slug);
        skipped++;
      } else if (resolution.action === "duplicate_candidate" || resolution.action === "stub_created") {
        // Create stub file + DB entry
        const pageType = mapEntityType(entity.type);
        const slug = generateSlug(entity.name, pageType);
        const fileName = slugToFilePath(slug);
        const filePath = join(this.vaultPath, fileName);
        const now = new Date().toISOString();
        const body = `> Extracted from dialogue\n\n## Context\n\n${entity.context}`;
        const tags = resolution.action === "duplicate_candidate"
          ? ["auto-extracted", "duplicate-candidate"]
          : ["auto-extracted"];
        const frontmatter = {
          title: entity.name,
          type: pageType,
          slug,
          tags,
          tier: 3,
          created_at: now,
          updated_at: now,
        };

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, stringifyFrontmatter(frontmatter, body), "utf-8");

        const contentHash = hashContent(stringifyFrontmatter(frontmatter, body));
        this.db.upsertPage({
          slug,
          type: pageType,
          title: entity.name,
          filePath: relative(this.vaultPath, filePath),
          contentHash,
        });

        entitySlugMap.set(entity.name, slug);
        this.db.incrementMentionCount(slug);
        newEntities++;
      }
    }

    // Relations
    for (const rel of result.relations) {
      const fromSlug = entitySlugMap.get(rel.from) ?? findEntitySlug(this.db, rel.from);
      const toSlug = entitySlugMap.get(rel.to) ?? findEntitySlug(this.db, rel.to);
      if (!fromSlug || !toSlug) continue;

      const normRel = normalizeRelation(rel.relation);

      if (this.db.linkExists(fromSlug, toSlug, normRel)) continue;

      this.db.insertLink(fromSlug, toSlug, normRel, rel.context ?? null, undefined, undefined, "dialogue", 0.4);

      newRelations++;
    }

    // Events — only those with dates
    for (const event of result.events) {
      if (!event.date) continue;

      const participantSlug = event.participants
        .map((p) => entitySlugMap.get(p) ?? findEntitySlug(this.db, p))
        .find(Boolean);

      if (participantSlug) {
        this.db.addTimelineEntry(participantSlug, event.description, event.date, "dialogue");
      } else {
        this.db.addTimelineEntry("brain/dialogue-events", event.description, event.date, "dialogue");
      }

      newEvents++;
    }

    return { newEntities, newRelations, newEvents, skipped };
  }

  private writeLog(
    mode: DialogueMode,
    newEntities: number,
    newRelations: number,
    newEvents: number,
    skipped: number
  ): void {
    this.db.addIngestLog(
      "dialogue", mode, "dialogue",
      JSON.stringify({ mode, newEntities, newRelations, newEvents, skipped })
    );
  }
}
