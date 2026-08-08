#!/usr/bin/env bun
/**
 * Hermes-style real-dialogue acceptance gate (#193).
 *
 * Six anonymous dialogue journeys over the REAL MCP tool path, verifying an
 * Agent can use CBrain through natural conversation patterns without exposing
 * users to internal tool mechanics. This is an acceptance harness for the current
 * product contract — not a new search feature. It reuses the v2-rc-gate harness
 * (mock embedding/Lance, isolation, query counter, gate server, ceiling, privacy
 * scanners) and the real deep_recall / recall_episode / graph_query / ingest tools.
 *
 *   bun run gate:hermes        stdout = stable JSON report, stderr = human summary
 *   exit: 0 = go, 1 = no-go, 2 = fatal
 *
 * All fixtures are anonymous. No real people/orgs/products/places/paths/dialogue.
 */
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CBrainDB } from "../src/storage/sqlite.js";
import { buildContext, type ToolContext } from "../src/mcp/context.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import {
  makeMockEmbedding,
  makeMockLance,
  createIsolation,
  installQueryCounter,
  buildGateServer,
  withCeiling,
  parseEnvelope,
  scanDisplay,
  scanGlobal,
  verdictOf,
  firstFailed,
  sanitizeOutput,
  type AssertionResult,
  type ToolMap,
  type QueryCounter,
  type MockLance,
} from "./check-v2-rc-gate.js";

// ── Constants ──

const HANG_CEILING_MS = 8000; // dialogue paths can fan out; catch true hangs only
const QUERY_BUDGET = 60; // generous per-journey; trips on real N+1 explosions

// Anonymous fixture identifiers (no real names/orgs/products/places).
const METHOD_SLUG = "brain/concepts/concept/fang-fa-jia";
const METHOD_TITLE = "方法甲";
const METHOD_BODY = "方法甲是一种决策框架，核心是先验证假设再推进，落地时需要跨团队对齐。";
const ORG_SLUG = "brain/entities/organization/zu-zhi-jia";
const ORG_TITLE = "组织甲";
const P1_SLUG = "brain/entities/person/lian-xi-ren-jia";
const P1_TITLE = "联系人甲";
const P1_BODY = "联系人甲负责方法甲的落地，向组织甲汇报，2024年团建上分享落地经验。";
const P2_SLUG = "brain/entities/person/lian-xi-ren-yi";
const P2_TITLE = "联系人乙";
const P2_BODY = "联系人乙研究方法甲的应用，与联系人甲在团建上合作讨论。";
const EPISODE_YEAR = "2024";
const EPISODE_DATE = "2024-09-15";

// Runtime-stored facts (ingested during the gate, not seeded).
const FACT_TITLE = "项目甲";
const FACT_BODY = "项目甲采用方法甲框架推进，2024年团建确认立项。";

// ── Types ──

type HermesStatus = "pass" | "fail";

interface HermesJourney {
  readonly id: string;
  readonly tool: string;
  readonly status: HermesStatus;
  readonly duration_ms: number;
  readonly query_count: number;
  readonly query_budget: number;
  readonly degraded: boolean;
  readonly privacy_passed: boolean;
  readonly failure_reason: string | null;
  readonly assertions: AssertionResult[];
}

interface HermesReport {
  readonly gate: "v2-hermes";
  readonly version: string;
  readonly timestamp: string;
  readonly verdict: "go" | "no-go";
  readonly journeys: HermesJourney[];
  readonly privacy: { readonly passed: boolean; readonly assertions: AssertionResult[] };
  readonly failed_stage: string | null;
  readonly reason: string | null;
  readonly cleanup: { readonly verified: boolean; readonly path: string };
  readonly duration_ms: number;
}

interface HermesResult {
  readonly report: HermesReport;
  readonly exitCode: number;
}

interface JourneyContext {
  readonly tools: ToolMap;
  readonly counter: QueryCounter;
  readonly db: CBrainDB;
  readonly vaultPath: string;
  readonly faults: HermesFaults;
}

// ── Fixture seeding (anonymous) ──

