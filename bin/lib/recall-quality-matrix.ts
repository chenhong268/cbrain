import { createHash } from "node:crypto";

export const SAFE_FIXTURE_TOKENS: ReadonlySet<string> = new Set([
	"系统",
	"恢复",
	"边界",
	"明确",
	"责任",
	"速度",
	"体验",
	"观察",
	"记录",
	"抽象",
	"治理",
	"稳定",
	"原因",
	"约束",
	"近似",
	"噪声",
	"背景",
	"主题",
	"说明",
	"已",
	"未知",
	"线索",
	"为什么",
	"需要",
	"上次",
	"，",
	"。",
	"？",
	"！",
	"：",
	"；",
	"、",
]);

export type RecallCorpusSourceId = `source_${string}`;
export type RecallAnswerPointId = `point_${string}`;
export type RecallQualityCaseId =
	| `operational_${"positive" | "negative"}_${string}`
	| `content_${"positive" | "negative"}_${string}`
	| `abstract_${"positive" | "negative"}_${string}`;

export interface RecallAnswerPoint {
	readonly pointId: RecallAnswerPointId;
	readonly text: string;
}

export interface RecallTimelineEntry {
	readonly date: string;
	readonly text: string;
}

export interface RecallCorpusSource {
	readonly sourceId: RecallCorpusSourceId;
	readonly title: string;
	readonly type: "record" | "insight";
	readonly body: string;
	readonly answerPoints: readonly RecallAnswerPoint[];
	readonly timeline: readonly RecallTimelineEntry[];
}

export type RecallCorpus = readonly RecallCorpusSource[];

interface RecallQualityCaseBase {
	readonly caseId: RecallQualityCaseId;
	readonly category: "operational_meta" | "content_meta" | "abstract_concept";
}

export interface NextActionsRouteContractCase extends RecallQualityCaseBase {
	readonly category: "operational_meta";
	readonly kind: "route_contract";
	readonly canonicalInputSha256: string;
	readonly expectedTool: "next_actions";
	readonly expectedArgs: Readonly<{ includeRaw: false }>;
	readonly forbiddenTools: readonly (
		| "query"
		| "cbrain_recall"
		| "deep_recall"
	)[];
}

export interface ContentRecallRouteContractCase extends RecallQualityCaseBase {
	readonly category: "operational_meta";
	readonly kind: "route_contract";
	readonly canonicalInputSha256: string;
	readonly expectedTool: "cbrain_recall";
	readonly expectedArgs: Readonly<{ detail: "normal" }>;
	readonly forbiddenTools: readonly (
		| "next_actions"
		| "query"
		| "deep_recall"
	)[];
}

export type RecallRouteContractCase =
	| NextActionsRouteContractCase
	| ContentRecallRouteContractCase;

export interface RecallRequiredAnswerPoints {
	readonly sourceId: RecallCorpusSourceId;
	readonly pointIds: readonly RecallAnswerPointId[];
	readonly match: "all" | "any";
}

export interface RecallSemanticCase extends RecallQualityCaseBase {
	readonly category: "content_meta" | "abstract_concept";
	readonly kind: "semantic_recall";
	readonly query: string;
	readonly expectedTool: "cbrain_recall";
	readonly expectedFrontdoorRoute: "content_recall";
	readonly oracle: "answerable" | "unanswerable";
	readonly expectedSources: readonly RecallCorpusSourceId[];
	readonly allowedSources: readonly RecallCorpusSourceId[];
	readonly requiredAnswerPoints: readonly RecallRequiredAnswerPoints[];
	readonly mustNotSources: readonly RecallCorpusSourceId[];
	readonly allowedStatuses: readonly ("ok" | "empty")[];
}

export type RecallQualityCase = RecallRouteContractCase | RecallSemanticCase;

export type BaselineFailureCode =
	| "recall_miss"
	| "unexpected_recall"
	| "wrong_source"
	| "irrelevant_but_ok"
	| "insufficient_false_positive"
	| "status_mismatch"
	| "degraded_response";

export interface RecallQualityBaselineTop3 {
	readonly sourceId: RecallCorpusSourceId;
	readonly matchedPointIds: readonly RecallAnswerPointId[];
}

export interface RecallQualityBaselineEntry {
	readonly caseId: RecallQualityCaseId;
	readonly failureCodes: readonly BaselineFailureCode[];
	readonly answerStatus: "ok" | "empty" | "degraded";
	readonly degradationKind: "none" | "evidence";
	readonly evidenceSufficiency:
		| "sufficient"
		| "insufficient"
		| "not_applicable";
	readonly top3: readonly RecallQualityBaselineTop3[];
	readonly followUp: "#337";
}

export type RecallQualityBaseline = readonly RecallQualityBaselineEntry[];

export type RecallQualityFailureCode =
	| "route_mismatch"
	| BaselineFailureCode
	| "unclassified_degraded"
	| "legacy_regression"
	| "privacy_failure"
	| "nondeterministic"
	| "execution_failure";

export interface RecallRouteContractObservation {
	readonly kind: "route_contract";
	readonly caseId: RecallQualityCaseId;
	readonly actualTool: string;
}

export interface RecallSemanticObservation {
	readonly kind: "semantic_recall";
	readonly caseId: RecallQualityCaseId;
	readonly actualTool: string;
	readonly actualFrontdoorRoute: string;
	readonly answerStatus: "ok" | "empty" | "degraded";
	readonly degradationKind: "none" | "evidence" | "unclassified";
	readonly evidenceSufficiency:
		| "sufficient"
		| "insufficient"
		| "not_applicable";
	readonly top3: readonly RecallQualityBaselineTop3[];
}

export type RecallQualityObservation =
	| RecallRouteContractObservation
	| RecallSemanticObservation;

export type RecallQualityEvaluationErrorCode =
	| "case_id_mismatch"
	| "observation_kind_mismatch"
	| "report_input_mismatch"
	| "case_set_mismatch"
	| "legacy_lane_mismatch"
	| "invalid_duration"
	| "report_serialization_invalid";

export class RecallQualityEvaluationError extends Error {
	readonly code: RecallQualityEvaluationErrorCode;

	constructor(code: RecallQualityEvaluationErrorCode) {
		super(`recall_quality_evaluation:${code}`);
		this.name = "RecallQualityEvaluationError";
		this.code = code;
	}
}

interface EvaluatedRecallCaseBase {
	readonly caseId: RecallQualityCaseId;
	readonly category:
		| "operational_meta"
		| "content_meta"
		| "abstract_concept";
	readonly failureCodes: readonly RecallQualityFailureCode[];
	readonly routeMatches: boolean;
}

export interface EvaluatedRecallRouteCase extends EvaluatedRecallCaseBase {
	readonly kind: "route_contract";
	readonly testCase: RecallRouteContractCase;
	readonly observation: RecallRouteContractObservation;
}

export interface EvaluatedRecallSemanticCase extends EvaluatedRecallCaseBase {
	readonly kind: "semantic_recall";
	readonly testCase: RecallSemanticCase;
	readonly observation: RecallSemanticObservation;
	readonly expectedCoverage: boolean;
	readonly expectedSourcesFound: number;
	readonly expectedSourcesTotal: number;
}

export type EvaluatedRecallCase =
	| EvaluatedRecallRouteCase
	| EvaluatedRecallSemanticCase;

export interface RecallQualityRateMetric {
	readonly numerator: number;
	readonly denominator: number;
	readonly rate: number;
}

export interface RecallQualityMetrics {
	readonly routeAccuracy: RecallQualityRateMetric;
	readonly routeAccuracyByCategory: Readonly<
		Record<EvaluatedRecallCase["category"], RecallQualityRateMetric>
	>;
	readonly recallAt3: RecallQualityRateMetric;
	readonly wrongSourceRate: RecallQualityRateMetric;
	readonly irrelevantButOkRate: RecallQualityRateMetric;
	readonly insufficientFalsePositiveRate: RecallQualityRateMetric;
}

export type BaselineDisposition =
	| "pass"
	| "known_failure"
	| "regression"
	| "unexpected_pass";

export interface BaselineCaseComparison {
	readonly caseId: RecallQualityCaseId;
	readonly failureCodes: readonly RecallQualityFailureCode[];
	readonly disposition: BaselineDisposition;
}

export interface BaselineComparison {
	readonly cases: readonly BaselineCaseComparison[];
	readonly qualityStatus: "pass" | "known_failure" | "regression";
	readonly strictVerdict: "go" | "no-go";
	readonly ciVerdict: "go" | "no-go";
	readonly counts: Readonly<{
		knownFailures: number;
		regressions: number;
		unexpectedPasses: number;
	}>;
}

