#!/usr/bin/env bun
// check-v2-rc-gate.ts — Offline v2.0 release-candidate hardening gate
//
// Usage: bun bin/check-v2-rc-gate.ts
//
// Exercises CBrain as a deterministic kernel through the SAME registered MCP
// handler path Hermes uses (buildContext + registerAllTools), driving real-user
// journeys over an anonymous synthetic knowledge set in an isolated temporary
// HOME/vault/runtime. Never reads the real vault or runtime.
//
// Journeys:
//   1. exact entity recall                      (deep_recall, title match)
//   2. normal topic recall (non-title phrase)   (deep_recall, FTS body path)
//   3. grounded recall with evidence            (deep_recall grounded)
//   4. relationship / hierarchy lookup          (graph_query)
//   5. episodic person recall from clues        (recall_episode)
//   6. provenance / version-history follow-up   (get_versions)
//   7. controlled degraded-search fault         (deep_recall → vector error, FTS fallback)
//   8. empty-search                             (deep_recall → graceful empty wording)
//
// Validates, per journey:
//   - privacy: no slug/path/stack/vector/debug/credential in display
//   - compactness: first-response display within a char budget
//   - operation/query-count budget (per-journey baseline × headroom, deterministic)
//   - generous wall-clock ceiling (hang detection only)
//
// Test-only fault controls (env vars, ignored in production):
//   RC_FAULT_RETRIEVAL=1     — empty out recall so a must-hit journey fails
//   RC_FAULT_PRIVACY_LEAK=1  — inject a banned token into a journey display
//   RC_FAULT_HANG=1          — make the first journey's handler never resolve
//   RC_FAULT_QUERY_BUDGET=1  — inflate the SQL counter so budgets are breached
//
// Exit codes: 0 = go, 1 = no-go, 2 = fatal (script bug)
// stdout: machine-readable JSON report. stderr: concise terminal summary.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import type { LanceDBManager } from "../src/storage/lancedb.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import { buildContext, type ToolContext } from "../src/mcp/context.js";
import { registerAllTools } from "../src/mcp/register.js";
import { sanitizeError } from "../src/mcp/server.js";
import { buildPerfReport, type PerfReport } from "../src/release/perf-report.js";

// ── Types ──

type Verdict = "go" | "no-go";

interface AssertionResult {
  readonly check: string;
  readonly passed: boolean;
  readonly actual: string;
  readonly expected: string;
}

interface JourneyResult {
  readonly id: string;
  readonly tool: string;
  readonly passed: boolean;
  readonly duration_ms: number;
  readonly query_count: number;
  readonly query_budget: number;
  readonly display_chars: number;
  readonly timed_out: boolean;
  readonly assertions: ReadonlyArray<AssertionResult>;
  readonly failed_reason: string | null;
}

interface GateReport {
  readonly gate: "v2-rc";
  readonly version: string;
  readonly timestamp: string;
  readonly verdict: Verdict;
  readonly journeys: ReadonlyArray<JourneyResult>;
  readonly privacy: { readonly passed: boolean; readonly assertions: ReadonlyArray<AssertionResult> };
  readonly budgets: {
    readonly baselines: Readonly<Record<string, number>>;
    readonly headroom_mult: number;
    readonly hang_ceiling_ms: number;
    readonly display_chars: number;
  };
  readonly slowest_journey: { readonly id: string; readonly duration_ms: number } | null;
  readonly failed_stage: string | null;
  readonly reason: string | null;
  readonly next_action: string | null;
  readonly cleanup: { readonly verified: boolean; readonly path: string };
  readonly duration_ms: number;
}

interface GateResult {
  readonly report: GateReport;
  readonly exitCode: number;
}

interface IsolationContext {
  readonly tmpdir: string;
  readonly homeDir: string;
  readonly brainDir: string;
  readonly vaultPath: string;
  readonly runtimePath: string;
  readonly dbPath: string;
  readonly profileDir: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolMap = Record<string, { handler: (args: any) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>;

// ── Constants ──

const HANG_CEILING_MS = 5000;           // hang detection only; real journeys are sub-second
const DISPLAY_BUDGET_CHARS = 600;       // compact first-response (short-message channel)

// Per-journey SQL-statement baseline, measured on the anonymous fixture WITH
// the scale fillers seeded (60 anonymous persons). These are the CONSTANT
// operation counts — the batch DB methods are true IN-clause batches, so a
// correct implementation's query count does NOT grow as pages grow. The budget
// is baseline × QUERY_HEADROOM_MULT (a small fixed margin). A per-page N+1
// regression multiplies a journey's DB work with page/person count and trips
// no-go deterministically at that journey — e.g. episodic stays at 6 over 62
// persons; a per-person loop would be 60+ and breach the 12 budget. Counts are
// fully deterministic (verified zero variance across runs). Bump a baseline
// only when a journey legitimately gains a constant query.
const QUERY_HEADROOM_MULT = 2;
const QUERY_BASELINE: Readonly<Record<string, number>> = {
  "exact-recall": 26,
  "topic-recall": 14,
  "grounded-recall": 4,
  "relationship-lookup": 7,
  "episodic-person": 6,
  "version-history": 2,
  "degraded-search": 2,
  "empty-search": 2,
};
// Fallback for any journey id without an explicit baseline.
const FALLBACK_QUERY_BUDGET = 60;

function budgetFor(id: string): number {
  const base = QUERY_BASELINE[id];
  return base != null ? base * QUERY_HEADROOM_MULT : FALLBACK_QUERY_BUDGET;
}

// Anonymous synthetic fixture. No real names, no real identifiers.
const METHOD_SLUG = "concepts/method-alpha";
const METHOD_TITLE = "方法Alpha";
const ORG_SLUG = "entities/org-zeta";
const ORG_TITLE = "组织Zeta";
const P1_SLUG = "entities/person-jiayi";
const P1_TITLE = "联系人甲";
const P2_SLUG = "entities/person-jiaer";
const P2_TITLE = "联系人乙";
const REC_SLUG = "records/topic-beta-note";
const REC_TITLE = "主题Beta笔记";

// Body phrases used as NON-title queries — exercises the FTS/topic path that
// exact-title journeys skip.
const TOPIC_PHRASE = "三层架构";          // appears only in METHOD_BODY
const DEGRADED_PHRASE = "核心机制";        // appears in METHOD/ORG bodies → FTS fallback hit

const METHOD_BODY =
  "方法Alpha是一种确定性核心机制，采用三层架构：数据层、逻辑层与接口层。" +
  "组织Zeta是方法Alpha的主要采用方，由联系人甲负责落地。";
const ORG_BODY = "组织Zeta采用方法Alpha作为核心机制，联系人甲负责落地实施。";
const P1_BODY =
  "联系人甲在组织Zeta工作，负责方法Alpha的落地实施。" +
  "与联系人乙在2025年团建上共同讨论了主题Beta。";
const P2_BODY = "联系人乙发起了主题Beta，并在2025年团建上与联系人甲讨论了方法Alpha的应用。";
const REC_BODY =
  "主题Beta笔记：主题Beta围绕方法Alpha的三层架构展开，" +
  "2025年团建期间由联系人乙发起、联系人甲参与讨论。";

// Absolute anonymous time anchor (not a relative "去年"). Derive both the
// fixture timeline date and the time hint from one controlled value so the
// episodic journey stays green in any calendar year.
const EPISODE_YEAR = "2025";
const EPISODE_DATE = `${EPISODE_YEAR}-08-20`;
const VERSION_CONTENT = "方法Alpha v1 初始版本：确定性核心机制，三层架构。";

// ── Mocks (offline, deterministic; no network, no real vector index) ──

// Bag-of-character embedding: each char lands at its own charCode dimension
// (no modulo) and the vector is L2-normalized, so cosine = shared-character
// ratio. Dimensions cover the CJK Unified Ideographs block so Chinese chars
// never collide. This is a faithful, deterministic stand-in for semantic
// similarity: a non-exact query (a body phrase) hits the page whose body shares
// those characters, while an unrelated query with no shared chars gets no hit —
// exactly how a real index surfaces a topically-relevant neighbour.
const EMBED_DIM = 40960; // 0..0x9fff — covers CJK without modulo collision
function embedText(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < EMBED_DIM) v[code] += 1;
  }
  let sumSq = 0;
  for (let i = 0; i < EMBED_DIM; i++) { const c = v[i]; if (c !== 0) sumSq += c * c; }
  if (sumSq === 0) return v;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < EMBED_DIM; i++) { if (v[i] !== 0) v[i] *= inv; }
  return v;
}

