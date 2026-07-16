#!/usr/bin/env bun

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingProvider } from "../src/embedding/provider.js";
import { JobQueue } from "../src/core/jobs.js";
import { PageManager } from "../src/core/page.js";
import { classifyFrontdoorQuery } from "../src/core/retrieval/frontdoor-router.js";
import { buildContext } from "../src/mcp/context.js";
import { attachMcpTools, type CBrainDeps } from "../src/mcp/server.js";
import { registerFrontdoorTools } from "../src/mcp/tools/frontdoor.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import type { LanceDBManager } from "../src/storage/lancedb.js";
import { checkAgentWorkflowContract } from "./check-docs-consistency.js";
import {
	buildRecallQualityReport,
	checkRecallQualityPrivacy,
	evaluateRecallCase,
	parseRecallQualityBaseline,
	parseRecallQualityCases,
	parseRecallQualityCorpus,
	RecallQualityFixtureError,
	resolveOperationalRouteObservations,
	type LegacyRecallCaseId,
	type LegacyRecallCaseSummary,
	type LegacyRecallLane,
	type RecallCorpus,
	type RecallQualityCaseId,
	type RecallQualityPublicReport,
	type RecallQualityObservation,
	type RecallRouteContractCase,
	type RecallRouteContractObservation,
	type RecallSemanticCase,
	type RecallSemanticObservation,
} from "./lib/recall-quality-matrix.js";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_WORKER_MARKER = "RECALL_QUALITY_INTERNAL_WORKER";
const CORPUS_PATH = join(PROJECT_DIR, "tests/fixtures/recall-quality-corpus.jsonl");
const CASES_PATH = join(PROJECT_DIR, "tests/fixtures/recall-quality-cases.jsonl");
const BASELINE_PATH = join(PROJECT_DIR, "tests/fixtures/recall-quality-baseline.json");
const AGENT_FACING_PATH = join(PROJECT_DIR, "skills/agent-facing.routing-eval.jsonl");
type CaseId = LegacyRecallCaseId;
type Lane = LegacyRecallLane;
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

interface LegacyRecallQualityMatrixResult {
  readonly lanes: Readonly<Record<Lane, GateStatus>>;
  readonly cases: readonly RecallQualityCaseResult[];
  readonly boundedRuntime: boolean;
}

