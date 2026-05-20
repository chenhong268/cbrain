import type { CBrainDB } from "../storage/sqlite.js";
import type { LLMProvider } from "../llm/provider.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { LanceDBManager } from "../storage/lancedb.js";
import type { Logger } from "./logger.js";

const CONCURRENCY = 3;

const SEAL_SYSTEM_PROMPT = `你是一个知识压缩引擎。任务：将以下原始文本片段压缩为一条结构化摘要。

要求：
1. 保留所有核心事实、数字、人名、日期、关键结论
2. 去除冗余表述，合并重复信息
3. 保持信息密度最大化
4. 输出 JSON 格式：{ "summary": "压缩后的摘要文本", "key_topics": ["主题1", "主题2"] }

只输出 JSON，不要任何其他内容。`;

export interface SealPageResult {
  sealed: boolean;
  reason: string;
}

export interface SealBatchResult {
  sealed: number;
  skipped: number;
  errors: number;
}

export class SealManager {
  private db: CBrainDB;
  private llm: LLMProvider;
  private embedding: EmbeddingProvider;
  private lance: LanceDBManager;
  private logger: Logger | null;

  constructor(
    db: CBrainDB,
    llm: LLMProvider,
    embedding: EmbeddingProvider,
    lance: LanceDBManager,
    logger?: Logger | null
  ) {
    this.db = db;
    this.llm = llm;
    this.embedding = embedding;
    this.lance = lance;
    this.logger = logger ?? null;
  }

  async sealPage(slug: string): Promise<SealPageResult> {
    const rawChunks = this.db.getChunksByPage(slug, { summaryLevel: 0 });
    if (rawChunks.length === 0) return { sealed: false, reason: "no raw chunks" };

    const currentHash = this.db.getRawChunkContentHash(slug);
    const existing = this.db.getL1Summary(slug);
    if (existing && existing.content_hash === currentHash) {
      return { sealed: false, reason: "unchanged" };
    }

    const combined = rawChunks.map(c => c.content).join("\n\n---\n\n");
    const raw = await this.callLLM(SEAL_SYSTEM_PROMPT, combined);
    const parsed = this.parseJSON<{ summary: string; key_topics: string[] }>(raw, null);
    if (!parsed?.summary) {
      return { sealed: false, reason: "LLM failed to generate summary" };
    }

    // Remove old L1 from SQLite + LanceDB
    this.db.deleteL1Summary(slug);
    await this.lance.deleteL1VectorByPageSlug(slug);

    // Insert new L1 into SQLite + LanceDB
    const summaryEmbedding = await this.embedding.embed(parsed.summary);
    this.db.insertChunkWithLevel(slug, -1, parsed.summary, 1, currentHash);
    await this.lance.addChunks([{
      pageSlug: slug,
      chunkIndex: -1,
      content: parsed.summary,
      vector: new Float32Array(summaryEmbedding.embedding),
    }]);

    // Rebuild FTS: raw chunks + L1 summary
    this.db.ftsDeleteByPage(slug);
    for (const chunk of rawChunks) {
      this.db.ftsInsert(slug, chunk.content);
    }
    this.db.ftsInsert(slug, parsed.summary);

    return { sealed: true, reason: "sealed" };
  }

  async sealChanged(): Promise<SealBatchResult> {
    const slugs = this.db.getPagesWithChangedChunks();
    return this.batchSeal(slugs);
  }

  async sealAll(): Promise<SealBatchResult> {
    const slugs = this.db.getPagesNeedingSeal();
    return this.batchSeal(slugs);
  }

  // ─── Private ────────────────────────────────────────────────

  private async batchSeal(slugs: string[]): Promise<SealBatchResult> {
    let sealed = 0;
    let skipped = 0;
    let errors = 0;

    const batches = this.chunk(slugs, CONCURRENCY);
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(slug => this.sealPage(slug))
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value.sealed) sealed++;
          else skipped++;
        } else {
          errors++;
          this.logger?.warn("seal", `Failed: ${(r.reason as Error).message}`);
        }
      }
    }

    return { sealed, skipped, errors };
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

  private parseJSON<T>(raw: string, fallback: T | null): T | null {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}
