import { CBrainDB } from "../storage/sqlite.js";
import { PageManager } from "./page.js";
import { generateSlug } from "../utils/slug.js";
import { normalizePageType, type PageType } from "./shared.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import { NerEngine } from "./ner.js";
import type { LLMProvider } from "../llm/provider.js";
import { ContentPipeline, type NerPipelineResult } from "./pipeline.js";
import { FACT_FIELD_WHITELIST, } from "./ner.js";

const ENTITY_FACTS_PROMPT = `You are a structured fact extractor. Given an entity's page content, extract concrete, verifiable facts as key-value pairs.

## Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name

## Rules:
- Every fact MUST have an evidence field (verbatim quote from source)
- Do NOT infer or fabricate — only extract explicitly stated facts
- Skip fields not in the whitelist
- confidence: 0.0-1.0

## Output (JSON only):
{"facts": [{"field": "field name", "value": "value", "confidence": 0.9, "evidence": "verbatim quote"}]}

Return ONLY valid JSON.`;

export interface IngestInput {
  content: string;
  type: "markdown" | "text";
  title?: string;
  tags?: string[];
  pageType?: "record" | "insight";
  skipNer?: boolean;
}

export interface IngestResult {
  slug: string;
  created: boolean;
  linksExtracted: number;
  ner?: NerPipelineResult | null;
}

export class IngestManager {
  private db: CBrainDB;
  private pages: PageManager;
  private nerEngine: NerEngine | null;
  private llmProvider: LLMProvider | undefined;
  private pipeline: ContentPipeline;

  constructor(
    db: CBrainDB,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    vaultPath: string,
    llmProvider?: LLMProvider
  ) {
    this.db = db;
    this.pages = new PageManager(db, vaultPath);
    this.nerEngine = llmProvider ? new NerEngine(llmProvider) : null;
    this.llmProvider = llmProvider;
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
    const type = normalizePageType(parsed.frontmatter.type ?? overrides?.pageType ?? "record");
    const slug = parsed.frontmatter.slug ?? generateSlug(title, type);
    const body = parsed.body;
    const effectiveTags = parsed.frontmatter.tags ?? overrides?.tags ?? [];

    return this.ingestCore(slug, title, type, body, effectiveTags, !overrides?.skipNer);
  }

  private async ingestText(input: IngestInput): Promise<IngestResult> {
    const rawTitle = input.title ?? input.content.split("\n").find(l => l.trim())?.trim().slice(0, 50) ?? "Untitled";
    const routedPersonTitle = this.inferPersonRelationshipTitle(input.content, input.title);
    const existingPersonSlug = this.findExistingPersonSlug(input.title ?? routedPersonTitle ?? rawTitle);

    if (existingPersonSlug) {
      return this.ingestEntityAppend(existingPersonSlug, input.content, input.tags ?? [], !input.skipNer);
    }

    const title = routedPersonTitle ?? rawTitle;
    const type = normalizePageType(routedPersonTitle ? "entity/person" : input.pageType ?? "record");
    const slug = generateSlug(title, type);
    const body = input.content;
    const tags = input.tags ?? [];

    return this.ingestCore(slug, title, type, body, tags, !input.skipNer);
  }

  private findExistingPersonSlug(title: string | undefined): string | null {
    if (!title) return null;
    const row = this.db.getPageByTitle(title.trim());
    if (!row || row.type !== "entity/person") return null;
    return row.slug;
  }

  private inferPersonRelationshipTitle(content: string, explicitTitle?: string): string | null {
    if (explicitTitle) return null;
    const firstLine = content.split("\n").find(l => l.trim())?.trim() ?? "";
    const match = firstLine.match(/^([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·.\s-]{1,20})[，,：:]\s*(.+)$/u);
    if (!match) return null;

    const name = match[1].trim();
    const description = match[2];
    if (!/[\p{Script=Han}A-Za-z]/u.test(name)) return null;
    if (!/(同事|同学|同门|朋友|学弟|学长|学姐|学妹|上级|下属|同僚|前任|现任|汇报|认识|合作|负责|任职|worked with|reports to|colleague|friend)/iu.test(description)) {
      return null;
    }
    return name;
  }