export const LEGACY_RECALL_CASE_IDS = [
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

export const ISSUE_336_RECALL_CASE_IDS = [
	"operational_positive_01",
	"operational_negative_01",
	"content_positive_01",
	"content_negative_01",
	"abstract_positive_01",
	"abstract_negative_01",
] as const satisfies readonly RecallQualityCaseId[];

const ISSUE_336_BASELINE_CASE_IDS: ReadonlySet<RecallQualityCaseId> = new Set([
	"content_positive_01",
	"content_negative_01",
	"abstract_positive_01",
	"abstract_negative_01",
]);

export type LegacyRecallCaseId = (typeof LEGACY_RECALL_CASE_IDS)[number];
export type LegacyRecallLane = "retrieval" | "router" | "evidence" | "latency";

const LEGACY_RECALL_LANE_BY_ID: Readonly<Record<LegacyRecallCaseId, LegacyRecallLane>> = {
	zh_exact: "retrieval",
	en_exact: "retrieval",
	mixed_alias: "retrieval",
	abstract_topic: "retrieval",
	honest_empty: "retrieval",
	temporal_evidence: "evidence",
	relationship_route: "router",
	operational_contract: "router",
	bounded_runtime: "latency",
};

export interface LegacyRecallCaseSummary {
	readonly id: LegacyRecallCaseId;
	readonly lane: LegacyRecallLane;
	readonly passed: boolean;
}

export interface RecallQualityPublicRateMetric {
	readonly numerator: number;
	readonly denominator: number;
	readonly rate: number;
}

export interface RecallQualityPublicReport {
	readonly gate: "recall-quality-matrix";
	readonly schema_version: 2;
	readonly mode: "default" | "strict";
	readonly route_scope: "agent_contract_plus_frontdoor";
	readonly strict_verdict: "go" | "no-go";
	readonly ci_verdict: "go" | "no-go";
	readonly verdict: "go" | "no-go";
	readonly strict_failure: boolean;
	readonly quality_status: "pass" | "known_failure" | "regression";
	readonly metrics: Readonly<{
		route_accuracy: RecallQualityPublicRateMetric;
		route_accuracy_by_category: Readonly<{
			operational_meta: RecallQualityPublicRateMetric;
			content_meta: RecallQualityPublicRateMetric;
			abstract_concept: RecallQualityPublicRateMetric;
		}>;
		recall_at_3: RecallQualityPublicRateMetric;
		wrong_source_rate: RecallQualityPublicRateMetric;
		irrelevant_but_ok_rate: RecallQualityPublicRateMetric;
		insufficient_false_positive_rate: RecallQualityPublicRateMetric;
	}>;
	readonly category_counts: Readonly<{
		operational_meta: number;
		content_meta: number;
		abstract_concept: number;
	}>;
	readonly failure_counts: Readonly<Record<RecallQualityFailureCode, number>>;
	readonly counts: Readonly<{
		known_failures: number;
		regressions: number;
		unexpected_passes: number;
	}>;
	readonly cases: readonly Readonly<{
		case_id: RecallQualityCaseId;
		category: EvaluatedRecallCase["category"];
		kind: EvaluatedRecallCase["kind"];
		failure_codes: readonly RecallQualityFailureCode[];
		disposition: BaselineDisposition;
	}>[];
	readonly legacy_v1: Readonly<{
		status: "pass" | "fail";
		cases: readonly Readonly<{
			id: LegacyRecallCaseId;
			lane: LegacyRecallLane;
			status: "pass" | "fail";
		}>[];
	}>;
	readonly privacy: "pass" | "fail";
	readonly determinism: "pass" | "fail";
	readonly bounded_runtime: boolean;
	readonly reproducibility_fingerprint: string;
	readonly advisory_duration_ms: number;
}

export interface BuildRecallQualityReportInput {
	readonly evaluatedCases: readonly EvaluatedRecallCase[];
	readonly baseline: RecallQualityBaseline;
	readonly legacyCases: readonly LegacyRecallCaseSummary[];
	readonly mode: "default" | "strict";
	readonly privacyPass: boolean;
	readonly deterministic: boolean;
	readonly boundedRuntime: boolean;
	readonly advisoryDurationMs: number;
}

export type RecallQualityFixtureErrorCode =
	| "malformed_json"
	| "fixture_not_object"
	| "empty_fixture"
	| "unknown_fields"
	| "missing_fields"
	| "invalid_field_type"
	| "invalid_fixture_spacing"
	| "unsafe_fixture_text"
	| "unsafe_fixture_token"
	| "invalid_source_id"
	| "invalid_title"
	| "invalid_point_id"
	| "invalid_source_type"
	| "invalid_timeline_date"
	| "duplicate_source_id"
	| "duplicate_title"
	| "duplicate_point_id"
	| "invalid_case_id"
	| "invalid_case_category"
	| "invalid_case_kind"
	| "case_polarity_mismatch"
	| "invalid_route_contract"
	| "invalid_semantic_tool"
	| "invalid_semantic_route"
	| "duplicate_case_id"
	| "duplicate_reference"
	| "unknown_source_reference"
	| "unknown_point_reference"
	| "point_source_mismatch"
	| "source_partition_overlap"
	| "source_partition_incomplete"
	| "answerable_sources_required"
	| "answerable_allowed_sources_mismatch"
	| "answerable_point_rule_mismatch"
	| "unanswerable_sources_forbidden"
	| "invalid_answerable_statuses"
	| "invalid_unanswerable_statuses"
	| "baseline_not_array"
	| "invalid_baseline_failure_code"
	| "invalid_baseline_follow_up"
	| "invalid_baseline_signature"
	| "unknown_baseline_case"
	| "duplicate_baseline_case_id"
	| "canonical_hash_missing"
	| "canonical_hash_duplicate"
	| "canonical_contract_mismatch";

export class RecallQualityFixtureError extends Error {
	readonly code: RecallQualityFixtureErrorCode;

	constructor(code: RecallQualityFixtureErrorCode) {
		super(`recall_quality_fixture:${code}`);
		this.name = "RecallQualityFixtureError";
		this.code = code;
	}
}

const CORPUS_KEYS = [
	"source_id",
	"title",
	"type",
	"body",
	"answer_points",
	"timeline",
] as const;
const ANSWER_POINT_KEYS = ["point_id", "text"] as const;
const TIMELINE_KEYS = ["date", "text"] as const;
const ROUTE_CASE_KEYS = [
	"case_id",
	"category",
	"kind",
	"canonical_input_sha256",
	"expected_tool",
	"expected_args",
	"forbidden_tools",
] as const;
const SEMANTIC_CASE_KEYS = [
	"case_id",
	"category",
	"kind",
	"query",
	"expected_tool",
	"expected_frontdoor_route",
	"oracle",
	"expected_sources",
	"allowed_sources",
	"required_answer_points",
	"must_not_sources",
	"allowed_statuses",
] as const;
const REQUIRED_POINT_KEYS = ["source_id", "point_ids", "match"] as const;
const BASELINE_KEYS = [
	"case_id",
	"failure_codes",
	"answer_status",
	"degradation_kind",
	"evidence_sufficiency",
	"top3",
	"follow_up",
] as const;
const BASELINE_TOP3_KEYS = ["source_id", "matched_point_ids"] as const;

const CASE_ID_PATTERN =
	/^(operational|content|abstract)_(positive|negative)_[0-9]{2}$/;
const SOURCE_ID_PATTERN = /^source_[a-z]$/;
const POINT_ID_PATTERN = /^point_[a-z]$/;
const TITLE_PATTERN = /^匿名(?:记录|主题)[A-Z]$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const BASELINE_FAILURE_CODES: ReadonlySet<string> = new Set([
	"recall_miss",
	"unexpected_recall",
	"wrong_source",
	"irrelevant_but_ok",
	"insufficient_false_positive",
	"status_mismatch",
	"degraded_response",
]);

function fail(code: RecallQualityFixtureErrorCode): never {
	throw new RecallQualityFixtureError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) fail("fixture_not_object");
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const actual = Object.keys(value);
	const expectedSet = new Set(expected);
	if (actual.some((key) => !expectedSet.has(key))) fail("unknown_fields");
	if (expected.some((key) => !Object.hasOwn(value, key)))
		fail("missing_fields");
}

function assertString(value: unknown): asserts value is string {
	if (typeof value !== "string") fail("invalid_field_type");
}

function assertArray(value: unknown): asserts value is unknown[] {
	if (!Array.isArray(value)) fail("invalid_field_type");
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0)!;
		return codePoint < 32 || codePoint === 127;
	});
}

function assertUnsafeTextAbsent(value: unknown): void {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === "string") {
			const unsafe =
				hasControlCharacter(current) ||
				current.includes("../") ||
				current.includes("..\\") ||
				/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(current) ||
				/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(current) ||
				/(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/.test(current) ||
				/1[3-9]\d{9}/.test(current) ||
				/(?:password|passwd|api[_-]?key|token|secret|authorization|bearer)\s*[:=]/i.test(
					current,
				) ||
				/\bsk-[A-Za-z0-9_-]{8,}\b/.test(current) ||
				/sentinel/i.test(current);
			if (unsafe) fail("unsafe_fixture_text");
		} else if (Array.isArray(current)) {
			for (const item of current) pending.push(item);
		} else if (isRecord(current)) {
			for (const [key, item] of Object.entries(current)) {
				pending.push(key, item);
			}
		}
	}
}

