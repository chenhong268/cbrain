import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  OllamaEmbeddingProvider,
  OLLAMA_DEFAULT_MODEL,
  QUERY_PREFIX,
} from "../../src/embedding/ollama.js";

const DIMS = 1024;

// Sequence-based fetch mock, mirroring the Zhipu provider tests. Each call
// consumes the next response (the last one repeats). Discriminated by `kind`:
// ok / error (HTTP status) / throw (network failure) / hang (never resolves,
// rejects with AbortError when the caller aborts its signal).
type SeqResponse =
  | { kind: "ok"; embeddings?: number[][]; tokens?: number; omitEmbeddings?: boolean }
  | { kind: "error"; status: number; body?: string }
  | { kind: "throw"; error: Error }
  | { kind: "hang" };

interface RecordedCall {
  url: string;
  body: { model: string; input: string[]; truncate: boolean };
}

let calls: RecordedCall[] = [];

function mockFetchSequence(responses: SeqResponse[]): ReturnType<typeof mock> {
  let call = 0;
  const fn = mock((url: string, init?: { signal?: AbortSignal; body?: string }) => {
    calls.push({
      url,
      body: JSON.parse(init?.body ?? "{}") as RecordedCall["body"],
    });
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
        const json: Record<string, unknown> = {
          prompt_eval_count: resp.tokens ?? 1,
        };
        if (!resp.omitEmbeddings) {
          json.embeddings = resp.embeddings ?? [new Array(DIMS).fill(0.5)];
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(json),
        });
      }
      case "error":
        return Promise.resolve({
          ok: false,
          status: resp.status,
          json: () => Promise.resolve({ error: `status ${resp.status}` }),
          // The body is deliberately hostile: it echoes input text. The
          // provider must never surface it in an error message.
          text: () => Promise.resolve(resp.body ?? "{}"),
        });
    }
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

/** Unit-norm vector with a distinctive first component. */
function unitVector(seed: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = seed;
  return v;
}

/** Unit vector on a single distinct axis. Different inputs get different axes,
 * so the normalized vector still identifies exactly one input: fixtures that
 * only differ in magnitude collapse to the same vector after L2 normalization
 * and therefore cannot detect a reordered or re-sharded response. */
