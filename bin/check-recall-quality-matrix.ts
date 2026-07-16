#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import { PageManager } from "../src/core/page.js";
import { classifyFrontdoorQuery } from "../src/core/retrieval/frontdoor-router.js";
import { createServer, type CBrainDeps } from "../src/mcp/server.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import { checkAgentWorkflowContract } from "./check-docs-consistency.js";
import {
	resolveOperationalRouteObservations,
	type RecallRouteContractCase,
	type RecallRouteContractObservation,
} from "./lib/recall-quality-matrix.js";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASE_IDS = [
  "zh_exact",
  "en_exact",
  "mixed_alias",
  "abstract_topic",
  "honest_empty",
  "temporal_evidence",
  "relationship_route",
  "operational_contract",
  "bounded_runtime",
] as const;
type CaseId = typeof CASE_IDS[number];
type Lane = "retrieval" | "router" | "evidence" | "latency";
type GateStatus = "pass" | "fail";
type Fault = Lane | "privacy";

export interface RecallQualityCaseMetrics {
  readonly recall_at_k: number | null;
  readonly noise_at_k: number | null;
  readonly honest_empty: boolean | null;
  readonly evidence_coverage: "sufficient" | "partial" | "insufficient" | null;
  readonly route_match: boolean | null;
  readonly degraded: boolean;
  readonly latency_warning: boolean;
  readonly completion: "complete" | "retrieval_degraded" | "latency_warning";
}

export interface RecallQualityCaseResult {
  readonly id: CaseId;
  readonly lane: Lane;
  readonly passed: boolean;
  readonly metrics: RecallQualityCaseMetrics;
}

export interface RecallQualityMatrixReport {
  readonly gate: "recall-quality-matrix";
  readonly version: 1;
  readonly verdict: "go" | "no-go";
  readonly lanes: Readonly<Record<Lane, GateStatus>>;
  readonly cases: readonly RecallQualityCaseResult[];
  readonly privacy: GateStatus;
  readonly duration_ms: number;
}

export interface RecallQualityMatrixOptions {
  readonly fault?: Fault;
}

export interface OperationalContractExecutionOptions {
	readonly agentFacingRoutingText: string;
	readonly cases: readonly RecallRouteContractCase[];
	readonly createSemanticHandler: () => unknown;
}

/** Route-contract execution is deliberately data-only and never constructs a semantic handler. */
export function executeOperationalContractCases(
	options: OperationalContractExecutionOptions,
): readonly RecallRouteContractObservation[] {
	return resolveOperationalRouteObservations(
		options.agentFacingRoutingText,
		options.cases,
	);
}

const emptyMetrics = (): RecallQualityCaseMetrics => ({
  recall_at_k: null,
  noise_at_k: null,
  honest_empty: null,
  evidence_coverage: null,
  route_match: null,
  degraded: false,
  latency_warning: false,
  completion: "complete",
});

function createEmbedding(): EmbeddingProvider {
  const vector = (text: string) => Array.from({ length: 32 }, (_, i) =>
    ((text.charCodeAt(i % Math.max(text.length, 1)) || 0) % 97) / 97,
  );
  return {
    dimensions: 32,
    embed: async (text) => ({ embedding: vector(text), tokenCount: text.length }),
    embedBatch: async (texts) => texts.map((text) => ({ embedding: vector(text), tokenCount: text.length })),
  };
}

function createEmptyLance() {
  return {
    connect: async () => {},
    addChunks: async () => {},
    search: async () => [],
    fullTextSearch: async () => [],
    deleteByPageSlug: async () => {},
    deleteRawChunksByPageSlug: async () => {},
    close: async () => {},
    createFTSIndex: async () => {},
  };
}

function getTools(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }> }> })
    ._registeredTools;
}

function seedPage(
  db: CBrainDB,
  pages: PageManager,
  input: { slug: string; title: string; type: string; body: string },
): string {
  const slug = pages.create({ ...input, tags: [] }).slug;
  db.rawDb.prepare("INSERT INTO chunks (page_slug, chunk_index, content) VALUES (?, ?, ?)").run(slug, 0, input.body);
  db.rawDb.prepare("INSERT INTO chunks_fts (page_slug, content) VALUES (?, ?)").run(slug, input.body);
  return slug;
}

