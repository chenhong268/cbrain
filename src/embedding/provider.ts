export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  embed(text: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult>;
  embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]>;
  readonly dimensions: number;
}