function axisVector(axis: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[axis] = 1;
  return v;
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

describe("OllamaEmbeddingProvider", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Provider with negligible retry delay so retry tests stay fast. */
  function fastProvider(overrides: { timeoutMs?: number; maxRetries?: number } = {}) {
    return new OllamaEmbeddingProvider("http://127.0.0.1:11434", undefined, {
      baseRetryDelayMs: 1,
      ...overrides,
    });
  }

  describe("request shape", () => {
    test("posts to /api/embed with the configured model and truncate:false", async () => {
      mockFetchSequence([{ kind: "ok" }]);
      await fastProvider().embed("hello");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:11434/api/embed");
      expect(calls[0].body.model).toBe(OLLAMA_DEFAULT_MODEL);
      expect(calls[0].body.truncate).toBe(false);
      expect(calls[0].body.input).toEqual(["hello"]);
    });

    test("strips trailing slashes from a custom base URL", async () => {
      mockFetchSequence([{ kind: "ok" }]);
      const provider = new OllamaEmbeddingProvider("http://localhost:9999///", "custom-model");
      await provider.embed("hello");

      expect(calls[0].url).toBe("http://localhost:9999/api/embed");
      expect(calls[0].body.model).toBe("custom-model");
    });

    test("does not call the network for empty input", async () => {
      const fn = mockFetchSequence([{ kind: "ok" }]);
      const result = await fastProvider().embedBatch([]);

      expect(result).toEqual([]);
      expect(fn).not.toHaveBeenCalled();
    });

    test("reports 1024 dimensions", () => {
      expect(fastProvider().dimensions).toBe(1024);
    });
  });

  describe("query instruction prefix", () => {
    test("applies the evaluated prefix exactly once for purpose:query", async () => {
      mockFetchSequence([{ kind: "ok" }]);
      await fastProvider().embed("主题D 的 实体A", { purpose: "query" });

      expect(calls[0].body.input[0]).toBe(`${QUERY_PREFIX}主题D 的 实体A`);
      // Guard the measured string itself: reflowing it silently degrades recall.
      expect(QUERY_PREFIX).toBe(
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
      );
    });

    test("leaves document text unwrapped when purpose is omitted", async () => {
      mockFetchSequence([{ kind: "ok" }]);
      await fastProvider().embed("a document chunk");
      expect(calls[0].body.input[0]).toBe("a document chunk");
    });

    test("leaves document text unwrapped for purpose:document", async () => {
      mockFetchSequence([
        { kind: "ok", embeddings: [unitVector(1), unitVector(2)] },
      ]);
      await fastProvider().embedBatch(["doc one", "doc two"], { purpose: "document" });
      expect(calls[0].body.input).toEqual(["doc one", "doc two"]);
    });

    test("applies the prefix to every input in a query batch", async () => {
      mockFetchSequence([{ kind: "ok", embeddings: [unitVector(1), unitVector(2)] }]);
      await fastProvider().embedBatch(["q1", "q2"], { purpose: "query" });

      expect(calls[0].body.input).toEqual([`${QUERY_PREFIX}q1`, `${QUERY_PREFIX}q2`]);
      // Prefix must be applied exactly once — no double wrapping.
      expect(calls[0].body.input[0].split("Instruct:").length - 1).toBe(1);
    });
  });

  describe("batching", () => {
    test("shards 130 inputs and maps every response back to its own input", async () => {
      const texts = Array.from({ length: 130 }, (_, i) => `chunk-${i}`);
      mockFetchSequence([
        { kind: "ok", embeddings: texts.slice(0, 64).map((_, i) => axisVector(i)) },
        { kind: "ok", embeddings: texts.slice(64, 128).map((_, i) => axisVector(64 + i)) },
        { kind: "ok", embeddings: texts.slice(128).map((_, i) => axisVector(128 + i)) },
      ]);

      const results = await fastProvider().embedBatch(texts);

      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.body.input.length)).toEqual([64, 64, 2]);
      expect(results).toHaveLength(130);
      // Item by item: result i is the unit vector on axis i and nothing else.
      for (let i = 0; i < texts.length; i++) {
        expect(results[i].embedding[i]).toBeCloseTo(1, 9);
        expect(norm(results[i].embedding)).toBeCloseTo(1, 9);
        expect(results[i].embedding.filter((x) => x !== 0)).toHaveLength(1);
      }
      // Across both shard boundaries: 63|64 and 127|128.
      expect(results[63].embedding[63]).toBeCloseTo(1, 9);
      expect(results[64].embedding[64]).toBeCloseTo(1, 9);
      expect(results[127].embedding[127]).toBeCloseTo(1, 9);
      expect(results[128].embedding[128]).toBeCloseTo(1, 9);
      expect(results[129].embedding[129]).toBeCloseTo(1, 9);
    });

    test("distributes tokenCount evenly across inputs", async () => {
      mockFetchSequence([{ kind: "ok", embeddings: [unitVector(1), unitVector(1)], tokens: 10 }]);
      const results = await fastProvider().embedBatch(["a", "b"]);
      expect(results.map((r) => r.tokenCount)).toEqual([5, 5]);
    });
  });

  describe("normalization", () => {
    test("L2-normalizes each returned vector", async () => {
      const raw = new Array(DIMS).fill(0);
      raw[0] = 3;
      raw[1] = 4; // norm 5
      mockFetchSequence([{ kind: "ok", embeddings: [raw] }]);

      const { embedding } = await fastProvider().embed("hello");

      expect(norm(embedding)).toBeCloseTo(1, 9);
      expect(embedding[0]).toBeCloseTo(0.6, 9);
      expect(embedding[1]).toBeCloseTo(0.8, 9);
    });

    test("query and document vectors share the same normalization path", async () => {
      const raw = new Array(DIMS).fill(0);
      raw[0] = 7;
      mockFetchSequence([{ kind: "ok", embeddings: [raw] }, { kind: "ok", embeddings: [raw] }]);

      const doc = await fastProvider().embed("text");
      const query = await fastProvider().embed("text", { purpose: "query" });

      expect(query.embedding).toEqual(doc.embedding);
      expect(norm(query.embedding)).toBeCloseTo(1, 9);
    });
  });

  describe("response validation (fail loud, never repair)", () => {
    test("rejects a dimension mismatch", async () => {
      mockFetchSequence([{ kind: "ok", embeddings: [new Array(768).fill(0.1)] }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(
        /dimension mismatch at index 0: got 768, expected 1024/,
      );
    });

    test("rejects an embedding-count mismatch", async () => {
      mockFetchSequence([{ kind: "ok", embeddings: [unitVector(1)] }]);
      await expect(fastProvider().embedBatch(["a", "b"])).rejects.toThrow(
        /count mismatch: got 1, expected 2/,
      );
    });

    test("rejects a missing embeddings array", async () => {
      mockFetchSequence([{ kind: "ok", omitEmbeddings: true }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(/has no embeddings array/);
    });

    test("rejects a non-array embedding entry", async () => {
      mockFetchSequence([
        { kind: "ok", embeddings: ["not-an-array" as unknown as number[]] },
      ]);
      await expect(fastProvider().embed("x")).rejects.toThrow(
        /dimension mismatch at index 0: got non-array/,
      );
    });

    test("rejects non-finite values", async () => {
      const bad = new Array(DIMS).fill(0.1);
      bad[5] = Number.NaN;
      mockFetchSequence([{ kind: "ok", embeddings: [bad] }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(
        /contains a non-finite value/,
      );
    });

    test("rejects a zero vector instead of fabricating a placeholder", async () => {
      mockFetchSequence([{ kind: "ok", embeddings: [new Array(DIMS).fill(0)] }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(/is a zero vector/);
    });

    test("rejects an overflowed norm instead of returning 1024 zeros", async () => {
      // Every entry is finite, but squaring them overflows the sum to
      // Infinity. Dividing by that norm would emit an all-zero vector — the
      // very placeholder this provider must never fabricate.
      mockFetchSequence([{ kind: "ok", embeddings: [new Array(DIMS).fill(1e308)] }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(/has a non-finite norm/);
    });
  });

  describe("error handling", () => {
    test("fails fast on 400 without retrying", async () => {
      const fn = mockFetchSequence([{ kind: "error", status: 400 }]);
      await expect(fastProvider({ maxRetries: 3 }).embed("x")).rejects.toThrow(
        /Ollama embedding API error: 400/,
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("hints at `ollama pull` on 404", async () => {
      mockFetchSequence([{ kind: "error", status: 404 }]);
      await expect(fastProvider().embed("x")).rejects.toThrow(/ollama pull/);
    });

    test("never puts the response body into the error message", async () => {
      mockFetchSequence([
        { kind: "error", status: 400, body: "SECRET-CALLER-TEXT-should-not-leak" },
      ]);
      try {
        await fastProvider().embed("SECRET-CALLER-TEXT-should-not-leak");
        throw new Error("expected the embed call to reject");
      } catch (error) {
        expect((error as Error).message).not.toContain("SECRET-CALLER-TEXT-should-not-leak");
      }
    });

    test("retries 500 up to maxRetries then reports the attempt count", async () => {
      const fn = mockFetchSequence([{ kind: "error", status: 500 }]);
      await expect(fastProvider({ maxRetries: 3 }).embed("x")).rejects.toThrow(
        /Ollama embedding API error: 500 \(after 4 attempts\)/,
      );
      expect(fn).toHaveBeenCalledTimes(4);
    });

    test("retries 429 and succeeds on a later attempt", async () => {
      const fn = mockFetchSequence([
        { kind: "error", status: 429 },
        { kind: "ok" },
      ]);
      const { embedding } = await fastProvider({ maxRetries: 3 }).embed("x");
      expect(embedding).toHaveLength(DIMS);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test("retries a network failure (Ollama not running)", async () => {
      const fn = mockFetchSequence([
        { kind: "throw", error: new Error("Connection refused") },
        { kind: "ok" },
      ]);
      await fastProvider({ maxRetries: 3 }).embed("x");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test("never echoes caller text carried by a third-party transport error", async () => {
      // A transport layer can attach the request body (and therefore the
      // caller's embedding text) to its own error. The provider must classify
      // instead of interpolating, in the message and in the stack.
      const echoed = "匿名页面正文占位符-must-not-leak";
      mockFetchSequence([
        { kind: "throw", error: new Error(`socket closed while sending ${echoed}`) },
      ]);

      try {
        await fastProvider({ maxRetries: 0 }).embed(echoed);
        throw new Error("expected the embed call to reject");
      } catch (error) {
        const { message, stack } = error as Error;
        expect(message).not.toContain(echoed);
        expect(stack ?? "").not.toContain(echoed);
        expect(message).toMatch(/Ollama embedding network error: request failed/);
      }
    });

    test("classifies a TypeError transport failure without its text", async () => {
      mockFetchSequence([
        { kind: "throw", error: new TypeError("connect ECONNREFUSED 127.0.0.1:11434") },
      ]);
      await expect(fastProvider({ maxRetries: 0 }).embed("x")).rejects.toThrow(
        /network error: connection failed/,
      );
    });

    test("times out an unresponsive server and reports the budget", async () => {
      const fn = mockFetchSequence([{ kind: "hang" }]);
      await expect(
        fastProvider({ timeoutMs: 20, maxRetries: 0 }).embed("x"),
      ).rejects.toThrow(/timed out after 20ms/);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("propagates a caller abort without retrying", async () => {
      const fn = mockFetchSequence([{ kind: "hang" }]);
      const controller = new AbortController();
      const promise = fastProvider({ maxRetries: 3 }).embed("x", {
        signal: controller.signal,
      });
      controller.abort();
      await expect(promise).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("throws immediately when the caller signal is already aborted", async () => {
      const fn = mockFetchSequence([{ kind: "ok" }]);
      const controller = new AbortController();
      controller.abort();
      await expect(
        fastProvider().embed("x", { signal: controller.signal }),
      ).rejects.toThrow();
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