async function recall(
  handler: (input: unknown) => Promise<{ content: Array<{ text: string }> }>,
  input: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await handler({ detail: "brief", include_raw: true, ...input });
  return JSON.parse(response.content[0].text) as Record<string, any>;
}

function retrievalCase(id: CaseId, payload: Record<string, any>, expectedSlug: string): RecallQualityCaseResult {
  const slugs = (payload.entities ?? []).map((entity: { slug?: string }) => entity.slug).filter(Boolean) as string[];
  const relevant = slugs.filter((slug) => slug === expectedSlug).length;
  const noise = slugs.filter((slug) => slug !== expectedSlug).length;
  const recallAtK = relevant > 0 ? 1 : 0;
  const noiseAtK = slugs.length > 0 ? noise / slugs.length : 0;
  const degraded = payload.raw?.search_meta?.degraded === true;
  const latencyWarning = payload.raw?.search_meta?.latency_warning === true;
  return {
    id,
    lane: "retrieval",
    passed: recallAtK === 1 && noiseAtK === 0 && !degraded,
    metrics: {
      ...emptyMetrics(),
      recall_at_k: recallAtK,
      noise_at_k: noiseAtK,
      degraded,
      latency_warning: latencyWarning,
      completion: degraded ? "retrieval_degraded" : latencyWarning ? "latency_warning" : "complete",
    },
  };
}

function applyFault(cases: RecallQualityCaseResult[], fault?: Fault): RecallQualityCaseResult[] {
  if (!fault || fault === "privacy") return cases;
  const targetId: Record<Lane, CaseId> = {
    retrieval: "zh_exact",
    router: "relationship_route",
    evidence: "temporal_evidence",
    latency: "bounded_runtime",
  };
  return cases.map((item) => item.id === targetId[fault] ? { ...item, passed: false } : item);
}

function reportIsPrivate(report: RecallQualityMatrixReport): boolean {
  const text = JSON.stringify(report);
  return !/(实体甲|组织乙|Project Alpha|韧性治理|\/Users\/|"(?:slug|query|title|path|body|content|score)"\s*:)/u.test(text);
}