function assertSafeFixtureText(value: unknown): asserts value is string {
	assertString(value);
	if (value.length === 0 || value.trim() !== value || value.includes("  ")) {
		fail("invalid_fixture_spacing");
	}
	for (const token of value.split(" ")) {
		if (!SAFE_FIXTURE_TOKENS.has(token)) fail("unsafe_fixture_token");
	}
}

function assertStringArray(value: unknown): asserts value is string[] {
	assertArray(value);
	for (const item of value) assertString(item);
}

function assertUnique(values: readonly string[]): void {
	if (new Set(values).size !== values.length) fail("duplicate_reference");
}

function assertExactStringArray(
	value: readonly string[],
	expected: readonly string[],
	code: RecallQualityFixtureErrorCode,
): void {
	if (
		value.length !== expected.length ||
		value.some((item, index) => item !== expected[index])
	)
		fail(code);
}

function parseJsonLines(text: string): unknown[] {
	if (text.length === 0) fail("empty_fixture");
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (normalized.length === 0) fail("empty_fixture");
	const result: unknown[] = [];
	for (const line of normalized.split("\n")) {
		if (line.trim().length === 0) fail("malformed_json");
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			fail("malformed_json");
		}
		assertUnsafeTextAbsent(parsed);
		result.push(parsed);
	}
	return result;
}

function assertSourceId(value: unknown): asserts value is RecallCorpusSourceId {
	assertString(value);
	if (!SOURCE_ID_PATTERN.test(value)) fail("invalid_source_id");
}

function assertPointId(value: unknown): asserts value is RecallAnswerPointId {
	assertString(value);
	if (!POINT_ID_PATTERN.test(value)) fail("invalid_point_id");
}

function assertCaseId(value: unknown): asserts value is RecallQualityCaseId {
	assertString(value);
	if (!CASE_ID_PATTERN.test(value)) fail("invalid_case_id");
}

function parseAnswerPoint(value: unknown): RecallAnswerPoint {
	assertRecord(value);
	assertExactKeys(value, ANSWER_POINT_KEYS);
	assertPointId(value.point_id);
	assertSafeFixtureText(value.text);
	return { pointId: value.point_id, text: value.text };
}

function parseTimelineEntry(value: unknown): RecallTimelineEntry {
	assertRecord(value);
	assertExactKeys(value, TIMELINE_KEYS);
	assertString(value.date);
	const parsedDate = new Date(`${value.date}T00:00:00Z`);
	if (
		!ISO_DATE_PATTERN.test(value.date) ||
		Number.isNaN(parsedDate.valueOf()) ||
		parsedDate.toISOString().slice(0, 10) !== value.date
	) {
		fail("invalid_timeline_date");
	}
	assertSafeFixtureText(value.text);
	return { date: value.date, text: value.text };
}

export function parseRecallQualityCorpus(text: string): RecallCorpus {
	const rows = parseJsonLines(text);
	const sourceIds = new Set<string>();
	const titles = new Set<string>();
	const pointIds = new Set<string>();

	return rows.map((row) => {
		assertRecord(row);
		assertExactKeys(row, CORPUS_KEYS);
		assertSourceId(row.source_id);
		if (sourceIds.has(row.source_id)) fail("duplicate_source_id");
		sourceIds.add(row.source_id);

		assertString(row.title);
		if (!TITLE_PATTERN.test(row.title)) fail("invalid_title");
		if (titles.has(row.title)) fail("duplicate_title");
		titles.add(row.title);
		if (row.type !== "record" && row.type !== "insight")
			fail("invalid_source_type");
		assertSafeFixtureText(row.body);

		assertArray(row.answer_points);
		if (row.answer_points.length === 0) fail("invalid_field_type");
		const answerPoints = row.answer_points.map(parseAnswerPoint);
		for (const point of answerPoints) {
			if (pointIds.has(point.pointId)) fail("duplicate_point_id");
			pointIds.add(point.pointId);
		}

		assertArray(row.timeline);
		const timeline = row.timeline.map(parseTimelineEntry);
		return {
			sourceId: row.source_id,
			title: row.title,
			type: row.type,
			body: row.body,
			answerPoints,
			timeline,
		};
	});
}

function parseCaseBase(row: Record<string, unknown>): RecallQualityCaseBase {
	assertCaseId(row.case_id);
	if (
		row.category !== "operational_meta" &&
		row.category !== "content_meta" &&
		row.category !== "abstract_concept"
	) {
		fail("invalid_case_category");
	}
	const prefix = row.case_id.split("_", 1)[0];
	const expectedCategory =
		prefix === "operational"
			? "operational_meta"
			: prefix === "content"
				? "content_meta"
				: "abstract_concept";
	if (row.category !== expectedCategory) fail("invalid_case_category");
	return { caseId: row.case_id, category: row.category };
}

function parseForbiddenTools(value: unknown): string[] {
	assertStringArray(value);
	assertUnique(value);
	const known = new Set([
		"next_actions",
		"query",
		"cbrain_recall",
		"deep_recall",
	]);
	if (value.length === 0 || value.some((tool) => !known.has(tool)))
		fail("invalid_route_contract");
	return value;
}

function parseRouteCase(row: Record<string, unknown>): RecallRouteContractCase {
	assertExactKeys(row, ROUTE_CASE_KEYS);
	const base = parseCaseBase(row);
	if (base.category !== "operational_meta") fail("invalid_case_category");
	if (row.kind !== "route_contract") fail("invalid_case_kind");
	if (row.expected_tool !== "next_actions" && row.expected_tool !== "cbrain_recall") {
		fail("invalid_route_contract");
	}
	const positive = base.caseId.startsWith("operational_positive_");
	if (
		(positive && row.expected_tool !== "next_actions") ||
		(!positive && row.expected_tool !== "cbrain_recall")
	) {
		fail("case_polarity_mismatch");
	}
	assertString(row.canonical_input_sha256);
	if (!SHA256_PATTERN.test(row.canonical_input_sha256))
		fail("invalid_route_contract");
	const forbiddenTools = parseForbiddenTools(row.forbidden_tools);
	assertRecord(row.expected_args);
	if (
		typeof row.expected_tool === "string" &&
		forbiddenTools.includes(row.expected_tool)
	) {
		fail("invalid_route_contract");
	}

	if (row.expected_tool === "next_actions") {
		assertExactKeys(row.expected_args, ["include_raw"]);
		if (row.expected_args.include_raw !== false) fail("invalid_route_contract");
		assertExactStringArray(
			forbiddenTools,
			["query", "cbrain_recall", "deep_recall"],
			"invalid_route_contract",
		);
		return {
			...base,
			category: "operational_meta",
			kind: "route_contract",
			canonicalInputSha256: row.canonical_input_sha256,
			expectedTool: "next_actions",
			expectedArgs: { includeRaw: false },
			forbiddenTools:
				forbiddenTools as NextActionsRouteContractCase["forbiddenTools"],
		};
	}

	if (row.expected_tool === "cbrain_recall") {
		assertExactKeys(row.expected_args, ["detail"]);
		if (
			row.expected_args.detail !== "normal" ||
			!forbiddenTools.includes("next_actions")
		) {
			fail("invalid_route_contract");
		}
		return {
			...base,
			category: "operational_meta",
			kind: "route_contract",
			canonicalInputSha256: row.canonical_input_sha256,
			expectedTool: "cbrain_recall",
			expectedArgs: { detail: "normal" },
			forbiddenTools:
				forbiddenTools as ContentRecallRouteContractCase["forbiddenTools"],
		};
	}

	fail("invalid_route_contract");
}

function parseSourceIdArray(value: unknown): RecallCorpusSourceId[] {
	assertArray(value);
	const result = value.map((item) => {
		assertSourceId(item);
		return item;
	});
	assertUnique(result);
	return result;
}

function parseRequiredAnswerPoints(
	value: unknown,
): RecallRequiredAnswerPoints[] {
	assertArray(value);
	const sourceIds = new Set<string>();
	return value.map((item) => {
		assertRecord(item);
		assertExactKeys(item, REQUIRED_POINT_KEYS);
		assertSourceId(item.source_id);
		if (sourceIds.has(item.source_id)) fail("duplicate_reference");
		sourceIds.add(item.source_id);
		assertArray(item.point_ids);
		const pointIds = item.point_ids.map((pointId) => {
			assertPointId(pointId);
			return pointId;
		});
		if (pointIds.length === 0) fail("invalid_field_type");
		assertUnique(pointIds);
		if (item.match !== "all" && item.match !== "any")
			fail("invalid_field_type");
		return { sourceId: item.source_id, pointIds, match: item.match };
	});
}

