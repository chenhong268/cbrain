#!/usr/bin/env bun

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	compareRecallBaseline,
	evaluateRecallCase,
	parseRecallQualityBaseline,
	parseRecallQualityCases,
	parseRecallQualityCorpus,
	RecallQualityFixtureError,
	resolveOperationalRouteObservations,
	sealRecallQualityReport,
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
const WORKER_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CANONICAL_GATE_READ_PATHS = new Set([
	CORPUS_PATH,
	CASES_PATH,
	BASELINE_PATH,
	AGENT_FACING_PATH,
].map((path) => resolve(path)));
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
	readonly runtimeCounters: Readonly<{
		handlerInvocations: number;
		hybridSearchCalls: number;
		embeddingCalls: number;
		ftsCalls: number;
		lanceCalls: number;
		llmCalls: number;
		advancedFallbackCalls: number;
		supportOnlyDbCalls: number;
		dbPageReads: number;
		pageHydrationCalls: number;
		emittedCandidateCount: number;
		rejectedPageHydrationCalls: number;
		missingDbPageReads: number;
		missingPageHydrationCalls: number;
	}>;
	readonly invocations: readonly Readonly<{
		caseId: RecallSemanticCase["caseId"];
		detail: "normal";
		includeRaw: true;
	}>[];
	readonly observations: readonly RecallSemanticObservation[];
	readonly vector: Readonly<{
		lanceSearchCalls: number;
		weakDistanceCandidateObserved: boolean;
		weakQueryAndCandidateNonZeroObserved: boolean;
		weakFiniteCosineBelowThresholdObserved: boolean;
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
	| "semantic_file_access"
	| "legacy_db"
	| "legacy_context"
	| "legacy_handler"
	| "legacy_close"
	| "legacy_file_access"
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
	readonly fileAccess?: RecallGateFileAccess;
}

export interface RecallGateFileAccess {
	allowTemporaryRoot(root: string): void;
	readText(path: string): string;
	exists(path: string): boolean;
}

export interface RecallGateFileAccessOptions {
	readonly forbiddenPaths?: readonly string[];
	readonly onForbiddenAttempt?: () => void;
}

/** The only runner boundary allowed to read canonical inputs or temporary roots. */
export function createRecallGateFileAccess(
	options: RecallGateFileAccessOptions = {},
): RecallGateFileAccess {
	const temporaryRoots: Array<Readonly<{ lexical: string; real: string }>> = [];
	const forbiddenPaths = (options.forbiddenPaths ?? []).flatMap((path) => {
		const lexical = resolve(path);
		try {
			return [lexical, realpathSync(lexical)];
		} catch {
			return [lexical];
		}
	});
	const deny = (): never => {
		options.onForbiddenAttempt?.();
		throw new Error("recall_gate_file_access_denied");
	};
	const isWithin = (root: string, path: string): boolean => {
		const child = relative(root, path);
		return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
	};
	const isForbidden = (path: string): boolean =>
		forbiddenPaths.some((item) => path === item || isWithin(item, path));
	const lexicalScope = (path: string): Readonly<{
		normalized: string;
		canonical: boolean;
		temporaryRoot?: Readonly<{ lexical: string; real: string }>;
	}> => {
		const normalized = resolve(path);
		if (isForbidden(normalized)) deny();
		if (CANONICAL_GATE_READ_PATHS.has(normalized)) {
			return { normalized, canonical: true };
		}
		const temporaryRoot = temporaryRoots.find((root) =>
			isWithin(root.lexical, normalized)
		);
		if (!temporaryRoot) deny();
		return { normalized, canonical: false, temporaryRoot };
	};
	const validateNearestExisting = (
		scope: ReturnType<typeof lexicalScope>,
	): void => {
		let candidate = scope.normalized;
		while (true) {
			let real: string;
			try {
				lstatSync(candidate);
				real = realpathSync(candidate);
			} catch (error) {
				if ((error as { code?: unknown }).code !== "ENOENT") deny();
				const parent = dirname(candidate);
				if (parent === candidate) deny();
				candidate = parent;
				continue;
			}
			if (isForbidden(real)) deny();
			if (scope.canonical) {
				const expected = join(realpathSync(PROJECT_DIR), relative(PROJECT_DIR, candidate));
				if (real !== expected) deny();
			} else {
				const root = scope.temporaryRoot ?? deny();
				const expected = join(root.real, relative(root.lexical, candidate));
				if (
					real !== expected ||
					(isWithin(root.lexical, candidate) && !isWithin(root.real, real))
				) deny();
			}
			return;
		}
	};
	return {
		allowTemporaryRoot(root) {
			const normalized = resolve(root);
			const temporaryBase = resolve(tmpdir());
			const { stats, real, realTemporaryBase } = (() => {
				try {
					return {
						stats: lstatSync(normalized),
						real: realpathSync(normalized),
						realTemporaryBase: realpathSync(temporaryBase),
					};
				} catch {
					return deny();
				}
			})();
			if (
				!normalized.startsWith(`${temporaryBase}${sep}`) ||
				!/^cbrain-recall-(semantic|matrix|worker)-/.test(basename(normalized)) ||
				stats.isSymbolicLink() || !stats.isDirectory() ||
				!isWithin(realTemporaryBase, real)
			) {
				deny();
			}
			temporaryRoots.push({ lexical: normalized, real });
		},
		readText(path) {
			const scope = lexicalScope(path);
			validateNearestExisting(scope);
			return readFileSync(scope.normalized, "utf8");
		},
		exists(path) {
			const scope = lexicalScope(path);
			validateNearestExisting(scope);
			return existsSync(scope.normalized);
		},
	};
}

