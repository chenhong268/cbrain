import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { ZhipuEmbeddingProvider } from "../../src/embedding/zhipu.js";

// Sequence-based fetch mock for #270 timeout/retry tests. Each call consumes
// the next response (last one repeats if calls exceed length). Discriminated
// by `kind`: ok / error (HTTP status) / throw (network error) / hang (never
// resolves, rejects with AbortError when the caller aborts its signal).
type SeqResponse =
  | { kind: "ok"; data?: number[][]; tokens?: number }
  | { kind: "error"; status: number; body?: string }
  | { kind: "throw"; error: Error }
  | { kind: "hang" };

function mockFetchSequence(responses: SeqResponse[]): ReturnType<typeof mock> {
  let call = 0;
  const fn = mock((_url: string, init?: { signal?: AbortSignal }) => {
    const resp = responses[Math.min(call, responses.length - 1)];
    call++;
    switch (resp.kind) {
      case "hang":
        return new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      case "throw":
        return Promise.reject(resp.error);
      case "ok": {
        const emb = resp.data ?? [new Array(2048).fill(0)];
        const data = emb.map((embedding, index) => ({ embedding, index }));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ data, usage: { total_tokens: resp.tokens ?? data.length } }),
          text: () => Promise.resolve("{}"),
        });
      }
      case "error": {
        const body = resp.body ?? `{"error":"status ${resp.status}"}`;
        return Promise.resolve({
          ok: false,
          status: resp.status,
          json: () => Promise.resolve({ error: { message: `status ${resp.status}` } }),
          text: () => Promise.resolve(body),
        });
      }
    }
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

