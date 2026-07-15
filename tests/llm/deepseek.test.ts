import { describe, test, expect, afterEach } from "bun:test";
import { DeepSeekLLMProvider } from "../../src/llm/deepseek.js";

describe("DeepSeekLLMProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("chat", () => {
    test("returns content from API response", async () => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Hello, world!" }, finish_reason: "stop" }],
            usage: { total_tokens: 10 },
          }),
          { status: 200 }
        )) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("fake-key");
      const result = await provider.chat([{ role: "user", content: "Say hello" }]);
      expect(result).toBe("Hello, world!");
    });

    test("sends correct request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = (async (_url: string, opts: any) => {
        capturedBody = opts.body;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("test-key");
      await provider.chat([
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hi" },
      ]);

      const body = JSON.parse(capturedBody!);
      expect(body.model).toBe("deepseek-v4-flash");
      expect(body.messages.length).toBe(2);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    test("forwards an explicit thinking mode without changing the default", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_url: string, opts: any) => {
        bodies.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("test-key");
      await provider.chat([{ role: "user", content: "默认调用" }]);
      await provider.chat(
        [{ role: "user", content: "结构化抽取" }],
        { thinking: "disabled" },
      );

      expect(bodies[0].thinking).toBeUndefined();
      expect(bodies[1].thinking).toEqual({ type: "disabled" });
    });

    test("does not send the V4 thinking extension to a custom endpoint by default", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", "https://custom.api.example/v1", "legacy-model");
      await provider.chat(
        [{ role: "user", content: "结构化抽取" }],
        { thinking: "disabled" },
      );

      expect(capturedBody?.thinking).toBeUndefined();
    });

    test("requires both the official host and a V4 model for automatic thinking support", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_url: string, opts: any) => {
        bodies.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const providers = [
        new DeepSeekLLMProvider("key", "https://api.deepseek.com", "legacy-model"),
        new DeepSeekLLMProvider("key", "https://api.deepseek.com.evil.example", "deepseek-v4-flash"),
        new DeepSeekLLMProvider("key", "https://api.deepseek.com@evil.example", "deepseek-v4-flash"),
      ];
      for (const provider of providers) {
        await provider.chat([{ role: "user", content: "结构化抽取" }], { thinking: "disabled" });
      }

      expect(bodies).toHaveLength(3);
      expect(bodies.every((body) => body.thinking === undefined)).toBe(true);
    });

    test("explicitly disabling thinking capability overrides official V4 auto-detection", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider(
        "key",
        "https://api.deepseek.com",
        "deepseek-v4-flash",
        { supportsThinking: false },
      );
      await provider.chat([{ role: "user", content: "结构化抽取" }], { thinking: "disabled" });

      expect(capturedBody?.thinking).toBeUndefined();
    });

    test("allows an explicit thinking-capability opt-in for a compatible proxy", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      globalThis.fetch = (async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider(
        "key",
        "https://compatible.proxy.example/v1",
        "proxy-v4",
        { supportsThinking: true },
      );
      await provider.chat(
        [{ role: "user", content: "结构化抽取" }],
        { thinking: "disabled" },
      );

      expect(capturedBody?.thinking).toEqual({ type: "disabled" });
    });

    test("uses custom base URL and model", async () => {
      let capturedUrl: string | undefined;
      globalThis.fetch = (async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", "https://custom.api.com/v4", "deepseek-other");
      await provider.chat([{ role: "user", content: "Hi" }]);
      expect(capturedUrl).toBe("https://custom.api.com/v4/chat/completions");
    });

    test("throws on non-200 response", async () => {
      globalThis.fetch = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;
      const provider = new DeepSeekLLMProvider("bad-key");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow("DeepSeek API error: 401");
    });

    test("returns empty string on empty choices", async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
      const provider = new DeepSeekLLMProvider("key");
      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("");
    });

    test("handles network errors", async () => {
      globalThis.fetch = (async () => { throw new Error("Network failure"); }) as unknown as typeof fetch;
      const provider = new DeepSeekLLMProvider("key");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow();
    });

    test("name property is deepseek", () => {
      expect(new DeepSeekLLMProvider("key").name).toBe("deepseek");
    });
  });

  describe("timeout", () => {
    test("throws on timeout", async () => {
      // Simulate a slow fetch that listens for the abort signal.
      globalThis.fetch = (async (_url: string, opts: any) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (opts.signal?.aborted) { onAbort(); return; }
          opts.signal?.addEventListener("abort", onAbort, { once: true });
        })) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", undefined, undefined, { timeoutMs: 100 });
      let caught: unknown;
      try {
        await provider.chat([{ role: "user", content: "Hi" }]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { message?: string }).message).toBe("DeepSeek LLM request timed out after 100ms");
      expect((caught as { isLLMTimeout?: boolean }).isLLMTimeout).toBe(true);
      expect((caught as { timeoutMs?: number }).timeoutMs).toBe(100);
    });

    test("uses its own aborted signal instead of realm-specific DOMException checks", async () => {
      globalThis.fetch = (async (_url: string, opts: any) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error("aborted elsewhere"), { name: "AbortError" }));
          if (opts.signal?.aborted) { onAbort(); return; }
          opts.signal?.addEventListener("abort", onAbort, { once: true });
        })) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", undefined, undefined, { timeoutMs: 20 });
      let caught: unknown;
      try {
        await provider.chat([{ role: "user", content: "Hi" }]);
      } catch (error) {
        caught = error;
      }

      expect((caught as { code?: string }).code).toBe("LLM_TIMEOUT");
      expect((caught as { timeoutMs?: number }).timeoutMs).toBe(20);
    });

    test("does not classify an early provider AbortError as an owned timeout", async () => {
      const earlyAbort = Object.assign(new Error("provider aborted early"), { name: "AbortError" });
      globalThis.fetch = (async () => { throw earlyAbort; }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", undefined, undefined, { timeoutMs: 5_000 });
      let caught: unknown;
      try {
        await provider.chat([{ role: "user", content: "Hi" }]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(earlyAbort);
      expect((caught as { code?: string }).code).toBeUndefined();
    });

    test("default timeout is 30s (constructor accepts no opts)", () => {
      expect(new DeepSeekLLMProvider("key")).toBeDefined();
    });

    test("succeeds within timeout and passes signal", async () => {
      globalThis.fetch = (async (_url: string, opts: any) => {
        expect(opts.signal).toBeDefined();
        expect(opts.signal.aborted).toBe(false);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "fast" }, finish_reason: "stop" }] }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      const provider = new DeepSeekLLMProvider("key", undefined, undefined, { timeoutMs: 5000 });
      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("fast");
    });
  });
});
