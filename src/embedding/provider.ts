export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
  readonly dimensions: number;
}
