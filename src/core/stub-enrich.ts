import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import type { PageManager } from "./page.js";
import type { ContentPipeline } from "./pipeline.js";
import type { Logger } from "./logger.js";
import type { SearchProvider } from "../search/provider.js";

const CONCURRENCY = 3;
const DEFAULT_MENTION_THRESHOLD = 3;
const MAX_BATCH_SIZE = 50;
const STUB_TIMEOUT_MS = 30_000;
const MIN_CONTEXT_THRESHOLD = 3;
const WEB_SEARCH_MAX_RESULTS = 3;
const SUMMARY_MAX_LENGTH = 500;

const STUB_ENRICH_PROMPT = `你是一个知识提炼引擎。根据以下碎片化信息，为指定实体生成简明摘要。

要求：
1. 一句话定位：50字以内，说清"这是什么"
2. 关键事实 3-5 条，每条标注来源
   - vault 内部信息标注为 (来源：[[slug]])
   - 网络信息标注为 (来源：web)
3. 只基于提供的数据，不编造任何信息
4. 全部中文
5. 输出 JSON 格式：{ "summary": "摘要文本", "facts": ["事实1 (来源：web)", "事实2 (来源：[[slug]])"] }

信息来源标记：
- 前缀 [xxx 提及] 或 [xxx 内容] → vault 内部文档
- 前缀 [web] → 网络搜索

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
  private search: SearchProvider | null;

  constructor(
    db: CBrainDB,
    llm: LLMProvider,
    _embedding: EmbeddingProvider,
    _lance: LanceDBManager,
    pages: PageManager,
    pipeline: ContentPipeline,
    logger?: Logger | null,
    searchProvider?: SearchProvider | null,
  ) {
    this.db = db;
    this.llm = llm;
    this.pages = pages;
    this.pipeline = pipeline;
    this.logger = logger ?? null;
    this.search = searchProvider ?? null;
  }

  async enrichStub(slug: string): Promise<StubEnrichResult> {
    const page = this.pages.getBySlug(slug);
    if (!page) return { enriched: false, reason: "page not found" };

    // Skip already enriched pages
    if (page.frontmatter.enriched_at) {
      return { enriched: false, reason: "already_enriched" };
    }

    // Gather internal context
    const internalContext = this.gatherContext(slug, page.title);

    // Web search fallback when internal context is thin
    const sources: string[] = ["internal"];
    const webSnippets: string[] = [];

    if (internalContext.length < MIN_CONTEXT_THRESHOLD && this.search) {
      try {
        const results = await this.search.search(page.title, { maxResults: WEB_SEARCH_MAX_RESULTS });
        for (const r of results) {
          webSnippets.push(`[web] ${r.snippet}`);
        }
        if (webSnippets.length > 0) {
          sources.push("web");
          this.logger?.info("stub-enrich", `Web search fallback for ${slug}: ${results.length} results`);
        }
      } catch (e) {
        this.logger?.warn("stub-enrich", `Web search failed for ${slug}, continuing with internal context`, { error: String(e) });
      }
    }

    // If still no context at all, skip
    if (internalContext.length === 0 && webSnippets.length === 0) {
      return { enriched: false, reason: "no_context" };
    }

    // Build combined context and call LLM
    const allContext = [...internalContext, ...webSnippets];
    const userContent = buildUserContent(page.title, page.frontmatter.type as string, allContext);
    const raw = await this.callLLM(STUB_ENRICH_PROMPT, userContent);
    const parsed = this.parseJSON<{ summary: string; facts: string[] }>(raw);
    if (!parsed?.summary) {
      return { enriched: false, reason: "llm_failed" };
    }

    // Enforce summary length cap
    const summary = parsed.summary.slice(0, SUMMARY_MAX_LENGTH);

    // Build new body — preserve original auto-extracted line + any manual content
    const enrichedBody = buildEnrichedBody(page.body ?? "", summary, parsed.facts, internalContext);

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
      extra: { enriched_at: now, enriched_sources: sources },
    });

    return { enriched: true, reason: "enriched" };
  }

  async enrichAll(threshold = DEFAULT_MENTION_THRESHOLD): Promise<StubEnrichBatchResult> {
    const candidates = this.db.getPopularThinPages(threshold);
    if (candidates.length === 0) {
      return { enriched: 0, skipped: 0, errors: 0 };
    }

    // Cap batch size to prevent runaway processing
    const slugs = candidates.slice(0, MAX_BATCH_SIZE).map(c => c.slug);
    const dropped = candidates.length - slugs.length;
    if (dropped > 0) {
      this.logger?.warn("stub-enrich", `${candidates.length} candidates found, processing first ${MAX_BATCH_SIZE}, ${dropped} deferred to next cycle`);
    }
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

  // Note: Promise.race does NOT cancel the underlying fetch() — the LLM request
  // may continue consuming quota after timeout. This is acceptable for stub
  // enrichment (low volume, nightly batch). A proper fix would require
  // AbortController support in the LLMProvider interface.
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

function buildEnrichedBody(originalBody: string, summary: string, facts: string[], internalContext?: string[]): string {
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
      manualLines.push(line);
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
  // Vault records — internal context snippets
  if (internalContext && internalContext.length > 0) {
    parts.push("");
    parts.push("**Vault 记录：**");
    for (const ctx of internalContext.slice(0, 3)) {
      parts.push(`- ${ctx.slice(0, 100)}`);
    }
  }
  // Preserve any manual content the user added — collapse consecutive blank lines
  if (manualLines.some(l => l.trim().length > 0)) {
    const collapsed = collapseBlankLines(manualLines);
    parts.push("");
    parts.push(...collapsed);
  }

  return parts.join("\n");
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (!prevBlank) result.push("");
      prevBlank = true;
    } else {
      result.push(line);
      prevBlank = false;
    }
  }
  // Trim leading/trailing blank lines
  while (result.length > 0 && result[0].trim().length === 0) result.shift();
  while (result.length > 0 && result[result.length - 1].trim().length === 0) result.pop();
  return result;
}