function observeTemporaryRoot(path: string): () => boolean {
	const fileAccess = createRecallGateFileAccess();
	fileAccess.allowTemporaryRoot(path);
	return () => fileAccess.exists(path);
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
		entities?: readonly unknown[];
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
	const rawEntities = envelope.raw?.entities;
	if (rawEntities !== undefined && !Array.isArray(rawEntities)) {
		throw new Error("recall_quality_candidate_invalid");
	}
	let top3: RecallSemanticObservation["top3"];
	try {
		top3 = (rawEntities ?? []).slice(0, 3).map((entity) => {
			if (entity === null || typeof entity !== "object" || Array.isArray(entity)) {
				throw new Error("candidate_shape");
			}
			const prototype = Object.getPrototypeOf(entity);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new Error("candidate_shape");
			}
			const title = Object.getOwnPropertyDescriptor(entity, "title");
			const snippet = Object.getOwnPropertyDescriptor(entity, "snippet");
			if (!title || !("value" in title) || typeof title.value !== "string" ||
				!snippet || !("value" in snippet) || typeof snippet.value !== "string"
			) {
				throw new Error("candidate_shape");
			}
			const source = titleToSource.get(title.value);
			if (!source) throw new Error("candidate_identity");
			const evidenceTokens = new Set(snippet.value.split(/\s+/u).filter(Boolean));
			return {
				sourceId: source.sourceId,
				matchedPointIds: source.answerPoints
					.filter((point) => point.text.split(" ").every((token) => evidenceTokens.has(token)))
					.map((point) => point.pointId)
					.sort(),
			};
		});
	} catch {
		throw new Error("recall_quality_candidate_invalid");
	}
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
	readonly distanceOneResultCalls: number;
	readonly nonZeroDistanceOneResultCalls: number;
	readonly finiteWeakCosineResultCalls: number;
	seed(document: GateVectorDocument): void;
}

interface CountingFixtureEmbedding extends EmbeddingProvider {
	readonly embedCalls: number;
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
	if (text === "上次 近似 噪声 未知 线索" || text === "抽象 近似 噪声 未知 线索") {
		return [0.5, 0.5, 0.5, 0.5];
	}
	return [0, 0, 0, 0];
}

function createFixtureEmbedding(): CountingFixtureEmbedding {
	let embedCalls = 0;
	const embedOne = (text: string) => ({
		embedding: fixtureConceptVector(text),
		tokenCount: text.length,
	});
	return {
		get embedCalls() {
			return embedCalls;
		},
		dimensions: CONCEPT_DIMENSIONS,
		embed: async (text) => {
			embedCalls += 1;
			return embedOne(text);
		},
		embedBatch: async (texts) => {
			embedCalls += 1;
			return texts.map(embedOne);
		},
	};
}

function squaredL2(left: readonly number[], right: readonly number[]): number {
	if (left.length !== right.length) throw new Error("gate_vector_dimension_mismatch");
	let distance = 0;
	for (let index = 0; index < left.length; index += 1) {
		distance += ((left[index] ?? 0) - (right[index] ?? 0)) ** 2;
	}
	return distance;
}