describe("ZhipuEmbeddingProvider", () => {
  let provider: ZhipuEmbeddingProvider;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    provider = new ZhipuEmbeddingProvider("test-api-key");
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text?: () => Promise<string>;
  }): ReturnType<typeof mock> {
    const fullResponse = {
      ...response,
      text:
        response.text ??
        (() => Promise.resolve(JSON.stringify({ error: "unknown" }))),
    };
    const fn = mock(() => Promise.resolve(fullResponse));
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    return fn;
  }

  test("dimensions is 2048", () => {
    expect(provider.dimensions).toBe(2048);
  });

  test("embed single text returns embedding and token count", async () => {
    const embedding = new Array(2048).fill(0).map((_, i) => i * 0.001);
    mockFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ embedding, index: 0 }],
          usage: { total_tokens: 10 },
        }),
    });

    const result = await provider.embed("hello world");

    expect(result.embedding).toEqual(embedding);
    expect(result.tokenCount).toBe(10);
  });

  test("embed sends correct request body", async () => {
    const embedding = new Array(2048).fill(0);
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ embedding, index: 0 }],
          usage: { total_tokens: 5 },
        }),
    });

    await provider.embed("test text");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      "https://open.bigmodel.cn/api/paas/v4/embeddings"
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-api-key",
    });
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      model: "embedding-3",
      input: ["test text"],
    });
  });

  test("embedBatch sends all texts in single request", async () => {
    const texts = ["hello", "world", "foo"];
    const embeddings = texts.map((_, i) => ({
      embedding: new Array(2048).fill(i),
      index: i,
    }));

    mockFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: embeddings,
          usage: { total_tokens: 30 },
        }),
    });

    const results = await provider.embedBatch(texts);

    expect(results).toHaveLength(3);
    expect(results[0].embedding).toEqual(new Array(2048).fill(0));
    expect(results[1].embedding).toEqual(new Array(2048).fill(1));
    expect(results[2].embedding).toEqual(new Array(2048).fill(2));
  });

  test("embedBatch returns empty array for empty input", async () => {
    const results = await provider.embedBatch([]);
    expect(results).toEqual([]);
  });

  test("embedBatch results are ordered by index regardless of API response order", async () => {
    const texts = ["a", "b", "c"];
    const embeddings = [
      { embedding: new Array(2048).fill(2), index: 2 },
      { embedding: new Array(2048).fill(0), index: 0 },
      { embedding: new Array(2048).fill(1), index: 1 },
    ];

    mockFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: embeddings,
          usage: { total_tokens: 9 },
        }),
    });

    const results = await provider.embedBatch(texts);

    expect(results[0].embedding).toEqual(new Array(2048).fill(0));
    expect(results[1].embedding).toEqual(new Array(2048).fill(1));
    expect(results[2].embedding).toEqual(new Array(2048).fill(2));
  });

  test("embed throws on non-2xx response", async () => {
    mockFetch({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { message: "invalid api key" } }),
      text: () => Promise.resolve('{"error":{"message":"invalid api key"}}'),
    });

    expect(provider.embed("test")).rejects.toThrow(/401/);
  });

  test("embed throws with response body in error", async () => {
    mockFetch({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { message: "rate limited" } }),
      text: () => Promise.resolve('{"error":{"message":"rate limited"}}'),
    });

    try {
      await provider.embed("test");
      expect.unreachable("Should have thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      const msg = (error as Error).message;
      expect(msg).toContain("429");
      expect(msg).toContain("rate limited");
    }
  });

  test("embedBatch throws on non-2xx response", async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "internal error" }),
      text: () => Promise.resolve('{"error":"internal error"}'),
    });

    expect(provider.embedBatch(["a", "b"])).rejects.toThrow(/500/);
  });

  test("embed with custom base_url uses that url", async () => {
    const customProvider = new ZhipuEmbeddingProvider(
      "key",
      "https://custom.api.com/v4"
    );
    const embedding = new Array(2048).fill(0);
    const fetchFn = mockFetch({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ embedding, index: 0 }],
          usage: { total_tokens: 1 },
        }),
    });

    await customProvider.embed("test");

    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("https://custom.api.com/v4/embeddings");
  });

  test("#269 embedBatch shards at zhipu 64-text cap and preserves order", async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const fetchFn = mock(async (_url: string, init?: { body?: string }) => {
      const input = JSON.parse(init?.body ?? "{}").input as string[];
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: input.map((t, idx) => ({ embedding: [t.length], index: idx })),
            usage: { total_tokens: input.length * 10 },
          }),
      };
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;

    const results = await provider.embedBatch(texts);

    // 100 texts at cap 64 → exactly 2 shards (64 + 36)
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchFn.mock.calls[0][1]?.body as string) as { input: string[] };
    const body2 = JSON.parse(fetchFn.mock.calls[1][1]?.body as string) as { input: string[] };
    expect(body1.input).toHaveLength(64);
    expect(body2.input).toHaveLength(36);

    // N-in → N-out, input order preserved across shards
    expect(results).toHaveLength(100);
    expect(results[0].embedding).toEqual([texts[0].length]);
    expect(results[63].embedding).toEqual([texts[63].length]);
    expect(results[64].embedding).toEqual([texts[64].length]);
    expect(results[99].embedding).toEqual([texts[99].length]);

    // total tokens 1000 averaged over 100 texts = 10
    expect(results[0].tokenCount).toBe(10);
  });
});