export interface RecallQualityMatrixOptions {
  readonly fault?: Fault;
	readonly strict?: boolean;
	readonly boundedRuntimeProbe?: Readonly<{
		startedAtMs: number;
		finishedAtMs: number;
		timeoutMs: number;
	}>;
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

export interface SemanticRecallIntegrationResult {
	readonly worker: Readonly<{
		closedEnvironment: boolean;
		inheritedCbrainVariables: number;
		temporaryRootRemoved: boolean;
	}>;
	readonly topology: Readonly<{
		contextBuilder: "buildContext";
		server: "bare_mcp";
		registeredTools: readonly ["cbrain_recall"];
		jobStartCalls: number;
	}>;
	readonly noLlmProvider: boolean;
	readonly networkAdapterCalls: number;
	readonly invocations: readonly Readonly<{
		caseId: RecallSemanticCase["caseId"];
		detail: "normal";
		includeRaw: true;
	}>[];
	readonly observations: readonly RecallSemanticObservation[];
	readonly vector: Readonly<{
		lanceSearchCalls: number;
		noSharedTokens: boolean;
		abstractExpectedSourceFound: boolean;
		ftsControlExpectedSourceFound: boolean;
		ftsControlApi: "HybridSearch.search(strategy=fts)";
		comparisonLayer: "retrieval_candidates";
		tieOrderStable: boolean;
		tieOrder: readonly Readonly<{ pageSlug: string; chunkIndex: number }>[];
	}>;
}

export type RecallCleanupFailureStage =
	| "semantic_db"
	| "semantic_context"
	| "semantic_handler"
	| "semantic_close"
	| "legacy_db"
	| "legacy_context"
	| "legacy_handler"
	| "legacy_close"
	| "worker_spawn";

export interface RecallCleanupFailureProbeResult {
	readonly failureObserved: true;
	readonly failureBoundary: RecallCleanupFailureStage;
	readonly suiteRootRemoved: true;
	readonly workerRootRemoved: true;
	readonly parentEnvironmentRestored: true;
}

interface SuiteFailureHooks {
	readonly closeFailure?: boolean;
	readonly onCloseInvoked?: () => void;
	readonly onRootCreated?: (root: string) => void;
	readonly runtime?: SuiteRuntimeDependencies;
}

type RegisteredToolHandler = (
	input: unknown,
) => Promise<{ content: Array<{ text: string }> }>;

interface SuiteRuntimeDependencies {
	readonly openDb: (path: string) => CBrainDB;
	readonly createContext: typeof buildContext;
	readonly invokeHandler: (
		handler: RegisteredToolHandler,
		input: unknown,
	) => Promise<{ content: Array<{ text: string }> }>;
}

const DEFAULT_SUITE_RUNTIME: SuiteRuntimeDependencies = {
	openDb: (path) => new CBrainDB(path),
	createContext: buildContext,
	invokeHandler: (handler, input) => handler(input),
};

interface NetworkPoison {
	readonly calls: () => number;
	readonly originalFetch: typeof globalThis.fetch;
	restore(): void;
}

function installNetworkPoison(): NetworkPoison {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = ((..._args: Parameters<typeof globalThis.fetch>) => {
		calls += 1;
		return Promise.reject(new Error("recall_quality_network_forbidden"));
	}) as unknown as typeof globalThis.fetch;
	return {
		calls: () => calls,
		originalFetch,
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

interface ProductionFrontdoorEnvelope {
	readonly summary?: Readonly<{ status?: unknown }>;
	readonly raw?: Readonly<{
		routing?: Readonly<{ chosen_route?: unknown }>;
		entities?: readonly Readonly<{
			title?: unknown;
			snippet?: unknown;
			body?: unknown;
		}>[];
		evidence_pack?: Readonly<{
			coverage?: Readonly<{ coverage_status?: unknown }>;
		}>;
	}>;
}

/**
 * Convert the production-shaped frontdoor envelope into controlled fixture IDs.
 * Queries, titles, snippets, bodies, scores, and routing diagnostics never leave
 * this boundary.
 */
export function mapFrontdoorEnvelopeToSemanticObservation(
	testCase: RecallSemanticCase,
	envelope: ProductionFrontdoorEnvelope,
	corpus: RecallCorpus,
): RecallSemanticObservation {
	const titleToSource = new Map(corpus.map((source) => [source.title, source]));
	const entities = Array.isArray(envelope.raw?.entities)
		? envelope.raw.entities
		: [];
	const top3 = entities.slice(0, 3).flatMap((entity) => {
		if (typeof entity.title !== "string") return [];
		const source = titleToSource.get(entity.title);
		if (!source) return [];
		const evidenceText = [entity.snippet]
			.filter((value): value is string => typeof value === "string")
			.join(" ");
		const evidenceTokens = new Set(evidenceText.split(/\s+/u).filter(Boolean));
		return [{
			sourceId: source.sourceId,
			matchedPointIds: source.answerPoints
				.filter((point) => point.text.split(" ").every((token) => evidenceTokens.has(token)))
				.map((point) => point.pointId)
				.sort(),
		}];
	});
	const rawStatus = envelope.summary?.status;
	const answerStatus = rawStatus === "ok" || rawStatus === "empty"
		? rawStatus
		: "degraded";
	const rawCoverage = envelope.raw?.evidence_pack?.coverage?.coverage_status;
	const evidenceSufficiency = rawCoverage === "sufficient"
		? "sufficient"
		: rawCoverage === "partial" || rawCoverage === "insufficient"
			? "insufficient"
			: "not_applicable";
	const degradationKind = answerStatus !== "degraded"
		? "none"
		: evidenceSufficiency === "insufficient"
			? "evidence"
			: "unclassified";

	return {
		kind: "semantic_recall",
		caseId: testCase.caseId,
		actualTool: "cbrain_recall",
		actualFrontdoorRoute:
			typeof envelope.raw?.routing?.chosen_route === "string"
				? envelope.raw.routing.chosen_route
				: "unknown",
		answerStatus,
		degradationKind,
		evidenceSufficiency,
		top3,
	};
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

interface GateVectorDocument {
	readonly pageSlug: string;
	readonly chunkIndex: number;
	readonly content: string;
	readonly embedding: readonly number[];
}

interface GateVectorIndex extends LanceDBManager {
	readonly searchCalls: number;
	seed(document: GateVectorDocument): void;
}

const CONCEPT_DIMENSIONS = 4;

function fixtureConceptVector(text: string): number[] {
	if (text === "系统 恢复 边界 明确 责任" || text === "上次 系统 恢复 边界") {
		return [1, 0, 0, 0];
	}
	if (text === "抽象 治理 稳定 原因 约束" || text === "上次 为什么 需要 未知 线索") {
		return [0, 0, 1, 0];
	}
	if (text === "系统 速度 体验 观察 记录" || text === "近似 噪声 背景 主题 说明") {
		return [0, 1, 0, 0];
	}
	return [0, 0, 0, 0];
}

function createFixtureEmbedding(): EmbeddingProvider {
	const embedOne = (text: string) => ({
		embedding: fixtureConceptVector(text),
		tokenCount: text.length,
	});
	return {
		dimensions: CONCEPT_DIMENSIONS,
		embed: async (text) => embedOne(text),
		embedBatch: async (texts) => texts.map(embedOne),
	};
}

function cosine(left: readonly number[], right: readonly number[]): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		dot += (left[index] ?? 0) * (right[index] ?? 0);
		leftNorm += (left[index] ?? 0) ** 2;
		rightNorm += (right[index] ?? 0) ** 2;
	}
	if (leftNorm === 0 || rightNorm === 0) return 0;
	return dot / Math.sqrt(leftNorm * rightNorm);
}

function createGateVectorIndex(): GateVectorIndex {
	const documents: GateVectorDocument[] = [];
	let searchCalls = 0;
	const index = {
		get searchCalls() {
			return searchCalls;
		},
		seed(document: GateVectorDocument) {
			documents.push(document);
		},
		connect: async () => {},
		addChunks: async () => {},
		search: async (embedding: readonly number[], limit: number) => {
			searchCalls += 1;
			return documents
				.map((document) => ({ document, similarity: cosine(embedding, document.embedding) }))
				.filter((item) => item.similarity >= 0.8)
				.sort((left, right) =>
				right.similarity - left.similarity ||
				left.document.pageSlug.localeCompare(right.document.pageSlug) ||
				left.document.chunkIndex - right.document.chunkIndex
				)
				.slice(0, limit)
				.map(({ document, similarity }) => ({
					pageSlug: document.pageSlug,
					chunkIndex: document.chunkIndex,
					content: document.content,
					_distance: 1 - similarity,
				}));
		},
		fullTextSearch: async () => [],
		deleteByPageSlug: async () => {},
		deleteRawChunksByPageSlug: async () => {},
		close: async () => {},
		createFTSIndex: async () => {},
	};
	return index as unknown as GateVectorIndex;
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

function loadCanonicalSemanticFixtures(): {
	readonly corpus: RecallCorpus;
	readonly cases: readonly RecallSemanticCase[];
} {
	const corpus = parseRecallQualityCorpus(readFileSync(CORPUS_PATH, "utf8"));
	const cases = parseRecallQualityCases(
		readFileSync(CASES_PATH, "utf8"),
		corpus,
	).filter((testCase): testCase is RecallSemanticCase =>
		testCase.kind === "semantic_recall"
	);
	return { corpus, cases };
}

async function executeSemanticRecallWorker(
	hooks: SuiteFailureHooks = {},
): Promise<SemanticRecallIntegrationResult> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
	const allowedEnvironment = new Set([
		"PATH",
		"LANG",
		"LC_ALL",
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		INTERNAL_WORKER_MARKER,
	]);
	const environmentKeys = Object.keys(process.env);
	const closedEnvironment = environmentKeys.every((key) => allowedEnvironment.has(key));
	const inheritedCbrainVariables = environmentKeys.filter((key) => key.startsWith("CBRAIN_")).length;
	const root = mkdtempSync(join(tmpdir(), "cbrain-recall-semantic-"));
	let db: CBrainDB | undefined;
	let result: Omit<SemanticRecallIntegrationResult, "worker"> | undefined;
	let originalJobStart: typeof JobQueue.prototype.start | undefined;
	let networkPoison: NetworkPoison | undefined;
	let jobStartCalls = 0;
	try {
		const runtime = hooks.runtime ?? DEFAULT_SUITE_RUNTIME;
		hooks.onRootCreated?.(root);
		const vaultPath = join(root, "vault");
		const runtimePath = join(root, "runtime");
		const profileDir = join(root, "profile");
		for (const path of [vaultPath, runtimePath, profileDir]) {
			mkdirSync(path, { recursive: true });
		}
		originalJobStart = JobQueue.prototype.start;
		JobQueue.prototype.start = function recallQualityJobStartSpy() {
			jobStartCalls += 1;
		};
		networkPoison = installNetworkPoison();
		const fixtures = loadCanonicalSemanticFixtures();
		db = runtime.openDb(join(root, "brain.sqlite"));
		if (hooks.closeFailure) {
			const close = db.close.bind(db);
			db.close = () => {
				close();
				hooks.onCloseInvoked?.();
				throw new Error("semantic_close_failure");
			};
		}
		const pages = new PageManager(db, vaultPath);
		const embedding = createFixtureEmbedding();
		const lance = createGateVectorIndex();
		const slugBySource = new Map<string, string>();
		for (const source of fixtures.corpus) {
			const slug = seedPage(db, pages, {
				slug: `records/${source.sourceId.replace("_", "-")}`,
				title: source.title,
				type: source.type,
				body: source.body,
			});
			slugBySource.set(source.sourceId, slug);
			for (const timeline of source.timeline) {
				db.addTimelineEntry(slug, timeline.text, timeline.date, "manual");
			}
		}
		for (const document of [
			{ sourceId: "source_d", chunkIndex: 0 },
			{ sourceId: "source_b", chunkIndex: 10 },
			{ sourceId: "source_b", chunkIndex: 2 },
			{ sourceId: "source_c", chunkIndex: 0 },
			{ sourceId: "source_a", chunkIndex: 0 },
		] as const) {
			const source = fixtures.corpus.find((item) => item.sourceId === document.sourceId);
			const pageSlug = slugBySource.get(document.sourceId);
			if (!source || !pageSlug) throw new Error("vector_seed_missing");
			lance.seed({
				pageSlug,
				chunkIndex: document.chunkIndex,
				content: source.body,
				embedding: fixtureConceptVector(source.body),
			});
		}

		const ctx = runtime.createContext({
			db,
			embedding,
			lance,
			vaultPath,
			dbPath: join(root, "brain.sqlite"),
			profileDir,
			runtimePath,
		});
		const server = new McpServer({ name: "cbrain-recall-quality", version: "task-4" });
		registerFrontdoorTools(server, ctx);
		const tools = getTools(server);
		const registeredTools = Object.keys(tools);
		if (registeredTools.length !== 1 || registeredTools[0] !== "cbrain_recall") {
			throw new Error("unexpected_semantic_tool_surface");
		}
		const observations: RecallSemanticObservation[] = [];
		const invocations: Array<{
			caseId: RecallSemanticCase["caseId"];
			detail: "normal";
			includeRaw: true;
		}> = [];
		for (const testCase of fixtures.cases) {
			const args = {
				query: testCase.query,
				detail: "normal" as const,
				include_raw: true as const,
			};
			invocations.push({ caseId: testCase.caseId, detail: args.detail, includeRaw: args.include_raw });
			const response = await runtime.invokeHandler(tools.cbrain_recall.handler, args);
			const envelope = JSON.parse(response.content[0]?.text ?? "{}") as ProductionFrontdoorEnvelope;
			observations.push(mapFrontdoorEnvelopeToSemanticObservation(testCase, envelope, fixtures.corpus));
		}

		const abstractCase = fixtures.cases.find((testCase) => testCase.caseId === "abstract_positive_01");
		if (!abstractCase) throw new Error("abstract_case_missing");
		const expectedSource = abstractCase.expectedSources[0];
		if (!expectedSource) throw new Error("abstract_source_missing");
		const expectedCorpus = fixtures.corpus.find((source) => source.sourceId === expectedSource);
		if (!expectedCorpus) throw new Error("abstract_corpus_missing");
		const queryTokens = new Set(abstractCase.query.split(" "));
		const noSharedTokens = expectedCorpus.body.split(" ").every((token) => !queryTokens.has(token));
		const ftsControl = await ctx.search.search(abstractCase.query, {
			strategy: "fts",
			limit: 3,
			multiQuery: false,
		});
		const expectedSlug = slugBySource.get(expectedSource);
		const abstractObservation = observations.find((item) => item.caseId === abstractCase.caseId);
		const tieResults = await lance.search([0, 1, 0, 0], 10);
		const tieOrder = tieResults.map((item) => ({
			pageSlug: item.pageSlug,
			chunkIndex: item.chunkIndex,
		}));
		const expectedTieOrder = [...tieOrder].sort((left, right) =>
			left.pageSlug.localeCompare(right.pageSlug) ||
			left.chunkIndex - right.chunkIndex
		);

		result = {
			topology: {
				contextBuilder: "buildContext",
				server: "bare_mcp",
				registeredTools: ["cbrain_recall"],
				jobStartCalls,
			},
			noLlmProvider: ctx.llm === undefined,
			networkAdapterCalls: networkPoison.calls(),
			invocations,
			observations,
			vector: {
				lanceSearchCalls: lance.searchCalls,
				noSharedTokens,
				abstractExpectedSourceFound:
					abstractObservation?.top3.some((item) => item.sourceId === expectedSource) ?? false,
				ftsControlExpectedSourceFound:
					expectedSlug !== undefined && ftsControl.some((item) => item.slug === expectedSlug),
				ftsControlApi: "HybridSearch.search(strategy=fts)",
				comparisonLayer: "retrieval_candidates",
				tieOrderStable: JSON.stringify(tieOrder) === JSON.stringify(expectedTieOrder),
				tieOrder,
			},
		};
	} finally {
		try {
			networkPoison?.restore();
			if (originalJobStart) JobQueue.prototype.start = originalJobStart;
		} finally {
			try {
				db?.close();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	}
	if (!result) throw new Error("semantic_worker_incomplete");
	return {
		...result,
		worker: {
			closedEnvironment,
			inheritedCbrainVariables,
			temporaryRootRemoved: !existsSync(root),
		},
	};
}

async function recall(
	handler: RegisteredToolHandler,
  input: Record<string, unknown>,
	invokeHandler: SuiteRuntimeDependencies["invokeHandler"] = DEFAULT_SUITE_RUNTIME.invokeHandler,
): Promise<Record<string, any>> {
	const response = await invokeHandler(handler, { detail: "brief", include_raw: true, ...input });
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

async function executeRecallQualityMatrixWorker(
	options: RecallQualityMatrixOptions = {},
	hooks: SuiteFailureHooks = {},
): Promise<LegacyRecallQualityMatrixResult> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
  const root = mkdtempSync(join(tmpdir(), "cbrain-recall-matrix-"));
	let db: CBrainDB | undefined;
  try {
		const runtime = hooks.runtime ?? DEFAULT_SUITE_RUNTIME;
		hooks.onRootCreated?.(root);
		db = runtime.openDb(join(root, "brain.sqlite"));
		if (hooks.closeFailure) {
			const close = db.close.bind(db);
			db.close = () => {
				close();
				hooks.onCloseInvoked?.();
				throw new Error("legacy_close_failure");
			};
		}
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
    const legacyContext = runtime.createContext(deps);
    const legacyServer = new McpServer({ name: "cbrain-recall-quality", version: "legacy-v1" });
    attachMcpTools(legacyServer, legacyContext);
    const tools = getTools(legacyServer);

		const zhPayload = await recall(tools.deep_recall.handler, { query: "实体甲" }, runtime.invokeHandler);
		if (options.fault === "retrieval") zhPayload.entities = [];
		const zh = retrievalCase("zh_exact", zhPayload, zhSlug);
		const en = retrievalCase("en_exact", await recall(tools.deep_recall.handler, { query: "Project Alpha" }, runtime.invokeHandler), enSlug);
    const mixed = retrievalCase(
      "mixed_alias",
			await recall(tools.deep_recall.handler, { query: "Project Alpha 项目甲", strategy: "fts" }, runtime.invokeHandler),
      enSlug,
    );
    const abstract = retrievalCase(
      "abstract_topic",
			await recall(tools.deep_recall.handler, { query: "迁移方案的痛点是什么", strategy: "fts" }, runtime.invokeHandler),
      zhSlug,
    );

		const emptyPayload = await recall(tools.deep_recall.handler, { query: "不存在主题 qzxv" }, runtime.invokeHandler);
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
		}, runtime.invokeHandler);
		const coverage = options.fault === "evidence"
			? "insufficient"
			: temporalPayload.raw?.evidence_pack?.coverage?.coverage_status ?? "insufficient";
    const temporal: RecallQualityCaseResult = {
      id: "temporal_evidence",
      lane: "evidence",
      passed: coverage === "sufficient",
      metrics: { ...emptyMetrics(), evidence_coverage: coverage },
    };

    const route = classifyFrontdoorQuery("实体甲和组织乙有什么关系");
		const observedRelationshipRoute = options.fault === "router"
			? "content_recall"
			: route.chosen_route;
    const relationship: RecallQualityCaseResult = {
      id: "relationship_route",
      lane: "router",
      passed: observedRelationshipRoute === "relationship",
      metrics: { ...emptyMetrics(), route_match: observedRelationshipRoute === "relationship" },
    };

    const workflowChecks = checkAgentWorkflowContract(join(PROJECT_DIR, "skills"));
    const operationsPass = workflowChecks.every((check) => check.passed);
    const operations: RecallQualityCaseResult = {
      id: "operational_contract",
      lane: "router",
      passed: operationsPass,
      metrics: { ...emptyMetrics(), route_match: operationsPass },
    };

		const boundedRuntimeProbe = options.boundedRuntimeProbe ?? (
			options.fault === "latency"
				? { startedAtMs: 0, finishedAtMs: 5_001, timeoutMs: 5_000 }
				: { startedAtMs: 0, finishedAtMs: 1, timeoutMs: 5_000 }
		);
		const boundedRuntimePass =
			Number.isFinite(boundedRuntimeProbe.startedAtMs) &&
			Number.isFinite(boundedRuntimeProbe.finishedAtMs) &&
			Number.isFinite(boundedRuntimeProbe.timeoutMs) &&
			boundedRuntimeProbe.timeoutMs > 0 &&
			boundedRuntimeProbe.finishedAtMs >= boundedRuntimeProbe.startedAtMs &&
			boundedRuntimeProbe.finishedAtMs - boundedRuntimeProbe.startedAtMs <=
				boundedRuntimeProbe.timeoutMs;
    const boundedRuntime: RecallQualityCaseResult = {
      id: "bounded_runtime",
      lane: "latency",
      passed: boundedRuntimePass,
      metrics: emptyMetrics(),
    };
    const cases = [zh, en, mixed, abstract, empty, temporal, relationship, operations, boundedRuntime];
    const lanes: Record<Lane, GateStatus> = {
      retrieval: cases.filter((item) => item.lane === "retrieval").every((item) => item.passed) ? "pass" : "fail",
      router: cases.filter((item) => item.lane === "router").every((item) => item.passed) ? "pass" : "fail",
      evidence: cases.filter((item) => item.lane === "evidence").every((item) => item.passed) ? "pass" : "fail",
      latency: cases.filter((item) => item.lane === "latency").every((item) => item.passed) ? "pass" : "fail",
    };
    return {
			lanes,
			cases,
			boundedRuntime: boundedRuntimePass,
		};
  } finally {
		try {
			db?.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
  }
}

async function spawnClosedWorker<T>(
	expression: string,
	onRootCreated?: (root: string) => void,
	spawnProcess: typeof Bun.spawn = Bun.spawn,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "cbrain-recall-worker-"));
	try {
		onRootCreated?.(root);
		const home = join(root, "home");
		const config = join(root, "xdg-config");
		const data = join(root, "xdg-data");
		for (const path of [home, config, data]) mkdirSync(path, { recursive: true });
		const child = spawnProcess({
			cmd: [process.execPath, "-e", expression],
			cwd: PROJECT_DIR,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				HOME: home,
				XDG_CONFIG_HOME: config,
				XDG_DATA_HOME: data,
				[INTERNAL_WORKER_MARKER]: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) {
			void stderr;
			throw new Error("recall_quality_worker_failed");
		}
		return JSON.parse(stdout) as T;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function environmentSnapshot(): string {
	return JSON.stringify(Object.entries(process.env).sort(([left], [right]) =>
		left.localeCompare(right)
	));
}

export async function runRecallFailureProbeWorker(
	stage: RecallCleanupFailureStage,
): Promise<Readonly<{
	failureObserved: boolean;
	boundaryCalled: boolean;
	suiteRootRemoved: boolean;
}>> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
	let suiteRoot: string | undefined;
	let failureObserved = false;
	let boundaryCalled = false;
	const runtime: SuiteRuntimeDependencies = {
		openDb: stage.endsWith("_db")
			? () => {
				boundaryCalled = true;
				throw new Error("db_open_failure");
			}
			: DEFAULT_SUITE_RUNTIME.openDb,
		createContext: stage.endsWith("_context")
			? () => {
				boundaryCalled = true;
				throw new Error("context_factory_failure");
			}
			: DEFAULT_SUITE_RUNTIME.createContext,
		invokeHandler: stage.endsWith("_handler")
			? async () => {
				boundaryCalled = true;
				throw new Error("registered_handler_failure");
			}
			: DEFAULT_SUITE_RUNTIME.invokeHandler,
	};
	const hooks: SuiteFailureHooks = {
		closeFailure: stage.endsWith("_close"),
		onCloseInvoked: () => {
			boundaryCalled = true;
		},
		onRootCreated: (root) => {
			suiteRoot = root;
		},
		runtime,
	};
	try {
		if (stage.startsWith("semantic_")) {
			await executeSemanticRecallWorker(hooks);
		} else {
			await executeRecallQualityMatrixWorker({}, hooks);
		}
	} catch {
		failureObserved = true;
	}
	return {
		failureObserved,
		boundaryCalled,
		suiteRootRemoved: suiteRoot !== undefined && !existsSync(suiteRoot),
	};
}

export async function runRecallCleanupFailureProbe(
	stage: RecallCleanupFailureStage,
): Promise<RecallCleanupFailureProbeResult> {
	const beforeEnvironment = environmentSnapshot();
	let workerRoot: string | undefined;
	const moduleUrl = JSON.stringify(import.meta.url);
	if (stage === "worker_spawn") {
		let failureObserved = false;
		let spawnBoundaryCalled = false;
		try {
			await spawnClosedWorker(
				"process.stdout.write('{}');",
				(root) => {
					workerRoot = root;
				},
				((..._args: Parameters<typeof Bun.spawn>) => {
					spawnBoundaryCalled = true;
					throw new Error("worker_spawn_failure");
				}) as unknown as typeof Bun.spawn,
			);
		} catch {
			failureObserved = true;
		}
		const workerRootRemoved = workerRoot !== undefined && !existsSync(workerRoot);
		const parentEnvironmentRestored = environmentSnapshot() === beforeEnvironment;
		if (!failureObserved || !spawnBoundaryCalled || !workerRootRemoved || !parentEnvironmentRestored) {
			throw new Error("recall_quality_cleanup_probe_failed");
		}
		return {
			failureObserved: true,
			failureBoundary: stage,
			suiteRootRemoved: true,
			workerRootRemoved: true,
			parentEnvironmentRestored: true,
		};
	}
	const childResult = await spawnClosedWorker<Readonly<{
		failureObserved: boolean;
		boundaryCalled: boolean;
		suiteRootRemoved: boolean;
	}>>(
		`import { runRecallFailureProbeWorker } from ${moduleUrl};` +
			`const result = await runRecallFailureProbeWorker(${JSON.stringify(stage)});` +
			"process.stdout.write(JSON.stringify(result));",
		(root) => {
			workerRoot = root;
		},
	);
	const workerRootRemoved = workerRoot !== undefined && !existsSync(workerRoot);
	const parentEnvironmentRestored = environmentSnapshot() === beforeEnvironment;
	if (
		!childResult.failureObserved ||
		!childResult.boundaryCalled ||
		!childResult.suiteRootRemoved ||
		!workerRootRemoved ||
		!parentEnvironmentRestored
	) {
		throw new Error("recall_quality_cleanup_probe_failed");
	}
	return {
		failureObserved: true,
		failureBoundary: stage,
		suiteRootRemoved: true,
		workerRootRemoved: true,
		parentEnvironmentRestored: true,
	};
}

export async function probeNetworkPoisonAdapterWorker(): Promise<Readonly<{
	calls: number;
	rejected: boolean;
	restored: boolean;
}>> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
	const poison = installNetworkPoison();
	let rejected = false;
	try {
		await globalThis.fetch("https://recall-quality.invalid/");
	} catch {
		rejected = true;
	} finally {
		poison.restore();
	}
	return {
		calls: poison.calls(),
		rejected,
		restored: globalThis.fetch === poison.originalFetch,
	};
}

export async function probeNetworkPoisonAdapter(): Promise<Readonly<{
	calls: number;
	rejected: boolean;
	restored: boolean;
}>> {
	const moduleUrl = JSON.stringify(import.meta.url);
	return spawnClosedWorker(
		`import { probeNetworkPoisonAdapterWorker } from ${moduleUrl};` +
			"const result = await probeNetworkPoisonAdapterWorker();" +
			"process.stdout.write(JSON.stringify(result));",
	);
}

export async function runSemanticRecallIntegration(): Promise<SemanticRecallIntegrationResult> {
	const moduleUrl = JSON.stringify(import.meta.url);
	return spawnClosedWorker<SemanticRecallIntegrationResult>(
		`import { runSemanticRecallWorker } from ${moduleUrl};` +
			"const result = await runSemanticRecallWorker();" +
			"process.stdout.write(JSON.stringify(result));",
	);
}

/** Internal fixed worker. It has no fixture, path, fault, or baseline selector. */
export async function runSemanticRecallWorker(): Promise<SemanticRecallIntegrationResult> {
	return executeSemanticRecallWorker();
}

export async function runRecallQualityMatrix(
	options: RecallQualityMatrixOptions = {},
): Promise<RecallQualityPublicReport> {
	validateCanonicalFixtures();
	const moduleUrl = JSON.stringify(import.meta.url);
	const serializedOptions = JSON.stringify(options);
	return spawnClosedWorker<RecallQualityPublicReport>(
		`import { runRecallQualityMatrixWorker } from ${moduleUrl};` +
			`const report = await runRecallQualityMatrixWorker(${serializedOptions});` +
			"process.stdout.write(JSON.stringify(report));",
	);
}

function validateCanonicalFixtures(): void {
	const corpus = parseRecallQualityCorpus(readFileSync(CORPUS_PATH, "utf8"));
	const cases = parseRecallQualityCases(readFileSync(CASES_PATH, "utf8"), corpus);
	parseRecallQualityBaseline(readFileSync(BASELINE_PATH, "utf8"), cases, corpus);
	const routeCases = cases.filter(
		(testCase): testCase is RecallRouteContractCase => testCase.kind === "route_contract",
	);
	resolveOperationalRouteObservations(
		readFileSync(AGENT_FACING_PATH, "utf8"),
		routeCases,
	);
}

/** Internal fixed worker used by the closed parent process only. */
export async function runRecallQualityMatrixWorker(
	options: RecallQualityMatrixOptions = {},
): Promise<RecallQualityPublicReport> {
	const started = performance.now();
	const corpus = parseRecallQualityCorpus(readFileSync(CORPUS_PATH, "utf8"));
	const cases = parseRecallQualityCases(readFileSync(CASES_PATH, "utf8"), corpus);
	const baseline = parseRecallQualityBaseline(
		readFileSync(BASELINE_PATH, "utf8"),
		cases,
		corpus,
	);
	const routeCases = cases.filter(
		(testCase): testCase is RecallRouteContractCase => testCase.kind === "route_contract",
	);
	const operational = executeOperationalContractCases({
		agentFacingRoutingText: readFileSync(AGENT_FACING_PATH, "utf8"),
		cases: routeCases,
		createSemanticHandler: () => {
			throw new Error("semantic_handler_forbidden");
		},
	});
	const semantic = await executeSemanticRecallWorker();
	const observations = new Map<RecallQualityCaseId, RecallQualityObservation>([
		...operational.map((item) => [item.caseId, item] as const),
		...semantic.observations.map((item) => [item.caseId, item] as const),
	]);
	const evaluated = cases.map((testCase) => {
		const observation = observations.get(testCase.caseId);
		if (!observation) throw new Error("recall_quality_observation_missing");
		return evaluateRecallCase(testCase, observation);
	});
	const legacy = await executeRecallQualityMatrixWorker(options);
	const legacyCases: LegacyRecallCaseSummary[] = legacy.cases.map((item) => ({
		id: item.id,
		lane: item.lane,
		passed: item.passed,
	}));

	const reportInput = {
		evaluatedCases: evaluated,
		baseline,
		legacyCases,
		mode: options.strict ? "strict" as const : "default" as const,
		deterministic: true,
		boundedRuntime: legacy.boundedRuntime,
		advisoryDurationMs: performance.now() - started,
	};
	const candidateReport = buildRecallQualityReport({
		...reportInput,
		privacyPass: true,
	});
	const privacyObservations: unknown[] = [
		...operational,
		...semantic.observations,
	];
	if (options.fault === "privacy" && privacyObservations[0]) {
		privacyObservations[0] = {
			...(privacyObservations[0] as Record<string, unknown>),
			privacy_probe: "recall-quality-private-sentinel-336",
		};
	}
	const privacyPass = checkRecallQualityPrivacy({
		observations: privacyObservations,
		legacyCases,
	}, candidateReport);
	return privacyPass
		? candidateReport
		: buildRecallQualityReport({ ...reportInput, privacyPass: false });
}

export type RecallQualityCliErrorCode =
	| "INVALID_USAGE"
	| "FIXTURE_MISSING"
	| "FIXTURE_INVALID"
	| "EXECUTION_FAILED";

export interface RecallQualityCliResult {
	readonly exitCode: 0 | 1 | 2;
	readonly output: RecallQualityPublicReport | Readonly<{
		gate: "recall-quality-matrix";
		schema_version: 2;
		status: "error";
		code: RecallQualityCliErrorCode;
	}>;
}

export interface RecallQualityCliDependencies {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly run?: (options: RecallQualityMatrixOptions) => Promise<RecallQualityPublicReport>;
}

function cliError(code: RecallQualityCliErrorCode): RecallQualityCliResult {
	return {
		exitCode: 2,
		output: {
			gate: "recall-quality-matrix",
			schema_version: 2,
			status: "error",
			code,
		},
	};
}

export async function runRecallQualityCli(
	args: readonly string[],
	dependencies: RecallQualityCliDependencies = {},
): Promise<RecallQualityCliResult> {
	const environment = dependencies.environment ?? process.env;
	if (
		args.length > 1 ||
		(args.length === 1 && args[0] !== "--strict") ||
		Object.entries(environment).some(([key, value]) =>
			value !== undefined &&
			(key.startsWith("RECALL_QUALITY_") || key.startsWith("RECALL_MATRIX_"))
		)
	) {
		return cliError("INVALID_USAGE");
	}
	try {
		const report = await (dependencies.run ?? runRecallQualityMatrix)({
			strict: args[0] === "--strict",
		});
		return { exitCode: report.verdict === "go" ? 0 : 1, output: report };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (code === "ENOENT") return cliError("FIXTURE_MISSING");
		if (error instanceof RecallQualityFixtureError || typeof code === "string" && (
			code.startsWith("invalid_") || code === "malformed_json"
		)) {
			return cliError("FIXTURE_INVALID");
		}
		return cliError("EXECUTION_FAILED");
	}
}

if (import.meta.main) {
	const result = await runRecallQualityCli(process.argv.slice(2));
	console.log(JSON.stringify(result.output, null, 2));
	process.exitCode = result.exitCode;
}