function parseSemanticCase(row: Record<string, unknown>): RecallSemanticCase {
	assertExactKeys(row, SEMANTIC_CASE_KEYS);
	const base = parseCaseBase(row);
	if (
		base.category !== "content_meta" &&
		base.category !== "abstract_concept"
	) {
		fail("invalid_case_category");
	}
	if (row.kind !== "semantic_recall") fail("invalid_case_kind");
	assertSafeFixtureText(row.query);
	if (row.expected_tool !== "cbrain_recall") fail("invalid_semantic_tool");
	if (row.expected_frontdoor_route !== "content_recall")
		fail("invalid_semantic_route");
	if (row.oracle !== "answerable" && row.oracle !== "unanswerable")
		fail("invalid_field_type");
	const positive = base.caseId.includes("_positive_");
	if (
		(positive && row.oracle !== "answerable") ||
		(!positive && row.oracle !== "unanswerable")
	) {
		fail("case_polarity_mismatch");
	}

	const expectedSources = parseSourceIdArray(row.expected_sources);
	const allowedSources = parseSourceIdArray(row.allowed_sources);
	const requiredAnswerPoints = parseRequiredAnswerPoints(
		row.required_answer_points,
	);
	const mustNotSources = parseSourceIdArray(row.must_not_sources);
	assertStringArray(row.allowed_statuses);

	return {
		...base,
		category: base.category,
		kind: "semantic_recall",
		query: row.query,
		expectedTool: "cbrain_recall",
		expectedFrontdoorRoute: "content_recall",
		oracle: row.oracle,
		expectedSources,
		allowedSources,
		requiredAnswerPoints,
		mustNotSources,
		allowedStatuses: row.allowed_statuses as Array<"ok" | "empty">,
	};
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length && left.every((item) => right.includes(item))
	);
}

function validateSemanticReferences(
	testCase: RecallSemanticCase,
	corpus: RecallCorpus,
): void {
	const sourceById = new Map(corpus.map((source) => [source.sourceId, source]));
	const referencedSources = [
		...testCase.expectedSources,
		...testCase.allowedSources,
		...testCase.mustNotSources,
		...testCase.requiredAnswerPoints.map((rule) => rule.sourceId),
	];
	if (referencedSources.some((sourceId) => !sourceById.has(sourceId)))
		fail("unknown_source_reference");

	for (const rule of testCase.requiredAnswerPoints) {
		const source = sourceById.get(rule.sourceId)!;
		const allPoints = new Map(
			corpus.flatMap((item) =>
				item.answerPoints.map((point) => [point.pointId, item.sourceId]),
			),
		);
		for (const pointId of rule.pointIds) {
			const pointSource = allPoints.get(pointId);
			if (!pointSource) fail("unknown_point_reference");
			if (pointSource !== source.sourceId) fail("point_source_mismatch");
		}
	}

	if (
		testCase.allowedSources.some((sourceId) =>
			testCase.mustNotSources.includes(sourceId),
		)
	) {
		fail("source_partition_overlap");
	}
	const partition = [...testCase.allowedSources, ...testCase.mustNotSources];
	if (
		!sameSet(
			partition,
			corpus.map((source) => source.sourceId),
		)
	)
		fail("source_partition_incomplete");
	if (testCase.mustNotSources.length === 0) fail("source_partition_incomplete");

	if (testCase.oracle === "answerable") {
		if (testCase.expectedSources.length === 0)
			fail("answerable_sources_required");
		if (!sameSet(testCase.allowedSources, testCase.expectedSources)) {
			fail("answerable_allowed_sources_mismatch");
		}
		if (
			!sameSet(
				testCase.requiredAnswerPoints.map((rule) => rule.sourceId),
				testCase.expectedSources,
			)
		) {
			fail("answerable_point_rule_mismatch");
		}
		assertExactStringArray(
			testCase.allowedStatuses,
			["ok"],
			"invalid_answerable_statuses",
		);
		return;
	}

	if (
		testCase.expectedSources.length !== 0 ||
		testCase.allowedSources.length !== 0 ||
		testCase.requiredAnswerPoints.length !== 0
	) {
		fail("unanswerable_sources_forbidden");
	}
	assertExactStringArray(
		testCase.allowedStatuses,
		["empty"],
		"invalid_unanswerable_statuses",
	);
}

export function parseRecallQualityCases(
	text: string,
	corpus: RecallCorpus,
): readonly RecallQualityCase[] {
	const rows = parseJsonLines(text);
	const cases = rows.map((row) => {
		assertRecord(row);
		if (row.kind === "route_contract") return parseRouteCase(row);
		if (row.kind === "semantic_recall") return parseSemanticCase(row);
		return fail("invalid_case_kind");
	});

	const caseIds = new Set<string>();
	for (const testCase of cases) {
		if (caseIds.has(testCase.caseId)) fail("duplicate_case_id");
		caseIds.add(testCase.caseId);
		if (testCase.kind === "semantic_recall")
			validateSemanticReferences(testCase, corpus);
	}
	return cases;
}

function inputSha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function canonicalContractMatches(
	row: Record<string, unknown>,
	testCase: RecallRouteContractCase,
): row is Record<string, unknown> & { expected_tool: string } {
	if (!isRecord(row.expected_args) || !Array.isArray(row.forbidden_tools)) {
		return false;
	}
	const forbiddenTools = row.forbidden_tools;
	if (!forbiddenTools.every((tool) => typeof tool === "string")) return false;
	if (new Set(forbiddenTools).size !== forbiddenTools.length) return false;
	if (
		typeof row.expected_tool !== "string" ||
		forbiddenTools.includes(row.expected_tool) ||
		!testCase.forbiddenTools.every((tool) => forbiddenTools.includes(tool))
	) {
		return false;
	}

	if (testCase.expectedTool === "next_actions") {
		return (
			row.category === "operational" &&
			row.expected_tool === "next_actions" &&
			Object.keys(row.expected_args).length === 1 &&
			row.expected_args.include_raw === false
		);
	}

	return (
		row.category === "content_recall" &&
		row.expected_tool === "cbrain_recall" &&
		Object.keys(row.expected_args).length === 1 &&
		row.expected_args.detail === "normal"
	);
}

/**
 * Resolve operational-family cases against the canonical Agent-facing profile.
 * Inputs and their SHA-256 values remain local to this function; observations
 * contain only allowlisted contract identifiers.
 */
export function resolveOperationalRouteObservations(
	agentFacingRoutingText: string,
	cases: readonly RecallRouteContractCase[],
): readonly RecallRouteContractObservation[] {
	const rowsByInputHash = new Map<string, Record<string, unknown>[]>();
	for (const value of parseJsonLines(agentFacingRoutingText)) {
		assertRecord(value);
		if (typeof value.input !== "string") continue;
		const hash = inputSha256(value.input);
		const rows = rowsByInputHash.get(hash) ?? [];
		rows.push(value);
		rowsByInputHash.set(hash, rows);
	}

	return cases.map((testCase) => {
		const rows = rowsByInputHash.get(testCase.canonicalInputSha256) ?? [];
		if (rows.length === 0) fail("canonical_hash_missing");
		if (rows.length !== 1) fail("canonical_hash_duplicate");
		const row = rows[0]!;
		if (!canonicalContractMatches(row, testCase)) {
			fail("canonical_contract_mismatch");
		}
		return {
			kind: "route_contract",
			caseId: testCase.caseId,
			actualTool: row.expected_tool,
		};
	});
}

function parseBaselineTop3(
	value: unknown,
	pointSourceById: ReadonlyMap<RecallAnswerPointId, RecallCorpusSourceId>,
): RecallQualityBaselineTop3[] {
	assertArray(value);
	if (value.length > 3) fail("invalid_baseline_signature");
	const sources = new Set<string>();
	return value.map((item) => {
		assertRecord(item);
		assertExactKeys(item, BASELINE_TOP3_KEYS);
		assertSourceId(item.source_id);
		if (![...pointSourceById.values()].includes(item.source_id))
			fail("unknown_source_reference");
		if (sources.has(item.source_id)) fail("invalid_baseline_signature");
		sources.add(item.source_id);
		assertArray(item.matched_point_ids);
		const matchedPointIds = item.matched_point_ids.map((pointId) => {
			assertPointId(pointId);
			const pointSource = pointSourceById.get(pointId);
			if (!pointSource) fail("unknown_point_reference");
			if (pointSource !== item.source_id) fail("point_source_mismatch");
			return pointId;
		});
		assertUnique(matchedPointIds);
		if (
			[...matchedPointIds]
				.sort()
				.some((pointId, index) => pointId !== matchedPointIds[index])
		) {
			fail("invalid_baseline_signature");
		}
		return { sourceId: item.source_id, matchedPointIds };
	});
}

