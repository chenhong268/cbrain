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
	| "duplicate_point_id"
	| "invalid_case_id"
	| "invalid_case_category"
	| "invalid_case_kind"
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
	| "duplicate_baseline_case_id";

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
	if (typeof value === "string") {
		const unsafe =
			hasControlCharacter(value) ||
			value.includes("../") ||
			value.includes("..\\") ||
			/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(value) ||
			/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
			/(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/.test(value) ||
			/1[3-9]\d{9}/.test(value) ||
			/(?:password|passwd|api[_-]?key|token|secret|authorization|bearer)\s*[:=]/i.test(
				value,
			) ||
			/\bsk-[A-Za-z0-9_-]{8,}\b/.test(value) ||
			/sentinel/i.test(value);
		if (unsafe) fail("unsafe_fixture_text");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertUnsafeTextAbsent(item);
		return;
	}
	if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			assertUnsafeTextAbsent(key);
			assertUnsafeTextAbsent(item);
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
	const pointIds = new Set<string>();

	return rows.map((row) => {
		assertRecord(row);
		assertExactKeys(row, CORPUS_KEYS);
		assertSourceId(row.source_id);
		if (sourceIds.has(row.source_id)) fail("duplicate_source_id");
		sourceIds.add(row.source_id);

		assertString(row.title);
		if (!TITLE_PATTERN.test(row.title)) fail("invalid_title");
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
	assertString(row.canonical_input_sha256);
	if (!SHA256_PATTERN.test(row.canonical_input_sha256))
		fail("invalid_route_contract");
	const forbiddenTools = parseForbiddenTools(row.forbidden_tools);
	assertRecord(row.expected_args);

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

function parseBaselineTop3(value: unknown): RecallQualityBaselineTop3[] {
	assertArray(value);
	if (value.length > 3) fail("invalid_baseline_signature");
	const sources = new Set<string>();
	return value.map((item) => {
		assertRecord(item);
		assertExactKeys(item, BASELINE_TOP3_KEYS);
		assertSourceId(item.source_id);
		if (sources.has(item.source_id)) fail("invalid_baseline_signature");
		sources.add(item.source_id);
		assertArray(item.matched_point_ids);
		const matchedPointIds = item.matched_point_ids.map((pointId) => {
			assertPointId(pointId);
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
		if (item.follow_up !== "#337") fail("invalid_baseline_follow_up");
		const top3 = parseBaselineTop3(item.top3);
		if (
			top3.some(
				(entry) =>
					![...testCase.allowedSources, ...testCase.mustNotSources].includes(
						entry.sourceId,
					),
			)
		) {
			fail("unknown_source_reference");
		}

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
