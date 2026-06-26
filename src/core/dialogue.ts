import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { CBrainDB } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import type { LanceDBManager } from "../storage/lancedb.js";
import type { Logger } from "./logger.js";
import type { PageManager } from "./page.js";
import {
  ExtractionResult,
  StructuredFact,
  getFactFieldWhitelist,
  type EntityType,
  filterExtractedEntities,
  filterRelations,
} from "./ner.js";
import { findEntitySlug, mapEntityType, hashContent, normalizeRelation } from "./shared.js";
import { EntityResolver } from "./entity-resolver.js";
import { generateSlug, slugToFilePath } from "../utils/slug.js";
import { stringifyFrontmatter, readPageFile, writePageFile } from "../utils/frontmatter.js";

export type DialogueMode = "auto" | "manual";

export interface DialogueIngestResult {
  decision: "recorded" | "needs_review" | "skipped";
  reason?: string;
  newEntities: number;
  newRelations: number;
  newEvents: number;
  skipped: number;
  filtered: Array<{ name: string; type: string; relevance: string; reason: string }>;
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
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }],
  "facts": [{ "entity": "实体名", "field": "字段名", "value": "值", "confidence": 0.9, "evidence": "原文引用" }]
}

## Structured Facts
Extract concrete key-value facts about entities. Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name
Every fact MUST have an evidence field (verbatim quote). No inference.

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
{"should_ingest": boolean, "entities": [{"name": "实体名", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文片段"}], "relations": [{"from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据"}], "events": [{"date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"]}], "facts": [{"entity": "实体名", "field": "字段名", "value": "值", "confidence": 0.9, "evidence": "原文引用"}]}

## Structured Facts
Extract concrete key-value facts about entities. Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name
Every fact MUST have an evidence field (verbatim quote). No inference.

## Rules
1. Only extract information explicitly stated — no inference
2. When in doubt, set should_ingest: false
3. Return ONLY JSON, no explanation`;

export class DialogueIngest {
  private db: CBrainDB;
  private vaultPath: string;
  private pages: PageManager | null;
  private llm?: LLMProvider;
  private logger?: Logger;
  private embedding: EmbeddingProvider;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    _lance: LanceDBManager,
    vaultPath: string,
    llm?: LLMProvider,
    logger?: Logger,
    pages?: PageManager,
  ) {
    this.db = db;
    this.vaultPath = vaultPath;
    this.pages = pages ?? null;
    this.llm = llm;
    this.logger = logger;
    this.embedding = embedding;
  }

  async ingest(text: string, mode: DialogueMode = "manual", sessionId?: string): Promise<DialogueIngestResult> {
    const empty: DialogueIngestResult = { decision: "skipped", reason: "empty input", newEntities: 0, newRelations: 0, newEvents: 0, skipped: 0, filtered: [] };

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
      this.logger?.error("dialogue", "LLM 调用失败", { error: e instanceof Error ? e.message : String(e) });
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
    const dialogueSource = sessionId ?? `dialogue/${mode}/untraced`;
    const { newEntities, newRelations, newEvents, skipped, filtered } = await this.applyIncremental(result, mode, dialogueSource);

    // Step 3: Determine decision
    const hasNew = (newEntities + newRelations + newEvents) > 0;
    const decision = hasNew ? "recorded" : "skipped";

    // Step 4: Write ingest_log
    this.writeLog(mode, newEntities, newRelations, newEvents, skipped);

    return { decision, newEntities, newRelations, newEvents, skipped, filtered };
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
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        filtered: [],
      };
    } catch (e) {
      this.logger?.error("dialogue", "LLM 响应 JSON 解析失败", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async applyIncremental(result: ExtractionResult, mode: DialogueMode = "manual", dialogueSource?: string): Promise<{
    newEntities: number;
    newRelations: number;
    newEvents: number;
    skipped: number;
    filtered: Array<{ name: string; type: string; relevance: string; reason: string }>;
  }> {
    let newEntities = 0;
    let newRelations = 0;
    let newEvents = 0;
    let skipped = 0;

    const entitySlugMap = new Map<string, string>();

    // Step 1: Apply shared entity filter (blacklist, suffix patterns, generics, length, cap)
    const { kept, filtered } = filterExtractedEntities(result.entities, { mode });
    const filteredReport = filtered.map(f => ({
      name: f.entity.name,
      type: f.entity.type,
      relevance: f.entity.relevance,
      reason: f.reason,
    }));
    skipped += filtered.length;

    // Step 2: Resolve kept entities through EntityResolver
    const resolver = new EntityResolver(this.db, this.llm, {
      embedding: this.embedding,
      embeddingMode: "shadow",
    });
    const candidates = kept.map(e => ({ name: e.name, type: e.type, relevance: e.relevance }));
    const resolutionMap = resolver.resolveAll(candidates);
    await resolver.semanticResolve(resolutionMap, candidates);

    for (const entity of kept) {
      const resolution = resolutionMap.get(entity.name);
      if (!resolution) continue;

      if (resolution.action === "resolved_to_existing" || resolution.action === "alias_added") {
        entitySlugMap.set(entity.name, resolution.slug);
        this.db.incrementMentionCount(resolution.slug);
        skipped++;
      } else if (resolution.action === "duplicate_candidate" || resolution.action === "stub_created") {
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

    // Step 3: Structured facts — only for resolved entities, fill empty fields only
    const keptNames = new Set(kept.map(e => e.name));
    if (result.facts.length > 0) {
      const entityTypeMap = new Map<string, EntityType>(
        kept.map(e => [e.name, e.type])
      );
      const resolvedForFacts = new Map<string, string>();
      for (const entity of kept) {
        const r = resolutionMap.get(entity.name);
        if (r && (r.action === "resolved_to_existing" || r.action === "alias_added")) {
          resolvedForFacts.set(entity.name, r.slug);
        }
      }

      const validFacts = result.facts
        .filter(f => f.entity && f.field && f.value && f.evidence)
        .filter(f => keptNames.has(f.entity))
        .filter(f => {
          const et = entityTypeMap.get(f.entity);
          if (!et) return false;
          const allowed = getFactFieldWhitelist()[et];
          return allowed && allowed.includes(f.field);
        });

      const bestFacts = new Map<string, StructuredFact>();
      for (const f of validFacts) {
        const key = `${f.entity}|${f.field}`;
        const existing = bestFacts.get(key);
        if (!existing || f.confidence > existing.confidence) {
          bestFacts.set(key, f);
        }
      }

      for (const fact of bestFacts.values()) {
        const slug = resolvedForFacts.get(fact.entity);
        if (!slug) continue;

        const page = this.db.getPage(slug);
        if (!page) continue;

        const filePath = join(this.vaultPath, page.file_path);
        try {
          const { frontmatter, body } = readPageFile(filePath);
          const current = frontmatter[fact.field];
          if (current !== undefined && current !== null && current !== "") continue;

          frontmatter[fact.field] = fact.value;
          frontmatter.updated_at = new Date().toISOString();
          writePageFile(filePath, frontmatter, body);
        } catch {
          // File read/write error — skip silently
        }
      }
    }

    // Step 4: Relations — filtered by kept entity names
    const validRelations = filterRelations(result.relations, keptNames);
    const relationSlugs = new Set<string>();
    for (const rel of validRelations) {
      const fromSlug = entitySlugMap.get(rel.from) ?? findEntitySlug(this.db, rel.from);
      const toSlug = entitySlugMap.get(rel.to) ?? findEntitySlug(this.db, rel.to);
      if (!fromSlug || !toSlug) continue;

      const normRel = normalizeRelation(rel.relation);

      if (this.db.linkExists(fromSlug, toSlug, normRel)) continue;

      this.db.insertLink(fromSlug, toSlug, normRel, rel.context ?? null, undefined, undefined, "dialogue", 0.4, undefined, { source_page_slug: dialogueSource, evidence: rel.context ?? undefined });

      relationSlugs.add(fromSlug);
      relationSlugs.add(toSlug);
      newRelations++;
    }

    // Sync Known Relations for all entity slugs touched by this dialogue
    if (this.pages) {
      const allDialogueSlugs = new Set<string>();
      for (const slug of entitySlugMap.values()) allDialogueSlugs.add(slug);
      for (const s of relationSlugs) allDialogueSlugs.add(s);
      this.pages.syncAffectedSlugs(allDialogueSlugs);
    }

    // Step 5: Events — only those with dates
    for (const event of result.events) {
      if (!event.date) continue;

      const participantSlug = event.participants
        .map((p) => entitySlugMap.get(p) ?? findEntitySlug(this.db, p))
        .find(Boolean);

      const provOpts = { source_page_slug: dialogueSource, evidence: event.description };

      if (participantSlug) {
        this.db.addTimelineEntry(participantSlug, event.description, event.date, "dialogue", provOpts);
      } else {
        this.db.addTimelineEntry("brain/dialogue-events", event.description, event.date, "dialogue", provOpts);
      }

      newEvents++;
    }

    return { newEntities, newRelations, newEvents, skipped, filtered: filteredReport };
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