export function parseRecallQualityBaseline(
	text: string,
	cases: readonly RecallQualityCase[],
	corpus: RecallCorpus,
): RecallQualityBaseline {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("malformed_json");
	}
	assertUnsafeTextAbsent(parsed);
	if (!Array.isArray(parsed)) fail("baseline_not_array");

	const caseById = new Map(
		cases.map((testCase) => [testCase.caseId, testCase]),
	);
	const baselineCaseIds = new Set<string>();
	const pointSourceById = new Map(
		corpus.flatMap((source) =>
			source.answerPoints.map((point) => [point.pointId, source.sourceId]),
		),
	);
	return parsed.map((item) => {
		assertRecord(item);
		assertExactKeys(item, BASELINE_KEYS);
		assertCaseId(item.case_id);
		if (baselineCaseIds.has(item.case_id)) fail("duplicate_baseline_case_id");
		baselineCaseIds.add(item.case_id);
		const testCase = caseById.get(item.case_id);
		if (!testCase || testCase.kind !== "semantic_recall")
			fail("unknown_baseline_case");

		const failureCodes = item.failure_codes;
		assertStringArray(failureCodes);
		if (
			failureCodes.length === 0 ||
			failureCodes.some((code) => !BASELINE_FAILURE_CODES.has(code))
		) {
			fail("invalid_baseline_failure_code");
		}
		assertUnique(failureCodes);
		if (
			[...failureCodes]
				.sort()
				.some((code, index) => code !== failureCodes[index])
		) {
			fail("invalid_baseline_signature");
		}
		if (
			item.answer_status !== "ok" &&
			item.answer_status !== "empty" &&
			item.answer_status !== "degraded"
		) {
			fail("invalid_baseline_signature");
		}
		if (
			item.degradation_kind !== "none" &&
			item.degradation_kind !== "evidence"
		) {
			fail("invalid_baseline_signature");
		}
		if (
			item.evidence_sufficiency !== "sufficient" &&
			item.evidence_sufficiency !== "insufficient" &&
			item.evidence_sufficiency !== "not_applicable"
		) {
			fail("invalid_baseline_signature");
		}
		if (item.answer_status === "degraded") {
			if (
				item.degradation_kind !== "evidence" ||
				item.evidence_sufficiency !== "insufficient" ||
				!failureCodes.includes("degraded_response") ||
				!failureCodes.includes("status_mismatch")
			) {
				fail("invalid_baseline_signature");
			}
		} else if (
			item.degradation_kind !== "none" ||
			failureCodes.includes("degraded_response")
		) {
			fail("invalid_baseline_signature");
		}
		if (item.follow_up !== "#337") fail("invalid_baseline_follow_up");
		const top3 = parseBaselineTop3(item.top3, pointSourceById);

		return {
			caseId: item.case_id,
			failureCodes: failureCodes as BaselineFailureCode[],
			answerStatus: item.answer_status,
			degradationKind: item.degradation_kind,
			evidenceSufficiency: item.evidence_sufficiency,
			top3,
			followUp: "#337",
		};
	});
}

function evaluationFail(code: RecallQualityEvaluationErrorCode): never {
	throw new RecallQualityEvaluationError(code);
}

function isRouteObservationShape(
	observation: RecallQualityObservation,
): observation is RecallRouteContractObservation {
	return observation.kind === "route_contract" && !("top3" in observation);
}

function isSemanticObservationShape(
	observation: RecallQualityObservation,
): observation is RecallSemanticObservation {
	return observation.kind === "semantic_recall" && "top3" in observation;
}

function sortedFailureCodes(
	codes: ReadonlySet<RecallQualityFailureCode>,
): RecallQualityFailureCode[] {
	return [...codes].sort();
}

function normalizeObservationTop3(
	top3: readonly RecallQualityBaselineTop3[],
): RecallQualityBaselineTop3[] {
	return top3.map((item) => ({
		sourceId: item.sourceId,
		matchedPointIds: [...item.matchedPointIds].sort(),
	}));
}

export function evaluateRecallCase(
	testCase: RecallRouteContractCase,
	observation: RecallRouteContractObservation,
): EvaluatedRecallRouteCase;
export function evaluateRecallCase(
	testCase: RecallSemanticCase,
	observation: RecallSemanticObservation,
): EvaluatedRecallSemanticCase;
export function evaluateRecallCase(
	testCase: RecallQualityCase,
	observation: RecallQualityObservation,
): EvaluatedRecallCase;
export function evaluateRecallCase(
	testCase: RecallQualityCase,
	observation: RecallQualityObservation,
): EvaluatedRecallCase {
	const failures = new Set<RecallQualityFailureCode>();
	if (observation.caseId !== testCase.caseId) {
		evaluationFail("case_id_mismatch");
	}

	if (testCase.kind === "route_contract") {
		if (!isRouteObservationShape(observation)) {
			evaluationFail("observation_kind_mismatch");
		}
		const routeMatches = observation.actualTool === testCase.expectedTool;
		if (!routeMatches) failures.add("route_mismatch");
		return {
			caseId: testCase.caseId,
			category: testCase.category,
			kind: "route_contract",
			testCase,
			observation: {
				kind: "route_contract",
				caseId: observation.caseId,
				actualTool: observation.actualTool,
			},
			failureCodes: sortedFailureCodes(failures),
			routeMatches,
		};
	}

	if (!isSemanticObservationShape(observation)) {
		evaluationFail("observation_kind_mismatch");
	}
	if (
		observation.answerStatus !== "degraded" &&
		observation.degradationKind !== "none"
	) {
		failures.add("execution_failure");
	}
	const degradationKind =
		observation.answerStatus === "degraded" &&
		observation.degradationKind !== "unclassified" &&
		!(
			observation.degradationKind === "evidence" &&
			observation.evidenceSufficiency === "insufficient"
		)
			? "unclassified"
			: observation.degradationKind;

	const normalizedObservation: RecallSemanticObservation = {
		...observation,
		degradationKind,
		top3: normalizeObservationTop3(observation.top3),
	};
	const routeMatches =
		normalizedObservation.actualTool === testCase.expectedTool &&
		normalizedObservation.actualFrontdoorRoute ===
			testCase.expectedFrontdoorRoute;
	if (!routeMatches) failures.add("route_mismatch");

	const pointsBySource = new Map<
		RecallCorpusSourceId,
		Set<RecallAnswerPointId>
	>();
	for (const item of normalizedObservation.top3) {
		let points = pointsBySource.get(item.sourceId);
		if (!points) {
			points = new Set();
			pointsBySource.set(item.sourceId, points);
		}
		for (const pointId of item.matchedPointIds) points.add(pointId);
	}

	const expectedSourcesFound = testCase.expectedSources.filter((sourceId) =>
		pointsBySource.has(sourceId),
	).length;
	const expectedCoverage =
		testCase.oracle === "unanswerable"
			? normalizedObservation.top3.length === 0
			: testCase.expectedSources.every((sourceId) => {
					const matchedPoints = pointsBySource.get(sourceId);
					if (!matchedPoints) return false;
					const rule = testCase.requiredAnswerPoints.find(
						(item) => item.sourceId === sourceId,
					);
					if (!rule) return false;
					return rule.match === "all"
						? rule.pointIds.every((pointId) => matchedPoints.has(pointId))
						: rule.pointIds.some((pointId) => matchedPoints.has(pointId));
				});

	if (testCase.oracle === "answerable" && !expectedCoverage) {
		failures.add("recall_miss");
	}
	if (
		testCase.oracle === "unanswerable" &&
		normalizedObservation.top3.length > 0
	) {
		failures.add("unexpected_recall");
	}
	if (
		normalizedObservation.top3.some(
			(item) => !testCase.allowedSources.includes(item.sourceId),
		)
	) {
		failures.add("wrong_source");
	}
	if (
		normalizedObservation.answerStatus === "ok" &&
		(testCase.oracle === "unanswerable" || !expectedCoverage)
	) {
		failures.add("irrelevant_but_ok");
	}
	if (
		testCase.oracle === "answerable" &&
		expectedCoverage &&
		normalizedObservation.evidenceSufficiency === "insufficient"
	) {
		failures.add("insufficient_false_positive");
	}
	if (
		!testCase.allowedStatuses.some(
			(status) => status === normalizedObservation.answerStatus,
		)
	) {
		failures.add("status_mismatch");
	}
	if (normalizedObservation.answerStatus === "degraded") {
		failures.add("degraded_response");
	}
	if (
		normalizedObservation.answerStatus === "degraded" &&
		normalizedObservation.degradationKind === "unclassified"
	) {
		failures.add("unclassified_degraded");
	}

	return {
		caseId: testCase.caseId,
		category: testCase.category,
		kind: "semantic_recall",
		testCase,
		observation: normalizedObservation,
		failureCodes: sortedFailureCodes(failures),
		routeMatches,
		expectedCoverage,
		expectedSourcesFound,
		expectedSourcesTotal: testCase.expectedSources.length,
	};
}

function rateMetric(
	numerator: number,
	denominator: number,
): RecallQualityRateMetric {
	return {
		numerator,
		denominator,
		rate: denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6)),
	};
}