async function seedHermesFixture(
  db: CBrainDB,
  vaultPath: string,
  embedding: EmbeddingProvider,
  lance: MockLance,
): Promise<void> {
  const raw = db.rawDb;

  const seedPage = async (slug: string, type: string, title: string, fileRel: string, body: string): Promise<void> => {
    raw.prepare(
      `INSERT INTO pages (slug, type, title, file_path, content_hash, tier, mention_count) VALUES (?, ?, ?, ?, ?, 2, 1)`,
    ).run(slug, type, title, fileRel, `h-${slug}`);
    const filePath = join(vaultPath, fileRel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `---\ntitle: "${title}"\ntype: ${type}\n---\n${body}\n`, "utf-8");
    raw.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, 0, ?)").run(slug, body);
    raw.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, body);
    const { embedding: emb } = await embedding.embed(body);
    lance._seedDoc(slug, 0, body, emb);
  };

  await seedPage(METHOD_SLUG, "concept/concept", METHOD_TITLE, `${METHOD_SLUG}.md`, METHOD_BODY);
  await seedPage(ORG_SLUG, "entity/organization", ORG_TITLE, `${ORG_SLUG}.md`, `组织甲是联系人甲与联系人乙的上级组织。`);
  await seedPage(P1_SLUG, "entity/person", P1_TITLE, `${P1_SLUG}.md`, P1_BODY);
  await seedPage(P2_SLUG, "entity/person", P2_TITLE, `${P2_SLUG}.md`, P2_BODY);

  // Well-used core concept carries real activity/hotness (like a production memory),
  // so a normal non-exact recall is healthy, not structurally degraded.
  raw.prepare("UPDATE pages SET activity_weight = 1.0, hotness_score = 1.0 WHERE slug = ?").run(METHOD_SLUG);

  const seedLink = (from: string, to: string, relation: string, context: string): void => {
    // #233: reports_to is a current-fact relation — seed as trusted so default
    // graph reads (graph_query traverse) include it. Other relations stay
    // default ('candidate' via column default), which is fine for them.
    const trustState = relation === "reports_to" ? "trusted" : "candidate";
    raw.prepare(
      "INSERT INTO links (from_slug, to_slug, relation, context, source_type, confidence, trust_state) VALUES (?, ?, ?, ?, 'agent', 0.9, ?)",
    ).run(from, to, relation, context, trustState);
  };
  seedLink(P1_SLUG, ORG_SLUG, "reports_to", "联系人甲向组织甲汇报");
  seedLink(P1_SLUG, P2_SLUG, "collaborated", "团建上合作讨论");
  seedLink(P1_SLUG, METHOD_SLUG, "implements", "负责方法甲落地");
  seedLink(P2_SLUG, METHOD_SLUG, "studies", "研究方法甲应用");

  raw.prepare(
    "INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, '团建')",
  ).run(P1_SLUG, "团建分享方法甲落地经验，与联系人乙讨论", EPISODE_DATE);
  raw.prepare(
    "INSERT INTO timeline (page_slug, summary, event_date, source) VALUES (?, ?, ?, '团建')",
  ).run(P2_SLUG, "团建参与方法甲讨论", EPISODE_DATE);
}

// ── Helpers ──

function displayOf(parsed: Record<string, unknown> | null): string {
  return typeof parsed?.display === "string" ? (parsed.display as string) : "";
}
function entitiesOf(parsed: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(parsed?.entities) ? (parsed!.entities as Array<Record<string, unknown>>) : [];
}
function summaryStatus(parsed: Record<string, unknown> | null): string | undefined {
  return (parsed?.summary as { status?: string } | undefined)?.status;
}

function buildHermesJourney(
  id: string,
  tool: string,
  durationMs: number,
  queryCount: number,
  degraded: boolean,
  timedOut: boolean,
  assertions: AssertionResult[],
): HermesJourney {
  const passed = !timedOut && verdictOf(assertions);
  const first = firstFailed(assertions);
  const privacyPassed = assertions.filter((a) => a.check.startsWith("display has no ")).every((a) => a.passed);
  return {
    id,
    tool,
    status: passed ? "pass" : "fail",
    duration_ms: durationMs,
    query_count: queryCount,
    query_budget: QUERY_BUDGET,
    degraded,
    privacy_passed: privacyPassed,
    failure_reason: timedOut
      ? "timeout: handler did not resolve within ceiling"
      : first
        ? `${first.check}: ${first.actual} (expected ${first.expected})`
        : null,
    assertions,
  };
}