function makeMockEmbedding(): EmbeddingProvider {
  const embedOne = (text: string) => ({
    embedding: embedText(text),
    tokenCount: text.length,
  });
  return {
    dimensions: EMBED_DIM,
    embed: async (text: string) => embedOne(text),
    embedBatch: async (texts: string[]) => texts.map(embedOne),
  };
}

type VectorMode = "ok" | "error";

interface MockDoc {
  readonly pageSlug: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly embedding: number[];
}

interface MockLance extends LanceDBManager {
  vectorMode: VectorMode;
  /** Gate-only: seed the in-memory vector index with a page-body embedding. */
  _seedDoc(pageSlug: string, chunkIndex: number, content: string, embedding: number[]): void;
}

// Minimum cosine for a vector hit. Below this the mock returns no vector
// result — mirroring a real index that does not surface unrelated neighbours,
// so an unrelated query (empty-search) gets no vector fallback.
const MOCK_VECTOR_MIN_COSINE = 0.2;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Deterministic LanceDB stand-in. In `ok` mode it runs cosine nearest-neighbour
 *  over the seeded page-body embeddings so the normal hybrid path has a REAL
 *  vector recall signal (a non-exact query can hit via cosine). `vectorMode =
 *  "error"` makes the vector search throw — exercising the production
 *  vector-error → FTS-fallback degradation path. */
