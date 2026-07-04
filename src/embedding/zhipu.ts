import type { EmbeddingProvider, EmbeddingResult } from "./provider.js";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const MODEL = "embedding-3";
const DIMENSIONS = 2048;

// Network resilience defaults for #270: abort hangs, retry transient faults.
// Mirrors src/llm/zhipu.ts (AbortController + signal) but adds retry/backoff,
// which the embedding batch path needs because a stalled shard otherwise
// blocks sync / ingest / reindex / rebuild indefinitely.
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 200;

/**
 * Redact secrets a malicious proxy or verbose fetch impl may echo back inside
 * a response body or transport error before either is interpolated into a
 * thrown Error. Strips Authorization header echoes, bare Bearer tokens, then
 * the raw API key verbatim (split/join — the key may hold regex metacharacters).
 * Order matters: header/Bearer patterns first, then the raw-key sweep.
 */
function sanitizeEmbeddingErrorText(text: string, apiKey: string): string {
  const redacted = text
    .replace(/Authorization\s*:\s*\S+(?:\s+\S+)?/gi, "Authorization: ***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
  if (apiKey.length === 0) return redacted;
  return redacted.split(apiKey).join("***");
}

interface ZhipuEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

export interface ZhipuEmbeddingOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
}

export class ZhipuEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private baseRetryDelayMs: number;
  readonly dimensions: number = DIMENSIONS;

  constructor(
    apiKey: string,
    baseUrl: string = DEFAULT_BASE_URL,
    opts?: ZhipuEmbeddingOptions,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = opts?.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
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
      const json = await this.fetchShardWithRetry(batch);
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

  /**
   * POST one ≤64-text shard to /embeddings with timeout + retry.
   *
   * Retry policy: 429 and 5xx are retried (transient); network errors and
   * timeouts are retried; non-429 4xx fail fast (client error, retry won't
   * help). On exhaustion the last error is rethrown with an attempt count.
   * Errors carry status / timeout / attempt context but never the API key.
   */
  private async fetchShardWithRetry(
    batch: string[],
  ): Promise<ZhipuEmbeddingResponse> {
    const url = `${this.baseUrl}/embeddings`;
    const body = JSON.stringify({ model: MODEL, input: batch });

    type ShardResult =
      | { ok: true; json: ZhipuEmbeddingResponse }
      | { ok: false; error: Error; retryable: boolean };

    let lastError: Error = new Error("Zhipu embedding request failed");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      // try/catch only classifies the fetch outcome into `result`; the
      // throw/no-throw decision is made below the block so a fail-fast
      // 4xx throw can't be accidentally caught and retried.
      let result: ShardResult;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        if (response.ok) {
          const json = (await response.json()) as ZhipuEmbeddingResponse;
          result = { ok: true, json };
        } else {
          const status = response.status;
          const responseBody = await response.text();
          const sanitizedBody = sanitizeEmbeddingErrorText(
            responseBody,
            this.apiKey,
          );
          const retryable = status === 429 || status >= 500;
          result = {
            ok: false,
            retryable,
            error: new Error(
              `Zhipu embedding API error: ${status} ${sanitizedBody}`,
            ),
          };
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          result = {
            ok: false,
            retryable: true,
            error: new Error(
              `Zhipu embedding request timed out after ${this.timeoutMs}ms`,
            ),
          };
        } else {
          // Network failure (fetch rejected) — transient, retry it. Wrap the
          // raw error so the surfaced string is fully owned by this module;
          // a request header (Authorization) must never transit a third-party
          // error message, even if a future fetch impl changes its shape.
          const reason = error instanceof Error ? error.message : String(error);
          const sanitizedReason = sanitizeEmbeddingErrorText(
            reason,
            this.apiKey,
          );
          result = {
            ok: false,
            retryable: true,
            error: new Error(
              `Zhipu embedding network error: ${sanitizedReason}`,
            ),
          };
        }
      } finally {
        clearTimeout(timer);
      }

      if (result.ok) return result.json;
      lastError = result.error;

      // Non-429 4xx: client error, retrying won't help — fail fast.
      if (!result.retryable) throw result.error;

      // Retryable, but no attempts left — surface the last error with context.
      if (attempt === this.maxRetries) {
        throw new Error(
          `${lastError.message} (after ${attempt + 1} attempts)`,
        );
      }

      // Exponential backoff with up to 25% jitter before the next attempt.
      const backoff = this.baseRetryDelayMs * 2 ** attempt;
      const jitter = Math.random() * (backoff * 0.25);
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }

    // Unreachable: every iteration either returns or throws above.
    throw lastError;
  }
}
