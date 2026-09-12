import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticResearchPipeline } from "../../../src/core/agentic/pipeline.js";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { HybridSearch } from "../../../src/core/retrieval/search.js";
import { ZhipuEmbeddingProvider } from "../../../src/embedding/zhipu.js";
import { DeepSeekLLMProvider } from "../../../src/llm/deepseek.js";

test("research deadline aborts a real embedding HTTP response and starts no later request", async () => {
  const root = mkdtempSync(join(tmpdir(), "cbrain-research-abort-"));
  const db = new CBrainDB(join(root, "brain.sqlite"));
  let requests = 0;
  let closed = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    requests++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); },
      cancel() { closed = true; },
    }), { headers: { "Content-Type": "application/json" } });
  } });
  try {
    const embedding = new ZhipuEmbeddingProvider("fixture", server.url.href.replace(/\/$/, ""));
    const search = new HybridSearch(db, embedding, { search: async () => [] } as never, { rrf_k: 60 });
    const pipeline = new AgenticResearchPipeline({ db, search, pages: {} as never, graph: {} as never,
      llm: { name: "fixture", chat: async () => JSON.stringify({ intent: "entity_lookup", entities: [], budget: {}, steps: [
        { kind: "search", input: "实体A" }, { kind: "search", input: "实体B" },
      ] }) },
    });
    const result = await pipeline.run({ query: "实体A", budgetOverride: { max_ms: 200 } });
    expect(result.status).toBe("degraded");
    for (let i = 0; i < 20 && !closed; i++) await Bun.sleep(10);
    expect(requests).toBe(1);
    expect(closed).toBe(true);
    expect(result.trace_summary.budgetUsed.searches).toBe(1);
    expect(result.follow_up_execution).toBeUndefined();
  } finally {
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 3000);

test("already cancelled research calls no planner or search provider", async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const pipeline = new AgenticResearchPipeline({ signal: controller.signal,
    db: {} as never, pages: {} as never, graph: {} as never,
    search: { search: async () => { calls++; return []; } } as never,
    llm: { name: "fixture", chat: async () => { calls++; return "{}"; } },
  });
  const result = await pipeline.run({ query: "实体A" });
  expect(result.status).toBe("degraded");
  expect(calls).toBe(0);
});

test("caller cancellation interrupts a real planner response before its deadline", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let closed = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    started();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"choices":[')); }, cancel() { closed = true; } }));
  } });
  try {
    const controller = new AbortController();
    const pipeline = new AgenticResearchPipeline({ signal: controller.signal,
      db: {} as never, pages: {} as never, graph: {} as never, search: {} as never,
      llm: new DeepSeekLLMProvider("fixture", server.url.href.replace(/\/$/, "")),
    });
    const result = pipeline.run({ query: "实体A", budgetOverride: { max_ms: 2000 } });
    await requestStarted;
    controller.abort();
    expect((await result).status).toBe("degraded");
    for (let i = 0; i < 20 && !closed; i++) await Bun.sleep(10);
    expect(closed).toBe(true);
  } finally { server.stop(true); }
}, 3000);
