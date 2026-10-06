import { describe, expect, test } from "bun:test";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import {
  attachRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import type { SearchResult } from "../../src/core/retrieval/search.js";
import type { VectorIndexIdentity } from "../../src/storage/lance-identity.js";

const VERIFIED_IDENTITY: VectorIndexIdentity = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
  documentEncoding: 1,
  modelDigest: "ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d",
};

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface HarnessOptions {
  readonly candidates: readonly SearchResult[];
  readonly identity: VectorIndexIdentity | null;
  readonly ftsCandidates?: readonly SearchResult[];
}

function candidatePage(slug: string, cosine: number, _title: string): SearchResult {
  const support: RetrievalSupport = { vector: { original: { rankScore: 1, vectorCosineSimilarity: cosine } } };
  return attachRetrievalSupport({ slug, score: 0.01, snippet: "匿名正文片段", source: "hybrid" }, support);
}

function parsed(output: { content: Array<{ type: string; text: string }> }): Record<string, any> {
  return JSON.parse(output.content[0]!.text) as Record<string, any>;
}

function makeHarness(options: HarnessOptions) {
  const db = new CBrainDB(":memory:");
  const counters = { search: 0, fts: 0, embedding: 0, model: 0, identity: 0 };
  let handler: Handler | undefined;
  registerFrontdoorTools({
    registerTool(name: string, _definition: unknown, registered: Handler) {
      if (name === "cbrain_recall") handler = registered;
    },
  } as never, {
    outputMode: "legacy",
    db,
    identityPersonSlug: "entities/person-a",
    lance: {
      vectorIdentitySnapshot: () => {
        counters.identity++;
        return options.identity ? { ...options.identity } : null;
      },
    },
    embedding: {
      embed: async () => { counters.embedding++; return { embedding: new Array(1024).fill(0), tokenCount: 1 }; },
      embedBatch: async (texts: string[]) => {
        counters.embedding++;
        return texts.map((text) => ({ embedding: new Array(1024).fill(0), tokenCount: text.length }));
      },
      dimensions: 1024,
    },
    llm: { chat: async () => { counters.model++; return "{}"; } },
    search: {
      async search(_query: string, searchOptions?: { strategy?: string }) {
        if (searchOptions?.strategy === "fts") {
          counters.fts++;
          return options.ftsCandidates ?? [];
        }
        counters.search++;
        return options.candidates;
      },
    },
    pages: {
      getBySlug: (slug: string) => ({
        slug,
        title: slug === "records/alpha" ? "匿名主题甲结论" : "匿名主题乙结论",
        type: "record",
        body: "匿名正文片段",
        frontmatter: {},
      }),
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  if (!handler) throw new Error("frontdoor handler not registered");
  return {
    counters,
    call: (query: string, detail?: string) => handler!({ query, ...(detail ? { detail } : {}) }),
    close: () => db.close(),
  };
}

describe("#550 local Qwen content fallback at the front door", () => {
  test("returns the leading page only for the measured model when every admission stayed empty", async () => {
    const harness = makeHarness({
      candidates: [candidatePage("records/alpha", 0.7, "匿名主题甲结论"), candidatePage("records/beta", 0.5, "匿名主题乙结论")],
      identity: VERIFIED_IDENTITY,
    });
    try {
      const envelope = parsed(await harness.call("匿名主题甲的结论是什么"));
      expect(envelope.summary.status).toBe("ok");
      expect(envelope.summary.count).toBe(1);
      expect(envelope.display).toContain("匿名主题甲结论");
      expect(envelope.raw.routing.chosen_route).toBe("content_recall");
      expect(harness.counters.identity).toBe(1);
    } finally {
      harness.close();
    }
  });

  test.each([
    ["no verified index identity", null],
    ["a model that was never measured", { ...VERIFIED_IDENTITY, model: "qwen3-embedding:4b" }],
    ["the same model without a recorded digest", { ...VERIFIED_IDENTITY, modelDigest: undefined }],
    ["a drifted digest", { ...VERIFIED_IDENTITY, modelDigest: "c".repeat(64) }],
    ["another provider", { ...VERIFIED_IDENTITY, provider: "zhipu" }],
    ["another index width", { ...VERIFIED_IDENTITY, dimensions: 2048 }],
  ])("stays empty for %s", async (_label, identity) => {
    const harness = makeHarness({
      candidates: [candidatePage("records/alpha", 0.7, "匿名主题甲结论"), candidatePage("records/beta", 0.5, "匿名主题乙结论")],
      identity: identity as VectorIndexIdentity | null,
    });
    try {
      const envelope = parsed(await harness.call("匿名主题甲的结论是什么"));
      expect(envelope.summary.status).toBe("empty");
      expect(envelope.summary.count).toBe(0);
      expect(harness.counters.embedding).toBe(0);
      expect(harness.counters.model).toBe(0);
    } finally {
      harness.close();
    }
  });

  test("stays empty below the measured floor and on a near tie", async () => {
    const belowFloor = makeHarness({
      candidates: [candidatePage("records/alpha", 0.59, "匿名主题甲结论"), candidatePage("records/beta", 0.2, "匿名主题乙结论")],
      identity: VERIFIED_IDENTITY,
    });
    const nearTie = makeHarness({
      candidates: [candidatePage("records/alpha", 0.7, "匿名主题甲结论"), candidatePage("records/beta", 0.68, "匿名主题乙结论")],
      identity: VERIFIED_IDENTITY,
    });
    const singlePage = makeHarness({
      candidates: [candidatePage("records/alpha", 0.7, "匿名主题甲结论")],
      identity: VERIFIED_IDENTITY,
    });
    try {
      expect(parsed(await belowFloor.call("匿名主题甲的结论是什么")).summary.status).toBe("empty");
      expect(parsed(await nearTie.call("匿名主题甲的结论是什么")).summary.status).toBe("empty");
      expect(parsed(await singlePage.call("匿名主题甲的结论是什么")).summary.status).toBe("empty");
    } finally {
      belowFloor.close();
      nearTie.close();
      singlePage.close();
    }
  });

  test("never consults the index identity for an excluded request shape", async () => {
    const candidates = [candidatePage("records/alpha", 0.7, "匿名主题甲结论"), candidatePage("records/beta", 0.5, "匿名主题乙结论")];
    const birthday = makeHarness({ candidates, identity: VERIFIED_IDENTITY });
    const cause = makeHarness({ candidates, identity: VERIFIED_IDENTITY });
    const report = makeHarness({ candidates, identity: VERIFIED_IDENTITY });
    const unknownCue = makeHarness({ candidates, identity: VERIFIED_IDENTITY });
    try {
      await birthday.call("匿名主题甲的生日");
      await cause.call("组织丙 年度三 成本 上升 原因");
      await report.call("实体甲 aliasb 地区丙 二季度 销售下滑 2026Q2 财报");
      await unknownCue.call("匿名主题甲的结论是什么 未知");
      expect(birthday.counters.identity).toBe(0);
      expect(cause.counters.identity).toBe(0);
      expect(report.counters.identity).toBe(0);
      expect(unknownCue.counters.identity).toBe(0);
      expect(birthday.counters.embedding).toBe(0);
      expect(cause.counters.embedding).toBe(0);
      expect(report.counters.embedding).toBe(0);
      expect(unknownCue.counters.embedding).toBe(0);
    } finally {
      birthday.close();
      cause.close();
      report.close();
      unknownCue.close();
    }
  });

  test("is never consulted once an existing admission already accepted a page", async () => {
    const harness = makeHarness({
      candidates: [candidatePage("records/alpha", 0.9, "匿名主题甲结论"), candidatePage("records/beta", 0.2, "匿名主题乙结论")],
      identity: VERIFIED_IDENTITY,
    });
    try {
      const envelope = parsed(await harness.call("匿名主题甲的结论是什么"));
      expect(envelope.summary.status).toBe("ok");
      expect(envelope.display).toContain("匿名主题甲结论");
      expect(harness.counters.identity).toBe(0);
    } finally {
      harness.close();
    }
  });

  test("adds no search, embedding or model call to the empty path", async () => {
    const candidates = [candidatePage("records/alpha", 0.7, "匿名主题甲结论"), candidatePage("records/beta", 0.5, "匿名主题乙结论")];
    const withFallback = makeHarness({ candidates, identity: VERIFIED_IDENTITY });
    const withoutFallback = makeHarness({ candidates, identity: null });
    try {
      const rescued = parsed(await withFallback.call("匿名主题甲的结论是什么"));
      const empty = parsed(await withoutFallback.call("匿名主题甲的结论是什么"));
      expect(rescued.summary.count).toBe(1);
      expect(empty.summary.count).toBe(0);
      expect(withFallback.counters.search).toBe(withoutFallback.counters.search);
      expect(withFallback.counters.fts).toBe(withoutFallback.counters.fts);
      expect(withFallback.counters.embedding).toBe(withoutFallback.counters.embedding);
      expect(withFallback.counters.model).toBe(withoutFallback.counters.model);
    } finally {
      withFallback.close();
      withoutFallback.close();
    }
  });
});
