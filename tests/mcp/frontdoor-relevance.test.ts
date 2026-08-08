import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { HybridSearch, type SearchResult, type SearchOptions, type SearchTrace } from "../../src/core/retrieval/search.js";
import {
  attachRetrievalSupport,
  type RetrievalSupport,
} from "../../src/core/retrieval/retrieval-support.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";
import { registerRecallTools } from "../../src/mcp/tools/recall.js";
import { buildContext } from "../../src/mcp/context.js";
import { sanitizeError } from "../../src/mcp/server.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

interface Harness {
  call(args: Record<string, unknown>): ReturnType<Handler>;
  searchCalls: Array<{ query: string; options?: SearchOptions }>;
  pageSlugs: string[];
  evidenceCalls: string[];
  logCalls: unknown[];
}

const SUPPORT_FIELD_SENTINELS = [
  "vectorCosineSimilarity",
  "rootLexicalCoverage",
  "rankScore",
  "strong_vector",
  "strong_lexical",
  "insufficient_support",
  "0.8123456789",
  "987654.125",
  "ROOT-QUERY-SUPPORT-SENTINEL",
  "CANDIDATE-VECTOR-SENTINEL",
];

function importsRetrievalSupport(source: string, fileName = "scan.ts"): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const isTarget = (value: ts.Expression | undefined): boolean => {
    if (value === undefined) return false;
    let unwrapped = value;
    while (
      ts.isParenthesizedExpression(unwrapped)
      || ts.isAsExpression(unwrapped)
      || ts.isSatisfiesExpression(unwrapped)
      || ts.isNonNullExpression(unwrapped)
      || ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }
    if (!ts.isStringLiteralLike(unwrapped)) return false;
    const modulePath = unwrapped.text.replace(/[?#].*$/u, "");
    return /(?:^|\/)retrieval-support(?:\.js)?$/u.test(modulePath);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && isTarget(node.moduleSpecifier)
    ) {
      found = true;
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && isTarget(node.moduleReference.expression)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      // Any directly written static module string is considered a dependency,
      // regardless of whether the loader is require, a require alias, or a
      // createRequire bridge. This deliberately favors privacy over name-based
      // loader recognition.
      if (node.arguments.some((argument) => isTarget(argument))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function result(
  slug: string,
  support?: RetrievalSupport,
  snippet = "匿名可见片段",
  source: SearchResult["source"] = "hybrid",
): SearchResult {
  const value: SearchResult = { slug, score: 0.01, snippet, source };
  Object.defineProperty(value, "candidateVector", {
    value: ["CANDIDATE-VECTOR-SENTINEL", 987654.125],
    enumerable: false,
  });
  if (!support) return value;
  const tainted = Object.fromEntries(Object.entries(support).map(([channel, channelSupport]) => [
    channel,
    Object.fromEntries(Object.entries(channelSupport ?? {}).map(([origin, evidence]) => [
      origin,
      {
        ...evidence,
        rootQuery: "ROOT-QUERY-SUPPORT-SENTINEL",
        candidateVector: ["CANDIDATE-VECTOR-SENTINEL", 987654.125],
        decisionReason: "insufficient_support",
        uniqueSupportField: "UNIQUE-SUPPORT-FIELD-SENTINEL",
      },
    ])),
  ]));
  return attachRetrievalSupport(value, tainted as RetrievalSupport);
}

function makeHarness(
  results: SearchResult[],
  outputMode: "legacy" | "structured" = "legacy",
  opts: {
    temporalEvidence?: "sufficient" | "partial" | "insufficient";
    pageError?: Error;
    pageType?: string;
    missingSlugs?: ReadonlySet<string>;
    overviewLinks?: (slug: string) => { outgoing: unknown[]; incoming: unknown[] };
    overviewTimeline?: (slug: string) => unknown[];
    sparseBatch?: boolean;
    proactiveHint?: "expiry" | "timeline" | "shared";
    fallbackResults?: SearchResult[];
  } = {},
): Harness {
  let handler: Handler | undefined;
  const searchCalls: Array<{ query: string; options?: SearchOptions }> = [];
  const pageSlugs: string[] = [];
  const evidenceCalls: string[] = [];
  const logCalls: unknown[] = [];
  const server = {
    registerTool(name: string, _definition: unknown, registered: Handler) {
      if (name === "cbrain_recall") handler = registered;
    },
  };
  const temporal = opts.temporalEvidence;
  const db = {
    batchGetTimelineForSlugs(slugs: string[]) {
      evidenceCalls.push(`timeline:${slugs.join(",")}`);
      if (opts.sparseBatch) return new Map();
      return new Map(slugs.map((slug) => {
        if (opts.overviewTimeline) return [slug, opts.overviewTimeline(slug)];
        return [slug, temporal === "sufficient" || temporal === "partial"
          ? [{ summary: "匿名时间线", event_date: "2026-01-01", trust_state: "trusted" }]
          : []];
      }));
    },
    batchGetLinksForSlugs(slugs: string[]) {
      evidenceCalls.push(`links:${slugs.join(",")}`);
      if (opts.sparseBatch) return new Map();
      return new Map(slugs.map((slug) => {
        if (opts.overviewLinks) return [slug, opts.overviewLinks(slug)];
        if (opts.proactiveHint === "shared") {
          return [slug, {
            outgoing: [{ from_slug: slug, to_slug: "shared-target", relation: "关联", trust_state: "trusted" }],
            incoming: [],
          }];
        }
        return [slug, temporal === "sufficient"
          ? { outgoing: [{ from_slug: slug, to_slug: "匿名目标", relation: "关联", trust_state: "trusted" }], incoming: [] }
          : { outgoing: [], incoming: [] }];
      }));
    },
    getPageTitlesAndTypes(slugs: string[]) {
      evidenceCalls.push(`titles:${slugs.join(",")}`);
      return new Map(slugs.map((slug) => [slug, { title: `标题-${slug}`, type: "note" }]));
    },
    getRawChunkHitsForPage(slug: string) {
      evidenceCalls.push(`raw-hit:${slug}`);
      return [];
    },
    getChunksByPage(slug: string) {
      evidenceCalls.push(`raw-fallback:${slug}`);
      return [];
    },
    isSealedPage(slug: string) {
      evidenceCalls.push(`sealed:${slug}`);
      return false;
    },
    getL1Summary(slug: string) {
      evidenceCalls.push(`summary:${slug}`);
      return null;
    },
    getExpiringSlugsInSet(slugs: string[]) {
      evidenceCalls.push(`expiry:${slugs.join(",")}`);
      return opts.proactiveHint === "expiry"
        ? [{ slug: slugs[0] ?? "accepted", title: "匿名主题", expires_at: "2026-01-01" }]
        : [];
    },
    getRecentEventsInNetwork(slugs: string[]) {
      evidenceCalls.push(`network:${slugs.join(",")}`);
      return opts.proactiveHint === "timeline"
        ? [{ slug: "neighbor", title: "匿名邻居", summary: "近期有新动态", event_date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }]
        : [];
    },
  };
  const ctx = {
    outputMode,
    search: {
      async search(query: string, options?: SearchOptions) {
        searchCalls.push({ query, options });
        return options?.strategy === "fts" ? opts.fallbackResults ?? results : results;
      },
    },
    pages: {
      getBySlug(slug: string) {
        pageSlugs.push(slug);
        if (opts.pageError) throw opts.pageError;
        if (opts.missingSlugs?.has(slug)) return null;
        const page: { title: string; body: string; type?: string } = {
          title: `标题-${slug}`,
          body: `正文-${slug}`,
        };
        if (opts.pageType !== undefined) page.type = opts.pageType;
        return page;
      },
    },
    db,
    logger: {
      info(...args: unknown[]) { logCalls.push(args); },
      warn(...args: unknown[]) { logCalls.push(args); },
      error(...args: unknown[]) { logCalls.push(args); },
    },
  };

  registerFrontdoorTools(server as never, ctx as never);
  if (!handler) throw new Error("frontdoor handler not registered");
  return {
    call: (args) => handler!(args),
    searchCalls,
    pageSlugs,
    evidenceCalls,
    logCalls,
  };
}

function parsed(output: Awaited<ReturnType<Handler>>): Record<string, unknown> {
  return JSON.parse(output.content[0]!.text) as Record<string, unknown>;
}

describe("content frontdoor honesty sequencing", () => {
  test("content recall surfaces a budgeted expiry hint", async () => {
    const harness = makeHarness([result("accepted", { exact: { original: { rankScore: 1 } } })], "legacy", {
      proactiveHint: "expiry",
    });

    const output = parsed(await harness.call({ query: "匿名主题" })) as {
      raw: { proactive_hints?: Array<{ rule: string; why: string }> };
    };

    expect(output.raw.proactive_hints).toHaveLength(1);
    expect(output.raw.proactive_hints?.[0]).toMatchObject({
      rule: "expiry_alert",
      why: expect.any(String),
    });
  });

  test("content recall projects a budgeted hint in structured details", async () => {
    const harness = makeHarness([result("accepted", { exact: { original: { rankScore: 1 } } })], "structured", {
      proactiveHint: "expiry",
    });

    const output = await harness.call({ query: "匿名主题" });
    const structured = output.structuredContent as {
      data?: { details?: { proactive_hints?: Array<{ text: string; why: string }> } };
    };

    expect(structured.data?.details?.proactive_hints).toHaveLength(1);
    expect(structured.data?.details?.proactive_hints?.[0]).toMatchObject({
      text: expect.any(String),
      why: expect.any(String),
    });
  });

  test.each([
    ["network_timeline", "timeline", ["accepted"]],
    ["shared_connection", "shared", ["accepted-a", "accepted-b"]],
  ] as const)("content recall carries the %s hint rule", async (rule, proactiveHint, slugs) => {
    const harness = makeHarness(
      slugs.map((slug) => result(slug, { exact: { original: { rankScore: 1 } } })),
      "legacy",
      { proactiveHint },
    );

    const output = parsed(await harness.call({ query: "匿名主题" })) as {
      raw: { proactive_hints?: Array<{ rule: string }> };
    };

    expect(output.raw.proactive_hints).toHaveLength(1);
    expect(output.raw.proactive_hints?.[0]?.rule).toBe(rule);
  });

  test("searches exactly once with support capture and skips sealed-detail enrichment", async () => {
    const accepted = result("accepted", { exact: { original: { rankScore: 1 } } });
    const harness = makeHarness([accepted]);

    await harness.call({ query: "匿名主题", detail: "brief" });

    expect(harness.searchCalls).toEqual([{
      query: "匿名主题",
      options: { limit: 3, _captureSupport: true, _skipDetailEnrich: true },
    }]);
    expect(harness.searchCalls[0]!.options).not.toHaveProperty("multiStep");
  });

  test("uses a clearly stronger FTS match when normal content recall has no admissible result", async () => {
    const rejected = result("initial-noise", {
      fts: { original: { rankScore: 8, rootLexicalCoverage: 0.2 } },
    });
    const fallback = result("fts-rescue", {
      fts: { original: { rankScore: 30, rootLexicalCoverage: 0.4 } },
    }, "匿名决策已记录", "fts");
    fallback.score = 30;
    const runnerUp = result("fts-runner-up", {
      fts: { original: { rankScore: 14, rootLexicalCoverage: 0.2 } },
    }, "其他匿名内容", "fts");
    runnerUp.score = 14;
    const harness = makeHarness([rejected], "legacy", { fallbackResults: [fallback, runnerUp] });

    const output = parsed(await harness.call({ query: "匿名新版决策与扩大试用条件" })) as {
      summary: { status: string; count: number };
      raw: { entities: Array<{ title: string }> };
    };

    expect(output.summary).toMatchObject({ status: "ok", count: 1 });
    expect(output.raw.entities.map((entity) => entity.title)).toEqual(["标题-fts-rescue"]);
    expect(harness.searchCalls).toEqual([
      {
        query: "匿名新版决策与扩大试用条件",
        options: { limit: 3, _captureSupport: true, _skipDetailEnrich: true },
      },
      {
        query: "匿名新版决策与扩大试用条件",
        options: { strategy: "fts", limit: 3, _captureSupport: true, _skipDetailEnrich: true },
      },
    ]);
  });

  test("skips an unsupported FTS leader for the only clearly supported fallback", async () => {
    const rejected = result("initial-noise", {
      fts: { original: { rankScore: 8, rootLexicalCoverage: 0.2 } },
    });
    const unsupportedLeader = result("fts-noise", {
      fts: { original: { rankScore: 28, rootLexicalCoverage: 0 } },
    }, "无关匿名内容", "fts");
    unsupportedLeader.score = 28;
    const fallback = result("fts-rescue", {
      fts: { original: { rankScore: 20, rootLexicalCoverage: 0.4 } },
    }, "匿名决策已记录", "fts");
    fallback.score = 20;
    const weakTail = result("fts-tail", {
      fts: { original: { rankScore: 10, rootLexicalCoverage: 0.2 } },
    }, "其他匿名内容", "fts");
    weakTail.score = 10;
    const harness = makeHarness([rejected], "legacy", {
      fallbackResults: [unsupportedLeader, fallback, weakTail],
    });

    const output = parsed(await harness.call({ query: "匿名扩大试用的已确认决策与准入条件" })) as {
      summary: { status: string; count: number };
      raw: { entities: Array<{ title: string }> };
    };

    expect(output.summary).toMatchObject({ status: "ok", count: 1 });
    expect(output.raw.entities.map((entity) => entity.title)).toEqual(["标题-fts-rescue"]);
  });

  test("keeps ambiguous FTS fallback results hidden", async () => {
    const rejected = result("initial-noise", {
      fts: { original: { rankScore: 8, rootLexicalCoverage: 0.2 } },
    });
    const top = result("ambiguous-top", {
      fts: { original: { rankScore: 25, rootLexicalCoverage: 0.4 } },
    }, "匿名相邻内容", "fts");
    top.score = 25;
    const nearMatch = result("ambiguous-runner-up", {
      fts: { original: { rankScore: 14, rootLexicalCoverage: 0.4 } },
    }, "匿名相邻内容", "fts");
    nearMatch.score = 14;
    const harness = makeHarness([rejected], "legacy", { fallbackResults: [top, nearMatch] });

    const output = parsed(await harness.call({ query: "匿名新版决策与扩大试用条件" })) as {
      summary: { status: string };
    };

    expect(output.summary.status).toBe("empty");
  });

  test("does not treat two chunks from the same page as competing FTS fallback results", async () => {
    const rejected = result("initial-noise", {
      fts: { original: { rankScore: 8, rootLexicalCoverage: 0.2 } },
    });
    const firstChunk = result("single-supported-page", {
      fts: { original: { rankScore: 30, rootLexicalCoverage: 0.4 } },
    }, "匿名记录的第一段", "fts");
    firstChunk.score = 30;
    const secondChunk = result("single-supported-page", {
      fts: { original: { rankScore: 22, rootLexicalCoverage: 0.4 } },
    }, "匿名记录的第二段", "fts");
    secondChunk.score = 22;
    const unrelatedPage = result("other-page", {
      fts: { original: { rankScore: 12, rootLexicalCoverage: 0.2 } },
    }, "其他匿名内容", "fts");
    unrelatedPage.score = 12;
    const harness = makeHarness([rejected], "legacy", {
      fallbackResults: [firstChunk, secondChunk, unrelatedPage],
    });

    const output = parsed(await harness.call({ query: "匿名问题的明确记录" })) as {
      summary: { status: string; count: number };
      raw: { entities: Array<{ title: string }> };
    };

    expect(output.summary).toMatchObject({ status: "ok", count: 1 });
    expect(output.raw.entities.map((entity) => entity.title)).toEqual(["标题-single-supported-page"]);
  });

  test("does not rescue a question that explicitly marks its clue as unknown", async () => {
    const rejected = result("initial-noise", {
      fts: { original: { rankScore: 8, rootLexicalCoverage: 0.2 } },
    });
    const top = result("unknown-top", {
      fts: { original: { rankScore: 30, rootLexicalCoverage: 0.4 } },
    }, "匿名相邻内容", "fts");
    top.score = 30;
    const runnerUp = result("unknown-runner-up", {
      fts: { original: { rankScore: 14, rootLexicalCoverage: 0.2 } },
    }, "其他匿名内容", "fts");
    runnerUp.score = 14;
    const harness = makeHarness([rejected], "legacy", { fallbackResults: [top, runnerUp] });

    const output = parsed(await harness.call({ query: "匿名未知线索" })) as {
      summary: { status: string };
    };

    expect(output.summary.status).toBe("empty");
    expect(harness.searchCalls).toHaveLength(1);
  });

  test("rejects before page, sealed, raw, evidence, and formatting work", async () => {
    const rejected = result("discarded-candidate-sentinel", {
      graph: { original: { rankScore: 987654.125 } },
      fts: { original: { rankScore: 987654.125, rootLexicalCoverage: 0.2 } },
    });
    const harness = makeHarness([rejected]);
    const output = await harness.call({ query: "匿名主题上周的具体内容", detail: "normal" });
    const envelope = parsed(output) as { summary: { status: string }; raw: { entities: unknown[] } };

    expect(envelope.summary.status).toBe("empty");
    expect(envelope.raw.entities).toEqual([]);
    expect(harness.pageSlugs).toEqual([]);
    expect(harness.evidenceCalls).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("discarded-candidate-sentinel");
  });

  test("hydrates accepted slugs only and preserves their input order", async () => {
    const rejected = result("rejected", { fts: { original: { rankScore: 9, rootLexicalCoverage: 0.1 } } });
    const accepted2 = result("accepted-2", { vector: { original: { rankScore: 2, vectorCosineSimilarity: 0.9 } } });
    const accepted3 = result("accepted-3", { fts: { original: { rankScore: 1, rootLexicalCoverage: 0.7 } } });
    const harness = makeHarness([rejected, accepted2, accepted3]);
    const output = await harness.call({ query: "匿名主题", detail: "normal" });
    const envelope = parsed(output) as { summary: { status: string; count: number }; raw: { entities: Array<{ title: string }> } };

    expect(envelope.summary).toMatchObject({ status: "ok", count: 2 });
    expect(harness.pageSlugs).toEqual(["accepted-2", "accepted-3"]);
    expect(envelope.raw.entities.map((entity) => entity.title)).toEqual([
      "标题-accepted-2",
      "标题-accepted-3",
    ]);
  });

  test.each([
    ["exact", { exact: { original: { rankScore: 1 } } }],
    ["strong vector", { vector: { original: { rankScore: 1, vectorCosineSimilarity: 0.8123456789 } } }],
    ["strong FTS after embedding failure", { fts: { original: { rankScore: 1, rootLexicalCoverage: 0.7 } } }],
    ["strong temporal", { temporal: { original: { rankScore: 1, rootLexicalCoverage: 0.7 } } }],
  ] as const)("keeps %s positive", async (_label, support) => {
    const harness = makeHarness([result("accepted", support)]);
    const output = parsed(await harness.call({ query: "匿名主题" })) as { summary: { status: string; count: number } };
    expect(output.summary).toMatchObject({ status: "ok", count: 1 });
  });

  test("accepted temporal result with incomplete evidence remains degraded", async () => {
    const accepted = result("accepted", {
      temporal: { original: { rankScore: 1, rootLexicalCoverage: 0.7 } },
    });
    const harness = makeHarness([accepted], "legacy", { temporalEvidence: "partial" });
    const output = parsed(await harness.call({ query: "匿名主题上周的具体内容" })) as {
      summary: { status: string; degraded_reason?: string };
    };

    expect(output.summary.status).toBe("degraded");
    expect(output.summary.degraded_reason).toBe("证据覆盖不足");
    expect(harness.evidenceCalls.length).toBeGreaterThan(0);
    expect(harness.evidenceCalls.every((entry) => !entry.includes("rejected"))).toBe(true);
  });

  test("non-content debug route keeps its exact options, output, and zero hydration counters", async () => {
    const supported = result("debug-only", {
      vector: { original: { rankScore: 987654.125, vectorCosineSimilarity: 0.8123456789 } },
    }, "匿名调试片段");
    const harness = makeHarness([supported]);
    const output = parsed(await harness.call({ query: "debug 一下匿名关键词在哪些页面出现" })) as {
      raw: { results: SearchResult[] };
    };

    expect(harness.searchCalls).toEqual([{
      query: "debug 一下匿名关键词在哪些页面出现",
      options: { strategy: "all", limit: 10 },
    }]);
    expect(output.raw.results).toEqual([{
      slug: "debug-only",
      score: 0.01,
      snippet: "匿名调试片段",
      source: "hybrid",
    }]);
    expect(harness.pageSlugs).toEqual([]);
    expect(harness.evidenceCalls).toEqual([]);
  });

  test("forced hydration error does not absorb attached support into the error surface", async () => {
    const supported = result("accepted", {
      vector: { original: { rankScore: 987654.125, vectorCosineSimilarity: 0.8123456789 } },
    });
    const harness = makeHarness([supported], "legacy", {
      pageError: new Error("forced hydration failure"),
    });
    let errorText = "";
    try {
      await harness.call({ query: "匿名主题", detail: "normal" });
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }

    expect(errorText).toBe("forced hydration failure");
    const errorSurface = JSON.stringify({ error: sanitizeError(errorText) });
    expect(errorSurface).toContain("forced hydration failure");
    for (const sentinel of SUPPORT_FIELD_SENTINELS) expect(errorSurface).not.toContain(sentinel);
  });
});

describe("retrieval support privacy matrix", () => {
  test("real HybridSearch keeps strong FTS when embedding is unavailable and isolates support from non-empty logs and trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-frontdoor-honesty-"));
    const db = new CBrainDB(join(root, "brain.sqlite"));
    const query = "主题甲乙丙丁戊";
    const counters = { embedding: 0, lance: 0, fts: 0 };
    const logCalls: unknown[] = [];
    try {
      db.upsertPage({
        slug: "notes/fts-only",
        type: "note",
        title: "匿名文档",
        filePath: "notes/fts-only.md",
        contentHash: "hash-fts-only",
      });
      db.insertChunkWithLevel("notes/fts-only", 0, `匿名上下文 ${query} 可靠证据`, 0, null);
      db.ftsInsert("notes/fts-only", `匿名上下文 ${query} 可靠证据`);
      const originalFts = db.ftsSearch.bind(db);
      db.ftsSearch = ((...args: Parameters<CBrainDB["ftsSearch"]>) => {
        counters.fts++;
        return originalFts(...args);
      }) as CBrainDB["ftsSearch"];
      const search = new HybridSearch(
        db,
        {
          dimensions: 2,
          async embed() {
            counters.embedding++;
            throw new Error("controlled embedding outage");
          },
          async embedBatch() { return []; },
        },
        {
          async search() { counters.lance++; return []; },
        } as never,
        {
          multiQuery: false,
          logger: {
            info(...args: unknown[]) { logCalls.push(args); },
            warn(...args: unknown[]) { logCalls.push(args); },
            error(...args: unknown[]) { logCalls.push(args); },
          } as never,
        },
      );

      const trace: SearchTrace = {};
      const traced = await search.search(query, {
        limit: 3,
        _captureSupport: true,
        _skipDetailEnrich: true,
        _trace: trace,
      });
      expect(traced).toHaveLength(1);
      expect(trace).toMatchObject({ degraded_reason: "vector_error" });
      expect(Object.keys(trace).length).toBeGreaterThan(0);
      expect(logCalls.length).toBeGreaterThan(0);

      counters.embedding = 0;
      counters.lance = 0;
      counters.fts = 0;
      logCalls.length = 0;
      let handler: Handler | undefined;
      registerFrontdoorTools({
        registerTool(name: string, _definition: unknown, registered: Handler) {
          if (name === "cbrain_recall") handler = registered;
        },
      } as never, {
        outputMode: "legacy",
        search,
        pages: { getBySlug: () => ({ title: "匿名文档", body: "匿名正文" }) },
        db,
      } as never);
      const output = await handler!({ query });
      const envelope = parsed(output) as { summary: { status: string; count: number } };

      expect(envelope.summary).toMatchObject({ status: "ok", count: 1 });
      expect(counters).toEqual({ embedding: 1, lance: 0, fts: 1 });
      expect(logCalls.length).toBeGreaterThan(0);
      const surfaces = JSON.stringify({ output, logCalls, trace });
      for (const sentinel of SUPPORT_FIELD_SENTINELS) expect(surfaces).not.toContain(sentinel);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("real deep_recall retains sealed-detail probes and absolute search counters without support capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "cbrain-deep-recall-sealed-"));
    const vaultPath = join(root, "vault");
    const runtimePath = join(root, "runtime");
    mkdirSync(join(vaultPath, "notes"), { recursive: true });
    const db = new CBrainDB(join(root, "brain.sqlite"));
    const detailSentinel = "DETAIL-ALPHA-321";
    const counters = { handlerSearch: 0, embedding: 0, lance: 0, fts: 0, rawProbe: 0 };
    try {
      db.upsertPage({
        slug: "notes/sealed",
        type: "note",
        title: "匿名密封记录",
        filePath: "notes/sealed.md",
        contentHash: "hash-sealed",
      });
      db.rawDb.prepare("UPDATE pages SET tier = 1, mention_count = 5 WHERE slug = ?").run("notes/sealed");
      writeFileSync(join(vaultPath, "notes/sealed.md"), "---\ntitle: 匿名密封记录\ntype: note\n---\n匿名摘要正文");
      const rawChunk = `匿名合同编号 ${detailSentinel} 已确认。`;
      const summary = "匿名合同概要，未列编号。";
      db.insertChunkWithLevel("notes/sealed", 0, rawChunk, 0, null);
      db.ftsInsert("notes/sealed", rawChunk);
      db.insertChunkWithLevel("notes/sealed", -1, summary, 1, "summary-hash");
      db.ftsInsert("notes/sealed", summary);
      const originalFts = db.ftsSearch.bind(db);
      db.ftsSearch = ((...args: Parameters<CBrainDB["ftsSearch"]>) => {
        counters.fts++;
        return originalFts(...args);
      }) as CBrainDB["ftsSearch"];
      const originalRawProbe = db.getRawChunkHitsForPage.bind(db);
      db.getRawChunkHitsForPage = ((...args: Parameters<CBrainDB["getRawChunkHitsForPage"]>) => {
        counters.rawProbe++;
        return originalRawProbe(...args);
      }) as CBrainDB["getRawChunkHitsForPage"];
      const ctx = buildContext({
        db,
        embedding: {
          dimensions: 2,
          async embed() {
            counters.embedding++;
            return { embedding: [1, 0], tokenCount: 1 };
          },
          async embedBatch() { return []; },
        },
        lance: {
          async search() {
            counters.lance++;
            return [{ pageSlug: "notes/sealed", chunkIndex: -1, content: summary, _distance: 0.05 }];
          },
        } as never,
        vaultPath,
        runtimePath,
      });
      const originalSearch = ctx.search.search.bind(ctx.search);
      const searchOptions: Array<SearchOptions | undefined> = [];
      ctx.search.search = async (query, options) => {
        counters.handlerSearch++;
        searchOptions.push(options);
        return originalSearch(query, options);
      };
      let handler: Handler | undefined;
      registerRecallTools({
        registerTool(name: string, _definition: unknown, registered: Handler) {
          if (name === "deep_recall") handler = registered;
        },
      } as never, ctx);
      const output = await handler!({ query: detailSentinel, detail: "normal", include_raw: true });
      const blob = JSON.stringify(output);

      expect(blob).toContain(detailSentinel);
      expect(blob).not.toContain("raw_chunk");
      expect(searchOptions).toHaveLength(1);
      expect(searchOptions[0]).not.toHaveProperty("_captureSupport");
      expect(searchOptions[0]).not.toHaveProperty("_skipDetailEnrich");
      expect(counters).toEqual({ handlerSearch: 1, embedding: 1, lance: 1, fts: 1, rawProbe: 1 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["legacy", false],
    ["legacy", true],
    ["structured", false],
    ["structured", true],
  ] as const)("does not expose support in %s mode include_raw=%s", async (mode, includeRaw) => {
    const accepted = result("accepted", {
      vector: { original: { rankScore: 987654.125, vectorCosineSimilarity: 0.8123456789 } },
      fts: { original: { rankScore: 987654.125, rootLexicalCoverage: 0.7 } },
    });
    const harness = makeHarness([accepted], mode);
    const output = await harness.call({ query: "匿名主题", include_raw: includeRaw });
    const surfaces = [output.content, output.structuredContent, harness.logCalls, harness.searchCalls[0]?.options];
    const blob = JSON.stringify(surfaces);

    for (const sentinel of SUPPORT_FIELD_SENTINELS) expect(blob).not.toContain(sentinel);
  });

  test("debug raw, compact/audit projections, logs, traces, and error surfaces cannot access support", async () => {
    const supported = result("debug-result", {
      vector: { original: { rankScore: 987654.125, vectorCosineSimilarity: 0.8123456789 } },
    });
    const harness = makeHarness([supported], "structured");
    const debug = await harness.call({
      query: "debug 一下匿名关键词在哪些页面出现",
      include_raw: true,
    });
    const blob = JSON.stringify({
      content: debug.content,
      structuredContent: debug.structuredContent,
      logs: harness.logCalls,
      trace: harness.searchCalls[0]?.options?._trace,
      syntheticError: new Error("匿名检索失败").message,
    });

    for (const sentinel of SUPPORT_FIELD_SENTINELS) expect(blob).not.toContain(sentinel);
  });

  test("support accessor has a two-module structural import allowlist", () => {
    const sourceRoot = join(import.meta.dir, "../../src");
    const allowed = new Set([
      "core/retrieval/search.ts",
      "core/retrieval/content-relevance.ts",
    ]);
    const importers: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name.endsWith(".ts")) {
          const source = readFileSync(path, "utf8");
          if (importsRetrievalSupport(source, path)) {
            importers.push(path.slice(sourceRoot.length + 1));
          }
        }
      }
    };
    visit(sourceRoot);
    expect(importers.sort()).toEqual([...allowed].sort());
  });

  test.each([
    ["named import", 'import { getRetrievalSupport } from "./retrieval-support.js";'],
    ["namespace import", 'import * as privateSupport from "./retrieval-support.js";'],
    ["dynamic import", 'const privateSupport = import("./retrieval-support.js");'],
    ["named re-export", 'export { getRetrievalSupport } from "./retrieval-support.js";'],
    ["star re-export", 'export * from "./retrieval-support.js";'],
    ["CommonJS require", 'const privateSupport = require("./retrieval-support.js");'],
    ["createRequire bridge", 'const r = createRequire(import.meta.url); const privateSupport = r("./retrieval-support.js");'],
    ["require alias", 'const load = require; const privateSupport = load("./retrieval-support.js");'],
    ["import equals require", 'import privateSupport = require("./retrieval-support.js");'],
    ["dynamic import with as-expression", 'const privateSupport = import("./retrieval-support.js" as string);'],
    ["parenthesized require argument", 'const privateSupport = require(("./retrieval-support.js"));'],
    ["require argument with satisfies", 'const privateSupport = require("./retrieval-support.js" satisfies string);'],
    ["createRequire bridge with as-expression", 'const r = createRequire(import.meta.url); const privateSupport = r("./retrieval-support.js" as string);'],
    ["static import with query", 'import { getRetrievalSupport } from "./retrieval-support.js?review337";'],
    ["dynamic import with fragment", 'const privateSupport = import("./retrieval-support.js#review337");'],
  ])("AST import fence catches %s", (_label, source) => {
    expect(importsRetrievalSupport(source)).toBe(true);
  });

  test("AST import fence ignores comments and unrelated modules", () => {
    expect(importsRetrievalSupport('// import("./retrieval-support.js")\nimport x from "./other.js";')).toBe(false);
  });

  test("AST import fence documents dynamic-code best-effort residual", () => {
    // Static AST policy cannot prove computed module specifiers or code hidden
    // inside eval/Function. Runtime code execution remains an explicit residual.
    expect(importsRetrievalSupport('const name = "retrieval-" + "support.js"; load("./" + name);')).toBe(false);
    expect(importsRetrievalSupport('eval(\'require("./retrieval-support.js")\')')).toBe(false);
  });
});

describe("overview frontdoor hydration (#395)", () => {
  const OVERVIEW_QUERY = "总结一下匿名主题的全貌";

  test("searches with limit 5 and hydrates at most 5 entities in input order", async () => {
    const results = [
      result("主题A"),
      result("主题B"),
      result("主题C"),
      result("主题D"),
      result("主题E"),
      result("主题F"),
    ];
    const harness = makeHarness(results, "legacy", { pageType: "主题" });
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as { raw: { entities: Array<{ title: string }> } };

    expect(harness.searchCalls[0]?.options).toMatchObject({ limit: 5 });
    expect(harness.searchCalls[0]?.options?.limit).toBe(5);
    expect(envelope.raw.entities.map((e) => e.title)).toEqual([
      "标题-主题A", "标题-主题B", "标题-主题C", "标题-主题D", "标题-主题E",
    ]);
  });

  test("projects title, type, and snippet for each selected entity", async () => {
    const harness = makeHarness(
      [result("主题A", undefined, "片段A"), result("主题B", undefined, "片段B")],
      "legacy",
      { pageType: "主题" },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as {
      raw: { entities: Array<{ title: string; type?: string; snippet?: string }> };
    };

    expect(envelope.raw.entities).toEqual([
      { title: "标题-主题A", type: "主题", snippet: "片段A" },
      { title: "标题-主题B", type: "主题", snippet: "片段B" },
    ]);
  });

  test("preserves empty-string snippet verbatim in entity projection", async () => {
    const harness = makeHarness(
      [result("主题A", undefined, ""), result("主题B", undefined, "片段B")],
      "legacy",
      { pageType: "主题" },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as {
      raw: { entities: Array<{ title: string; snippet: string; type?: string }> };
    };

    // P3 — snippet is projected unconditionally; an empty-string snippet
    // must survive as snippet: "" (not be dropped by a truthiness guard).
    expect(envelope.raw.entities).toEqual([
      { title: "标题-主题A", snippet: "", type: "主题" },
      { title: "标题-主题B", snippet: "片段B", type: "主题" },
    ]);
  });

  test("batches links and timeline exactly once over the selected slugs", async () => {
    const harness = makeHarness(
      [result("主题A"), result("主题B")],
      "legacy",
      {
        pageType: "主题",
        overviewLinks: () => ({ outgoing: [], incoming: [] }),
        overviewTimeline: () => [],
      },
    );
    await harness.call({ query: OVERVIEW_QUERY });

    const linksCalls = harness.evidenceCalls.filter((entry) => entry.startsWith("links:"));
    const timelineCalls = harness.evidenceCalls.filter((entry) => entry.startsWith("timeline:"));
    expect(linksCalls).toEqual(["links:主题A,主题B"]);
    expect(timelineCalls).toEqual(["timeline:主题A,主题B"]);
  });

  test("stats sum active outgoing + incoming endpoints and active timeline events", async () => {
    const harness = makeHarness(
      [result("主题A"), result("主题B")],
      "legacy",
      {
        pageType: "主题",
        overviewLinks: (slug) => slug === "主题A"
          ? {
              outgoing: [{ from_slug: "主题A", to_slug: "邻居甲" }],
              incoming: [
                { from_slug: "邻居乙", to_slug: "主题A" },
                { from_slug: "邻居丙", to_slug: "主题A" },
              ],
            }
          : { outgoing: [{ from_slug: "主题B", to_slug: "邻居丁" }], incoming: [] },
        overviewTimeline: (slug) => (slug === "主题A" ? [{ summary: "事件甲" }, { summary: "事件乙" }] : [{ summary: "事件丙" }]),
      },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as {
      raw: { stats: { totalEntities: number; totalLinks: number; totalEvents: number } };
    };

    // 主题A: 1 outgoing + 2 incoming = 3; 主题B: 1 outgoing + 0 incoming = 1 → 4
    // 主题A: 2 events; 主题B: 1 event → 3
    expect(envelope.raw.stats).toEqual({ totalEntities: 2, totalLinks: 4, totalEvents: 3 });
  });

  test("empty search returns all-zero stats and skips per-entity batch queries", async () => {
    const harness = makeHarness([], "legacy", {
      pageType: "主题",
      overviewLinks: () => {
        throw new Error("links batch must not run on empty selection");
      },
      overviewTimeline: () => {
        throw new Error("timeline batch must not run on empty selection");
      },
    });
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as {
      summary: { status: string };
      raw: { entities: unknown[]; stats: { totalEntities: number; totalLinks: number; totalEvents: number } };
    };

    expect(envelope.summary.status).toBe("empty");
    expect(envelope.raw.entities).toEqual([]);
    expect(envelope.raw.stats).toEqual({ totalEntities: 0, totalLinks: 0, totalEvents: 0 });
    expect(harness.evidenceCalls.filter((entry) => entry.startsWith("links:"))).toEqual([]);
    expect(harness.evidenceCalls.filter((entry) => entry.startsWith("timeline:"))).toEqual([]);
  });

  test("structured projection keeps title/type/snippet and three stats, hides internals", async () => {
    const harness = makeHarness(
      [result("主题A", undefined, "片段A"), result("主题B", undefined, "片段B")],
      "structured",
      {
        pageType: "主题",
        overviewLinks: (slug) => (slug === "主题A"
          ? { outgoing: [{ from_slug: "主题A", to_slug: "邻居甲" }], incoming: [] }
          : { outgoing: [], incoming: [] }),
        overviewTimeline: (slug) => (slug === "主题A" ? [{ summary: "事件甲" }] : []),
      },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const structured = output.structuredContent as {
      data?: {
        details?: {
          topic?: string;
          entities?: Array<Record<string, unknown>>;
          stats?: Record<string, number>;
        };
      };
    };
    const details = structured.data?.details;

    expect(details?.topic).toBe(OVERVIEW_QUERY);
    expect(details?.entities).toEqual([
      { title: "标题-主题A", type: "主题", snippet: "片段A" },
      { title: "标题-主题B", type: "主题", snippet: "片段B" },
    ]);
    expect(details?.stats).toEqual({ totalEntities: 2, totalLinks: 1, totalEvents: 1 });

    const blob = JSON.stringify({ content: output.content, structuredContent: output.structuredContent });
    for (const forbidden of ["routing", "chosen_route", "latency_ms", '"slug"', "score", "body", "excerpt"]) {
      expect(blob).not.toContain(forbidden);
    }
  });

  test("missing page falls back to slug for title; absent batch map entries count as zero", async () => {
    const harness = makeHarness(
      [result("主题A", undefined, "片段A")],
      "legacy",
      {
        missingSlugs: new Set(["主题A"]),
        sparseBatch: true,
      },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const envelope = parsed(output) as {
      raw: {
        entities: Array<{ title: string; type?: string; snippet?: string }>;
        stats: { totalEntities: number; totalLinks: number; totalEvents: number };
      };
    };

    expect(envelope.raw.entities).toEqual([{ title: "主题A", snippet: "片段A" }]);
    expect(envelope.raw.stats).toEqual({ totalEntities: 1, totalLinks: 0, totalEvents: 0 });
  });

  test("structured projection redacts slug-fallback title when page is missing", async () => {
    const harness = makeHarness(
      [result("concept/匿名主题", undefined, "片段A")],
      "structured",
      { missingSlugs: new Set(["concept/匿名主题"]) },
    );
    const output = await harness.call({ query: OVERVIEW_QUERY });
    const structured = output.structuredContent as {
      data?: { details?: { entities?: Array<Record<string, unknown>> } };
    };
    const entity = structured.data?.details?.entities?.[0];

    // page missing → title falls back to the raw slug; the structured
    // sanitizer redacts the slug-bearing leaf (concept/... → [removed]).
    // The snippet is still surfaced; the raw slug never reaches the agent.
    expect(entity?.title).toBe("[removed]");
    expect(entity?.snippet).toBe("片段A");
    const blob = JSON.stringify({ content: output.content, structuredContent: output.structuredContent });
    expect(blob).not.toContain("concept/匿名主题");
  });
});
