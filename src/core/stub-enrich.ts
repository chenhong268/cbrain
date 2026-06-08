import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import type { PageManager } from "./page.js";
import type { ContentPipeline } from "./pipeline.js";
import type { Logger } from "./logger.js";

const CONCURRENCY = 3;
const DEFAULT_MENTION_THRESHOLD = 3;
const MAX_BATCH_SIZE = 50;
const STUB_TIMEOUT_MS = 30_000;

const STUB_ENRICH_PROMPT = `你是一个知识提炼引擎。根据以下碎片化信息，为指定实体生成简明摘要。

要求：
1. 摘要 50-100 字，概括实体的核心信息
2. 列出 3-5 条关键事实，每条标注来源
3. 只基于提供的数据，不编造任何信息
4. 全部中文
5. 输出 JSON 格式：{ "summary": "摘要文本", "facts": ["事实1", "事实2"] }

只输出 JSON，不要任何其他内容。`;

export interface StubEnrichResult {
  enriched: boolean;
  reason: string;
}

export interface StubEnrichBatchResult {
  enriched: number;
  skipped: number;
  errors: number;
}

export class StubEnrichManager {
  private db: CBrainDB;
  private llm: LLMProvider;
  private pages: PageManager;
  private pipeline: ContentPipeline;
  private logger: Logger | null;

  constructor(
    db: CBrainDB,
    llm: LLMProvider,
    _embedding: EmbeddingProvider,
    _lance: LanceDBManager,
    pages: PageManager,
    pipeline: ContentPipeline,
    logger?: Logger | null,
  ) {
    this.db = db;
    this.llm = llm;
    this.pages = pages;
    this.pipeline = pipeline;
    this.logger = logger ?? null;
  }

  async enrichStub(slug: string): Promise<StubEnrichResult> {
    const page = this.pages.getBySlug(slug);
    if (!page) return { enriched: false, reason: "page not found" };

    // Skip already enriched pages
    if (page.frontmatter.enriched_at) {
      return { enriched: false, reason: "already_enriched" };
    }

    // Gather context
    const context = this.gatherContext(slug, page.title);
    if (context.length === 0) {
      return { enriched: false, reason: "no_context" };
    }

    // Call LLM
    const userContent = buildUserContent(page.title, page.frontmatter.type as string, context);
    const raw = await this.callLLM(STUB_ENRICH_PROMPT, userContent);
    const parsed = this.parseJSON<{ summary: string; facts: string[] }>(raw);
    if (!parsed?.summary) {
      return { enriched: false, reason: "llm_failed" };
    }

    // Build new body — preserve original auto-extracted line + any manual content
    const enrichedBody = buildEnrichedBody(page.body ?? "", parsed.summary, parsed.facts);

    // BUG-1 fix: re-index FIRST, only write vault on success
    try {
      const { chunks, embedResults } = await this.pipeline.embed(enrichedBody);
      await this.pipeline.writeIndexes(slug, chunks, embedResults);
    } catch (e) {
      this.logger?.warn("stub-enrich", `Re-indexing failed for ${slug}, skipping vault write`, { error: String(e) });
      return { enriched: false, reason: "reindex_failed" };
    }

    // Re-index succeeded — now persist to vault
    const now = new Date().toISOString();
    this.pages.update(slug, {
      body: enrichedBody,
      extra: { enriched_at: now },
    });

    return { enriched: true, reason: "enriched" };
  }

  async enrichAll(threshold = DEFAULT_MENTION_THRESHOLD): Promise<StubEnrichBatchResult> {
    const candidates = this.db.getPopularThinPages(threshold);
    if (candidates.length === 0) {
      return { enriched: 0, skipped: 0, errors: 0 };
    }

    // BUG-2 fix: cap batch size to prevent runaway processing
    const slugs = candidates.slice(0, MAX_BATCH_SIZE).map(c => c.slug);
    return this.batchEnrich(slugs);
  }

  // ─── Private ────────────────────────────────────────────────

  private gatherContext(slug: string, entityName: string): string[] {
    const contextParts: string[] = [];

    // 1. Incoming links with context strings
    const incoming = this.db.getIncomingLinks(slug);
    for (const link of incoming) {
      if (link.context && link.context.trim().length > 0) {
        const source = link.from_slug.split("/").pop() ?? link.from_slug;
        contextParts.push(`[${source} 提及] ${link.context}`);
      }
    }

    // 2. External chunks — content from pages that mention this entity
    const sourceSlugs = [...new Set(incoming.map(l => l.from_slug))].filter(s => s !== slug);
    for (const sourceSlug of sourceSlugs.slice(0, 5)) {
      const chunks = this.db.getChunksByPage(sourceSlug, { summaryLevel: 0 });
      const relevant = chunks
        .filter(c => c.content.includes(entityName))
        .slice(0, 2);
      const sourceName = sourceSlug.split("/").pop() ?? sourceSlug;
      for (const c of relevant) {
        contextParts.push(`[${sourceName} 内容] ${c.content.slice(0, 200)}`);
      }
    }

    return contextParts;
  }

  private async batchEnrich(slugs: string[]): Promise<StubEnrichBatchResult> {
    let enriched = 0;
    let skipped = 0;
    let errors = 0;

    const batches = this.chunkArray(slugs, CONCURRENCY);
    for (const batch of batches) {
      // BUG-2 fix: per-stub timeout via Promise.race
      const results = await Promise.allSettled(
        batch.map(slug => this.withTimeout(this.enrichStub(slug), STUB_TIMEOUT_MS)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value.enriched) enriched++;
          else skipped++;
        } else {
          errors++;
          this.logger?.warn("stub-enrich", `Failed: ${(r.reason as Error).message}`);
        }
      }
    }

    return { enriched, skipped, errors };
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      ),
    ]);
  }

  private async callLLM(systemPrompt: string, userContent: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.llm.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ]);
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    return "";
  }

  private parseJSON<T>(raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}

// ─── Pure helpers ────────────────────────────────────────────

function buildUserContent(title: string, type: string, contextParts: string[]): string {
  const contextText = contextParts.join("\n\n");
  return `实体名称：${title}\n实体类型：${type}\n\n## 碎片化信息\n\n${contextText}`;
}

function buildEnrichedBody(originalBody: string, summary: string, facts: string[]): string {
  // BUG-3 fix: separate auto-extracted header from manual content
  const lines = originalBody.split("\n");
  const headerLines: string[] = [];
  const manualLines: string[] = [];

  let inHeader = true;
  for (const line of lines) {
    if (inHeader && line.trim().startsWith(">")) {
      headerLines.push(line);
    } else {
      inHeader = false;
      if (line.trim().length > 0) {
        manualLines.push(line);
      }
    }
  }

  const parts: string[] = [];
  if (headerLines.length > 0) parts.push(headerLines[0]);
  parts.push("");
  parts.push(summary);
  parts.push("");
  parts.push("**关键事实：**");
  for (const fact of facts) {
    parts.push(`- ${fact}`);
  }
  // Preserve any manual content the user added
  if (manualLines.length > 0) {
    parts.push("");
    parts.push(...manualLines);
  }

  return parts.join("\n");
}
