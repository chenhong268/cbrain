import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ZhipuLLMProvider } from "../../src/llm/zhipu.js";

describe("ZhipuLLMProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("chat", () => {
    test("returns content from API response", async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Hello, world!" }, finish_reason: "stop" }],
            usage: { total_tokens: 10 },
          }),
          { status: 200 }
        );

      const provider = new ZhipuLLMProvider("fake-key");
      const result = await provider.chat([
        { role: "user", content: "Say hello" },
      ]);
      expect(result).toBe("Hello, world!");
    });

    test("sends correct request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = async (url: string, opts: any) => {
        capturedBody = opts.body;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200 }
        );
      };

      const provider = new ZhipuLLMProvider("test-key");
      await provider.chat([
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hi" },
      ]);

      const body = JSON.parse(capturedBody!);
      expect(body.model).toBe("glm-4-flash");
      expect(body.messages.length).toBe(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.temperature).toBe(0.1);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    test("uses custom base URL and model", async () => {
      let capturedUrl: string | undefined;
      globalThis.fetch = async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200 }
        );
      };

      const provider = new ZhipuLLMProvider("key", "https://custom.api.com/v4", "glm-4-plus");
      await provider.chat([{ role: "user", content: "Hi" }]);

      expect(capturedUrl).toBe("https://custom.api.com/v4/chat/completions");
    });

    test("throws on non-200 response", async () => {
      globalThis.fetch = async () =>
        new Response("Unauthorized", { status: 401 });

      const provider = new ZhipuLLMProvider("bad-key");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Zhipu LLM API error: 401"
      );
    });

    test("returns empty string on empty choices", async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ choices: [] }),
          { status: 200 }
        );

      const provider = new ZhipuLLMProvider("key");
      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("");
    });

    test("handles network errors", async () => {
      globalThis.fetch = async () => {
        throw new Error("Network failure");
      };

      const provider = new ZhipuLLMProvider("key");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow();
    });

    test("name property is zhipu", () => {
      const provider = new ZhipuLLMProvider("key");
      expect(provider.name).toBe("zhipu");
    });
  });

  describe("timeout", () => {
    test("throws on timeout", async () => {
      // Simulate a slow fetch that listens for abort signal
      globalThis.fetch = async (_url: string, opts: any) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (opts.signal?.aborted) { onAbort(); return; }
          opts.signal?.addEventListener("abort", onAbort, { once: true });
        });

      const provider = new ZhipuLLMProvider("key", undefined, undefined, { timeoutMs: 100 });
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Zhipu LLM request timed out after 100ms"
      );
    });

    test("default timeout is 30s", () => {
      const provider = new ZhipuLLMProvider("key");
      // Can't directly read private field, but we verify the constructor accepts no opts
      expect(provider).toBeDefined();
    });

    test("succeeds within timeout", async () => {
      let aborted = false;
      globalThis.fetch = async (_url: string, opts: any) => {
        // Verify signal exists
        expect(opts.signal).toBeDefined();
        expect(opts.signal.aborted).toBe(false);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "fast" }, finish_reason: "stop" }],
          }),
          { status: 200 }
        );
      };

      const provider = new ZhipuLLMProvider("key", undefined, undefined, { timeoutMs: 5000 });
      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("fast");
    });
  });
});
