/**
 * #537 — real-handler regression for the closed keyword cause contract.
 *
 * Real components only: real temporary SQLite, real LanceDB, real PageManager
 * (temp vault) and the registered cbrain_recall handler. Only the local fixed
 * embedding is synthetic. No candidate list is replaced and no helper is tested
 * in isolation.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stringifyFrontmatter } from "../../src/utils/frontmatter.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { LanceDBManager, VECTOR_DIMENSIONS } from "../../src/storage/lancedb.js";
import { HybridSearch } from "../../src/core/retrieval/search.js";
import { PageManager } from "../../src/core/page.js";
import { computeRootLexicalCoverage } from "../../src/core/retrieval/retrieval-support.js";
import { registerFrontdoorTools } from "../../src/mcp/tools/frontdoor.js";

const CAUSE_QUERY = "实体A 季度二 收入 下滑 原因";
const CAUSE_BODY = "实体A在季度二收入下滑，原因为竞争加剧。";
const ANCHOR_QUERY = "组织甲方 季度二 收入 下滑 原因";
const ANCHOR_C1 = "组织甲方在季度三收入下滑，原因为竞争加剧。";
const ANCHOR_C2 = "组织甲方在季度三收入下滑，原因为渠道调整。";
const REPORT_QUERY = "实体甲 AliasB 地区丙仿制品 二季度 销售下滑 2026Q2 财报";
const REPORT_BODY = `# 组织丙2026年第二季度业绩
## 核心产品
| 产品 | Q2销售额 | 固定汇率同比 | 官方披露的主要原因 |
|---|---|---|---|
| 实体甲 AliasB | 12单位 | -25% | 主要受地区丙仿制品竞争影响 |`;
const UNVERIFIED_DISPLAY = "未找到可核验的原因证据。";
const UNVERIFIED_MESSAGE = "候选页面正文中没有可核验的原因证据";
const INCOMPLETE_DISPLAY = "候选页面尚未核验完成，暂时不能确认原因。";

// ───────────────────────── fixed local embedding ─────────────────────────
const e0 = new Float32Array(VECTOR_DIMENSIONS);
e0[0] = 1;
const vectorByText = new Map<string, Float32Array>();
const unregisteredEmbeds: string[] = [];

function fixtureVector(primary: number, tag: string): Float32Array {
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  const orthogonal = Math.sqrt(Math.max(0, 1 - primary * primary));
  const digest = createHash("sha256").update(tag).digest();
  vector[0] = primary;
  vector[1 + (digest[0]! % (VECTOR_DIMENSIONS - 1))] = orthogonal;
  return vector;
}

function makeEmbedder(query: string) {
  const queryTexts = new Set([query, query.normalize("NFKC")]);
  const embedOne = (text: string) => {
    if (queryTexts.has(text)) return { embedding: Array.from(e0), tokenCount: 0 };
    const registered = vectorByText.get(text);
    if (registered) return { embedding: Array.from(registered), tokenCount: 0 };
    unregisteredEmbeds.push(text.slice(0, 60));
    return { embedding: Array.from(fixtureVector(0.4, text)), tokenCount: 0 };
  };
  return {
    dimensions: VECTOR_DIMENSIONS,
    embed: async (text: string) => embedOne(text),
    embedBatch: async (texts: string[]) => texts.map(embedOne),
  };
}

// ───────────────────────── purity snapshots ─────────────────────────
function walkFiles(base: string, root = base, acc: string[] = []): string[] {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) walkFiles(full, root, acc);
    else acc.push(relative(root, full));
  }
  return acc;
}

function vaultSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of walkFiles(root).sort()) {
    out[rel] = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
  }
  return out;
}

function sortedRow(row: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key] ?? null]));
}

function knowledgeSnapshot(db: CBrainDB): Record<string, string[]> {
  const tables = (db as never as { rawDb: { prepare: (sql: string) => { all: () => unknown } } }).rawDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'query_log' ORDER BY name")
    .all() as Array<{ name: string }>;
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    const rows = (db as never as { rawDb: { prepare: (sql: string) => { all: () => unknown } } }).rawDb
      .prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    out[name] = rows.map(sortedRow).sort();
  }
  return out;
}

function changedTables(before: Record<string, string[]>, after: Record<string, string[]>): string[] {
  const changed: string[] = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[table] ?? null) !== JSON.stringify(after[table] ?? null)) changed.push(table);
  }
  return changed;
}

// ───────────────────────── fixture harness ─────────────────────────
interface PageFixture {
  slug: string;
  title: string;
  chunks: string[];
  body: string;
  vectorPrimary: number;
  /** Vault-side sabotage for the identity-drift and missing-page rows. */
  sabotage?: "title_drift" | "missing_file";
}

