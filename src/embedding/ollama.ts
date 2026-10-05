import { setTimeout as delay } from "node:timers/promises";
import type { EmbeddingProvider, EmbeddingRequestOptions, EmbeddingResult } from "./provider.js";

/**
 * #544: narrow local Ollama provider for Qwen3-Embedding-0.6B.
 *
 * Scope: one model (`qwen3-embedding:0.6b`, 1024 dims) over Ollama's native
 * `/api/embed`. No provider registry, no generic model surface. The cloud
 * Zhipu path and the deterministic gate path are untouched.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_DEFAULT_MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 1024;

/**
 * The exact query instruction prefix measured in the local private evaluation.
 * The caller's text is appended verbatim after it. The embedded newline and the
 * single space after `Query:` are part of the evaluated string — do not reflow
 * them, and apply the prefix in exactly one place (here) so a query is never
 * double-wrapped.
 */
export const QUERY_PREFIX =
  "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

// A page can carry 100+ chunks (#269). Shard so one request stays bounded in
// size and memory; `/api/embed` itself has no documented 64-input cap.
const MAX_BATCH_SIZE = 64;

// Mirrors the Zhipu provider's resilience budget (#270): abort hangs, retry
// transient faults, fail fast on client errors.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 200;

interface OllamaEmbedResponse {
  embeddings?: unknown;
  prompt_eval_count?: number;
}

export interface OllamaEmbeddingOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

/**
 * Validate one shard's response and L2-normalize every vector.
 *
 * Qwen3-Embedding returns unnormalized vectors; the LanceDB tables use the
 * default L2 metric, so normalizing here is what makes L2 distance equivalent
 * to cosine. Query and document vectors go through this same path, so the two
 * encodings cannot drift apart. A response that is short, mis-sized,
 * non-finite, or contains a zero vector is a hard error — never silently
 * repaired, never replaced by a placeholder vector.
 */
function validateEmbeddings(
  json: OllamaEmbedResponse,
  expectedCount: number,
  model: string,
): number[][] {
  const raw = json.embeddings;
  if (!Array.isArray(raw)) {
    throw new Error(`Ollama embedding response for "${model}" has no embeddings array`);
  }
  if (raw.length !== expectedCount) {
    throw new Error(
      `Ollama embedding count mismatch: got ${raw.length}, expected ${expectedCount}`,
    );
  }
  return raw.map((entry, index) => {
    if (!Array.isArray(entry)) {
      throw new Error(
        `Ollama embedding dimension mismatch at index ${index}: got non-array, expected ${DIMENSIONS}`,
      );
    }
    if (entry.length !== DIMENSIONS) {
      throw new Error(
        `Ollama embedding dimension mismatch at index ${index}: got ${entry.length}, expected ${DIMENSIONS}`,
      );
    }
    let sumSquares = 0;
    for (const value of entry) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `Ollama embedding at index ${index} contains a non-finite value`,
        );
      }
      sumSquares += value * value;
    }
    const norm = Math.sqrt(sumSquares);
    if (norm === 0) {
      throw new Error(`Ollama embedding at index ${index} is a zero vector`);
    }
    return (entry as number[]).map((value) => value / norm);
  });
}

/**
 * Actionable, input-free status hints. The server error body is never
 * interpolated: a body can echo the request text, and this module must not
 * put caller content into an error message.
 */