  private async ingestEntityAppend(slug: string, body: string, tags: string[], doNer: boolean): Promise<IngestResult> {
    const before = this.pages.getBySlug(slug);
    const page = this.pages.patch(slug, {
      body_append: body,
      tags_merge: tags,
    });
    if (!page) {
      throw new Error(`Cannot append to missing entity page: ${slug}`);
    }

    const { chunks, embedResults } = await this.pipeline.embed(page.body);
    const { count: linksExtracted, mentionedSlugs } = this.pipeline.processWikilinks(slug, page.body);
    await this.pipeline.writeIndexes(slug, chunks, embedResults);
    this.pipeline.writeIngestLog(slug, "api", { appended: true, chunks: chunks.length });

    let nerResult: NerPipelineResult | null | undefined;
    if (doNer && body.trim()) {
      try {
        nerResult = await this.pipeline.processNer(slug, body, before?.type ?? page.type, true, undefined, mentionedSlugs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.pipeline.writeIngestLog(slug, "api", { nerError: msg, appended: true });
      }
    }

    const nerResolvedSlugs = nerResult?.resolvedSlugs ?? [];
    const nerRelationSlugs = nerResult?.relationSlugs ?? [];
    this.pages.syncAffectedSlugs([slug, ...mentionedSlugs, ...nerResolvedSlugs, ...nerRelationSlugs]);

    return { slug, created: false, linksExtracted, ner: nerResult };
  }

  /**
   * For entity pages: extract structured facts from body into frontmatter.
   * Uses a targeted LLM call (like backfill), not the full NER pipeline.
   */
  private async extractEntityFacts(slug: string, title: string, type: string, body: string): Promise<void> {
    const page = this.pages.getBySlug(slug);
    if (!page) return;

    const llm = this.llmProvider;
    if (!llm) return;

    const raw = await llm.chat([
      { role: "system", content: ENTITY_FACTS_PROMPT },
      { role: "user", content: `Entity: ${title}\nType: ${type}\n\nContent:\n${body.slice(0, 3000)}` },
    ]);

    interface RawFact { field: string; value: string; confidence: number; evidence: string }
    let facts: RawFact[];
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .filter((f: Record<string, unknown>) => f.field && f.value && f.evidence);
    } catch {
      return;
    }

    const shortType = type.split("/").pop() ?? type;
    const allowedFields = FACT_FIELD_WHITELIST[shortType] ?? [];
    const pageData = page.frontmatter ?? {};
    const extra: Record<string, string> = {};

    for (const fact of facts) {
      if (!allowedFields.includes(fact.field)) continue;
      const current = pageData[fact.field];
      if (current !== undefined && current !== null && current !== "") continue;
      extra[fact.field] = String(fact.value);
    }

    if (Object.keys(extra).length > 0) {
      this.pages.update(slug, { extra });
    }
  }

  private async ingestCore(
    slug: string, title: string, type: PageType, body: string, tags: string[], doNer: boolean
  ): Promise<IngestResult> {
    const { chunks, embedResults } = await this.pipeline.embed(body);

    const existing = this.pages.getBySlug(slug);
    if (existing) {
      this.pages.update(slug, { body, tags });
    } else {
      this.pages.create({ title, type, body, tags, slug });
    }

    this.db.deleteLinksByRelation(slug, '提及');
    const { count: linksExtracted, mentionedSlugs } = this.pipeline.processWikilinks(slug, body);

    await this.pipeline.writeIndexes(slug, chunks, embedResults);
    this.pipeline.writeIngestLog(slug, "api", { chunks: chunks.length });

    let nerResult: NerPipelineResult | null | undefined;
    const shouldNer = doNer && !type.startsWith("entity/") && !type.startsWith("concept/") && !type.startsWith("insight/");
    if (shouldNer) {
      try {
        nerResult = await this.pipeline.processNer(slug, body, type, true, undefined, mentionedSlugs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.pipeline.writeIngestLog(slug, "api", { nerError: msg });
      }
    }

    // Entity type: extract structured facts from body into frontmatter
    if (type.startsWith("entity/") && doNer && this.llmProvider && body.trim()) {
      try {
        await this.extractEntityFacts(slug, title, type, body);
      } catch {
        // Non-critical — skip silently
      }
    }

    // Sync Known Relations for the ingested page and all mentioned/resolved entities
    const nerResolvedSlugs = nerResult?.resolvedSlugs ?? [];
    const nerRelationSlugs = nerResult?.relationSlugs ?? [];
    this.pages.syncAffectedSlugs([slug, ...mentionedSlugs, ...nerResolvedSlugs, ...nerRelationSlugs]);

    return { slug, created: !existing, linksExtracted, ner: nerResult };
  }
}