export function aggregateRecallMetrics(
	cases: readonly EvaluatedRecallCase[],
): RecallQualityMetrics {
	const categories = [
		"operational_meta",
		"content_meta",
		"abstract_concept",
	] as const;
	const routeAccuracyByCategory = Object.fromEntries(
		categories.map((category) => {
			const categoryCases = cases.filter((item) => item.category === category);
			return [
				category,
				rateMetric(
					categoryCases.filter((item) => item.routeMatches).length,
					categoryCases.length,
				),
			];
		}),
	) as Record<EvaluatedRecallCase["category"], RecallQualityRateMetric>;
	const semanticCases = cases.filter(
		(item): item is EvaluatedRecallSemanticCase =>
			item.kind === "semantic_recall",
	);
	const answerableCases = semanticCases.filter(
		(item) => item.testCase.oracle === "answerable",
	);
	const insufficientEligible = answerableCases.filter(
		(item) =>
			item.expectedCoverage &&
			item.observation.evidenceSufficiency !== "not_applicable",
	);

	return {
		routeAccuracy: rateMetric(
			cases.filter((item) => item.routeMatches).length,
			cases.length,
		),
		routeAccuracyByCategory,
		recallAt3: rateMetric(
			answerableCases.reduce(
				(total, item) => total + item.expectedSourcesFound,
				0,
			),
			answerableCases.reduce(
				(total, item) => total + item.expectedSourcesTotal,
				0,
			),
		),
		wrongSourceRate: rateMetric(
			semanticCases.filter((item) =>
				item.failureCodes.includes("wrong_source"),
			).length,
			semanticCases.length,
		),
		irrelevantButOkRate: rateMetric(
			semanticCases.filter((item) =>
				item.failureCodes.includes("irrelevant_but_ok"),
			).length,
			semanticCases.length,
		),
		insufficientFalsePositiveRate: rateMetric(
			insufficientEligible.filter((item) =>
				item.failureCodes.includes("insufficient_false_positive"),
			).length,
			insufficientEligible.length,
		),
	};
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => item === right[index])
	);
}

function sameTop3(
	left: readonly RecallQualityBaselineTop3[],
	right: readonly RecallQualityBaselineTop3[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((item, index) => {
		const other = right[index];
		return (
			other !== undefined &&
			item.sourceId === other.sourceId &&
			sameStrings(
				[...item.matchedPointIds].sort(),
				[...other.matchedPointIds].sort(),
			)
		);
	});
}

function isBaselineable(evaluated: EvaluatedRecallCase): boolean {
	return (
		evaluated.kind === "semantic_recall" &&
		evaluated.failureCodes.length > 0 &&
		evaluated.failureCodes.every((code) => BASELINE_FAILURE_CODES.has(code))
	);
}

function baselineSignatureMatches(
	evaluated: EvaluatedRecallCase,
	baseline: RecallQualityBaselineEntry,
): boolean {
	return (
		evaluated.kind === "semantic_recall" &&
		sameStrings(evaluated.failureCodes, baseline.failureCodes) &&
		evaluated.observation.answerStatus === baseline.answerStatus &&
		evaluated.observation.degradationKind === baseline.degradationKind &&
		evaluated.observation.evidenceSufficiency ===
			baseline.evidenceSufficiency &&
		sameTop3(evaluated.observation.top3, baseline.top3)
	);
}

export function compareRecallBaseline(
	cases: readonly EvaluatedRecallCase[],
	baseline: RecallQualityBaseline,
): BaselineComparison {
	const baselineByCaseId = new Map(
		baseline.map((entry) => [entry.caseId, entry]),
	);
	const evaluatedCaseIds = new Set<RecallQualityCaseId>();
	const comparisons: BaselineCaseComparison[] = cases.map((evaluated) => {
		evaluatedCaseIds.add(evaluated.caseId);
		const baselineEntry = baselineByCaseId.get(evaluated.caseId);
		let disposition: BaselineDisposition;
		if (evaluated.failureCodes.length === 0) {
			disposition = baselineEntry ? "unexpected_pass" : "pass";
		} else if (
			baselineEntry &&
			isBaselineable(evaluated) &&
			baselineSignatureMatches(evaluated, baselineEntry)
		) {
			disposition = "known_failure";
		} else {
			disposition = "regression";
		}
		return {
			caseId: evaluated.caseId,
			failureCodes: evaluated.failureCodes,
			disposition,
		};
	});

	for (const entry of baseline) {
		if (!evaluatedCaseIds.has(entry.caseId)) {
			comparisons.push({
				caseId: entry.caseId,
				failureCodes: [],
				disposition: "unexpected_pass",
			});
		}
	}

	const counts = {
		knownFailures: comparisons.filter(
			(item) => item.disposition === "known_failure",
		).length,
		regressions: comparisons.filter(
			(item) => item.disposition === "regression",
		).length,
		unexpectedPasses: comparisons.filter(
			(item) => item.disposition === "unexpected_pass",
		).length,
	};
	const ciIntegrityValid =
		counts.regressions === 0 && counts.unexpectedPasses === 0;
	const rawFailures = cases.some((item) => item.failureCodes.length > 0);
	const qualityStatus =
		ciIntegrityValid && counts.knownFailures === 0
			? "pass"
			: ciIntegrityValid
				? "known_failure"
				: "regression";

	return {
		cases: comparisons,
		qualityStatus,
		strictVerdict: ciIntegrityValid && !rawFailures ? "go" : "no-go",
		ciVerdict: ciIntegrityValid ? "go" : "no-go",
		counts,
	};
}

const REPORT_FAILURE_CODES: readonly RecallQualityFailureCode[] = [
	"degraded_response",
	"execution_failure",
	"insufficient_false_positive",
	"irrelevant_but_ok",
	"legacy_regression",
	"nondeterministic",
	"privacy_failure",
	"recall_miss",
	"route_mismatch",
	"status_mismatch",
	"unclassified_degraded",
	"unexpected_recall",
	"wrong_source",
];

const PUBLIC_REPORT_TOP_LEVEL_KEYS = [
	"gate",
	"schema_version",
	"mode",
	"route_scope",
	"strict_verdict",
	"ci_verdict",
	"verdict",
	"strict_failure",
	"quality_status",
	"metrics",
	"category_counts",
	"failure_counts",
	"counts",
	"cases",
	"legacy_v1",
	"privacy",
	"determinism",
	"bounded_runtime",
	"reproducibility_fingerprint",
	"advisory_duration_ms",
] as const;

const RAW_CANDIDATE_KEYS = ["observations", "legacyCases"] as const;
const RAW_ROUTE_OBSERVATION_KEYS = ["kind", "caseId", "actualTool"] as const;
const RAW_SEMANTIC_OBSERVATION_KEYS = [
	"kind",
	"caseId",
	"actualTool",
	"actualFrontdoorRoute",
	"answerStatus",
	"degradationKind",
	"evidenceSufficiency",
	"top3",
] as const;
const RAW_TOP3_KEYS = ["sourceId", "matchedPointIds"] as const;
const RAW_LEGACY_KEYS = ["id", "lane", "passed"] as const;
const RAW_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"next_actions",
	"cbrain_recall",
	"query",
	"deep_recall",
	"recall_episode",
	"get_org_tree",
	"agentic_research",
	"summarize",
]);
const RAW_ALLOWED_FRONTDOOR_ROUTES: ReadonlySet<string> = new Set([
	"grounded_recall",
	"content_recall",
	"episodic_recall",
	"hierarchy",
	"overview",
	"relationship",
	"reasoning",
	"debug_search",
	"unknown",
]);
const RAW_ALLOWED_ANSWER_STATUSES: ReadonlySet<string> = new Set([
	"ok",
	"empty",
	"degraded",
]);
const RAW_ALLOWED_DEGRADATION_KINDS: ReadonlySet<string> = new Set([
	"none",
	"evidence",
	"unclassified",
]);
const RAW_ALLOWED_EVIDENCE_SUFFICIENCY: ReadonlySet<string> = new Set([
	"sufficient",
	"insufficient",
	"not_applicable",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return (prototype === Object.prototype || prototype === null) &&
		!("toJSON" in value);
}

function isPlainArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && !("toJSON" in value);
}

function hasOnlyExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return sameStrings(actual, expected);
}

function isReportableCaseId(value: unknown): value is RecallQualityCaseId {
	return typeof value === "string" &&
		/^(operational|content|abstract)_(positive|negative)_[0-9]{2}$/.test(value);
}