function createGateVectorIndex(): GateVectorIndex {
	const documents: GateVectorDocument[] = [];
	let searchCalls = 0;
	let distanceOneResultCalls = 0;
	let nonZeroDistanceOneResultCalls = 0;
	let finiteWeakCosineResultCalls = 0;
	const index = {
		get searchCalls() {
			return searchCalls;
		},
		get distanceOneResultCalls() {
			return distanceOneResultCalls;
		},
		get nonZeroDistanceOneResultCalls() {
			return nonZeroDistanceOneResultCalls;
		},
		get finiteWeakCosineResultCalls() {
			return finiteWeakCosineResultCalls;
		},
		seed(document: GateVectorDocument) {
			documents.push(document);
		},
		connect: async () => {},
		addChunks: async () => {},
		search: async (
			embedding: readonly number[],
			limit: number,
			options?: Readonly<{ includeVector?: boolean }>,
		) => {
			searchCalls += 1;
			const selected = documents
				.map((document) => ({ document, distance: squaredL2(embedding, document.embedding) }))
				.sort((left, right) =>
					left.distance - right.distance ||
					left.document.pageSlug.localeCompare(right.document.pageSlug) ||
					left.document.chunkIndex - right.document.chunkIndex
				)
				.slice(0, limit);
			if (selected.some((item) => item.distance === 1)) distanceOneResultCalls += 1;
			const queryNormSquared = embedding.reduce((sum, value) => sum + value ** 2, 0);
			const finiteWeakCosine = selected.some((item) => {
				if (item.distance !== 1 || queryNormSquared === 0) return false;
				const candidateNormSquared = item.document.embedding.reduce(
					(sum, value) => sum + value ** 2,
					0,
				);
				if (candidateNormSquared === 0) return false;
				const dot = embedding.reduce(
					(sum, value, index) => sum + value * (item.document.embedding[index] ?? 0),
					0,
				);
				const cosine = dot / Math.sqrt(queryNormSquared * candidateNormSquared);
				return Number.isFinite(cosine) && cosine < 0.8;
			});
			if (selected.some((item) =>
				item.distance === 1
				&& queryNormSquared > 0
				&& item.document.embedding.some((value) => value !== 0)
			)) nonZeroDistanceOneResultCalls += 1;
			if (finiteWeakCosine) finiteWeakCosineResultCalls += 1;
			return selected
				.map(({ document, distance }) => ({
					pageSlug: document.pageSlug,
					chunkIndex: document.chunkIndex,
					content: document.content,
					_distance: distance,
					...(options?.includeVector
						? { vector: Float32Array.from(document.embedding) }
						: {}),
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

function loadCanonicalSemanticFixtures(fileAccess: RecallGateFileAccess): {
	readonly corpus: RecallCorpus;
	readonly cases: readonly RecallSemanticCase[];
} {
	const corpus = parseRecallQualityCorpus(fileAccess.readText(CORPUS_PATH));
	const cases = parseRecallQualityCases(
		fileAccess.readText(CASES_PATH),
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
	let fileAccess: RecallGateFileAccess | undefined;
	let db: CBrainDB | undefined;
	let result: Omit<SemanticRecallIntegrationResult, "worker"> | undefined;
	let originalJobStart: typeof JobQueue.prototype.start | undefined;
	let networkPoison: NetworkPoison | undefined;
	let jobStartCalls = 0;
	let handlerInvocations = 0;
	let hybridSearchCalls = 0;
	let ftsCalls = 0;
	let advancedFallbackCalls = 0;
	let pageHydrationCalls = 0;
	let emittedCandidateCount = 0;
	let supportOnlyDbCalls = 0;
	let dbPageReads = 0;
	let rejectedPageHydrationCalls = 0;
	let missingDbPageReads = 0;
	let missingPageHydrationCalls = 0;
	try {
		hooks.onRootCreated?.(root);
		fileAccess = hooks.fileAccess ?? createRecallGateFileAccess();
		fileAccess.allowTemporaryRoot(root);
		const runtime = hooks.runtime ?? DEFAULT_SUITE_RUNTIME;
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
		const fixtures = loadCanonicalSemanticFixtures(fileAccess);
		db = runtime.openDb(join(root, "brain.sqlite"));
		const originalFtsSearch = db.ftsSearch.bind(db);
		db.ftsSearch = ((...args: Parameters<CBrainDB["ftsSearch"]>) => {
			ftsCalls += 1;
			return originalFtsSearch(...args);
		}) as CBrainDB["ftsSearch"];
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
		const originalGetPage = db.getPage.bind(db);
		db.getPage = ((...args: Parameters<CBrainDB["getPage"]>) => {
			dbPageReads += 1;
			return originalGetPage(...args);
		}) as CBrainDB["getPage"];

		const ctx = runtime.createContext({
			db,
			embedding,
			lance,
			vaultPath,
			dbPath: join(root, "brain.sqlite"),
			profileDir,
			runtimePath,
		});
		const originalSearch = ctx.search.search.bind(ctx.search);
		ctx.search.search = (async (...args: Parameters<typeof originalSearch>) => {
			hybridSearchCalls += 1;
			if (args[1]?.multiStep === true) advancedFallbackCalls += 1;
			return originalSearch(...args);
		}) as typeof ctx.search.search;
		const originalGetBySlug = ctx.pages.getBySlug.bind(ctx.pages);
		ctx.pages.getBySlug = ((...args: Parameters<typeof originalGetBySlug>) => {
			pageHydrationCalls += 1;
			return originalGetBySlug(...args);
		}) as typeof ctx.pages.getBySlug;
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
			const dbPageReadsBefore = dbPageReads;
			const pageHydrationCallsBefore = pageHydrationCalls;
			const args = {
				query: testCase.query,
				detail: "normal" as const,
				include_raw: true as const,
			};
			invocations.push({ caseId: testCase.caseId, detail: args.detail, includeRaw: args.include_raw });
			handlerInvocations += 1;
			const response = await runtime.invokeHandler(tools.cbrain_recall.handler, args);
			const envelope = JSON.parse(response.content[0]?.text ?? "{}") as ProductionFrontdoorEnvelope;
			const emittedCandidates = Array.isArray(envelope.raw?.entities)
				? envelope.raw.entities.length
				: 0;
			emittedCandidateCount += emittedCandidates;
			const dbPageReadDelta = dbPageReads - dbPageReadsBefore;
			const pageHydrationDelta = pageHydrationCalls - pageHydrationCallsBefore;
			supportOnlyDbCalls += Math.max(0, dbPageReadDelta - emittedCandidates);
			missingDbPageReads += Math.max(0, emittedCandidates - dbPageReadDelta);
			rejectedPageHydrationCalls += Math.max(0, pageHydrationDelta - emittedCandidates);
			missingPageHydrationCalls += Math.max(0, emittedCandidates - pageHydrationDelta);
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
		const tieResults = await lance.search([0, 1, 0, 0], 3);
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
			runtimeCounters: {
				handlerInvocations,
				hybridSearchCalls,
				embeddingCalls: embedding.embedCalls,
				ftsCalls,
				lanceCalls: lance.searchCalls,
				llmCalls: 0,
				advancedFallbackCalls,
				// The controlled path hydrates each emitted candidate exactly once.
				// Any excess page read is therefore attributable only to admission.
				supportOnlyDbCalls,
				dbPageReads,
				pageHydrationCalls,
				emittedCandidateCount,
				rejectedPageHydrationCalls,
				missingDbPageReads,
				missingPageHydrationCalls,
			},
			invocations,
			observations,
			vector: {
				lanceSearchCalls: lance.searchCalls,
				weakDistanceCandidateObserved: lance.distanceOneResultCalls === 2,
				weakQueryAndCandidateNonZeroObserved:
					lance.nonZeroDistanceOneResultCalls === 2,
				weakFiniteCosineBelowThresholdObserved:
					lance.finiteWeakCosineResultCalls === 2,
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
			temporaryRootRemoved: fileAccess !== undefined && !fileAccess.exists(root),
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
		hooks.onRootCreated?.(root);
		const fileAccess = hooks.fileAccess ?? createRecallGateFileAccess();
		fileAccess.allowTemporaryRoot(root);
		const runtime = hooks.runtime ?? DEFAULT_SUITE_RUNTIME;
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
			readWorkerStreamCapped(child.stdout),
			readWorkerStreamCapped(child.stderr),
		]);
		if (stdout.exceeded || stderr.exceeded) {
			throw new RecallWorkerBootstrapError("WORKER_OUTPUT_LIMIT");
		}
		if (exitCode !== 0) {
			throw new RecallWorkerBootstrapError("WORKER_EXIT");
		}
		try {
			return JSON.parse(stdout.text) as T;
		} catch {
			throw new RecallWorkerBootstrapError("WORKER_INVALID_OUTPUT");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

type RecallWorkerBootstrapCode =
	| "WORKER_OUTPUT_LIMIT"
	| "WORKER_EXIT"
	| "WORKER_INVALID_OUTPUT";

class RecallWorkerBootstrapError extends Error {
	readonly code: RecallWorkerBootstrapCode;

	constructor(code: RecallWorkerBootstrapCode) {
		super("recall_quality_worker_bootstrap_failed");
		this.name = "RecallWorkerBootstrapError";
		this.code = code;
	}
}

interface CappedWorkerStream {
	readonly text: string;
	readonly exceeded: boolean;
}

async function readWorkerStreamCapped(
	stream: ReadableStream<Uint8Array>,
): Promise<CappedWorkerStream> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > WORKER_CAPTURE_LIMIT_BYTES) {
				await reader.cancel();
				return { text: "", exceeded: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes), exceeded: false };
}

function environmentSnapshot(): string {
	return JSON.stringify(Object.entries(process.env).sort(([left], [right]) =>
		left.localeCompare(right)
	));
}

export interface RecallQualityIsolationProbeResult {
	readonly closedEnvironment: true;
	readonly inheritedCbrainVariables: 0;
	readonly temporaryHome: true;
	readonly temporaryXdgConfig: true;
	readonly temporaryXdgData: true;
	readonly suiteOrder: readonly ["isolation_started", "semantic_suite", "legacy_suite"];
	readonly distinctSuiteRoots: true;
	readonly configuredPathOpenAttempts: 0;
	readonly suiteRootsRemoved: true;
}

/** Internal test probe: exercise both suites after the closed worker boundary. */
export async function runRecallQualityIsolationProbeWorker(): Promise<RecallQualityIsolationProbeResult> {
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
	const suiteOrder: Array<"isolation_started" | "semantic_suite" | "legacy_suite"> = [
		"isolation_started",
	];
	const suiteRoots: string[] = [];
	const suiteRootObservers: Array<() => boolean> = [];
	let currentRoot: string | undefined;
	let configuredPathOpenAttempts = 0;
	const runtime: SuiteRuntimeDependencies = {
		...DEFAULT_SUITE_RUNTIME,
		openDb: (path) => {
			if (!currentRoot || !resolve(path).startsWith(`${resolve(currentRoot)}${sep}`)) {
				configuredPathOpenAttempts += 1;
				throw new Error("recall_quality_non_temporary_path");
			}
			return DEFAULT_SUITE_RUNTIME.openDb(path);
		},
	};
	const hooks = (suite: "semantic_suite" | "legacy_suite"): SuiteFailureHooks => ({
		runtime,
		onRootCreated: (root) => {
			currentRoot = root;
			suiteRoots.push(root);
			suiteRootObservers.push(observeTemporaryRoot(root));
			suiteOrder.push(suite);
		},
	});

	await executeSemanticRecallWorker(hooks("semantic_suite"));
	currentRoot = undefined;
	await executeRecallQualityMatrixWorker({}, hooks("legacy_suite"));
	currentRoot = undefined;

	const home = process.env.HOME;
	const xdgConfig = process.env.XDG_CONFIG_HOME;
	const xdgData = process.env.XDG_DATA_HOME;
	const closedEnvironment =
		environmentKeys.length === allowedEnvironment.size &&
		environmentKeys.every((key) => allowedEnvironment.has(key));
	const inheritedCbrainVariables = environmentKeys.filter((key) =>
		key.startsWith("CBRAIN_")
	).length;
	const temporaryHome = typeof home === "string" && home.includes("cbrain-recall-worker-");
	const temporaryXdgConfig =
		typeof xdgConfig === "string" && xdgConfig.includes("cbrain-recall-worker-");
	const temporaryXdgData =
		typeof xdgData === "string" && xdgData.includes("cbrain-recall-worker-");
	const distinctSuiteRoots = suiteRoots.length === 2 && suiteRoots[0] !== suiteRoots[1];
	const suiteRootsRemoved = suiteRootObservers.every((exists) => !exists());
	if (
		!closedEnvironment || inheritedCbrainVariables !== 0 || !temporaryHome ||
		!temporaryXdgConfig || !temporaryXdgData || !distinctSuiteRoots ||
		configuredPathOpenAttempts !== 0 || !suiteRootsRemoved ||
		JSON.stringify(suiteOrder) !==
			JSON.stringify(["isolation_started", "semantic_suite", "legacy_suite"])
	) {
		throw new Error("recall_quality_isolation_probe_failed");
	}
	return {
		closedEnvironment: true,
		inheritedCbrainVariables: 0,
		temporaryHome: true,
		temporaryXdgConfig: true,
		temporaryXdgData: true,
		suiteOrder: ["isolation_started", "semantic_suite", "legacy_suite"],
		distinctSuiteRoots: true,
		configuredPathOpenAttempts: 0,
		suiteRootsRemoved: true,
	};
}

export async function probeRecallQualityIsolation(): Promise<RecallQualityIsolationProbeResult> {
	const moduleUrl = JSON.stringify(import.meta.url);
	return spawnClosedWorker(
		`import { runRecallQualityIsolationProbeWorker } from ${moduleUrl};` +
			"const result = await runRecallQualityIsolationProbeWorker();" +
			"process.stdout.write(JSON.stringify(result));",
	);
}

export interface RecallGateFileAccessProbeResult {
	readonly parentPreflightPassed: true;
	readonly workerSuitesPassed: true;
	readonly parentForbiddenAttempts: 0;
	readonly workerForbiddenAttempts: 0;
	readonly workerInheritedCbrainVariables: 0;
}

export async function runRecallGateFileAccessProbeWorker(
	forbiddenPaths: readonly string[],
): Promise<Readonly<{
	workerSuitesPassed: true;
	workerForbiddenAttempts: 0;
	workerInheritedCbrainVariables: 0;
}>> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
	let workerForbiddenAttempts = 0;
	const fileAccess = createRecallGateFileAccess({
		forbiddenPaths,
		onForbiddenAttempt: () => {
			workerForbiddenAttempts += 1;
		},
	});
	await runRecallQualityMatrixWorker({}, fileAccess);
	const inheritedCbrainVariables = Object.keys(process.env).filter((key) =>
		key.startsWith("CBRAIN_")
	).length;
	if (workerForbiddenAttempts !== 0 || inheritedCbrainVariables !== 0) {
		throw new Error("recall_gate_file_access_probe_failed");
	}
	return {
		workerSuitesPassed: true,
		workerForbiddenAttempts: 0,
		workerInheritedCbrainVariables: 0,
	};
}

export async function probeRecallGateFileAccess(
	forbiddenPaths: readonly string[],
): Promise<RecallGateFileAccessProbeResult> {
	let parentForbiddenAttempts = 0;
	const parentAccess = createRecallGateFileAccess({
		forbiddenPaths,
		onForbiddenAttempt: () => {
			parentForbiddenAttempts += 1;
		},
	});
	validateCanonicalFixtures(parentAccess);
	const moduleUrl = JSON.stringify(import.meta.url);
	const worker = await spawnClosedWorker<Readonly<{
		workerSuitesPassed: true;
		workerForbiddenAttempts: 0;
		workerInheritedCbrainVariables: 0;
	}>>(
		`import { runRecallGateFileAccessProbeWorker } from ${moduleUrl};` +
			`const result=await runRecallGateFileAccessProbeWorker(${JSON.stringify(forbiddenPaths)});` +
			"process.stdout.write(JSON.stringify(result));",
	);
	if (parentForbiddenAttempts !== 0 || worker.workerInheritedCbrainVariables !== 0) {
		throw new Error("recall_gate_file_access_probe_failed");
	}
	return {
		parentPreflightPassed: true,
		workerSuitesPassed: worker.workerSuitesPassed,
		parentForbiddenAttempts: 0,
		workerForbiddenAttempts: worker.workerForbiddenAttempts,
		workerInheritedCbrainVariables: 0,
	};
}

export type RecallWorkerTransportProbeScenario =
	| "stdout_overflow"
	| "stderr_overflow"
	| "nonzero_private_stderr"
	| "invalid_private_stdout";

export interface RecallWorkerTransportProbeResult {
	readonly code: RecallWorkerBootstrapCode;
	readonly workerRootRemoved: true;
}

/** Fixed finite transport probes; no fixture, path, fault, or baseline selector. */
export async function probeRecallWorkerTransport(
	scenario: RecallWorkerTransportProbeScenario,
): Promise<RecallWorkerTransportProbeResult> {
	const expressionByScenario: Readonly<Record<RecallWorkerTransportProbeScenario, string>> = {
		stdout_overflow:
			`process.stdout.write("PRIVATE_RECALL_SENTINEL".repeat(${WORKER_CAPTURE_LIMIT_BYTES}));`,
		stderr_overflow:
			`process.stderr.write("PRIVATE_RECALL_SENTINEL".repeat(${WORKER_CAPTURE_LIMIT_BYTES}));` +
			"process.stdout.write('{}');",
		nonzero_private_stderr:
			"process.stderr.write('PRIVATE_RECALL_SENTINEL');process.exitCode=7;",
		invalid_private_stdout:
			"process.stdout.write('PRIVATE_RECALL_SENTINEL');",
	};
	let workerRoot: string | undefined;
	let workerRootExists: (() => boolean) | undefined;
	try {
		await spawnClosedWorker(expressionByScenario[scenario], (root) => {
			workerRoot = root;
			workerRootExists = observeTemporaryRoot(root);
		});
		throw new Error("recall_quality_transport_probe_expected_failure");
	} catch (error) {
		if (!(error instanceof RecallWorkerBootstrapError)) throw error;
		if (!workerRoot || !workerRootExists || workerRootExists()) {
			throw new Error("recall_quality_transport_cleanup_failed");
		}
		return { code: error.code, workerRootRemoved: true };
	}
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
	let suiteRootExists: (() => boolean) | undefined;
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
	const fileAccess: RecallGateFileAccess | undefined = stage.endsWith("_file_access")
		? {
			allowTemporaryRoot: () => {
				boundaryCalled = true;
				throw new Error("file_access_registration_failure");
			},
			readText: () => {
				throw new Error("file_access_read_unreachable");
			},
			exists: () => {
				throw new Error("file_access_exists_unreachable");
			},
		}
		: undefined;
	const hooks: SuiteFailureHooks = {
		closeFailure: stage.endsWith("_close"),
		onCloseInvoked: () => {
			boundaryCalled = true;
		},
		onRootCreated: (root) => {
			suiteRoot = root;
			suiteRootExists = observeTemporaryRoot(root);
		},
		runtime,
		fileAccess,
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
		suiteRootRemoved:
			suiteRoot !== undefined && suiteRootExists !== undefined && !suiteRootExists(),
	};
}

export async function runRecallCleanupFailureProbe(
	stage: RecallCleanupFailureStage,
): Promise<RecallCleanupFailureProbeResult> {
	const beforeEnvironment = environmentSnapshot();
	let workerRoot: string | undefined;
	let workerRootExists: (() => boolean) | undefined;
	const moduleUrl = JSON.stringify(import.meta.url);
	if (stage === "worker_spawn") {
		let failureObserved = false;
		let spawnBoundaryCalled = false;
		try {
			await spawnClosedWorker(
				"process.stdout.write('{}');",
				(root) => {
					workerRoot = root;
					workerRootExists = observeTemporaryRoot(root);
				},
				((..._args: Parameters<typeof Bun.spawn>) => {
					spawnBoundaryCalled = true;
					throw new Error("worker_spawn_failure");
				}) as unknown as typeof Bun.spawn,
			);
		} catch {
			failureObserved = true;
		}
		const workerRootRemoved =
			workerRoot !== undefined && workerRootExists !== undefined && !workerRootExists();
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
			workerRootExists = observeTemporaryRoot(root);
		},
	);
	const workerRootRemoved =
		workerRoot !== undefined && workerRootExists !== undefined && !workerRootExists();
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

export interface RecallBaselineMatchProbeResult {
	readonly baselineEntries: number;
	readonly knownFailures: number;
	readonly regressions: number;
	readonly unexpectedPasses: number;
	readonly allLinkedTo337: boolean;
}

/** Compare exact synthetic signatures inside the worker; source/point IDs never cross IPC. */
export async function runRecallBaselineMatchProbeWorker(): Promise<RecallBaselineMatchProbeResult> {
	if (process.env[INTERNAL_WORKER_MARKER] !== "1") {
		throw new Error("recall_quality_worker_required");
	}
	const fileAccess = createRecallGateFileAccess();
	const corpus = parseRecallQualityCorpus(fileAccess.readText(CORPUS_PATH));
	const cases = parseRecallQualityCases(fileAccess.readText(CASES_PATH), corpus);
	const baseline = parseRecallQualityBaseline(
		fileAccess.readText(BASELINE_PATH),
		cases,
		corpus,
	);
	const semanticCases = cases.filter(
		(testCase): testCase is RecallSemanticCase => testCase.kind === "semantic_recall",
	);
	const semantic = await executeSemanticRecallWorker({ fileAccess });
	const observations = new Map(
		semantic.observations.map((observation) => [observation.caseId, observation]),
	);
	const evaluated = semanticCases.map((testCase) => {
		const observation = observations.get(testCase.caseId);
		if (!observation) throw new Error("recall_quality_observation_missing");
		return evaluateRecallCase(testCase, observation);
	});
	const comparison = compareRecallBaseline(evaluated, baseline);
	return {
		baselineEntries: baseline.length,
		knownFailures: comparison.counts.knownFailures,
		regressions: comparison.counts.regressions,
		unexpectedPasses: comparison.counts.unexpectedPasses,
		allLinkedTo337: baseline.every((entry) => entry.followUp === "#337"),
	};
}

export async function runRecallBaselineMatchProbe(): Promise<RecallBaselineMatchProbeResult> {
	const moduleUrl = JSON.stringify(import.meta.url);
	return spawnClosedWorker(
		`import { runRecallBaselineMatchProbeWorker } from ${moduleUrl};` +
			"const result = await runRecallBaselineMatchProbeWorker();" +
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
	const workerReport = await spawnClosedWorker<RecallQualityPublicReport>(
		`import { runRecallQualityMatrixWorker } from ${moduleUrl};` +
			`const report = await runRecallQualityMatrixWorker(${serializedOptions});` +
			"process.stdout.write(JSON.stringify(report));",
	);
	return sealRecallQualityReport(workerReport);
}

function validateCanonicalFixtures(
	fileAccess: RecallGateFileAccess = createRecallGateFileAccess(),
): void {
	const corpus = parseRecallQualityCorpus(fileAccess.readText(CORPUS_PATH));
	const cases = parseRecallQualityCases(fileAccess.readText(CASES_PATH), corpus);
	parseRecallQualityBaseline(fileAccess.readText(BASELINE_PATH), cases, corpus);
	const routeCases = cases.filter(
		(testCase): testCase is RecallRouteContractCase => testCase.kind === "route_contract",
	);
	resolveOperationalRouteObservations(
		fileAccess.readText(AGENT_FACING_PATH),
		routeCases,
	);
}

/** Internal fixed worker used by the closed parent process only. */
export async function runRecallQualityMatrixWorker(
	options: RecallQualityMatrixOptions = {},
	fileAccess: RecallGateFileAccess = createRecallGateFileAccess(),
): Promise<RecallQualityPublicReport> {
	const started = performance.now();
	const corpus = parseRecallQualityCorpus(fileAccess.readText(CORPUS_PATH));
	const cases = parseRecallQualityCases(fileAccess.readText(CASES_PATH), corpus);
	const baseline = parseRecallQualityBaseline(
		fileAccess.readText(BASELINE_PATH),
		cases,
		corpus,
	);
	const routeCases = cases.filter(
		(testCase): testCase is RecallRouteContractCase => testCase.kind === "route_contract",
	);
	const operational = executeOperationalContractCases({
		agentFacingRoutingText: fileAccess.readText(AGENT_FACING_PATH),
		cases: routeCases,
		createSemanticHandler: () => {
			throw new Error("semantic_handler_forbidden");
		},
	});
	const semantic = await executeSemanticRecallWorker({ fileAccess });
	const observations = new Map<RecallQualityCaseId, RecallQualityObservation>([
		...operational.map((item) => [item.caseId, item] as const),
		...semantic.observations.map((item) => [item.caseId, item] as const),
	]);
	const evaluated = cases.map((testCase) => {
		const observation = observations.get(testCase.caseId);
		if (!observation) throw new Error("recall_quality_observation_missing");
		return evaluateRecallCase(testCase, observation);
	});
	const legacy = await executeRecallQualityMatrixWorker(options, { fileAccess });
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
		const report = sealRecallQualityReport(
			await (dependencies.run ?? runRecallQualityMatrix)({
				strict: args[0] === "--strict",
			}),
		);
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

/** The single JSON transport used by both the executable and subprocess tests. */
export function emitRecallQualityCliResult(
	result: RecallQualityCliResult,
	write: (text: string) => void = (text) => {
		process.stdout.write(text);
	},
): void {
	write(`${JSON.stringify(result.output, null, 2)}\n`);
}

if (import.meta.main) {
	const result = await runRecallQualityCli(process.argv.slice(2));
	emitRecallQualityCliResult(result);
	process.exitCode = result.exitCode;
}
