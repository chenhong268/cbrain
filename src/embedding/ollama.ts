import { setTimeout as delay } from "node:timers/promises";
import type { EmbeddingProvider, EmbeddingRequestOptions, EmbeddingResult } from "./provider.js";

/**
 * #544: narrow local Ollama provider for Qwen3-Embedding-0.6B — one model
 * (`qwen3-embedding:0.6b`, 1024 dims) over Ollama's native `/api/embed`, with
 * no provider registry and no cloud fallback.
 *
 * Privacy rule for this module: an error message carries HTTP status codes,
 * fixed labels and attempt counts only. Caller text, server error bodies and
 * third-party error text/stack are never interpolated — all three can echo the
 * embedding input back.
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

// Mirrors the Zhipu provider's resilience budget (#270).
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

/** One classified embedding failure; `retryable` gates the retry loop. */
class EmbedError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** Actionable, input-free hint for one HTTP status (the body is never read). */
function statusHint(status: number, model: string): string {
  if (status === 404) return ` (model "${model}" not found; run \`ollama pull ${model}\`)`;
  if (status === 400) return " (request rejected; check model context length — truncate is disabled)";
  return "";
}

/** Fixed classification for a transport failure (e.g. Ollama not running). */
function transportError(error: unknown): EmbedError {
  const label = error instanceof TypeError ? "connection failed" : "request failed";
  return new EmbedError(`Ollama embedding network error: ${label}`, true);
}

/**
 * Validate one shard's response and L2-normalize every vector.
 *
 * Every vector is normalized here, in one place, for queries and documents
 * alike. The LanceDB tables use the L2 metric, so this is what keeps their
 * ranking equivalent to cosine ranking. A response that is short, mis-sized,
 * non-finite, or not normalizable (zero or non-finite norm) is a hard error —
 * never silently repaired, never replaced by a placeholder vector.
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
    // A non-array entry is a dimension mismatch at that index.
    const size = Array.isArray(entry) ? entry.length : "non-array";
    if (size !== DIMENSIONS) {
      throw new Error(
        `Ollama embedding dimension mismatch at index ${index}: got ${size}, expected ${DIMENSIONS}`,
      );
    }
    let sumSquares = 0;
    for (const value of entry as number[]) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Ollama embedding at index ${index} contains a non-finite value`);
      }
      sumSquares += value * value;
    }
    // Finite inputs can still overflow a sum of squares, and a zero norm cannot
    // be normalized. Dividing by either emits an all-zero vector, which would
    // silently break similarity ranking, so both fail loudly instead.
    const norm = Math.sqrt(sumSquares);
    if (!Number.isFinite(norm)) {
      throw new Error(`Ollama embedding at index ${index} has a non-finite norm`);
    }
    if (norm === 0) {
      throw new Error(`Ollama embedding at index ${index} is a zero vector`);
    }
    return (entry as number[]).map((value) => value / norm);
  });
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
    return (await this.embedBatch([text], options))[0];
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
   * `truncate:false` is always sent: an over-long input must fail loudly, and
   * nothing here shortens the text, retries against a cloud provider, or
   * fabricates a vector. Every outcome is classified into an `EmbedError`
   * before the retry decision, so a fail-fast 4xx is never retried.
   */
  private async fetchShardWithRetry(
    shard: string[],
    callerSignal?: AbortSignal,
  ): Promise<OllamaEmbedResponse> {
    const url = `${this.baseUrl}/api/embed`;
    const body = JSON.stringify({ model: this.model, input: shard, truncate: false });

    for (let attempt = 0; ; attempt++) {
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let failure: EmbedError;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal,
        });
        if (response.ok) return (await response.json()) as OllamaEmbedResponse;
        const { status } = response;
        // 429 and 5xx are transient; every other non-ok status is a client
        // error that a retry cannot fix.
        failure = new EmbedError(
          `Ollama embedding API error: ${status}${statusHint(status, this.model)}`,
          status === 429 || status >= 500,
        );
      } catch (error) {
        // A caller abort wins over classification and is never retried.
        callerSignal?.throwIfAborted();
        failure =
          error instanceof EmbedError
            ? error
            : error instanceof DOMException && error.name === "AbortError"
              ? new EmbedError(
                  `Ollama embedding request timed out after ${this.timeoutMs}ms`,
                  true,
                )
              : transportError(error);
      } finally {
        clearTimeout(timer);
      }

      callerSignal?.throwIfAborted();
      if (!failure.retryable) throw failure;
      // Retryable, but no attempts left — surface the last error with context.
      if (attempt >= this.maxRetries) {
        throw new Error(`${failure.message} (after ${attempt + 1} attempts)`);
      }
      // Exponential backoff with up to 25% jitter before the next attempt.
      const backoff = this.baseRetryDelayMs * 2 ** attempt;
      await delay(backoff + Math.random() * backoff * 0.25, undefined, {
        signal: callerSignal,
      });
    }
  }
}

/**
 * #545: resolve the local model digest from the Ollama model list — called only at an index creation
 * or rebuild boundary. Returns `undefined` when the server is unreachable or reports no digest.
 */
export async function resolveOllamaModelDigest(
  baseUrl: string = DEFAULT_BASE_URL,
  model: string = OLLAMA_DEFAULT_MODEL,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string | undefined> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  const controller = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!response.ok) return undefined;
    const json = (await response.json()) as {
      models?: Array<{ name?: string; model?: string; digest?: string }>;
    };
    const match = (json.models ?? []).find((entry) => entry.name === model || entry.model === model);
    return match?.digest && match.digest.length > 0 ? match.digest : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