interface Fixture {
  query: string;
  pages: PageFixture[];
  readThrowsFor?: string;
  detail?: "brief" | "normal" | "full";
  outputMode?: "legacy" | "structured";
  /** Controlled injection: expire the cache and change the source right after the fresh read. */
  expireAndDrift?: boolean;
}

interface RunReport {
  count: number;
  status: string;
  display: string;
  message: string;
  route: string;
  entities: Array<{ title: string; snippet: string; body?: string }>;
  searches: number;
  freshReads: number;
  cacheReads: number;
  freshReadsBySlug: Record<string, number>;
  tableChanges: string[];
  vaultChanged: boolean;
  queryLogDelta: number;
  /** Production coverage of the full body and of each indexed chunk. */
  coverage: Array<{ slug: string; body: number; chunks: number[] }>;
  /** Legacy raw.summary and structured data.details.summary. */
  rawSummary?: string;
  dataSummary?: string;
}

function page(slug: string, title: string, text: string, vectorPrimary: number): PageFixture {
  return { slug, title, chunks: [text], body: text, vectorPrimary };
}

async function runFixture(fixture: Fixture): Promise<RunReport> {
  const root = mkdtempSync(join(tmpdir(), "cbrain-537-impl-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const db = new CBrainDB(join(root, "brain.sqlite"));
  const lance = new LanceDBManager();
  await lance.connect(join(root, "lance"));
  const pages = new PageManager(db, vault, undefined, lance);
  const embedder = makeEmbedder(fixture.query);
  const search = new HybridSearch(db, embedder as never, lance, { multiQuery: false });
  const counters = { searches: 0, freshReads: 0, cacheReads: 0 };
  const freshReadsBySlug: Record<string, number> = {};
  const countingSearch = new Proxy(search, {
    get(target, prop, receiver) {
      if (prop === "search") {
        return async (q: string, options?: Record<string, unknown>) => {
          counters.searches++;
          return await (target.search as (a: string, b?: unknown) => Promise<unknown>)(q, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const countingPages = new Proxy(pages, {
    get(target, prop, receiver) {
      if (prop === "getBySlugFresh") {
        return (slug: string) => {
          counters.freshReads++;
          freshReadsBySlug[slug] = (freshReadsBySlug[slug] ?? 0) + 1;
          if (fixture.readThrowsFor === slug) throw new Error("source unavailable");
          const snapshot = (target.getBySlugFresh as (value: string) => unknown)(slug);
          if (fixture.expireAndDrift) {
            // Test-side failure injection only: expire the real page cache and
            // replace the DB row plus the vault file immediately after the
            // certified fresh read. The recall path itself must never read this
            // second source for the answer, title, or page metadata.
            const cache = (target as unknown as { cache: Map<string, { expires: number }> }).cache;
            const entry = cache.get(slug);
            if (entry) entry.expires = 0;
            db.upsertPage({ slug, title: "漂移记录B", type: "record", filePath: `${slug}.md`, contentHash: "b" });
            writeFileSync(join(vault, `${slug}.md`), stringifyFrontmatter(
              { title: "漂移记录B", type: "record", slug },
              "实体B在季度三收入上升，原因为渠道调整。",
            ));
          }
          return snapshot;
        };
      }
      if (prop === "getBySlug") {
        return (slug: string) => {
          counters.cacheReads++;
          return (target.getBySlug as (value: string) => unknown)(slug);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  try {
    for (const fixturePage of fixture.pages) {
      db.upsertPage({
        slug: fixturePage.slug,
        title: fixturePage.title,
        type: "record",
        filePath: `${fixturePage.slug}.md`,
        contentHash: "a",
      });
      for (const [index, chunk] of fixturePage.chunks.entries()) {
        db.insertChunkWithLevel(fixturePage.slug, index, chunk, 0, null);
        db.ftsInsert(fixturePage.slug, chunk);
        const vector = fixtureVector(fixturePage.vectorPrimary, `${fixturePage.slug}:${index}`);
        vectorByText.set(chunk, vector);
        vectorByText.set(chunk.normalize("NFKC"), vector);
        await lance.addChunks([{ pageSlug: fixturePage.slug, chunkIndex: index, content: chunk, vector }]);
      }
      if (fixturePage.sabotage === "missing_file") continue;
      const filePath = join(vault, `${fixturePage.slug}.md`);
      mkdirSync(dirname(filePath), { recursive: true });
      const frontmatterTitle = fixturePage.sabotage === "title_drift"
        ? `${fixturePage.title}（漂移）`
        : fixturePage.title;
      writeFileSync(filePath, stringifyFrontmatter(
        { title: frontmatterTitle, type: "record", slug: fixturePage.slug },
        fixturePage.body,
      ));
    }

    let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    registerFrontdoorTools({
      registerTool(name: string, _definition: unknown, callback: typeof handler) {
        if (name === "cbrain_recall") handler = callback;
      },
    } as never, {
      outputMode: fixture.outputMode ?? "legacy", db, search: countingSearch, pages: countingPages,
      vaultPath: vault, embedding: embedder, lance,
    } as never);
    if (!handler) throw new Error("cbrain_recall handler was not registered");

    const rawDb = (db as never as { rawDb: { prepare: (sql: string) => { get: () => unknown } } }).rawDb;
    const before = knowledgeSnapshot(db);
    const beforeVault = vaultSnapshot(vault);
    const queryLogBefore = (rawDb.prepare("SELECT COUNT(*) AS c FROM query_log").get() as { c: number }).c;
    counters.searches = 0;
    counters.freshReads = 0;
    counters.cacheReads = 0;
    for (const key of Object.keys(freshReadsBySlug)) delete freshReadsBySlug[key];

    const response = await handler({ query: fixture.query, ...(fixture.detail ? { detail: fixture.detail } : {}) });
    const output = fixture.outputMode === "structured"
      ? (response as { structuredContent: { raw?: { summary?: string; entities?: unknown; routing?: { chosen_route?: string } }; data?: { details?: { summary?: string } }; summary?: { count?: number; status?: string; message?: string }; display?: string } }).structuredContent
      : JSON.parse(response.content[0].text);
    const queryLogAfter = (rawDb.prepare("SELECT COUNT(*) AS c FROM query_log").get() as { c: number }).c;

    const report: RunReport = {
      count: output.summary?.count ?? -1,
      status: output.summary?.status ?? "",
      display: output.display ?? "",
      message: output.summary?.message ?? "",
      route: output.raw?.routing?.chosen_route ?? "",
      entities: (output.raw?.entities ?? []) as RunReport["entities"],
      searches: counters.searches,
      freshReads: counters.freshReads,
      cacheReads: counters.cacheReads,
      freshReadsBySlug: { ...freshReadsBySlug },
      tableChanges: changedTables(before, knowledgeSnapshot(db)),
      vaultChanged: JSON.stringify(beforeVault) !== JSON.stringify(vaultSnapshot(vault)),
      queryLogDelta: queryLogAfter - queryLogBefore,
      coverage: fixture.pages.map((fixturePage) => ({
        slug: fixturePage.slug,
        body: computeRootLexicalCoverage(fixture.query, fixturePage.body),
        chunks: fixturePage.chunks.map((chunk) => computeRootLexicalCoverage(fixture.query, chunk)),
      })),
      rawSummary: output.raw?.summary,
      dataSummary: output.data?.details?.summary,
    };
    if (process.env.CBRAIN_537_MATRIX === "1") console.log(`MATRIX_537 ${JSON.stringify(report)}`);
    return report;
  } finally {
    lance.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function expectVerifiedAnswer(report: RunReport, snippet: string): void {
  expect(report.count).toBe(1);
  expect(report.status).toBe("ok");
  expect(report.route).toBe("content_recall");
  expect(report.entities[0]?.snippet).toBe(snippet);
  expect(report.tableChanges).toEqual([]);
  expect(report.vaultChanged).toBe(false);
  expect(report.queryLogDelta).toBe(1);
  expect(unregisteredEmbeds).toEqual([]);
}

function expectInsufficient(report: RunReport): void {
  expect(report.count).toBe(0);
  expect(report.status).toBe("empty");
  expect(report.display).toBe(UNVERIFIED_DISPLAY);
  expect(report.message).toBe(UNVERIFIED_MESSAGE);
  expect(report.entities).toEqual([]);
  expect(report.route).toBe("content_recall");
  expect(report.tableChanges).toEqual([]);
  expect(report.vaultChanged).toBe(false);
  expect(report.queryLogDelta).toBe(1);
  expect(unregisteredEmbeds).toEqual([]);
}

const TIMEOUT = 30_000;

test("verified cause sentence is returned for weak and strong vectors", async () => {
  const weak = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", "原始记录A", CAUSE_BODY, 0.1)] });
  expectVerifiedAnswer(weak, CAUSE_BODY);

  const strong = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", "原始记录A", CAUSE_BODY, 0.99)] });
  expectVerifiedAnswer(strong, CAUSE_BODY);
}, TIMEOUT);

const REJECTIONS: Array<[string, string]> = [
  ["wrong subject", "实体B在季度二收入下滑，原因为竞争加剧。"],
  ["wrong period", "实体A在季度三收入下滑，原因为竞争加剧。"],
  ["wrong action", "实体A在季度二收入上升，原因为竞争加剧。"],
  ["unknown cause", "实体A在季度二收入下滑，原因尚未明确。"],
  ["negated cause", "实体A在季度二收入未下滑，原因为竞争减弱。"],
  ["missing cause", "实体A在季度二收入变化，相关情况待补充。"],
];

for (const [label, body] of REJECTIONS) {
  test(`high-similarity candidate cannot answer with a ${label}`, async () => {
    const report = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", "原始记录A", body, 0.99)] });
    expectInsufficient(report);
    expect(report.freshReads).toBe(1);
  }, TIMEOUT);
}

test("title equal to the question cannot certify a wrong body and keeps a correct one", async () => {
  const wrong = await runFixture({
    query: CAUSE_QUERY,
    pages: [page("records/source-a", CAUSE_QUERY, "实体B在季度二收入下滑，原因为竞争加剧。", 0.1)],
  });
  expectInsufficient(wrong);

  const correct = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", CAUSE_QUERY, CAUSE_BODY, 0.1)] });
  expectVerifiedAnswer(correct, CAUSE_BODY);
}, TIMEOUT);

test("FTS subject anchor cannot answer with a wrong period", async () => {
  const report = await runFixture({
    query: ANCHOR_QUERY,
    pages: [{
      slug: "records/source-a", title: "原始记录A",
      chunks: [ANCHOR_C1, ANCHOR_C2], body: `${ANCHOR_C1}\n${ANCHOR_C2}`, vectorPrimary: 0.1,
    }],
  });
  expectInsufficient(report);
  // The primary admission rejects everything, so the existing second FTS round still runs.
  expect(report.searches).toBe(2);
  // Main round and FTS rescue share one slug: exactly one fresh body read.
  expect(report.freshReads).toBe(1);
  expect(report.freshReadsBySlug).toEqual({ "records/source-a": 1 });
}, TIMEOUT);

test("cross-chunk cause sentence is recovered from the verified body", async () => {
  const report = await runFixture({
    query: CAUSE_QUERY,
    pages: [{
      slug: "records/source-a", title: "原始记录A",
      chunks: ["实体A在季度二收入下滑，", "原因为竞争加剧。"], body: CAUSE_BODY, vectorPrimary: 0.99,
    }],
  });
  expectVerifiedAnswer(report, CAUSE_BODY);
  expect(computeRootLexicalCoverage(CAUSE_QUERY, "实体A在季度二收入下滑，")).toBe(0);
  expect(computeRootLexicalCoverage(CAUSE_QUERY, "原因为竞争加剧。")).toBe(0);
  expect(report.searches).toBe(1);
}, TIMEOUT);

test("a page holding another subject's cause sentence returns only the verified sentence", async () => {
  const otherSubject = "实体B在季度二收入下滑，原因为竞争加剧。";
  const verified = "实体A在季度二收入下滑，原因为渠道调整。";
  const body = `${otherSubject}\n${verified}`;
  const report = await runFixture({
    query: CAUSE_QUERY,
    detail: "normal",
    pages: [{ slug: "records/source-a", title: "原始记录A", chunks: [otherSubject, verified], body, vectorPrimary: 0.99 }],
  });
  expectVerifiedAnswer(report, verified);
  expect(report.entities[0]?.body).toBe(verified);
  expect(report.entities[0]?.snippet).not.toBe(body);
  expect(body.includes(report.entities[0]!.snippet)).toBe(true);
}, TIMEOUT);

const AUTHORIZED_NARROWING: Array<[string, string]> = [
  ["appended clause", "实体A在季度二收入下滑，原因为竞争加剧，且渠道调整影响了销量。"],
  ["colon answer", "实体A在季度二收入下滑，原因为：竞争加剧。"],
];

for (const [label, body] of AUTHORIZED_NARROWING) {
  test(`authorized narrowing reports insufficient evidence for a ${label}`, async () => {
    const report = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", "原始记录A", body, 0.99)] });
    expectInsufficient(report);
    expect(report.freshReads).toBe(1);
  }, TIMEOUT);
}

test("ordinary semantic request keeps its previous behavior and reads no body", async () => {
  const body = "实体A季度二收入下滑，竞争加剧导致。";
  const report = await runFixture({
    query: "实体A 季度二 收入 情况",
    pages: [page("records/source-a", "原始记录A", body, 0.99)],
  });
  expect(report.count).toBe(1);
  expect(report.status).toBe("ok");
  expect(report.route).toBe("content_recall");
  expect(report.entities[0]?.snippet).toBe(body);
  expect(report.freshReads).toBe(0);
  expect(report.tableChanges).toEqual([]);
}, TIMEOUT);

test("each slug is read at most once and bound to its own verified sentence", async () => {
  const first = "实体A在季度二收入下滑，原因为竞争加剧。";
  const second = "实体A在季度二收入下滑，原因为渠道调整。";
  const report = await runFixture({
    query: CAUSE_QUERY,
    pages: [
      page("records/source-a", "原始记录A", first, 0.99),
      page("records/source-b", "原始记录B", second, 0.95),
    ],
  });
  expect(report.count).toBe(2);
  expect(report.status).toBe("ok");
  const byTitle = new Map(report.entities.map((entity) => [entity.title, entity.snippet]));
  expect(byTitle.get("原始记录A")).toBe(first);
  expect(byTitle.get("原始记录B")).toBe(second);
  expect(new Set(report.entities.map((entity) => entity.snippet)).size).toBe(2);
  expect(report.searches).toBe(1);
  expect(report.freshReads).toBe(2);
  expect(report.freshReadsBySlug).toEqual({ "records/source-a": 1, "records/source-b": 1 });
  expect(report.tableChanges).toEqual([]);
  expect(report.vaultChanged).toBe(false);
}, TIMEOUT);

const UNVERIFIABLE: Array<[string, PageFixture, string | undefined]> = [
  ["identity drift", { ...page("records/source-a", "原始记录A", CAUSE_BODY, 0.99), sabotage: "title_drift" }, undefined],
  ["missing page", { ...page("records/source-a", "原始记录A", CAUSE_BODY, 0.99), sabotage: "missing_file" }, undefined],
  ["read failure", page("records/source-a", "原始记录A", CAUSE_BODY, 0.99), "records/source-a"],
];

for (const [label, fixturePage, readThrowsFor] of UNVERIFIABLE) {
  test(`${label} produces no unverified cause answer`, async () => {
    const report = await runFixture({ query: CAUSE_QUERY, pages: [fixturePage], ...(readThrowsFor ? { readThrowsFor } : {}) });
    expect(report.count).toBe(0);
    expect(report.route).toBe("content_recall");
    expect(report.entities).toEqual([]);
    expect(report.status).toBe("degraded");
    expect(report.display).toBe(INCOMPLETE_DISPLAY);
    expect(report.display).not.toBe(UNVERIFIED_DISPLAY);
    expect(report.freshReads).toBe(1);
  }, TIMEOUT);
}

test("a later retraction sentence stays outside the closed cause grammar", async () => {
  // Documented minimal boundary: the closed grammar proves ONE bounded source
  // sentence. A retraction stated in a different sentence of the same page is
  // neither parsed nor treated as a general contradiction. Widening this needs
  // an explicit decision; see the delivery notes.
  const retraction = "本页此前关于竞争加剧的说法已撤回。";
  const report = await runFixture({
    query: CAUSE_QUERY,
    pages: [{
      slug: "records/source-a", title: "原始记录A",
      chunks: [CAUSE_BODY, retraction], body: `${CAUSE_BODY}\n${retraction}`, vectorPrimary: 0.99,
    }],
  });
  expect(report.count).toBe(1);
  expect(report.entities[0]?.snippet).toBe(CAUSE_BODY);
  expect(report.coverage).toEqual([{ slug: "records/source-a", body: 1, chunks: [1, 0] }]);
}, TIMEOUT);

test("quarterly report verification and its read budget do not regress", async () => {
  const report = await runFixture({
    query: REPORT_QUERY,
    pages: [{
      slug: "records/report-a", title: "原始记录A",
      chunks: [REPORT_BODY.split("\n")[0]!, REPORT_BODY.split("\n").slice(1).join("\n")],
      body: REPORT_BODY,
      vectorPrimary: 0.99,
    }],
  });
  expect(report.count).toBe(1);
  expect(report.status).toBe("ok");
  expect(report.route).toBe("content_recall");
  expect(report.entities[0]?.snippet).toContain("主要受地区丙仿制品竞争影响");
  // One main search, one fresh body read for the certified report line.
  expect(report.searches).toBe(1);
  expect(report.freshReads).toBe(1);
  expect(report.freshReadsBySlug).toEqual({ "records/report-a": 1 });
  expect(report.tableChanges).toEqual([]);
  expect(report.vaultChanged).toBe(false);
}, TIMEOUT);

// ─────────────── review R1–R3 regressions (supplement round 1) ───────────────

const INCOMPLETE_MESSAGE = "候选页面尚未核验完成，暂时不能确认原因";
const COMPATIBLE_QUESTION_ENDINGS = ["？", "﹖", "⁇", "⁈", "⁉"];

/** Channels that exist in both output modes, without the legacy-only display. */
function expectTruthfulCauseSummary(report: RunReport, message: string, outputMode: "legacy" | "structured"): void {
  expect(report.count).toBe(0);
  expect(report.entities).toEqual([]);
  expect(report.tableChanges).toEqual([]);
  expect(report.queryLogDelta).toBe(1);
  expect(unregisteredEmbeds).toEqual([]);
  if (outputMode === "legacy") {
    expect(report.rawSummary).toBe(message);
    expect(report.rawSummary).not.toContain("没找到相关记忆");
    expect(report.message).toBe(message);
  } else {
    // The existing structured projection normalizes projected text with NFKC
    // before bounding it, so compare against that documented projection form.
    expect(report.dataSummary).toBe(message.normalize("NFKC"));
    expect(report.dataSummary).not.toContain("没找到相关记忆");
  }
}

test("R1: a missing cause sentence is never reported as no related memory", async () => {
  const wrongSubject = "实体B在季度二收入下滑，原因为竞争加剧。";
  const legacy = await runFixture({
    query: CAUSE_QUERY, outputMode: "legacy",
    pages: [page("records/source-a", "原始记录A", wrongSubject, 0.99)],
  });
  expectInsufficient(legacy);
  expectTruthfulCauseSummary(legacy, UNVERIFIED_MESSAGE, "legacy");

  const structured = await runFixture({
    query: CAUSE_QUERY, outputMode: "structured",
    pages: [page("records/source-a", "原始记录A", wrongSubject, 0.99)],
  });
  expect(structured.status).toBe("empty");
  expectTruthfulCauseSummary(structured, UNVERIFIED_MESSAGE, "structured");
}, TIMEOUT);

test("R1: an incomplete verification is reported truthfully in both output modes", async () => {
  for (const outputMode of ["legacy", "structured"] as const) {
    const report = await runFixture({
      query: CAUSE_QUERY, outputMode, readThrowsFor: "records/source-a",
      pages: [page("records/source-a", "原始记录A", CAUSE_BODY, 0.99)],
    });
    expect(report.status).toBe("degraded");
    expectTruthfulCauseSummary(report, INCOMPLETE_MESSAGE, outputMode);
    if (outputMode === "legacy") expect(report.display).toBe(INCOMPLETE_DISPLAY);
  }
}, TIMEOUT);

test("R2: an expired cache or drifted source cannot replace the certified snapshot", async () => {
  const report = await runFixture({
    query: CAUSE_QUERY, expireAndDrift: true,
    pages: [page("records/source-a", "原始记录A", CAUSE_BODY, 0.99)],
  });
  expect(report.count).toBe(1);
  expect(report.status).toBe("ok");
  // The verified snapshot supplies the answer, the title, and the page metadata.
  expect(report.entities[0]?.title).toBe("原始记录A");
  expect(report.entities[0]?.snippet).toBe(CAUSE_BODY);
  expect(report.entities[0]?.snippet).not.toContain("渠道调整");
  // Output hydration never falls back to the ordinary page cache (0 cache
  // calls, no second disk read). The one fresh read is the only page source
  // read for this request; getBySlugFresh itself does exactly one disk read.
  expect(report.cacheReads).toBe(0);
  expect(report.freshReads).toBe(1);
  expect(report.freshReadsBySlug).toEqual({ "records/source-a": 1 });
  // The second source was really injected by this test, not by recall itself.
  expect(report.vaultChanged).toBe(true);
  expect(report.tableChanges).toEqual(["pages"]);
}, TIMEOUT);

for (const ending of COMPATIBLE_QUESTION_ENDINGS) {
  test(`R3: a compatible question ending (${ending}) never certifies an assertion`, async () => {
    const report = await runFixture({
      query: CAUSE_QUERY,
      pages: [page("records/source-a", "原始记录A", `${CAUSE_BODY}${ending}`, 0.99)],
    });
    expectInsufficient(report);
    // Baseline grammar rejected this ending; the normalized ending still does.
    expect(report.coverage[0]?.body).toBe(0);
    expect(report.coverage[0]?.chunks).toEqual([0]);
    expect(report.entities).toEqual([]);
  }, TIMEOUT);
}

test("R3: the verified sentence keeps its original compatible characters", async () => {
  const body = "实体Ａ在季度二收入下滑，原因为竞争加剧。";
  const report = await runFixture({ query: CAUSE_QUERY, pages: [page("records/source-a", "原始记录A", body, 0.99)] });
  expectVerifiedAnswer(report, body);
  expect(report.entities[0]?.snippet).not.toBe(body.normalize("NFKC"));
}, TIMEOUT);