function makeMockLance(): MockLance {
  let vectorMode: VectorMode = "ok";
  const docs: MockDoc[] = [];
  const mgr = {
    get vectorMode(): VectorMode { return vectorMode; },
    set vectorMode(v: VectorMode) { vectorMode = v; },
    connect: async () => {},
    addChunks: async () => {},
    _seedDoc(pageSlug: string, chunkIndex: number, content: string, embedding: number[]): void {
      docs.push({ pageSlug, chunkIndex, content, embedding });
    },
    search: async (embedding: number[], limit: number) => {
      if (vectorMode === "error") throw new Error("vector index offline (rc-gate fault)");
      return docs
        .map((d) => ({ d, c: cosine(embedding, d.embedding) }))
        .filter((x) => x.c >= MOCK_VECTOR_MIN_COSINE)
        .sort((a, b) => b.c - a.c)
        .slice(0, limit)
        .map((x) => ({
          pageSlug: x.d.pageSlug,
          chunkIndex: x.d.chunkIndex,
          content: x.d.content,
          _distance: 1 - x.c,
        }));
    },
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
  return mgr as unknown as MockLance;
}

// ── Isolation ──

function createIsolation(): IsolationContext {
  const base = mkdtempSync(join(tmpdir(), "cbrain-rc-gate-"));
  const homeDir = join(base, "home");
  const brainDir = join(base, "brain");
  const vaultPath = join(brainDir, "vault");
  const runtimePath = join(brainDir, "runtime");
  const dbPath = join(brainDir, "brain.sqlite");
  const profileDir = join(brainDir, "profile");
  for (const d of [homeDir, brainDir, vaultPath, runtimePath, profileDir]) {
    mkdirSync(d, { recursive: true });
  }
  // Belt-and-suspenders: never let any submodule read the operator's real HOME/config.
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
  process.env.XDG_DATA_HOME = join(homeDir, ".local", "share");
  return { tmpdir: base, homeDir, brainDir, vaultPath, runtimePath, dbPath, profileDir };
}

// ── Fixture seeding (anonymous) ──

interface FixtureSeeds {
  readonly methodSlug: string;
  readonly p1Slug: string;
}

async function seedFixture(
  db: CBrainDB,
  vaultPath: string,
  embedding: EmbeddingProvider,
  lance: MockLance,
): Promise<FixtureSeeds> {
  const raw = db.rawDb;

  async function seedPage(slug: string, type: string, title: string, fileRel: string, body: string): Promise<void> {
    raw.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count)
       VALUES (?, ?, ?, ?, ?, 2, 1)`,
    ).run(slug, type, title, fileRel, `h-${slug}`);
    // Vault markdown so PageManager.getBySlug can read it.
    const filePath = join(vaultPath, fileRel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `---\ntitle: "${title}"\ntype: ${type}\n---\n${body}\n`, "utf-8");
    // FTS + chunks so keyword recall is deterministic.
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)").run(slug, body);
    raw.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, body);
    // Seed the in-memory vector index with this page's body embedding so the
    // normal hybrid path has a REAL vector recall signal — a non-exact query
    // can hit via cosine, exactly like production.
    const { embedding: emb } = await embedding.embed(body);
    lance._seedDoc(slug, 0, body, emb);
  }

  await seedPage(METHOD_SLUG, "concept", METHOD_TITLE, `${METHOD_SLUG}.md`, METHOD_BODY);
  await seedPage(ORG_SLUG, "entity", ORG_TITLE, `${ORG_SLUG}.md`, ORG_BODY);
  await seedPage(P1_SLUG, "entity/person", P1_TITLE, `${P1_SLUG}.md`, P1_BODY);
  await seedPage(P2_SLUG, "entity/person", P2_TITLE, `${P2_SLUG}.md`, P2_BODY);
  await seedPage(REC_SLUG, "record", REC_TITLE, `${REC_SLUG}.md`, REC_BODY);

  // Faithful "well-used core library" signal: the central concept (method-alpha)
  // carries real activity/hotness weights, exactly like a production memory that
  // has been queried and recently touched. Without this the offline fixture is a
  // cold, never-used index where every non-exact recall structurally lands below
  // the low-score threshold (RRF ≈ 1/(k+rank) alone) — which would make degraded
  // the normal success path. Seeding weights does NOT weaken any production
  // threshold; it makes the fixture behave like a real used memory.
  raw.prepare(
    "UPDATE pages SET activity_weight = 1.0, hotness_score = 1.0 WHERE slug = ?",
  ).run(METHOD_SLUG);

  // Relationships (graph_query journey).
  function seedLink(from: string, to: string, relation: string, context: string | null): void {
    raw.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, context, source_type, confidence) VALUES (?, ?, ?, ?, 'agent', 0.9)",
    ).run(from, to, relation, context);
  }
  seedLink(P1_SLUG, ORG_SLUG, "reports_to", "联系人甲向组织Zeta汇报");
  seedLink(P1_SLUG, P2_SLUG, "collaborated", "团建上合作讨论");
  seedLink(P1_SLUG, METHOD_SLUG, "implements", "负责方法Alpha落地");
  seedLink(P2_SLUG, METHOD_SLUG, "studies", "研究方法Alpha应用");

  // Timeline (episodic recall journey).
  function seedTimeline(slug: string, summary: string): void {
    raw.prepare(
      "INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, '团建')",
    ).run(slug, summary, EPISODE_DATE);
  }
  seedTimeline(P1_SLUG, "团建分享方法Alpha落地经验，与联系人乙讨论主题Beta");
  seedTimeline(P2_SLUG, "团建参与方法Alpha讨论，发起主题Beta");

  // Version history (provenance/version journey).
  raw.prepare("INSERT INTO versions (page_slug, version, content) VALUES (?, 1, ?)").run(METHOD_SLUG, VERSION_CONTENT);

  return { methodSlug: METHOD_SLUG, p1Slug: P1_SLUG };
}

// ── Anonymous scale fillers (#184 round 2) ──
//
// Five core pages cannot expose a scale-shaped N+1 regression: a per-page query
// over two persons is invisible. We seed a bounded set of ANONYMOUS irrelevant
// persons (no real identifiers, no overlap with any journey keyword) so the
// scale-sensitive journeys (episodic-person, relationship-lookup) run over a
// realistically-sized set. Because the batch DB methods are true IN-clause
// batches, a CORRECT implementation's query count stays constant as persons
// grow; a per-slug N+1 regression explodes with person count and trips the
// budget. Fillers never match any journey clue (body/timeline use no journey
// keyword; timeline uses a non-episode year) and never link to a core entity, so
// recall results and the relationship frontier are unchanged — only the query
// COUNT can move.
const FILLER_PERSON_COUNT = 60;
const FILLER_YEAR = "2024"; // != EPISODE_YEAR → episodic time clue never matches fillers

function seedScaleFiller(db: CBrainDB, vaultPath: string): void {
  const raw = db.rawDb;
  const stmtPage = raw.prepare(
    `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, 'entity/person', ?, ?, ?, 3, 0)`,
  );
  const stmtChunk = raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)");
  const stmtFts = raw.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)");
  const stmtTimeline = raw.prepare(
    "INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, '项目')",
  );
  const stmtLink = raw.prepare(
    "INSERT INTO links (from_slug, to_slug, relation, context, source_type, confidence) VALUES (?, ?, '协作', '项目内协作', 'agent', 0.5)",
  );
  // Phase 1: all pages first — link FK targets must exist before any link row.
  for (let i = 0; i < FILLER_PERSON_COUNT; i++) {
    const slug = `entities/person-filler-${i}`;
    const title = `填充人物${i}`;
    const body = `填充人物${i}负责项目Gamma第${i}阶段的进度跟踪与里程碑评审。`;
    stmtPage.run(slug, title, `${slug}.md`, `h-${slug}`);
    const filePath = join(vaultPath, `${slug}.md`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `---\ntitle: "${title}"\ntype: entity/person\n---\n${body}\n`, "utf-8");
    stmtChunk.run(slug, body);
    stmtFts.run(slug, body);
    // Non-EPISODE year → never matches the episodic time clue.
    const mm = String((i % 12) + 1).padStart(2, "0");
    const dd = String((i % 28) + 1).padStart(2, "0");
    stmtTimeline.run(slug, `项目Gamma第${i}阶段进度评审`, `${FILLER_YEAR}-${mm}-${dd}`);
  }
  // Phase 2: filler ring — linked to each other, never to a core entity, so the
  // relationship traversal frontier stays bounded and on-core.
  for (let i = 0; i < FILLER_PERSON_COUNT; i++) {
    const slug = `entities/person-filler-${i}`;
    const next = `entities/person-filler-${(i + 1) % FILLER_PERSON_COUNT}`;
    if (slug !== next) stmtLink.run(slug, next);
  }
}

// ── Server builder (mirrors src/mcp/server.ts createServer, minus dream worker) ──

function buildGateServer(ctx: ToolContext): { server: McpServer; tools: ToolMap } {
  const server = new McpServer({ name: "cbrain", version: "rc-gate" });

  // Same unified error wrapper as createServer — keeps the handler path faithful.
  const origRegister = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, def: any, handler: (...a: any[]) => Promise<any>) =>
    origRegister(name, def, async (...a: any[]) => {
      try {
        return await handler(...a);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: sanitizeError(msg) }) }],
          isError: true,
        };
      }
    });

  registerAllTools(server, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as ToolMap;
  return { server, tools };
}

// ── Query counter (deterministic DB operation budget) ──

interface QueryCounter {
  n: number;
}

/** Wrap prepare/exec so every SQL statement is counted. When `inflate` is set
 *  (RC_FAULT_QUERY_BUDGET), each statement counts as `INFLATE_STEP` — simulating
 *  a query explosion so budget enforcement can be proven, without timing. */
const INFLATE_STEP = 1000;
function installQueryCounter(db: CBrainDB, inflate: boolean): { counter: QueryCounter; restore(): void } {
  const counter: QueryCounter = { n: 0 };
  const raw = db.rawDb;
  const step = inflate ? INFLATE_STEP : 1;
  const origPrepare = raw.prepare.bind(raw);
  const origExec = raw.exec.bind(raw);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw.prepare = (...args: any[]) => { counter.n += step; return origPrepare(...args); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw.exec = (...args: any[]) => { counter.n += step; return origExec(...args); };
  return {
    counter,
    restore() {
      raw.prepare = origPrepare;
      raw.exec = origExec;
    },
  };
}

// ── Fault injection ──

interface FaultConfig {
  readonly retrieval: boolean;
  readonly privacyLeak: boolean;
  readonly hang: boolean;
  readonly queryBudget: boolean;
}

function readFaults(): FaultConfig {
  return {
    retrieval: process.env.RC_FAULT_RETRIEVAL === "1",
    privacyLeak: process.env.RC_FAULT_PRIVACY_LEAK === "1",
    hang: process.env.RC_FAULT_HANG === "1",
    queryBudget: process.env.RC_FAULT_QUERY_BUDGET === "1",
  };
}

/** Empty out recall so a must-hit journey fails. Returns a restore fn.
 *  Overrides both the exact-resolution path and the whole hybrid search path,
 *  so no internal exact-title/FTS fast-path can sneak a hit through. */
function applyRetrievalFault(ctx: ToolContext): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = ctx.db as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const search = ctx.search as any;
  const origResolve = db.resolveSlugs.bind(db);
  const origSearch = search.search.bind(search);
  db.resolveSlugs = (queries: string[]) => queries.map((q: string) => ({ query: q, slug: null, title: null, type: null }));
  search.search = async () => [];
  return () => {
    db.resolveSlugs = origResolve;
    search.search = origSearch;
  };
}

/** Make the hybrid search path never resolve (real handler hang). Returns a restore fn. */
function applyHangFault(ctx: ToolContext): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const search = ctx.search as any;
  const origSearch = search.search.bind(search);
  search.search = async () => new Promise<void>(() => {});
  return () => { search.search = origSearch; };
}

// ── Privacy scanners ──

const DISPLAY_BANNED = [
  "score", "distance", "similarity", "debug", "_debug", "trace", "threshold",
  "latency_ms", "vector", "embedding", "degraded_reason", "_stub", "reason_codes",
  "source_type", "weight", "hops", "bridge", "shared_neighbors",
];
const SLUG_PATH_FRAGMENT = /(entities|concepts|records|insights|events|brain)\//;
const FILE_PATH_FRAGMENT = /\/tmp\/|\/Users\/|runtime\/|\.sqlite|\.md\b|\.json\b/i;
const CREDENTIAL_FRAGMENT = /sk-[a-f0-9]{8,}|Bearer\s|api[_-]?key/i;
const VECTOR_ARRAY_FRAGMENT = /(-?\d+\.\d{4},){8}/;

function scanDisplay(display: string): AssertionResult[] {
  return [
    {
      check: "display has no slug path",
      passed: !SLUG_PATH_FRAGMENT.test(display),
      actual: SLUG_PATH_FRAGMENT.test(display) ? "slug fragment found" : "clean",
      expected: "no slug paths in display",
    },
    {
      check: "display has no file path",
      passed: !FILE_PATH_FRAGMENT.test(display),
      actual: FILE_PATH_FRAGMENT.test(display) ? "path found" : "clean",
      expected: "no filesystem paths in display",
    },
    {
      check: "display has no banned internal term",
      passed: !DISPLAY_BANNED.some((t) => new RegExp(`\\b${t}\\b`, "i").test(display)),
      actual: "clean",
      expected: "no score/vector/debug/etc. in display",
    },
    {
      check: "display has no credential pattern",
      passed: !CREDENTIAL_FRAGMENT.test(display),
      actual: CREDENTIAL_FRAGMENT.test(display) ? "credential found" : "clean",
      expected: "no credentials in display",
    },
  ];
}

function scanGlobal(text: string): AssertionResult[] {
  return [
    {
      check: "no operator home path anywhere",
      passed: !/\/Users\//.test(text),
      actual: /\/Users\//.test(text) ? "found" : "clean",
      expected: "no real home paths",
    },
    {
      check: "no tmp/runtime path anywhere",
      passed: !/\/tmp\/cbrain|runtime\//.test(text),
      actual: /\/tmp\/cbrain|runtime\//.test(text) ? "found" : "clean",
      expected: "no runtime paths",
    },
    {
      check: "no credential pattern anywhere",
      passed: !CREDENTIAL_FRAGMENT.test(text),
      actual: CREDENTIAL_FRAGMENT.test(text) ? "found" : "clean",
      expected: "no credentials",
    },
    {
      check: "no raw vector array anywhere",
      passed: !VECTOR_ARRAY_FRAGMENT.test(text),
      actual: VECTOR_ARRAY_FRAGMENT.test(text) ? "found" : "clean",
      expected: "no raw vectors",
    },
  ];
}

// ── Helpers ──

function verdictOf(assertions: ReadonlyArray<AssertionResult>): boolean {
  return assertions.every((a) => a.passed);
}

function firstFailed(assertions: ReadonlyArray<AssertionResult>): AssertionResult | null {
  return assertions.find((a) => !a.passed) ?? null;
}

/** Race a handler promise against a hang ceiling. */
async function withCeiling<T>(
  work: () => Promise<T>,
  ceilingMs: number,
): Promise<{ value: T | null; timedOut: boolean; durationMs: number }> {
  const start = performance.now();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<{ timedOut: true }>((resolve) => {
    handle = setTimeout(() => resolve({ timedOut: true }), ceilingMs);
  });
  try {
    const result = await Promise.race([work().then((value) => ({ value, timedOut: false as const })), ceiling]);
    if ("timedOut" in result && result.timedOut) {
      return { value: null, timedOut: true, durationMs: Math.round(performance.now() - start) };
    }
    return { value: result.value, timedOut: false, durationMs: Math.round(performance.now() - start) };
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

// Parse a handler result envelope (content[0].text) into an object.
function parseEnvelope(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): {
  parsed: Record<string, unknown> | null;
  isError: boolean;
} {
  const isError = result.isError === true;
  const text = result.content?.[0]?.text ?? "";
  try {
    return { parsed: JSON.parse(text), isError };
  } catch {
    return { parsed: null, isError };
  }
}

// ── Per-journey domain assertions + runners ──

function assertDisplayCompact(display: unknown): AssertionResult {
  const len = typeof display === "string" ? display.length : 0;
  return {
    check: "display compact (first response)",
    passed: len > 0 && len <= DISPLAY_BUDGET_CHARS,
    actual: `${len} chars`,
    expected: `1..${DISPLAY_BUDGET_CHARS} chars`,
  };
}

function assertRawPresent(parsed: Record<string, unknown> | null): AssertionResult {
  return {
    check: "raw payload present (expansion available)",
    passed: !!parsed && parsed.raw !== undefined && parsed.raw !== null,
    actual: parsed?.raw ? "present" : "missing",
    expected: "raw payload for follow-up expansion",
  };
}

function assertQueryBudget(id: string, q: number): AssertionResult {
  const budget = budgetFor(id);
  return {
    check: "query budget",
    passed: q <= budget,
    actual: `${q} queries`,
    expected: `<= ${budget} (baseline ${QUERY_BASELINE[id] ?? "?"}×${QUERY_HEADROOM_MULT})`,
  };
}

function buildJourney(
  id: string,
  tool: string,
  durationMs: number,
  queryCount: number,
  displayChars: number,
  timedOut: boolean,
  assertions: AssertionResult[],
): JourneyResult {
  const passed = !timedOut && verdictOf(assertions);
  const first = firstFailed(assertions);
  return {
    id,
    tool,
    passed,
    duration_ms: durationMs,
    query_count: queryCount,
    query_budget: budgetFor(id),
    display_chars: displayChars,
    timed_out: timedOut,
    assertions,
    failed_reason: timedOut
      ? "timeout: handler did not resolve within ceiling"
      : first ? `${first.check}: ${first.actual} (expected ${first.expected})` : null,
  };
}

interface JourneyContext {
  tools: ToolMap;
  counter: QueryCounter;
  faults: FaultConfig;
}

function entitiesOf(parsed: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(parsed?.entities) ? (parsed!.entities as Array<Record<string, unknown>>) : [];
}

function displayOf(parsed: Record<string, unknown> | null): string {
  return typeof parsed?.display === "string" ? (parsed!.display as string) : "";
}

// ── J1: exact entity recall (title match) ──

async function runJ1ExactRecall(jc: JourneyContext): Promise<JourneyResult> {
  const id = "exact-recall";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: METHOD_TITLE, limit: 5, strategy: "smart" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const entities = entitiesOf(parsed);
  const display = displayOf(parsed);
  const topMatches = entities.some((e) => {
    const slug = String(e.slug ?? "");
    const title = String(e.title ?? "");
    return slug.includes("method-alpha") || title === METHOD_TITLE;
  });
  const summaryStatus = (parsed?.summary as { status?: string } | undefined)?.status;
  const assertions: AssertionResult[] = [
    { check: "exact entity recalled", passed: topMatches, actual: topMatches ? "method-alpha found" : "not found", expected: "方法Alpha recalled" },
    { check: "summary status ok", passed: summaryStatus === "ok", actual: String(summaryStatus ?? "missing"), expected: "ok" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "deep_recall", durationMs, q, display.length, timedOut, assertions);
}

// ── J2: normal topic recall (NON-title body phrase → FTS path) ──

async function runJ2TopicRecall(jc: JourneyContext): Promise<JourneyResult> {
  const id = "topic-recall";
  // A NON-title body phrase. This exercises the FTS + vector hybrid path that
  // the exact-title journey skips. The offline vector mock returns a real cosine
  // hit for this phrase and the core concept carries activity/hotness weight,
  // so a NORMAL (non-exact) recall must be HEALTHY: status ok, not degraded, no
  // degradation reason code. Degraded behavior is the degraded-search journey's
  // exclusive job — it must never be the normal success path.
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: TOPIC_PHRASE, limit: 5, strategy: "smart" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const entities = entitiesOf(parsed);
  const display = displayOf(parsed);
  const hitMethod = entities.some((e) => String(e.slug ?? "").includes("method-alpha"));
  const summaryStatus = (parsed?.summary as { status?: string } | undefined)?.status;
  const searchMeta = parsed?.raw?.search_meta as { degraded?: boolean; reason_codes?: string[] } | undefined;
  const reasonCodes = Array.isArray(searchMeta?.reason_codes) ? (searchMeta!.reason_codes as string[]) : [];
  const isDegraded = searchMeta?.degraded === true;
  const assertions: AssertionResult[] = [
    { check: "topic phrase recalled via normal (non-title) path", passed: hitMethod, actual: hitMethod ? "method-alpha found" : "not found", expected: `method-alpha recalled for "${TOPIC_PHRASE}"` },
    { check: "non-empty result", passed: entities.length >= 1, actual: `${entities.length} entities`, expected: ">= 1 entity" },
    { check: "summary status ok", passed: summaryStatus === "ok", actual: String(summaryStatus ?? "missing"), expected: "ok" },
    { check: "not degraded", passed: !isDegraded, actual: isDegraded ? "degraded" : "ok", expected: "normal recall is healthy, not degraded" },
    { check: "no degradation reason code", passed: reasonCodes.length === 0, actual: reasonCodes.join(",") || "none", expected: "no low_score/vector_error/etc." },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "deep_recall", durationMs, q, display.length, timedOut, assertions);
}

// ── J3: grounded recall with evidence ──

async function runJ3Grounded(jc: JourneyContext): Promise<JourneyResult> {
  const id = "grounded-recall";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: METHOD_TITLE, limit: 5, grounded: true }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const hasGrounded = parsed?.grounded_answer !== undefined || parsed?.raw?.grounded_answer !== undefined;
  const assertions: AssertionResult[] = [
    { check: "grounded answer present", passed: hasGrounded, actual: hasGrounded ? "present" : "missing", expected: "evidence board" },
    { check: "display is evidence-shaped", passed: /证据|查找|事实|确认/.test(display), actual: display.slice(0, 40), expected: "evidence language in display" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "deep_recall", durationMs, q, display.length, timedOut, assertions);
}

// ── J4: relationship / hierarchy lookup ──

async function runJ4Graph(jc: JourneyContext, p1Slug: string): Promise<JourneyResult> {
  const id = "relationship-lookup";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.graph_query.handler({ slug: p1Slug, mode: "traverse" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  let display = displayOf(parsed);
  // Test-only fault: inject a banned token into a journey display to exercise the privacy pipeline.
  if (jc.faults.privacyLeak) {
    display = `${display} [entities/leaked-slug sk-deadbeefcafef00d1234 /tmp/cbrain-leak]`;
  }
  const resultLen = Array.isArray(parsed?.raw?.result) ? (parsed!.raw.result as unknown[]).length : 0;
  const assertions: AssertionResult[] = [
    { check: "relationship returned", passed: resultLen >= 1, actual: `${resultLen} relations`, expected: ">= 1 relation" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "graph_query", durationMs, q, display.length, timedOut, assertions);
}

// ── J5: episodic person recall — absolute time clue + matched_clues verification ──

async function runJ5Episode(jc: JourneyContext): Promise<JourneyResult> {
  const id = "episodic-person";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.recall_episode.handler({
      // "落地" is a body term unique to 联系人甲 — it disambiguates P1 from P2
      // (who only "discussed" the method), so the expected person wins the topic
      // dimension instead of tying on "方法Alpha" alone.
      query: `${EPISODE_YEAR}年团建讨论方法Alpha落地的人`,
      time_hint: `${EPISODE_YEAR}年`,
      topic_hint: `${METHOD_TITLE}落地`,
      context_hint: "团建",
    }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const candidates = Array.isArray(parsed?.candidates) ? (parsed!.candidates as Array<Record<string, unknown>>) : [];
  const top = candidates[0];
  const topIsP1 = !!top && String(top.slug ?? "").includes("person-jiayi");
  const clues = Array.isArray(top?.matched_clues) ? (top!.matched_clues as Array<{ dimension: string }>) : [];
  const dims = new Set(clues.map((c) => c.dimension));
  const hasTime = dims.has("time");
  const hasTopic = dims.has("topic");
  const hasContext = dims.has("context");
  const assertions: AssertionResult[] = [
    { check: "expected person is the top candidate", passed: topIsP1, actual: topIsP1 ? "联系人甲" : String(top?.slug ?? "none"), expected: "联系人甲 (person-jiayi)" },
    { check: "matched time clue", passed: hasTime, actual: hasTime ? "time" : "missing", expected: "time dimension matched" },
    { check: "matched topic clue", passed: hasTopic, actual: hasTopic ? "topic" : "missing", expected: "topic dimension matched" },
    { check: "matched context clue", passed: hasContext, actual: hasContext ? "context" : "missing", expected: "context dimension matched" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "recall_episode", durationMs, q, display.length, timedOut, assertions);
}

// ── J6: provenance / version-history ──

async function runJ6Versions(jc: JourneyContext, methodSlug: string): Promise<JourneyResult> {
  const id = "version-history";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.get_versions.handler({ slug: methodSlug }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const versions = Array.isArray(parsed?.raw?.versions) ? (parsed!.raw.versions as unknown[]) : [];
  const assertions: AssertionResult[] = [
    { check: "version history returned", passed: versions.length >= 1, actual: `${versions.length} versions`, expected: ">= 1 version" },
    { check: "display is version-shaped", passed: /版本/.test(display), actual: display.slice(0, 40), expected: "version language in display" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "get_versions", durationMs, q, display.length, timedOut, assertions);
}

// ── J7: controlled degraded search (vector error → FTS fallback) ──

async function runJ7Degraded(jc: JourneyContext, lance: MockLance): Promise<JourneyResult> {
  const id = "degraded-search";
  // Vector fault: either the RC_FAULT_VECTOR env, or always on for the degraded
  // journey so the production degradation path is exercised on every gate run.
  const prevMode = lance.vectorMode;
  lance.vectorMode = "error";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: DEGRADED_PHRASE, limit: 5, strategy: "smart" }),
    HANG_CEILING_MS,
  );
  lance.vectorMode = prevMode;
  const q = jc.counter.n;
  const { parsed, isError } = parseEnvelope(value ?? { content: [] });
  const entities = entitiesOf(parsed);
  const display = displayOf(parsed);
  const summary = parsed?.summary as { status?: string; degraded_reason?: string } | undefined;
  const searchMeta = parsed?.raw?.search_meta as { degraded?: boolean; reason_codes?: string[] } | undefined;
  const assertions: AssertionResult[] = [
    { check: "degraded status reported", passed: summary?.status === "degraded", actual: String(summary?.status ?? "missing"), expected: "summary.status = degraded" },
    { check: "degraded reason surfaced (raw only)", passed: !!summary?.degraded_reason, actual: summary?.degraded_reason ? "present" : "missing", expected: "degraded_reason in summary (kept out of display)" },
    { check: "not flagged as error", passed: !isError, actual: isError ? "isError" : "ok", expected: "graceful, not an error" },
    { check: "FTS fallback kept a useful result", passed: entities.length >= 1, actual: `${entities.length} entities`, expected: ">= 1 entity from FTS fallback" },
    { check: "search_meta.degraded set", passed: searchMeta?.degraded === true, actual: String(searchMeta?.degraded ?? "missing"), expected: "raw.search_meta.degraded = true" },
    { check: "display uses degraded-safe wording", passed: /返回了部分结果|搜索耗时较长/.test(display), actual: display.slice(0, 40), expected: "user-safe degraded wording" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "deep_recall", durationMs, q, display.length, timedOut, assertions);
}

// ── J8: empty search (no match → graceful empty wording) ──

async function runJ8Empty(jc: JourneyContext): Promise<JourneyResult> {
  const id = "empty-search";
  const { value, timedOut, durationMs } = await withCeiling(
    // z/q/x appear in NO fixture body (English tokens are Alpha/Zeta/Beta;
    // bodies are CJK), so this query shares zero characters with any page → no
    // vector hit and no FTS hit → a true graceful-empty result.
    () => jc.tools.deep_recall.handler({ query: "zzzqqqxxx", limit: 5 }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed, isError } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const summary = parsed?.summary as { status?: string } | undefined;
  const assertions: AssertionResult[] = [
    { check: "empty status reported", passed: summary?.status === "empty", actual: String(summary?.status ?? "missing"), expected: "summary.status = empty" },
    { check: "not flagged as error", passed: !isError, actual: isError ? "isError" : "ok", expected: "graceful, not an error" },
    { check: "display uses graceful empty wording", passed: /未找到/.test(display), actual: display.slice(0, 40), expected: "graceful empty wording" },
    assertRawPresent(parsed),
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(id, q),
  ];
  return buildJourney(id, "deep_recall", durationMs, q, display.length, timedOut, assertions);
}

// ── Output sanitization (mirrors first-recall gate) ──

function sanitizeOutput(json: string): string {
  let out = json;
  const realHome = process.env.HOME ?? "";
  if (realHome) out = out.replaceAll(realHome, "<HOME>");
  out = out.replaceAll("/Users/", "<HOME>/");
  out = out.replaceAll("cbrain-rc-gate-", "<tmp>/");
  out = out.replace(/sk-[a-f0-9]{8,}/gi, "<REDACTED>");
  return out;
}

// ── Orchestrator ──

async function executeGate(): Promise<GateResult> {
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")).version;
  const faults = readFaults();
  const gateStart = performance.now();

  const iso = createIsolation();
  let db: CBrainDB | undefined;
  const journeys: JourneyResult[] = [];
  let cleanupVerified = false;
  let fatalMsg: string | null = null;

  try {
    db = new CBrainDB(iso.dbPath);
    const lance = makeMockLance();
    const embedding = makeMockEmbedding();
    const seeds = await seedFixture(db, iso.vaultPath, embedding, lance);
    // Anonymous scale fillers — make the fixture realistically-sized so a
    // per-page N+1 is visible (see seedScaleFiller). Constant-operation journeys
    // keep their query count; this only enlarges the data the batches sweep.
    seedScaleFiller(db, iso.vaultPath);
    const ctx = buildContext({
      db,
      embedding,
      lance,
      vaultPath: iso.vaultPath,
      dbPath: iso.dbPath,
      profileDir: iso.profileDir,
      runtimePath: iso.runtimePath,
    });

    const counter = installQueryCounter(db, faults.queryBudget);
    try {
      // Build the server BEFORE injecting faults: handler closures read ctx.* at call
      // time, so an override applied after registration still takes effect.
      const { tools } = buildGateServer(ctx);
      const jc: JourneyContext = { tools, counter: counter.counter, faults };

      // Retrieval fault empties recall for the whole run (must-hit journeys fail).
      const restoreRetrieval = faults.retrieval ? applyRetrievalFault(ctx) : () => {};
      // Hang fault is scoped to J1 only — it proves the ceiling catches a real hang
      // without making every search-based journey pay the full ceiling.
      const restoreHang = faults.hang ? applyHangFault(ctx) : () => {};

      counter.counter.n = 0;
      journeys.push(await runJ1ExactRecall(jc));
      restoreHang();

      counter.counter.n = 0;
      journeys.push(await runJ2TopicRecall(jc));
      counter.counter.n = 0;
      journeys.push(await runJ3Grounded(jc));
      counter.counter.n = 0;
      journeys.push(await runJ4Graph(jc, seeds.p1Slug));
      counter.counter.n = 0;
      journeys.push(await runJ5Episode(jc));
      counter.counter.n = 0;
      journeys.push(await runJ6Versions(jc, seeds.methodSlug));
      counter.counter.n = 0;
      journeys.push(await runJ7Degraded(jc, lance));
      counter.counter.n = 0;
      journeys.push(await runJ8Empty(jc));

      restoreRetrieval();
    } finally {
      counter.restore();
    }
  } catch (e) {
    fatalMsg = e instanceof Error ? e.message : String(e);
  } finally {
    try { db?.close(); } catch { /* best effort */ }
    if (existsSync(iso.tmpdir)) {
      try {
        rmSync(iso.tmpdir, { recursive: true });
        cleanupVerified = !existsSync(iso.tmpdir);
      } catch {
        cleanupVerified = false;
      }
    } else {
      cleanupVerified = true;
    }
  }

  // ── Assemble report ──
  const slowest = journeys.length > 0
    ? journeys.reduce((a, b) => (b.duration_ms > a.duration_ms ? b : a))
    : null;

  const budgets: GateReport["budgets"] = {
    baselines: QUERY_BASELINE,
    headroom_mult: QUERY_HEADROOM_MULT,
    hang_ceiling_ms: HANG_CEILING_MS,
    display_chars: DISPLAY_BUDGET_CHARS,
  };

  let report: GateReport;
  let exitCode: number;

  if (fatalMsg) {
    report = {
      gate: "v2-rc",
      version,
      timestamp: new Date().toISOString(),
      verdict: "no-go",
      journeys,
      privacy: { passed: false, assertions: [{ check: "no fatal error", passed: false, actual: fatalMsg, expected: "no errors" }] },
      budgets,
      slowest_journey: slowest ? { id: slowest.id, duration_ms: slowest.duration_ms } : null,
      failed_stage: "fatal",
      reason: fatalMsg,
      next_action: "investigate gate script or handler throw",
      cleanup: { verified: cleanupVerified, path: cleanupVerified ? "<cleaned>" : "<retained>" },
      duration_ms: Math.round(performance.now() - gateStart),
    };
    exitCode = 2;
  } else {
    // Privacy = per-journey display scans (user-facing surface) + global report scan.
    const displayPrivacy = journeys.flatMap((j) =>
      j.assertions.filter((a) => a.check.startsWith("display has no ")),
    );
    const journeyJson = JSON.stringify(journeys, null, 2);
    const globalPrivacy = scanGlobal(sanitizeOutput(journeyJson));
    const privacyAssertions = [...displayPrivacy, ...globalPrivacy];
    const privacyPassed = privacyAssertions.every((a) => a.passed);

    const failed = journeys.find((j) => !j.passed) ?? null;
    const overallPassed = privacyPassed && !failed && cleanupVerified;

    const reason = failed
      ? (failed.timed_out
          ? `journey '${failed.id}' exceeded the ${HANG_CEILING_MS}ms hang ceiling`
          : `journey '${failed.id}' failed: ${failed.failed_reason}`)
      : (!privacyPassed ? "privacy scan detected a leak in the report" : (!cleanupVerified ? "temporary state was not cleaned up" : null));

    const nextAction = failed
      ? (failed.timed_out
          ? "find the handler that did not resolve; a downstream dependency is likely hanging"
          : `re-check '${failed.tool}' output contract for: ${failed.failed_reason}`)
      : (!privacyPassed ? "scrub the formatter leaking an internal field or credential" : (!cleanupVerified ? "ensure tmpdir removal runs on every path" : null));

    report = {
      gate: "v2-rc",
      version,
      timestamp: new Date().toISOString(),
      verdict: overallPassed ? "go" : "no-go",
      journeys,
      privacy: { passed: privacyPassed, assertions: privacyAssertions },
      budgets,
      slowest_journey: slowest ? { id: slowest.id, duration_ms: slowest.duration_ms } : null,
      failed_stage: failed ? failed.id : (!privacyPassed ? "privacy" : (!cleanupVerified ? "cleanup" : null)),
      reason,
      next_action: nextAction,
      cleanup: { verified: cleanupVerified, path: cleanupVerified ? "<cleaned>" : "<retained>" },
      duration_ms: Math.round(performance.now() - gateStart),
    };
    exitCode = overallPassed ? 0 : 1;
  }

  return { report, exitCode };
}

// ── Terminal summary ──

function writeSummary(report: GateReport): void {
  const lines: string[] = [];
  lines.push(`╔══ CBrain v2.0 RC Gate ══╗`);
  lines.push(`  verdict:   ${report.verdict.toUpperCase()}`);
  lines.push(`  duration:  ${report.duration_ms}ms`);
  if (report.slowest_journey) lines.push(`  slowest:   ${report.slowest_journey.id} (${report.slowest_journey.duration_ms}ms)`);
  lines.push(`  journeys:`);
  for (const j of report.journeys) {
    const mark = j.passed ? "✓" : "✗";
    lines.push(`    ${mark} ${j.id} [${j.tool}] ${j.duration_ms}ms / ${j.query_count}q≤${j.query_budget} / ${j.display_chars}chars${j.timed_out ? " TIMEOUT" : ""}`);
  }
  lines.push(`  privacy:   ${report.privacy.passed ? "clean" : "LEAK"}`);
  lines.push(`  cleanup:   ${report.cleanup.verified ? "ok" : "FAILED"}`);
  if (report.failed_stage) {
    lines.push(`  failed:    ${report.failed_stage}`);
    lines.push(`  reason:    ${report.reason}`);
    lines.push(`  next:      ${report.next_action}`);
  }
  lines.push(`╚══════════════════════════╝`);
  process.stderr.write(lines.join("\n") + "\n");
}

// ── Terminal summary: performance report (#188) ──

function writePerfSummary(report: PerfReport): void {
  const lines: string[] = [];
  lines.push(`╔══ CBrain v2.0 Perf Report ══╗`);
  lines.push(`  verdict:    ${report.verdict.toUpperCase()}`);
  lines.push(`  duration:   ${report.duration_ms}ms (journeys total ${report.total_duration_ms}ms)`);
  if (report.slowest_journey) {
    lines.push(`  slowest:    ${report.slowest_journey.id} (${report.slowest_journey.duration_ms}ms)`);
  }
  if (report.highest_query_utilization_journey) {
    const h = report.highest_query_utilization_journey;
    lines.push(`  hottest:    ${h.id} (${Math.round(h.utilization * 100)}% query budget)`);
  }
  lines.push(`  journeys:`);
  for (const j of report.journeys) {
    const mark = j.passed ? "✓" : "✗";
    const util = Math.round(j.query_budget_utilization * 100);
    lines.push(
      `    ${mark} ${j.id} ${j.duration_ms}ms / ${util}% budget (${j.query_count}/${j.query_budget}q) / ${j.display_chars}chars${j.timed_out ? " TIMEOUT" : ""}`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const w of report.warnings) lines.push(`    ⚠ ${w}`);
  } else {
    lines.push(`  warnings:   none`);
  }
  lines.push(`  cleanup:    ${report.cleanup.verified ? "ok" : "FAILED"}`);
  lines.push(`╚══════════════════════════════╝`);
  process.stderr.write(lines.join("\n") + "\n");
}

// ── Entry ──

const perfMode = process.argv.includes("--perf");

executeGate().then(({ report, exitCode }) => {
  if (perfMode) {
    // Performance report (#188): reuse the same journey measurements, emit a perf-shaped JSON.
    const perf = buildPerfReport({
      journeys: report.journeys,
      cleanupVerified: report.cleanup.verified,
      hangCeilingMs: report.budgets.hang_ceiling_ms,
      version: report.version,
      timestamp: report.timestamp,
      gateDurationMs: report.duration_ms,
    });
    const json = sanitizeOutput(JSON.stringify(perf, null, 2));
    process.stdout.write(json + "\n");
    writePerfSummary(JSON.parse(json) as PerfReport);
    process.exitCode = perf.verdict === "go" ? 0 : (exitCode === 2 ? 2 : 1);
  } else {
    const json = sanitizeOutput(JSON.stringify(report, null, 2));
    process.stdout.write(json + "\n");
    // The summary is derived from the sanitized report so stderr never echoes raw secrets either.
    writeSummary(JSON.parse(json) as GateReport);
    process.exitCode = exitCode;
  }
}).catch((e) => {
  const detail = e instanceof Error ? e.message : String(e);
  const safe = detail.replace(/\/Users\/[^\s:"]+/g, "<HOME>/...").replace(/sk-[a-f0-9]{8,}/gi, "<REDACTED>").split("\n")[0];
  process.stdout.write(JSON.stringify({
    gate: perfMode ? "v2-perf" : "v2-rc",
    verdict: "no-go",
    error: safe,
    cleanup: { verified: false, path: "<unknown>" },
  }, null, 2) + "\n");
  process.exitCode = 2;
});