function assertQueryBudget(q: number): AssertionResult {
  return {
    check: "operation/query budget respected",
    passed: q <= QUERY_BUDGET,
    actual: `${q} statements`,
    expected: `<= ${QUERY_BUDGET}`,
  };
}
function assertDisplayCompact(display: string): AssertionResult {
  return {
    check: "display is compact",
    passed: display.length > 0 && display.length <= 600,
    actual: `${display.length} chars`,
    expected: "1..600 chars",
  };
}

// ── Journeys ──

// H1: first memory recall — store a fact, then ask if it was discussed.
async function runH1FirstRecall(jc: JourneyContext): Promise<HermesJourney> {
  const id = "first-memory-recall";
  // Step 1: store the fact via the ingest tool.
  await jc.tools.ingest.handler({
    content: `---\ntitle: ${FACT_TITLE}\ntype: concept/concept\n---\n${FACT_BODY}`,
    type: "markdown",
    skipNer: true,
  });
  // Step 2: ask naturally whether it was discussed.
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: FACT_TITLE, limit: 5, strategy: "smart" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const entities = entitiesOf(parsed);
  let display = displayOf(parsed);
  // Test-only fault: inject a banned token into the display to exercise the privacy pipeline.
  if (jc.faults.privacyLeak) {
    display = `${display} [entities/leaked-slug sk-deadbeefcafef00d1234 /tmp/cbrain-leak]`;
  }
  const recalled = entities.some((e) => String(e.title ?? "") === FACT_TITLE || String(e.slug ?? "").includes("xiang-mu-jia"));
  const assertions: AssertionResult[] = [
    { check: "stored fact is recalled", passed: recalled, actual: recalled ? "found" : "not found", expected: `${FACT_TITLE} recalled` },
    { check: "summary status ok", passed: summaryStatus(parsed) === "ok", actual: String(summaryStatus(parsed) ?? "missing"), expected: "ok" },
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(q),
  ];
  return buildHermesJourney(id, "ingest+deep_recall", durationMs, q, false, timedOut, assertions);
}

