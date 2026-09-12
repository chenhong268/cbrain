import { test, expect, afterEach } from "bun:test";
import { DeepSeekLLMProvider } from "../../src/llm/deepseek.js";
import { ZhipuLLMProvider } from "../../src/llm/zhipu.js";
import { ZhipuEmbeddingProvider } from "../../src/embedding/zhipu.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const name of ["deepseek", "zhipu", "embedding"] as const) {
  test(`${name}: caller abort reaches fetch and is not a provider timeout`, async () => {
    let observed!: AbortSignal;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      observed = init!.signal!;
      return new Promise<Response>((resolve, reject) => {
        observed.addEventListener("abort", () => reject(observed.reason), { once: true });
        // A controlled late response keeps this regression test bounded even before the fix.
        setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "late" } }], data: [{ index: 0, embedding: [1] }] }))), 30);
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const provider = name === "deepseek" ? new DeepSeekLLMProvider("fixture") : new ZhipuLLMProvider("fixture");
    const result = name === "embedding"
      ? new ZhipuEmbeddingProvider("fixture").embed("entity", { signal: controller.signal })
      : provider.chat([{ role: "user", content: "entity" }], { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(observed.aborted).toBe(true);
  });
}

test("embedding abort stops retry backoff before another request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("busy", { status: 503 }); }) as unknown as typeof fetch;
  const controller = new AbortController();
  const embedding = new ZhipuEmbeddingProvider("fixture", undefined, { baseRetryDelayMs: 100 });
  const result = embedding.embed("entity", { signal: controller.signal });
  await Bun.sleep(10);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});