describe("ZhipuEmbeddingProvider timeout and retry (#270)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Shared retry config: short timeout/backoff so the suite stays fast. Real
  // defaults (30000ms / 3 retries / 200ms) are exercised by the source defaults.
  const retryOpts = { timeoutMs: 100, maxRetries: 2, baseRetryDelayMs: 1 };

  test("times out and rejects when fetch never resolves within timeoutMs", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 50,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    });
    const fetchFn = mockFetchSequence([{ kind: "hang" }]);

    try {
      await provider.embed("hang");
      expect.unreachable("should have timed out");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toMatch(/timed out/i);
      expect(msg).toContain("50");
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("retries on 429 then succeeds", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, retryOpts);
    const fetchFn = mockFetchSequence([
      { kind: "error", status: 429 },
      { kind: "ok" },
    ]);

    const result = await provider.embed("hello");

    expect(result.embedding).toHaveLength(2048);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("retries on 5xx (502) then succeeds", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, retryOpts);
    const fetchFn = mockFetchSequence([
      { kind: "error", status: 502 },
      { kind: "ok" },
    ]);

    await provider.embed("hello");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("does not retry on 401 (fail-fast 4xx, single call)", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, retryOpts);
    const fetchFn = mockFetchSequence([{ kind: "error", status: 401 }]);

    await expect(provider.embed("hello")).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("retries on network error then succeeds", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, retryOpts);
    const fetchFn = mockFetchSequence([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "ok" },
    ]);

    await provider.embed("hello");

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("#270 multi-shard: second shard 500 retries, order preserved", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 1000,
      maxRetries: 2,
      baseRetryDelayMs: 1,
    });
    let shard2Calls = 0;
    const fetchFn = mock(async (_url: string, init?: { body?: string }) => {
      const input = JSON.parse(init?.body ?? "{}").input as string[];
      const respondOk = () => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: input.map((t: string, idx: number) => ({
              embedding: [t.length],
              index: idx,
            })),
            usage: { total_tokens: input.length },
          }),
      });
      // shard 1 (64 texts) succeeds on first try
      if (input.length === 64) return respondOk();
      // shard 2 (36 texts): 500 once, then ok
      shard2Calls++;
      if (shard2Calls === 1) {
        return {
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "boom" }),
          text: () => Promise.resolve('{"error":"boom"}'),
        };
      }
      return respondOk();
    });
    globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch;

    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const results = await provider.embedBatch(texts);

    expect(results).toHaveLength(100);
    expect(results[0].embedding).toEqual([texts[0].length]);
    expect(results[63].embedding).toEqual([texts[63].length]);
    expect(results[64].embedding).toEqual([texts[64].length]);
    expect(results[99].embedding).toEqual([texts[99].length]);
    // shard 1: 1 call; shard 2: 2 calls (500 → 200) → 3 total
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("retry exhaustion throws without leaking api key", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 100,
      maxRetries: 2,
      baseRetryDelayMs: 1,
    });
    const fetchFn = mockFetchSequence([
      { kind: "error", status: 500 },
      { kind: "error", status: 500 },
      { kind: "error", status: 500 },
    ]);

    try {
      await provider.embed("hello");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("500");
      // Exhaustion surfaces the attempt count for diagnosis.
      expect(msg).toContain("after 3 attempts");
      expect(msg).not.toContain("test-api-key");
      expect(msg).not.toContain("Bearer");
    }
    // 1 initial attempt + 2 retries = 3 calls
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("network-error exhaustion uses controlled message and does not leak api key", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 100,
      maxRetries: 2,
      baseRetryDelayMs: 1,
    });
    const fetchFn = mockFetchSequence([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);

    try {
      await provider.embed("hello");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      // Network errors are wrapped with a controlled prefix (not passed through
      // verbatim), so the surface string is fully owned by this module and a
      // future fetch impl can never leak request headers via the error.
      expect(msg).toMatch(/Zhipu embedding network error/i);
      expect(msg).toContain("after 3 attempts");
      expect(msg).not.toContain("test-api-key");
      expect(msg).not.toContain("Bearer");
    }
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("5xx response body echoing Authorization header is redacted in error", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 100,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    });
    mockFetchSequence([
      {
        kind: "error",
        status: 500,
        body: "proxy echoed Authorization: Bearer test-api-key",
      },
    ]);
    try {
      await provider.embed("hello");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("500");
      expect(msg).not.toContain("test-api-key");
      expect(msg).not.toContain("Bearer test-api-key");
      // Header echo must be replaced with a redaction marker.
      expect(msg).toMatch(/Authorization:\s*\*\*\*/);
    }
  });

  test("network error message echoing Authorization header is redacted", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 100,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    });
    mockFetchSequence([
      {
        kind: "throw",
        error: new TypeError(
          "transport failed; Authorization: Bearer test-api-key",
        ),
      },
    ]);
    try {
      await provider.embed("hello");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("test-api-key");
      expect(msg).not.toContain("Bearer test-api-key");
      expect(msg).toMatch(/Authorization:\s*\*\*\*/);
    }
  });

  test("bare api key anywhere in response body is redacted", async () => {
    const provider = new ZhipuEmbeddingProvider("test-api-key", undefined, {
      timeoutMs: 100,
      maxRetries: 0,
      baseRetryDelayMs: 1,
    });
    mockFetchSequence([
      {
        kind: "error",
        status: 500,
        body: "config has test-api-key baked in",
      },
    ]);
    try {
      await provider.embed("hello");
      expect.unreachable("should have thrown");
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("test-api-key");
      expect(msg).toContain("***");
    }
  });
});