function rawObservationIsAllowlisted(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	if (value.kind === "route_contract") {
		return hasOnlyExactKeys(value, RAW_ROUTE_OBSERVATION_KEYS) &&
			isReportableCaseId(value.caseId) &&
			typeof value.actualTool === "string" &&
			RAW_ALLOWED_TOOLS.has(value.actualTool);
	}
	if (value.kind !== "semantic_recall" ||
		!hasOnlyExactKeys(value, RAW_SEMANTIC_OBSERVATION_KEYS) ||
		!isReportableCaseId(value.caseId) ||
		typeof value.actualTool !== "string" ||
		!RAW_ALLOWED_TOOLS.has(value.actualTool) ||
		typeof value.actualFrontdoorRoute !== "string" ||
		!RAW_ALLOWED_FRONTDOOR_ROUTES.has(value.actualFrontdoorRoute) ||
		typeof value.answerStatus !== "string" ||
		!RAW_ALLOWED_ANSWER_STATUSES.has(value.answerStatus) ||
		typeof value.degradationKind !== "string" ||
		!RAW_ALLOWED_DEGRADATION_KINDS.has(value.degradationKind) ||
		typeof value.evidenceSufficiency !== "string" ||
		!RAW_ALLOWED_EVIDENCE_SUFFICIENCY.has(value.evidenceSufficiency) ||
		!isPlainArray(value.top3)
	) {
		return false;
	}
	return value.top3.every((item) =>
		isPlainRecord(item) &&
		hasOnlyExactKeys(item, RAW_TOP3_KEYS) &&
		typeof item.sourceId === "string" &&
		/^source_[a-z]$/.test(item.sourceId) &&
		isPlainArray(item.matchedPointIds) &&
		item.matchedPointIds.every((pointId) =>
			typeof pointId === "string" && /^point_[a-z]$/.test(pointId)
		)
	);
}

