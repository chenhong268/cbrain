import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { ZhipuEmbeddingProvider } from "../../src/embedding/zhipu.js";

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
});