// H2: forgotten person by context — ask via time/event/topic clues, not exact name.
async function runH2ForgottenPerson(jc: JourneyContext): Promise<HermesJourney> {
  const id = "forgotten-person-by-context";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.recall_episode.handler({
      query: `${EPISODE_YEAR}年团建讨论方法甲落地的人`,
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
  const found = !!top && (String(top.slug ?? "").includes("lian-xi-ren-jia") || String(top.title ?? "") === P1_TITLE);
  const clues = Array.isArray(top?.matched_clues) ? (top!.matched_clues as Array<{ dimension: string }>) : [];
  const hasTime = clues.some((c) => c.dimension === "time");
  const hasTopic = clues.some((c) => c.dimension === "topic");
  const hasContext = clues.some((c) => c.dimension === "context");
  const assertions: AssertionResult[] = [
    { check: "person recalled from context clues", passed: found, actual: found ? P1_TITLE : "not found", expected: `${P1_TITLE} from clues` },
    { check: "result is a candidate, not raw dump", passed: candidates.length >= 1 && candidates.length <= 10, actual: `${candidates.length} candidates`, expected: "1..10 (curated candidate)" },
    { check: "matched clues surfaced", passed: hasTime && hasTopic, actual: `time=${hasTime},topic=${hasTopic},context=${hasContext}`, expected: "time + topic dimensions matched" },
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(q),
  ];
  return buildHermesJourney(id, "recall_episode", durationMs, q, false, timedOut, assertions);
}

// H3: relationship / organization traversal — who reports to / belongs under an entity.
async function runH3Relationship(jc: JourneyContext): Promise<HermesJourney> {
  const id = "relationship-traversal";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.graph_query.handler({ slug: P1_SLUG, mode: "traverse" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const relations = Array.isArray(parsed?.raw?.result) ? (parsed!.raw.result as Array<Record<string, unknown>>) : [];
  // Robust to the relation object's field names: the traversal must reach the org
  // or surface a reports_to edge.
  const relationsJson = JSON.stringify(relations);
  const reachesOrg = relationsJson.includes("zu-zhi-jia") || relationsJson.includes("reports_to");
  const assertions: AssertionResult[] = [
    { check: "relationship returned", passed: relations.length >= 1, actual: `${relations.length} relations`, expected: ">= 1 relation" },
    { check: "traversal reaches the org/reports_to", passed: reachesOrg, actual: reachesOrg ? "org reached" : "not reached", expected: "reports_to 组织甲" },
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(q),
  ];
  return buildHermesJourney(id, "graph_query", durationMs, q, false, timedOut, assertions);
}

// H4: grounded answer — why a prior decision was made (evidence board, no full-page dump).
async function runH4Grounded(jc: JourneyContext): Promise<HermesJourney> {
  const id = "grounded-answer";
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
    { check: "display is evidence-shaped", passed: /证据|查找|事实|确认|gap|gap/i.test(display), actual: display.slice(0, 40), expected: "evidence language" },
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(q),
  ];
  return buildHermesJourney(id, "deep_recall", durationMs, q, false, timedOut, assertions);
}

// H5: safe capture routing — a new piece of info is stored cleanly (no junk pages).
async function runH5SafeCapture(jc: JourneyContext): Promise<HermesJourney> {
  const id = "safe-capture-routing";
  // Snapshot DB + vault BEFORE so we can prove the capture has no junk side effects.
  const pagesBefore = countPages(jc.db);
  const mdBefore = new Set(listVaultMd(jc.vaultPath));
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.ingest.handler({
      content: `---\ntitle: 捕获记录B\ntype: record\n---\n这是一条待捕获的新信息，应当干净入库，并保留足够的匿名事实背景来证明记录内容完整且可检索。该信息还包含后续检索所需的上下文与事实边界。`,
      type: "markdown",
      skipNer: true,
    }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed, isError } = parseEnvelope(value ?? { content: [] });
  const raw = parsed?.raw as { slug?: string; created?: boolean; outcome?: string } | undefined;
  const slug = String(raw?.slug ?? "");
  const captured = raw?.created === true || raw?.outcome === "created";
  const display = displayOf(parsed);
  // Side-effect contract: exactly one new page + one new clean .md file (no dup/junk/untitled).
  const newPageCount = countPages(jc.db) - pagesBefore;
  const newMd = listVaultMd(jc.vaultPath).filter((p) => !mdBefore.has(p)).map((p) => basename(p));
  const noJunkFiles = newMd.every((n) => !n.startsWith("untitled-"));
  const assertions: AssertionResult[] = [
    { check: "capture succeeded (no error)", passed: !isError && captured, actual: isError ? "error" : raw?.outcome ?? "missing", expected: "created" },
    { check: "exactly one page created (no dup/junk)", passed: newPageCount === 1, actual: `${newPageCount} new pages`, expected: "exactly 1" },
    { check: "no junk/path-derived vault file", passed: newMd.length === 1 && noJunkFiles, actual: newMd.join(",") || "none", expected: "1 clean .md, no untitled-/path" },
    assertDisplayCompact(display.length ? display : slug),
    ...scanDisplay(display.length ? display : slug),
    assertQueryBudget(q),
  ];
  return buildHermesJourney(id, "ingest", durationMs, q, false, timedOut, assertions);
}

// H6: failure / degraded behavior — a missing case must degrade gracefully.
async function runH6Failure(jc: JourneyContext): Promise<HermesJourney> {
  const id = "failure-degraded";
  const { value, timedOut, durationMs } = await withCeiling(
    () => jc.tools.deep_recall.handler({ query: "完全不存在的概念ZetaNopeAlpha", limit: 5, strategy: "smart" }),
    HANG_CEILING_MS,
  );
  const q = jc.counter.n;
  const { parsed, isError } = parseEnvelope(value ?? { content: [] });
  const display = displayOf(parsed);
  const status = summaryStatus(parsed);
  const graceful = !isError && (status === "empty" || status === "degraded" || status === "ok");
  const assertions: AssertionResult[] = [
    { check: "missing query handled gracefully (no hard error)", passed: graceful, actual: isError ? "error" : String(status ?? "missing"), expected: "empty/degraded/ok, not a crash" },
    { check: "display gives a clear next action, not a stack", passed: display.length > 0 && !/Error|at \w+\.|stack|Trace/i.test(display), actual: display.slice(0, 40), expected: "user-safe wording, no stack trace" },
    assertDisplayCompact(display),
    ...scanDisplay(display),
    assertQueryBudget(q),
  ];
  // This journey EXPECTS a degraded/empty result; degraded flag is informational.
  const degraded = status === "degraded" || status === "empty";
  return buildHermesJourney(id, "deep_recall", durationMs, q, degraded, timedOut, assertions);
}

// ── Fault injection (test-only: prove the gate goes no-go on each failure class) ──

interface HermesFaults {
  readonly retrieval: boolean;
  readonly privacyLeak: boolean;
  readonly hang: boolean;
  readonly queryBudget: boolean;
}

function readHermesFaults(): HermesFaults {
  return {
    retrieval: process.env.HERMES_FAULT_RETRIEVAL === "1",
    privacyLeak: process.env.HERMES_FAULT_PRIVACY_LEAK === "1",
    hang: process.env.HERMES_FAULT_HANG === "1",
    queryBudget: process.env.HERMES_FAULT_QUERY_BUDGET === "1",
  };
}

/** Empty recall (resolveSlugs + hybrid search) so a must-recall journey misses. */
function applyRetrievalFault(ctx: ToolContext): () => void {
  const db = ctx.db as { resolveSlugs: (queries: string[]) => unknown };
  const search = ctx.search as { search: (...args: unknown[]) => Promise<unknown[]> };
  const origResolve = db.resolveSlugs.bind(db);
  const origSearch = search.search.bind(search);
  db.resolveSlugs = (queries: string[]) => queries.map((q) => ({ query: q, slug: null, title: null, type: null }));
  search.search = async () => [];
  return () => { db.resolveSlugs = origResolve; search.search = origSearch; };
}

/** Make the hybrid search path never resolve (real hang) so the ceiling catches it. */
function applyHangFault(ctx: ToolContext): () => void {
  const search = ctx.search as { search: (...args: unknown[]) => Promise<unknown> };
  const origSearch = search.search.bind(search);
  search.search = async () => new Promise<never>(() => {});
  return () => { search.search = origSearch; };
}

// ── DB/vault side-effect helpers (safe-capture junk check) ──

function countPages(db: CBrainDB): number {
  return (db.rawDb.prepare("SELECT COUNT(*) c FROM pages").get() as { c: number }).c;
}
function listVaultMd(vaultPath: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st: { isDirectory(): boolean };
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".md")) out.push(p);
    }
  };
  walk(vaultPath);
  return out;
}

