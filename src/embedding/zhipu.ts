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

    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({ model: MODEL, input: texts });

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
        `Zhipu embedding API error: ${response.status} ${responseBody}`
      );
    }

    const json = (await response.json()) as ZhipuEmbeddingResponse;

    // Sort by index to guarantee ordering matches input
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    return sorted.map((item) => ({
      embedding: item.embedding,
      tokenCount: json.usage?.total_tokens ?? 0,
    }));
  }
}