export async function runRecallQualityMatrix(options: RecallQualityMatrixOptions = {}): Promise<RecallQualityMatrixReport> {
  const started = performance.now();
  const root = mkdtempSync(join(tmpdir(), "cbrain-recall-matrix-"));
  const db = new CBrainDB(join(root, "brain.sqlite"));
  try {
    const vaultPath = join(root, "vault");
    const pages = new PageManager(db, vaultPath);
    const zhSlug = seedPage(db, pages, {
      slug: "entity/alpha-cn",
      title: "实体甲",
      type: "entity/person",
      body: "上次迁移方案已经确定。韧性治理依靠恢复演练与明确责任。",
    });
    const enSlug = seedPage(db, pages, {
      slug: "entity/project-alpha",
      title: "Project Alpha",
      type: "entity/project",
      body: "Project Alpha documents a bounded recovery workflow.",
    });
    const orgSlug = seedPage(db, pages, {
      slug: "entity/org-beta",
      title: "组织乙",
      type: "entity/organization",
      body: "组织乙负责协作流程。",
    });
    seedPage(db, pages, {
      slug: "concept/noise",
      title: "无关主题",
      type: "concept/concept",
      body: "这是一条与评测目标无关的占位内容。",
    });
    db.addAlias(enSlug, "项目甲");
    db.addTimelineEntry(zhSlug, "确认迁移方案", "2026-01-01", "manual");
    db.insertLink(zhSlug, orgSlug, "协作", null, 1, "strong", "manual", 0.9);

    const deps: CBrainDeps = {
      db,
      embedding: createEmbedding(),
      lance: createEmptyLance() as never,
      vaultPath,
      runtimePath: join(root, "runtime"),
    };
    const tools = getTools(createServer(deps));

    const zh = retrievalCase("zh_exact", await recall(tools.deep_recall.handler, { query: "实体甲" }), zhSlug);
    const en = retrievalCase("en_exact", await recall(tools.deep_recall.handler, { query: "Project Alpha" }), enSlug);
    const mixed = retrievalCase(
      "mixed_alias",
      await recall(tools.deep_recall.handler, { query: "Project Alpha 项目甲", strategy: "fts" }),
      enSlug,
    );
    const abstract = retrievalCase(
      "abstract_topic",
      await recall(tools.deep_recall.handler, { query: "迁移方案的痛点是什么", strategy: "fts" }),
      zhSlug,
    );

    const emptyPayload = await recall(tools.deep_recall.handler, { query: "不存在主题 qzxv" });
    const emptySlugs = (emptyPayload.entities ?? []).map((entity: { slug?: string }) => entity.slug).filter(Boolean);
    const honestEmpty = emptySlugs.length === 0 && emptyPayload.summary?.status === "empty";
    const empty: RecallQualityCaseResult = {
      id: "honest_empty",
      lane: "retrieval",
      passed: honestEmpty,
      metrics: { ...emptyMetrics(), noise_at_k: emptySlugs.length, honest_empty: honestEmpty },
    };

    const temporalPayload = await recall(tools.deep_recall.handler, {
      query: "上次迁移方案",
      strategy: "fts",
      evidence: "on",
    });
    const coverage = temporalPayload.raw?.evidence_pack?.coverage?.coverage_status ?? "insufficient";
    const temporal: RecallQualityCaseResult = {
      id: "temporal_evidence",
      lane: "evidence",
      passed: coverage === "sufficient",
      metrics: { ...emptyMetrics(), evidence_coverage: coverage },
    };

    const route = classifyFrontdoorQuery("实体甲和组织乙有什么关系");
    const relationship: RecallQualityCaseResult = {
      id: "relationship_route",
      lane: "router",
      passed: route.chosen_route === "relationship",
      metrics: { ...emptyMetrics(), route_match: route.chosen_route === "relationship" },
    };

    const workflowChecks = checkAgentWorkflowContract(join(PROJECT_DIR, "skills"));
    const operationsPass = workflowChecks.every((check) => check.passed);
    const operations: RecallQualityCaseResult = {
      id: "operational_contract",
      lane: "router",
      passed: operationsPass,
      metrics: { ...emptyMetrics(), route_match: operationsPass },
    };

    const measuredBeforeReport = performance.now() - started;
    const boundedRuntime: RecallQualityCaseResult = {
      id: "bounded_runtime",
      lane: "latency",
      passed: measuredBeforeReport < 5_000,
      metrics: emptyMetrics(),
    };
    const cases = applyFault(
      [zh, en, mixed, abstract, empty, temporal, relationship, operations, boundedRuntime],
      options.fault,
    );
    const elapsed = performance.now() - started;
    const lanes: Record<Lane, GateStatus> = {
      retrieval: cases.filter((item) => item.lane === "retrieval").every((item) => item.passed) ? "pass" : "fail",
      router: cases.filter((item) => item.lane === "router").every((item) => item.passed) ? "pass" : "fail",
      evidence: cases.filter((item) => item.lane === "evidence").every((item) => item.passed) ? "pass" : "fail",
      latency: cases.filter((item) => item.lane === "latency").every((item) => item.passed) ? "pass" : "fail",
    };
    const draft: RecallQualityMatrixReport = {
      gate: "recall-quality-matrix",
      version: 1,
      verdict: "no-go",
      lanes,
      cases,
      privacy: "pass",
      duration_ms: Math.round(elapsed),
    };
    const privacyPass = options.fault !== "privacy" && reportIsPrivate(draft);
    const verdict = Object.values(lanes).every((status) => status === "pass") && privacyPass ? "go" : "no-go";
    return { ...draft, verdict, privacy: privacyPass ? "pass" : "fail" };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const fault = process.env.RECALL_MATRIX_FAULT as Fault | undefined;
  try {
    const report = await runRecallQualityMatrix({ fault });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.verdict === "go" ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ gate: "recall-quality-matrix", version: 1, verdict: "no-go", reason: "gate_execution_failed" }));
    process.exitCode = 2;
  }
}