// ── Orchestrator ──

async function executeHermesGate(): Promise<HermesResult> {
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")).version;
  const gateStart = performance.now();

  const iso = createIsolation();
  let db: CBrainDB | undefined;
  const journeys: HermesJourney[] = [];
  let cleanupVerified = false;
  let fatalMsg: string | null = null;

  try {
    db = new CBrainDB(iso.dbPath);
    const lance = makeMockLance();
    const embedding = makeMockEmbedding();
    await seedHermesFixture(db, iso.vaultPath, embedding, lance);
    const ctx = buildContext({
      db,
      embedding,
      lance,
      vaultPath: iso.vaultPath,
      dbPath: iso.dbPath,
      profileDir: iso.profileDir,
      runtimePath: iso.runtimePath,
    });

    const faults = readHermesFaults();
    const counter = installQueryCounter(db, faults.queryBudget);
    try {
      const { tools } = buildGateServer(ctx);
      const jc: JourneyContext = { tools, counter: counter.counter, db, vaultPath: iso.vaultPath, faults };

      // Retrieval fault empties recall for the whole run (must-recall journeys fail).
      const restoreRetrieval = faults.retrieval ? applyRetrievalFault(ctx) : () => {};
      // Hang fault is scoped to H1 only — proves the ceiling catches a real hang
      // without making every search journey pay the full ceiling.
      const restoreHang = faults.hang ? applyHangFault(ctx) : () => {};
      try {
        counter.counter.n = 0;
        journeys.push(await runH1FirstRecall(jc));
        restoreHang();
        counter.counter.n = 0;
        journeys.push(await runH2ForgottenPerson(jc));
        counter.counter.n = 0;
        journeys.push(await runH3Relationship(jc));
        counter.counter.n = 0;
        journeys.push(await runH4Grounded(jc));
        counter.counter.n = 0;
        journeys.push(await runH5SafeCapture(jc));
        counter.counter.n = 0;
        journeys.push(await runH6Failure(jc));
      } finally {
        restoreRetrieval();
      }
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

  // Privacy: per-journey display scans + a global report scan.
  const displayPrivacy = journeys.flatMap((j) => j.assertions.filter((a) => a.check.startsWith("display has no ")));
  const journeyJson = JSON.stringify(journeys, null, 2);
  const globalPrivacy = scanGlobal(sanitizeOutput(journeyJson));
  const privacyAssertions = [...displayPrivacy, ...globalPrivacy];
  const privacyPassed = privacyAssertions.every((a) => a.passed);

  const failed = journeys.find((j) => j.status === "fail") ?? null;
  const overallPassed = privacyPassed && !failed && cleanupVerified && !fatalMsg;
  const reason = fatalMsg
    ? fatalMsg
    : failed
      ? failed.failure_reason ?? `journey '${failed.id}' failed`
      : !privacyPassed
        ? "privacy scan detected a leak in the report"
        : !cleanupVerified
          ? "temporary state was not cleaned up"
          : null;

  const report: HermesReport = {
    gate: "v2-hermes",
    version,
    timestamp: new Date().toISOString(),
    verdict: overallPassed ? "go" : "no-go",
    journeys,
    privacy: { passed: privacyPassed, assertions: privacyAssertions },
    failed_stage: failed ? failed.id : (!privacyPassed ? "privacy" : (!cleanupVerified ? "cleanup" : (fatalMsg ? "fatal" : null))),
    reason,
    cleanup: { verified: cleanupVerified, path: cleanupVerified ? "<cleaned>" : "<retained>" },
    duration_ms: Math.round(performance.now() - gateStart),
  };
  const exitCode = fatalMsg ? 2 : overallPassed ? 0 : 1;
  return { report, exitCode };
}

// ── Terminal summary ──

function writeHermesSummary(report: HermesReport): void {
  const lines: string[] = [];
  lines.push(`╔══ CBrain v2.0 Hermes Dialogue Gate ══╗`);
  lines.push(`  verdict:   ${report.verdict.toUpperCase()}`);
  lines.push(`  duration:  ${report.duration_ms}ms`);
  lines.push(`  journeys:`);
  for (const j of report.journeys) {
    const mark = j.status === "pass" ? "✓" : "✗";
    const deg = j.degraded ? " [degraded]" : "";
    lines.push(`    ${mark} ${j.id} [${j.tool}] ${j.duration_ms}ms / ${j.query_count}q≤${j.query_budget}${deg}${j.privacy_passed ? "" : " PRIVACY"}`);
  }
  lines.push(`  privacy:   ${report.privacy.passed ? "clean" : "LEAK"}`);
  lines.push(`  cleanup:   ${report.cleanup.verified ? "ok" : "FAILED"}`);
  if (report.failed_stage) {
    lines.push(`  failed:    ${report.failed_stage}`);
    lines.push(`  reason:    ${report.reason}`);
  }
  lines.push(`╚══════════════════════════════════════╝`);
  process.stderr.write(lines.join("\n") + "\n");
}

// ── Entry ──

if (import.meta.main) {
  executeHermesGate().then(({ report, exitCode }) => {
    const json = sanitizeOutput(JSON.stringify(report, null, 2));
    process.stdout.write(json + "\n");
    writeHermesSummary(JSON.parse(json) as HermesReport);
    process.exitCode = exitCode;
  }).catch((e) => {
    const detail = e instanceof Error ? e.message : String(e);
    const safe = detail.replace(/\/Users\/[^\s:"]+/g, "<HOME>/...").replace(/sk-[a-f0-9]{8,}/gi, "<REDACTED>").split("\n")[0];
    process.stdout.write(JSON.stringify({
      gate: "v2-hermes",
      verdict: "no-go",
      error: safe,
      cleanup: { verified: false, path: "<unknown>" },
    }, null, 2) + "\n");
    process.exitCode = 2;
  });
}