function statusHint(status: number, model: string): string {
  if (status === 404) return `(model "${model}" not found; run \`ollama pull ${model}\`)`;
  if (status === 400) {
    return "(request rejected; check model context length — truncate is disabled)";
  }
  return "";
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = DIMENSIONS;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxRetries: number;
  private baseRetryDelayMs: number;

  constructor(
    baseUrl: string = DEFAULT_BASE_URL,
    model: string = OLLAMA_DEFAULT_MODEL,
    opts?: OllamaEmbeddingOptions,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = opts?.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
  }

  async embed(text: string, options?: EmbeddingRequestOptions): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingResult[]> {
    options?.signal?.throwIfAborted();
    if (texts.length === 0) return [];

    // Purpose is per call, not per text: a shard is all-query or all-document.
    const purpose = options?.purpose ?? "document";
    const inputs =
      purpose === "query" ? texts.map((text) => `${QUERY_PREFIX}${text}`) : texts;

    const out: EmbeddingResult[] = [];
    let totalTokens = 0;
    for (let i = 0; i < inputs.length; i += MAX_BATCH_SIZE) {
      const shard = inputs.slice(i, i + MAX_BATCH_SIZE);
      const json = await this.fetchShardWithRetry(shard, options?.signal);
      totalTokens += json.prompt_eval_count ?? 0;
      // Input order and count are preserved: shards are contiguous slices and
      // each response is consumed in its own array order.
      for (const embedding of validateEmbeddings(json, shard.length, this.model)) {
        out.push({ embedding, tokenCount: 0 });
      }
    }

    // Distribute the request total evenly (tokenCount is informational only).
    const perText = Math.round(totalTokens / texts.length);
    return out.map((result) => ({ ...result, tokenCount: perText }));
  }

  /**
   * POST one ≤64-input shard to /api/embed with timeout + retry.
   *
   * `truncate:false` is always sent: an over-long input must fail loudly. No
   * failure path shortens the text, retries the request against a cloud
   * provider, or fabricates a vector.
   */
  private async fetchShardWithRetry(
    shard: string[],
    callerSignal?: AbortSignal,
  ): Promise<OllamaEmbedResponse> {
    const url = `${this.baseUrl}/api/embed`;
    const body = JSON.stringify({ model: this.model, input: shard, truncate: false });

    type ShardResult =
      | { ok: true; json: OllamaEmbedResponse }
      | { ok: false; error: Error; retryable: boolean };

    let lastError: Error = new Error("Ollama embedding request failed");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      // try/catch only classifies the fetch outcome into `result`; the
      // throw/no-throw decision is made below so a fail-fast 4xx cannot be
      // accidentally caught and retried.
      let result: ShardResult;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal,
        });

        if (response.ok) {
          result = { ok: true, json: (await response.json()) as OllamaEmbedResponse };
        } else {
          const status = response.status;
          const retryable = status === 429 || status >= 500;
          const hint = statusHint(status, this.model);
          result = {
            ok: false,
            retryable,
            error: new Error(
              `Ollama embedding API error: ${status}${hint ? ` ${hint}` : ""}`,
            ),
          };
        }
      } catch (error) {
        callerSignal?.throwIfAborted();
        if (error instanceof DOMException && error.name === "AbortError") {
          result = {
            ok: false,
            retryable: true,
            error: new Error(
              `Ollama embedding request timed out after ${this.timeoutMs}ms`,
            ),
          };
        } else {
          // Transport failure (e.g. Ollama not running) — transient, retry it.
          // A transport error never carries the request body.
          const reason = error instanceof Error ? error.message : String(error);
          result = {
            ok: false,
            retryable: true,
            error: new Error(`Ollama embedding network error: ${reason}`),
          };
        }
      } finally {
        clearTimeout(timer);
      }

      callerSignal?.throwIfAborted();
      if (result.ok) return result.json;
      lastError = result.error;

      // Non-429 4xx: client error, retrying won't help — fail fast.
      if (!result.retryable) throw result.error;

      // Retryable, but no attempts left — surface the last error with context.
      if (attempt === this.maxRetries) {
        throw new Error(`${lastError.message} (after ${attempt + 1} attempts)`);
      }

      // Exponential backoff with up to 25% jitter before the next attempt.
      const backoff = this.baseRetryDelayMs * 2 ** attempt;
      const jitter = Math.random() * (backoff * 0.25);
      await delay(backoff + jitter, undefined, { signal: callerSignal });
    }

    // Unreachable: every iteration either returns or throws above.
    throw lastError;
  }
}