function rawCandidateIsAllowlisted(value: unknown): boolean {
	if (!isPlainRecord(value) || !hasOnlyExactKeys(value, RAW_CANDIDATE_KEYS)) {
		return false;
	}
	if (!isPlainArray(value.observations) || !isPlainArray(value.legacyCases)) {
		return false;
	}
	return value.observations.every(rawObservationIsAllowlisted) &&
		value.legacyCases.every((item) =>
			isPlainRecord(item) &&
			hasOnlyExactKeys(item, RAW_LEGACY_KEYS) &&
			typeof item.id === "string" &&
			LEGACY_RECALL_CASE_IDS.includes(item.id as LegacyRecallCaseId) &&
			(item.lane === "retrieval" || item.lane === "router" ||
				item.lane === "evidence" || item.lane === "latency") &&
			typeof item.passed === "boolean"
		);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRateMetric(value: unknown): boolean {
	return isPlainRecord(value) &&
		hasOnlyExactKeys(value, ["numerator", "denominator", "rate"]) &&
		isNonNegativeInteger(value.numerator) &&
		isNonNegativeInteger(value.denominator) &&
		typeof value.rate === "number" &&
		Number.isFinite(value.rate) && value.rate >= 0 && value.rate <= 1;
}

function exactCountRecord(value: unknown, keys: readonly string[]): boolean {
	return isPlainRecord(value) && hasOnlyExactKeys(value, keys) &&
		keys.every((key) => isNonNegativeInteger(value[key]));
}

function publicMetricsAreAllowlisted(value: unknown): boolean {
	const keys = [
		"route_accuracy",
		"route_accuracy_by_category",
		"recall_at_3",
		"wrong_source_rate",
		"irrelevant_but_ok_rate",
		"insufficient_false_positive_rate",
	] as const;
	if (!isPlainRecord(value) || !hasOnlyExactKeys(value, keys) ||
		!isRateMetric(value.route_accuracy) ||
		!isRateMetric(value.recall_at_3) ||
		!isRateMetric(value.wrong_source_rate) ||
		!isRateMetric(value.irrelevant_but_ok_rate) ||
		!isRateMetric(value.insufficient_false_positive_rate) ||
		!isPlainRecord(value.route_accuracy_by_category) ||
		!hasOnlyExactKeys(value.route_accuracy_by_category, [
			"operational_meta",
			"content_meta",
			"abstract_concept",
		])
	) {
		return false;
	}
	return isRateMetric(value.route_accuracy_by_category.operational_meta) &&
		isRateMetric(value.route_accuracy_by_category.content_meta) &&
		isRateMetric(value.route_accuracy_by_category.abstract_concept);
}

function expectedCaseContract(caseId: RecallQualityCaseId): Readonly<{
	category: EvaluatedRecallCase["category"];
	kind: EvaluatedRecallCase["kind"];
}> | undefined {
	if (caseId === "operational_positive_01" || caseId === "operational_negative_01") {
		return { category: "operational_meta", kind: "route_contract" };
	}
	if (caseId === "content_positive_01" || caseId === "content_negative_01") {
		return { category: "content_meta", kind: "semantic_recall" };
	}
	if (caseId === "abstract_positive_01" || caseId === "abstract_negative_01") {
		return { category: "abstract_concept", kind: "semantic_recall" };
	}
	return undefined;
}

function publicCasesAreAllowlisted(value: unknown): boolean {
	if (!isPlainArray(value) || value.length !== ISSUE_336_RECALL_CASE_IDS.length) {
		return false;
	}
	return value.every((item, index) => {
		if (!isPlainRecord(item) || !hasOnlyExactKeys(item, [
			"case_id",
			"category",
			"kind",
			"failure_codes",
			"disposition",
		])) {
			return false;
		}
		const expectedId = ISSUE_336_RECALL_CASE_IDS[index];
		if (item.case_id !== expectedId) return false;
		const contract = expectedCaseContract(expectedId);
		if (!contract || item.category !== contract.category || item.kind !== contract.kind) {
			return false;
		}
		if (!isPlainArray(item.failure_codes) ||
			item.failure_codes.some((code) =>
				typeof code !== "string" || !REPORT_FAILURE_CODES.includes(code as RecallQualityFailureCode)
			) ||
			new Set(item.failure_codes).size !== item.failure_codes.length ||
			!sameStrings([...item.failure_codes].sort() as string[], item.failure_codes as string[])
		) {
			return false;
		}
		return item.disposition === "pass" || item.disposition === "known_failure" ||
			item.disposition === "regression" || item.disposition === "unexpected_pass";
	});
}

function publicLegacyIsAllowlisted(value: unknown): boolean {
	if (!isPlainRecord(value) || !hasOnlyExactKeys(value, ["status", "cases"]) ||
		(value.status !== "pass" && value.status !== "fail") ||
		!isPlainArray(value.cases) || value.cases.length !== LEGACY_RECALL_CASE_IDS.length
	) {
		return false;
	}
	const validCases = value.cases.every((item, index) => {
		const expectedId = LEGACY_RECALL_CASE_IDS[index];
		return isPlainRecord(item) && hasOnlyExactKeys(item, ["id", "lane", "status"]) &&
			item.id === expectedId && item.lane === LEGACY_RECALL_LANE_BY_ID[expectedId] &&
			(item.status === "pass" || item.status === "fail");
	});
	if (!validCases) return false;
	const anyFailed = value.cases.some((item) =>
		isPlainRecord(item) && item.status === "fail"
	);
	return value.status === (anyFailed ? "fail" : "pass");
}

function publicReportIsAllowlisted(value: unknown): boolean {
	if (!isPlainRecord(value) ||
		!hasOnlyExactKeys(value, PUBLIC_REPORT_TOP_LEVEL_KEYS)) {
		return false;
	}
	return value.gate === "recall-quality-matrix" &&
		value.schema_version === 2 &&
		(value.mode === "default" || value.mode === "strict") &&
		value.route_scope === "agent_contract_plus_frontdoor" &&
		(value.strict_verdict === "go" || value.strict_verdict === "no-go") &&
		(value.ci_verdict === "go" || value.ci_verdict === "no-go") &&
		(value.verdict === "go" || value.verdict === "no-go") &&
		typeof value.strict_failure === "boolean" &&
		(value.quality_status === "pass" || value.quality_status === "known_failure" ||
			value.quality_status === "regression") &&
		publicMetricsAreAllowlisted(value.metrics) &&
		exactCountRecord(value.category_counts, [
			"operational_meta",
			"content_meta",
			"abstract_concept",
		]) &&
		exactCountRecord(value.failure_counts, REPORT_FAILURE_CODES) &&
		exactCountRecord(value.counts, [
			"known_failures",
			"regressions",
			"unexpected_passes",
		]) &&
		publicCasesAreAllowlisted(value.cases) &&
		publicLegacyIsAllowlisted(value.legacy_v1) &&
		(value.privacy === "pass" || value.privacy === "fail") &&
		(value.determinism === "pass" || value.determinism === "fail") &&
		typeof value.bounded_runtime === "boolean" &&
		typeof value.reproducibility_fingerprint === "string" &&
		/^[a-f0-9]{64}$/.test(value.reproducibility_fingerprint) &&
		typeof value.advisory_duration_ms === "number" &&
		Number.isFinite(value.advisory_duration_ms) &&
		value.advisory_duration_ms >= 0;
}

/**
 * Validate both sides of the privacy boundary using closed field/value sets.
 * The internal candidate may contain controlled source/point IDs, while the
 * public report may contain only report enums and reportable case IDs.
 */
export function checkRecallQualityPrivacy(
	rawCandidate: unknown,
	publicReport: unknown,
): boolean {
	if (!rawCandidateIsAllowlisted(rawCandidate) ||
		!publicReportIsAllowlisted(publicReport)) {
		return false;
	}
	return publicReportSurvivesCanonicalRoundTrip(publicReport);
}

function publicReportSurvivesCanonicalRoundTrip(publicReport: unknown): boolean {
	try {
		const canonical = canonicalRecallQualityJson(publicReport);
		const parsed = JSON.parse(canonical) as unknown;
		return publicReportIsAllowlisted(parsed) &&
			canonical === canonicalRecallQualityJson(parsed);
	} catch {
		return false;
	}
}

function publicRate(metric: RecallQualityRateMetric): RecallQualityPublicRateMetric {
	return {
		numerator: metric.numerator,
		denominator: metric.denominator,
		rate: metric.rate,
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	return value;
}

export function canonicalRecallQualityJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

/**
 * Project evaluated results into the public v2 boundary. Every field is copied
 * explicitly; observations, fixtures, source identities, and free-form errors
 * are deliberately not accepted by this function.
 */
export function buildRecallQualityReport(
	input: BuildRecallQualityReportInput,
): RecallQualityPublicReport {
	const inputKeys = [
		"evaluatedCases",
		"baseline",
		"legacyCases",
		"mode",
		"privacyPass",
		"deterministic",
		"boundedRuntime",
		"advisoryDurationMs",
	] as const;
	if (!isPlainRecord(input) || !hasOnlyExactKeys(input, inputKeys) ||
		!isPlainArray(input.evaluatedCases) || !isPlainArray(input.baseline) ||
		!isPlainArray(input.legacyCases) ||
		input.evaluatedCases.some((item) => !isPlainRecord(item)) ||
		input.baseline.some((item) => !isPlainRecord(item)) ||
		input.legacyCases.some((item) =>
			!isPlainRecord(item) || !hasOnlyExactKeys(item, ["id", "lane", "passed"]) ||
			typeof item.id !== "string" || typeof item.lane !== "string" ||
			typeof item.passed !== "boolean"
		) ||
		(input.mode !== "default" && input.mode !== "strict") ||
		typeof input.privacyPass !== "boolean" ||
		typeof input.deterministic !== "boolean" ||
		typeof input.boundedRuntime !== "boolean"
	) {
		throw new RecallQualityEvaluationError("report_input_mismatch");
	}
	if (!Number.isFinite(input.advisoryDurationMs) || input.advisoryDurationMs < 0) {
		throw new RecallQualityEvaluationError("invalid_duration");
	}
	if (input.evaluatedCases.length !== ISSUE_336_RECALL_CASE_IDS.length) {
		throw new RecallQualityEvaluationError("case_set_mismatch");
	}
	for (let index = 0; index < ISSUE_336_RECALL_CASE_IDS.length; index += 1) {
		const evaluated = input.evaluatedCases[index];
		const expectedId = ISSUE_336_RECALL_CASE_IDS[index];
		const contract = expectedCaseContract(expectedId);
		if (!evaluated || evaluated.caseId !== expectedId || !contract ||
			evaluated.category !== contract.category || evaluated.kind !== contract.kind
		) {
			throw new RecallQualityEvaluationError("case_set_mismatch");
		}
	}
	const categoryCountsFromInput = {
		operational_meta: input.evaluatedCases.filter(
			(item) => item.category === "operational_meta",
		).length,
		content_meta: input.evaluatedCases.filter(
			(item) => item.category === "content_meta",
		).length,
		abstract_concept: input.evaluatedCases.filter(
			(item) => item.category === "abstract_concept",
		).length,
	};
	if (Object.values(categoryCountsFromInput).some((count) => count < 2)) {
		throw new RecallQualityEvaluationError("case_set_mismatch");
	}
	const baselineIds = input.baseline.map((item) => item.caseId);
	if (new Set(baselineIds).size !== baselineIds.length ||
		baselineIds.some((caseId) => !ISSUE_336_BASELINE_CASE_IDS.has(caseId))
	) {
		throw new RecallQualityEvaluationError("report_input_mismatch");
	}
	const comparison = compareRecallBaseline(input.evaluatedCases, input.baseline);
	const metrics = aggregateRecallMetrics(input.evaluatedCases);
	const comparisonByCase = new Map(
		comparison.cases.map((item) => [item.caseId, item]),
	);
	const legacyOrdered = LEGACY_RECALL_CASE_IDS.map((id) => {
		const item = input.legacyCases.find((candidate) => candidate.id === id);
		if (!item) throw new RecallQualityEvaluationError("case_id_mismatch");
		return item;
	});
	if (
		input.legacyCases.length !== LEGACY_RECALL_CASE_IDS.length ||
		new Set(input.legacyCases.map((item) => item.id)).size !==
			LEGACY_RECALL_CASE_IDS.length
	) {
		throw new RecallQualityEvaluationError("case_id_mismatch");
	}
	for (const item of legacyOrdered) {
		if (item.lane !== LEGACY_RECALL_LANE_BY_ID[item.id]) {
			throw new RecallQualityEvaluationError("legacy_lane_mismatch");
		}
	}

	const legacyFailed = legacyOrdered.some((item) => !item.passed);
	const integrityFailed =
		legacyFailed || !input.privacyPass || !input.deterministic || !input.boundedRuntime;
	const strictVerdict = integrityFailed ? "no-go" : comparison.strictVerdict;
	const ciVerdict = integrityFailed ? "no-go" : comparison.ciVerdict;
	const selectedVerdict = input.mode === "strict" ? strictVerdict : ciVerdict;
	const qualityStatus = integrityFailed ? "regression" : comparison.qualityStatus;

	const cases = input.evaluatedCases.map((evaluated) => {
		const compared = comparisonByCase.get(evaluated.caseId);
		if (!compared) throw new RecallQualityEvaluationError("case_id_mismatch");
		return {
			case_id: evaluated.caseId,
			category: evaluated.category,
			kind: evaluated.kind,
			failure_codes: [...compared.failureCodes].sort(),
			disposition: compared.disposition,
		};
	});
	const categoryCounts = categoryCountsFromInput;
	const failureCounts = Object.fromEntries(
		REPORT_FAILURE_CODES.map((code) => [
			code,
			cases.filter((item) => item.failure_codes.includes(code)).length +
				(code === "legacy_regression" && legacyFailed ? 1 : 0) +
				(code === "privacy_failure" && !input.privacyPass ? 1 : 0) +
				(code === "nondeterministic" && !input.deterministic ? 1 : 0) +
				(code === "execution_failure" && !input.boundedRuntime ? 1 : 0),
		]),
	) as Record<RecallQualityFailureCode, number>;

	const stableFields = {
		gate: "recall-quality-matrix" as const,
		schema_version: 2 as const,
		mode: input.mode,
		route_scope: "agent_contract_plus_frontdoor" as const,
		strict_verdict: strictVerdict,
		ci_verdict: ciVerdict,
		verdict: selectedVerdict,
		strict_failure: input.mode === "strict" && selectedVerdict === "no-go",
		quality_status: qualityStatus,
		metrics: {
			route_accuracy: publicRate(metrics.routeAccuracy),
			route_accuracy_by_category: {
				operational_meta: publicRate(metrics.routeAccuracyByCategory.operational_meta),
				content_meta: publicRate(metrics.routeAccuracyByCategory.content_meta),
				abstract_concept: publicRate(metrics.routeAccuracyByCategory.abstract_concept),
			},
			recall_at_3: publicRate(metrics.recallAt3),
			wrong_source_rate: publicRate(metrics.wrongSourceRate),
			irrelevant_but_ok_rate: publicRate(metrics.irrelevantButOkRate),
			insufficient_false_positive_rate: publicRate(metrics.insufficientFalsePositiveRate),
		},
		category_counts: categoryCounts,
		failure_counts: failureCounts,
		counts: {
			known_failures: comparison.counts.knownFailures,
			regressions: comparison.counts.regressions + (integrityFailed ? 1 : 0),
			unexpected_passes: comparison.counts.unexpectedPasses,
		},
		cases,
		legacy_v1: {
			status: legacyFailed ? "fail" as const : "pass" as const,
			cases: legacyOrdered.map((item) => ({
				id: item.id,
				lane: item.lane,
				status: item.passed ? "pass" as const : "fail" as const,
			})),
		},
		privacy: input.privacyPass ? "pass" as const : "fail" as const,
		determinism: input.deterministic ? "pass" as const : "fail" as const,
		bounded_runtime: input.boundedRuntime,
	};
	const fingerprint = createHash("sha256")
		.update(canonicalRecallQualityJson(stableFields))
		.digest("hex");

	const report: RecallQualityPublicReport = {
		...stableFields,
		reproducibility_fingerprint: fingerprint,
		advisory_duration_ms: Math.round(input.advisoryDurationMs),
	};
	if (!publicReportIsAllowlisted(report) ||
		!publicReportSurvivesCanonicalRoundTrip(report)) {
		throw new RecallQualityEvaluationError("report_serialization_invalid");
	}
	return report;
}
