import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "embedding-3";
const DIMENSIONS = 2048;

interface ZhipuEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

export class ZhipuEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  readonly dimensions: number = DIMENSIONS;

  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    // Zhipu embedding-3 caps each request at 64 input texts (API error 1214:
    // "input数组最大不得超过64条"). Shard, dispatch one request per shard,
    // and concat in input order so callers see a uniform N-in → N-out contract
    // regardless of batch size (a page can carry 100+ chunks; #269).
    const CAP = 64;
    const out: EmbeddingResult[] = [];
    let totalTokens = 0;
    for (let i = 0; i < texts.length; i += CAP) {
      const batch = texts.slice(i, i + CAP);
      const url = `${this.baseUrl}/embeddings`;
      const body = JSON.stringify({ model: MODEL, input: batch });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(
          `Zhipu embedding API error: ${response.status} ${responseBody}`,
        );
      }

      const json = (await response.json()) as ZhipuEmbeddingResponse;
      totalTokens += json.usage?.total_tokens ?? 0;

      // Sort by index to guarantee ordering matches this shard's input.
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) out.push({ embedding: item.embedding, tokenCount: 0 });
    }

    // Distribute total tokens evenly across all texts (matches prior per-call
    // averaging; tokenCount is informational only).
    const perText = Math.round(totalTokens / texts.length);
    return out.map((r) => ({ ...r, tokenCount: perText }));
  }
}
