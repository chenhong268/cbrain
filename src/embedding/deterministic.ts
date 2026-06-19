import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

/**
 * DeterministicEmbeddingProvider — in-process, network-free embedding stand-in.
 *
 * Gate/test-only: activated only when `cbrain.json` sets
 * `embedding.provider = "deterministic"`. Production configs use "zhipu".
 *
 * Why this exists (#204): the first-recall release gate exercises the PACKED
 * CLI as a subprocess, so the CLI must obtain embeddings somehow. The default
 * path is an HTTP mock server on localhost — but in environments where a TCP
 * listener cannot bind (both `Bun.serve({port:0})` and `net.listen(0)` fail),
 * the HTTP mock is unusable. This provider lets the CLI produce embeddings
 * in-process, with no socket, no HTTP, and no credentials, while staying a
 * faithful mock (fixed vector) so ingest+query recall still works.
 *
 * Every input maps to the same fixed vector — identical to the gate's HTTP mock
 * semantics — so the vector stored at ingest and the vector searched at query
 * agree and lance cosine recall hits. Keyword (FTS) recall is unaffected.
 */
const DIMENSIONS = 2048;
const FIXED_VECTOR = Array.from({ length: DIMENSIONS }, (_, i) =>
  Math.sin(i * 0.001) * 0.5,
);

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = DIMENSIONS;

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      embedding: [...FIXED_VECTOR],
      tokenCount: Math.max(1, Math.ceil(text.length / 4)),
    }));
  }
}
