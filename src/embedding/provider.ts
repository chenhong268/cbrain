export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

/**
 * #544: what the text is encoded for. Query consumers opt in; everything else
 * (chunk writes, L1 summaries, insight writes, entity similarity) keeps the
 * default so document vectors are never wrapped in the query instruction.
 */
export type EmbeddingPurpose = "query" | "document";

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
  /** Defaults to "document" when omitted. */
  purpose?: EmbeddingPurpose;
}

export interface EmbeddingProvider {
  embed(text: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult>;
  embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]>;
  readonly dimensions: number;
}
