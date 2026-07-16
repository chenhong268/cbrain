import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runRecallQualityMatrix } from "../../bin/check-recall-quality-matrix.js";
import {
	aggregateRecallMetrics,
	compareRecallBaseline,
	evaluateRecallCase,
	parseRecallQualityBaseline,
	parseRecallQualityCases,
	parseRecallQualityCorpus,
	SAFE_FIXTURE_TOKENS,
} from "../../bin/lib/recall-quality-matrix.js";
import type {
	EvaluatedRecallCase,
	RecallQualityBaselineEntry,
	RecallQualityCase,
	RecallQualityObservation,
	RecallRouteContractCase,
	RecallSemanticCase,
} from "../../bin/lib/recall-quality-matrix.js";

const CORPUS_TEXT = readFileSync(
	new URL("../fixtures/recall-quality-corpus.jsonl", import.meta.url),
	"utf8",
);
const CASES_TEXT = readFileSync(
	new URL("../fixtures/recall-quality-cases.jsonl", import.meta.url),
	"utf8",
);
const BASELINE_TEXT = readFileSync(
	new URL("../fixtures/recall-quality-baseline.json", import.meta.url),
	"utf8",
);

const jsonl = (rows: readonly unknown[]): string =>
	`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const corpusRows = (): Record<string, unknown>[] =>
	CORPUS_TEXT.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
const caseRows = (): Record<string, unknown>[] =>
	CASES_TEXT.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
const parseCanonicalCorpus = () => parseRecallQualityCorpus(CORPUS_TEXT);
const parseCanonicalCases = () =>
	parseRecallQualityCases(CASES_TEXT, parseCanonicalCorpus());

function expectFixtureError(
	run: () => unknown,
	code: string,
	forbidden?: string,
): void {
	try {
		run();
		throw new Error(`expected fixture error ${code}`);
	} catch (error) {
		expect(error).toMatchObject({ code });
		if (forbidden) expect(String(error)).not.toContain(forbidden);
	}
}

function expectEvaluationError(run: () => unknown, code: string): void {
	try {
		run();
		throw new Error(`expected evaluation error ${code}`);
	} catch (error) {
		expect(error).toMatchObject({
			name: "RecallQualityEvaluationError",
			code,
		});
	}
}

const routeCase = (): Record<string, unknown> => ({
	case_id: "operational_positive_01",
	category: "operational_meta",
	kind: "route_contract",
	canonical_input_sha256: "a".repeat(64),
	expected_tool: "next_actions",
	expected_args: { include_raw: false },
	forbidden_tools: ["query", "cbrain_recall", "deep_recall"],
});

const historicalRouteCase = (): Record<string, unknown> => ({
	case_id: "operational_negative_01",
	category: "operational_meta",
	kind: "route_contract",
	canonical_input_sha256: "b".repeat(64),
	expected_tool: "cbrain_recall",
	expected_args: { detail: "normal" },
	forbidden_tools: ["next_actions"],
});

const baselineEntry = (): Record<string, unknown> => ({
	case_id: "abstract_positive_01",
	failure_codes: ["recall_miss"],
	answer_status: "empty",
	degradation_kind: "none",
	evidence_sufficiency: "not_applicable",
	top3: [],
	follow_up: "#337",
});

const answerableCase = (
	overrides: Partial<RecallSemanticCase> = {},
): RecallSemanticCase => ({
	caseId: "abstract_positive_01",
	category: "abstract_concept",
	kind: "semantic_recall",
	query: "抽象 治理",
	expectedTool: "cbrain_recall",
	expectedFrontdoorRoute: "content_recall",
	oracle: "answerable",
	expectedSources: ["source_a"],
	allowedSources: ["source_a"],
	requiredAnswerPoints: [
		{
			sourceId: "source_a",
			pointIds: ["point_a", "point_b"],
			match: "all",
		},
	],
	mustNotSources: ["source_b", "source_c", "source_d"],
	allowedStatuses: ["ok"],
	...overrides,
});

const unanswerableCase = (
	overrides: Partial<RecallSemanticCase> = {},
): RecallSemanticCase => ({
	caseId: "abstract_negative_01",
	category: "abstract_concept",
	kind: "semantic_recall",
	query: "未知 线索",
	expectedTool: "cbrain_recall",
	expectedFrontdoorRoute: "content_recall",
	oracle: "unanswerable",
	expectedSources: [],
	allowedSources: [],
	requiredAnswerPoints: [],
	mustNotSources: ["source_a", "source_b", "source_c", "source_d"],
	allowedStatuses: ["empty"],
	...overrides,
});

const semanticObservation = (
	overrides: Partial<Extract<RecallQualityObservation, { top3: unknown }>> = {},
): Extract<RecallQualityObservation, { top3: unknown }> => ({
	kind: "semantic_recall",
	caseId: "abstract_positive_01",
	actualTool: "cbrain_recall",
	actualFrontdoorRoute: "content_recall",
	answerStatus: "ok",
	degradationKind: "none",
	evidenceSufficiency: "sufficient",
	top3: [
		{ sourceId: "source_a", matchedPointIds: ["point_b", "point_a"] },
	],
	...overrides,
});

const routeQualityCase = (
	overrides: Partial<RecallRouteContractCase> = {},
): RecallRouteContractCase => ({
	caseId: "operational_positive_01",
	category: "operational_meta",
	kind: "route_contract",
	canonicalInputSha256: "a".repeat(64),
	expectedTool: "next_actions",
	expectedArgs: { includeRaw: false },
	forbiddenTools: ["query", "cbrain_recall", "deep_recall"],
	...overrides,
} as RecallRouteContractCase);

const exactKnownFailureBaseline = (
	overrides: Partial<RecallQualityBaselineEntry> = {},
): RecallQualityBaselineEntry => ({
	caseId: "abstract_positive_01",
	failureCodes: ["irrelevant_but_ok", "recall_miss", "wrong_source"],
	answerStatus: "ok",
	degradationKind: "none",
	evidenceSufficiency: "sufficient",
	top3: [
		{
			sourceId: "source_b",
			matchedPointIds: ["point_b", "point_c"],
		},
		{ sourceId: "source_c", matchedPointIds: [] },
	],
	followUp: "#337",
	...overrides,
});

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

describe("fixture schema", () => {
	test("loads the controlled corpus, canonical semantic cases, synthetic route case, and empty baseline", () => {
		const corpus = parseCanonicalCorpus();
		const cases = parseCanonicalCases();
		const routes = parseRecallQualityCases(jsonl([routeCase()]), corpus);
		const baseline = parseRecallQualityBaseline(BASELINE_TEXT, cases, corpus);

		expect(corpus).toHaveLength(4);
		expect(cases.map((item) => item.caseId)).toEqual([
			"content_positive_01",
			"content_negative_01",
			"abstract_positive_01",
			"abstract_negative_01",
		]);
		expect(routes).toHaveLength(1);
		expect(baseline).toEqual([]);
		expect(SAFE_FIXTURE_TOKENS.size).toBeGreaterThan(0);
	});

	test.each([
		[
			"corpus",
			() => {
				const rows = corpusRows();
				rows[0]!.extra = false;
				return () => parseRecallQualityCorpus(jsonl(rows));
			},
		],
		[
			"route-contract",
			() => {
				const row = routeCase();
				row.fixture_path = "source_a";
				return () =>
					parseRecallQualityCases(jsonl([row]), parseCanonicalCorpus());
			},
		],
		[
			"semantic",
			() => {
				const rows = caseRows();
				rows[0]!.options = {};
				return () =>
					parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus());
			},
		],
		[
			"baseline",
			() => {
				const row = baselineEntry();
				row.environment = "source_a";
				return () =>
					parseRecallQualityBaseline(
						JSON.stringify([row]),
						parseCanonicalCases(),
						parseCanonicalCorpus(),
					);
			},
		],
	])("rejects unknown %s fields", (_label, makeRun) => {
		expectFixtureError(makeRun(), "unknown_fields");
	});

	test("rejects duplicate source, point, and case IDs", () => {
		const duplicateSource = corpusRows();
		duplicateSource[1]!.source_id = duplicateSource[0]!.source_id;
		expectFixtureError(
			() => parseRecallQualityCorpus(jsonl(duplicateSource)),
			"duplicate_source_id",
		);

		const duplicatePoint = corpusRows();
		const firstPoint = (
			duplicatePoint[0]!.answer_points as Array<Record<string, unknown>>
		)[0]!.point_id;
		(
			duplicatePoint[1]!.answer_points as Array<Record<string, unknown>>
		)[0]!.point_id = firstPoint;
		expectFixtureError(
			() => parseRecallQualityCorpus(jsonl(duplicatePoint)),
			"duplicate_point_id",
		);

		const duplicateCase = caseRows();
		duplicateCase[1] = structuredClone(duplicateCase[0]!);
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl(duplicateCase), parseCanonicalCorpus()),
			"duplicate_case_id",
		);
	});

	test.each([
		[
			"case ID",
			() => {
				const rows = caseRows();
				rows[0]!.case_id = "content_positive_1";
				return () =>
					parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus());
			},
			"invalid_case_id",
		],
		[
			"source ID",
			() => {
				const rows = corpusRows();
				rows[0]!.source_id = "source_aa";
				return () => parseRecallQualityCorpus(jsonl(rows));
			},
			"invalid_source_id",
		],
		[
			"title",
			() => {
				const rows = corpusRows();
				rows[0]!.title = "匿名记录甲";
				return () => parseRecallQualityCorpus(jsonl(rows));
			},
			"invalid_title",
		],
		[
			"point ID",
			() => {
				const rows = corpusRows();
				(
					rows[0]!.answer_points as Array<Record<string, unknown>>
				)[0]!.point_id = "point_aa";
				return () => parseRecallQualityCorpus(jsonl(rows));
			},
			"invalid_point_id",
		],
	])("enforces the closed %s grammar", (_label, makeRun, code) => {
		expectFixtureError(makeRun(), code);
	});

	test("rejects unknown and source-mismatched semantic references", () => {
		const unknownSource = caseRows();
		unknownSource[0]!.expected_sources = ["source_z"];
		unknownSource[0]!.allowed_sources = ["source_z"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl(unknownSource), parseCanonicalCorpus()),
			"unknown_source_reference",
		);

		const unknownPoint = caseRows();
		(
			unknownPoint[0]!.required_answer_points as Array<Record<string, unknown>>
		)[0]!.point_ids = ["point_z"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl(unknownPoint), parseCanonicalCorpus()),
			"unknown_point_reference",
		);

		const wrongSourcePoint = caseRows();
		(
			wrongSourcePoint[0]!.required_answer_points as Array<
				Record<string, unknown>
			>
		)[0]!.point_ids = ["point_b"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(
					jsonl(wrongSourcePoint),
					parseCanonicalCorpus(),
				),
			"point_source_mismatch",
		);
	});

	test("requires allowed and forbidden sources to be a disjoint exhaustive corpus partition", () => {
		const overlap = caseRows();
		overlap[0]!.must_not_sources = [
			"source_a",
			"source_b",
			"source_c",
			"source_d",
		];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(overlap), parseCanonicalCorpus()),
			"source_partition_overlap",
		);

		const incomplete = caseRows();
		incomplete[0]!.must_not_sources = ["source_b", "source_c"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(incomplete), parseCanonicalCorpus()),
			"source_partition_incomplete",
		);
	});

	test("requires answerable sources, point coverage, and allowed sources to agree exactly", () => {
		const noExpected = caseRows();
		noExpected[0]!.expected_sources = [];
		noExpected[0]!.allowed_sources = [];
		noExpected[0]!.required_answer_points = [];
		noExpected[0]!.must_not_sources = [
			"source_a",
			"source_b",
			"source_c",
			"source_d",
		];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(noExpected), parseCanonicalCorpus()),
			"answerable_sources_required",
		);

		const allowedMismatch = caseRows();
		allowedMismatch[0]!.allowed_sources = ["source_b"];
		allowedMismatch[0]!.must_not_sources = ["source_a", "source_c", "source_d"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl(allowedMismatch), parseCanonicalCorpus()),
			"answerable_allowed_sources_mismatch",
		);

		const missingRule = caseRows();
		missingRule[0]!.required_answer_points = [];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(missingRule), parseCanonicalCorpus()),
			"answerable_point_rule_mismatch",
		);
	});

	test("requires unanswerable cases to declare no expected, allowed, or point references", () => {
		const rows = caseRows();
		rows[1]!.expected_sources = ["source_a"];
		rows[1]!.allowed_sources = ["source_a"];
		rows[1]!.required_answer_points = [
			{ source_id: "source_a", point_ids: ["point_a"], match: "all" },
		];
		rows[1]!.must_not_sources = ["source_b", "source_c", "source_d"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus()),
			"unanswerable_sources_forbidden",
		);
	});

	test("requires exact normal statuses for answerable and unanswerable cases", () => {
		const answerable = caseRows();
		answerable[0]!.allowed_statuses = ["ok", "empty"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(answerable), parseCanonicalCorpus()),
			"invalid_answerable_statuses",
		);

		const unanswerable = caseRows();
		unanswerable[1]!.allowed_statuses = ["ok"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl(unanswerable), parseCanonicalCorpus()),
			"invalid_unanswerable_statuses",
		);
	});

	test("pins semantic cases to cbrain_recall and content_recall", () => {
		const wrongTool = caseRows();
		wrongTool[0]!.expected_tool = "query";
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(wrongTool), parseCanonicalCorpus()),
			"invalid_semantic_tool",
		);

		const wrongRoute = caseRows();
		wrongRoute[0]!.expected_frontdoor_route = "deep_recall";
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(wrongRoute), parseCanonicalCorpus()),
			"invalid_semantic_route",
		);
	});

	test("rejects a historical route contract that forbids its expected tool", () => {
		const row = historicalRouteCase();
		row.forbidden_tools = ["next_actions", "cbrain_recall"];
		expectFixtureError(
			() =>
				parseRecallQualityCases(jsonl([row]), parseCanonicalCorpus()),
			"invalid_route_contract",
		);
	});

	test("binds positive semantic case IDs to answerable oracles", () => {
		const rows = caseRows();
		rows[0]!.oracle = "unanswerable";
		rows[0]!.expected_sources = [];
		rows[0]!.allowed_sources = [];
		rows[0]!.required_answer_points = [];
		rows[0]!.must_not_sources = ["source_a", "source_b", "source_c", "source_d"];
		rows[0]!.allowed_statuses = ["empty"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus()),
			"case_polarity_mismatch",
		);
	});

	test("binds negative semantic case IDs to unanswerable oracles", () => {
		const rows = caseRows();
		rows[1]!.oracle = "answerable";
		rows[1]!.expected_sources = ["source_a"];
		rows[1]!.allowed_sources = ["source_a"];
		rows[1]!.required_answer_points = [
			{ source_id: "source_a", point_ids: ["point_a"], match: "all" },
		];
		rows[1]!.must_not_sources = ["source_b", "source_c", "source_d"];
		rows[1]!.allowed_statuses = ["ok"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus()),
			"case_polarity_mismatch",
		);
	});

	test("binds positive operational case IDs to next_actions", () => {
		const row = routeCase();
		row.expected_tool = "cbrain_recall";
		row.expected_args = { detail: "normal" };
		row.forbidden_tools = ["next_actions"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl([row]), parseCanonicalCorpus()),
			"case_polarity_mismatch",
		);
	});

	test("binds negative operational case IDs to cbrain_recall", () => {
		const row = historicalRouteCase();
		row.expected_tool = "next_actions";
		row.expected_args = { include_raw: false };
		row.forbidden_tools = ["query", "cbrain_recall", "deep_recall"];
		expectFixtureError(
			() => parseRecallQualityCases(jsonl([row]), parseCanonicalCorpus()),
			"case_polarity_mismatch",
		);
	});

	test("uses a finite, single-space-delimited vocabulary for every semantic free-text field", () => {
		expect(
			[...SAFE_FIXTURE_TOKENS].every(
				(token) => token.length > 0 && !token.includes(" "),
			),
		).toBe(true);

		const unknownCorpusToken = corpusRows();
		unknownCorpusToken[0]!.body = "系统 未登记词";
		expectFixtureError(
			() => parseRecallQualityCorpus(jsonl(unknownCorpusToken)),
			"unsafe_fixture_token",
		);

		const badSpacing = caseRows();
		badSpacing[0]!.query = "系统  恢复";
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(badSpacing), parseCanonicalCorpus()),
			"invalid_fixture_spacing",
		);
	});

	test.each([
		["control", "系统 \u0001 恢复"],
		["traversal", "../source_a"],
		["absolute path", "/Users/example/source_a"],
		["email", "fixture@example.com"],
		["credential", "api_key=fixture-secret"],
		["sentinel", "UNIQUE_SENTINEL_336"],
	])("rejects %s text without reflecting it in public errors", (_label, unsafe) => {
		const rows = caseRows();
		rows[0]!.query = unsafe;
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus()),
			"unsafe_fixture_text",
			unsafe,
		);
	});

	test.each([
		["source ID", (rows: Record<string, unknown>[], sentinel: string) => {
			rows[0]!.source_id = sentinel;
		}],
		["title", (rows: Record<string, unknown>[], sentinel: string) => {
			rows[0]!.title = sentinel;
		}],
		["body", (rows: Record<string, unknown>[], sentinel: string) => {
			rows[0]!.body = sentinel;
		}],
		["answer point", (rows: Record<string, unknown>[], sentinel: string) => {
			(rows[0]!.answer_points as Array<Record<string, unknown>>)[0]!.text = sentinel;
		}],
		["timeline", (rows: Record<string, unknown>[], sentinel: string) => {
			(rows[0]!.timeline as Array<Record<string, unknown>>)[0]!.text = sentinel;
		}],
	])("rejects a unique sentinel in corpus %s without reflecting it", (_label, mutate) => {
		const sentinel = `UNIQUE_SENTINEL_CORPUS_${_label}_336`;
		const rows = corpusRows();
		mutate(rows, sentinel);
		expectFixtureError(
			() => parseRecallQualityCorpus(jsonl(rows)),
			"unsafe_fixture_text",
			sentinel,
		);
	});

	test("rejects unsafe sentinels in case IDs as well as semantic text", () => {
		const sentinel = "UNIQUE_SENTINEL_CASE_336";
		const rows = caseRows();
		rows[0]!.case_id = sentinel;
		expectFixtureError(
			() => parseRecallQualityCases(jsonl(rows), parseCanonicalCorpus()),
			"unsafe_fixture_text",
			sentinel,
		);
	});

	test("rejects malformed JSON without reflecting raw rows", () => {
		const malformed = '{"source_id":"UNIQUE_SENTINEL_MALFORMED_336"';
		expectFixtureError(
			() => parseRecallQualityCorpus(malformed),
			"malformed_json",
			malformed,
		);
	});

	test("deep JSON input fails with a stable fixture code instead of RangeError", () => {
		const depth = 20_000;
		const deeplyNested = `{"source_id":"source_a","deep":${"[".repeat(depth)}"系统"${"]".repeat(depth)}}`;
		expectFixtureError(
			() => parseRecallQualityCorpus(deeplyNested),
			"unknown_fields",
		);
	});

	test("validates baseline exact enums, references, uniqueness, and fixed follow-up", () => {
		const cases = parseCanonicalCases();

		const badFailure = baselineEntry();
		badFailure.failure_codes = ["route_mismatch"];
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([badFailure]),
					cases,
					parseCanonicalCorpus(),
				),
			"invalid_baseline_failure_code",
		);

		const badFollowUp = baselineEntry();
		badFollowUp.follow_up = "#338";
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([badFollowUp]),
					cases,
					parseCanonicalCorpus(),
				),
			"invalid_baseline_follow_up",
		);

		const unknownCase = baselineEntry();
		unknownCase.case_id = "abstract_positive_99";
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([unknownCase]),
					cases,
					parseCanonicalCorpus(),
				),
			"unknown_baseline_case",
		);

		const duplicate = baselineEntry();
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([duplicate, duplicate]),
					cases,
					parseCanonicalCorpus(),
				),
			"duplicate_baseline_case_id",
		);
	});

	test.each([
		[
			"degraded without a degradation kind",
			{
				answer_status: "degraded",
				degradation_kind: "none",
				evidence_sufficiency: "insufficient",
			},
		],
		[
			"evidence degradation with sufficient evidence",
			{
				answer_status: "degraded",
				degradation_kind: "evidence",
				evidence_sufficiency: "sufficient",
			},
		],
		[
			"evidence degradation without applicable evidence",
			{
				answer_status: "degraded",
				degradation_kind: "evidence",
				evidence_sufficiency: "not_applicable",
			},
		],
		[
			"non-degraded status with an evidence degradation kind",
			{
				answer_status: "ok",
				degradation_kind: "evidence",
				evidence_sufficiency: "insufficient",
			},
		],
	] as const)("rejects an inconsistent baseline signature: %s", (_label, fields) => {
		const row = { ...baselineEntry(), ...fields };
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([row]),
					parseCanonicalCases(),
					parseCanonicalCorpus(),
				),
			"invalid_baseline_signature",
		);
	});

	test("accepts an evidence-derived degraded baseline only with insufficient evidence", () => {
		const row = {
			...baselineEntry(),
			failure_codes: [
				"degraded_response",
				"insufficient_false_positive",
				"status_mismatch",
			],
			answer_status: "degraded",
			degradation_kind: "evidence",
			evidence_sufficiency: "insufficient",
			top3: [{ source_id: "source_c", matched_point_ids: ["point_c"] }],
		};

		expect(
			parseRecallQualityBaseline(
				JSON.stringify([row]),
				parseCanonicalCases(),
				parseCanonicalCorpus(),
			),
		).toHaveLength(1);
	});

	test("rejects an unknown baseline matched point", () => {
		const row = baselineEntry();
		row.top3 = [{ source_id: "source_a", matched_point_ids: ["point_z"] }];
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([row]),
					parseCanonicalCases(),
					parseCanonicalCorpus(),
				),
			"unknown_point_reference",
		);
	});

	test("rejects a baseline matched point bound to another top-three source", () => {
		const row = baselineEntry();
		row.top3 = [{ source_id: "source_a", matched_point_ids: ["point_b"] }];
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([row]),
					parseCanonicalCases(),
					parseCanonicalCorpus(),
				),
			"point_source_mismatch",
		);
	});

	test("baseline root must be an exact JSON array", () => {
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify({ entries: [] }),
					parseCanonicalCases(),
					parseCanonicalCorpus(),
				),
			"baseline_not_array",
		);
	});
});

describe("quality oracle", () => {
	test("rejects observation case identity drift before evaluation", () => {
		expectEvaluationError(
			() =>
				evaluateRecallCase(
					answerableCase(),
					semanticObservation({ caseId: "abstract_positive_02" }),
				),
			"case_id_mismatch",
		);
	});

	test("rejects route and semantic observation shape swaps", () => {
		const routeTestCase: RecallQualityCase = routeQualityCase();
		const semanticTestCase: RecallQualityCase = answerableCase();
		const semanticShape = semanticObservation({
			caseId: "operational_positive_01",
		}) as RecallQualityObservation;
		const routeShape = {
			kind: "route_contract",
			caseId: "abstract_positive_01",
			actualTool: "cbrain_recall",
		} as unknown as RecallQualityObservation;

		expectEvaluationError(
			() => evaluateRecallCase(routeTestCase, semanticShape),
			"observation_kind_mismatch",
		);
		expectEvaluationError(
			() => evaluateRecallCase(semanticTestCase, routeShape),
			"observation_kind_mismatch",
		);
	});

	test("answerable exact expected source and all source-bound points passes", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation(),
		);

		expect(evaluated.failureCodes).toEqual([]);
		expect(evaluated.expectedCoverage).toBe(true);
		expect(evaluated.observation.top3).toEqual([
			{ sourceId: "source_a", matchedPointIds: ["point_a", "point_b"] },
		]);
	});

	test("answerable empty response records recall miss independently of status", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({ answerStatus: "empty", top3: [] }),
		);

		expect(evaluated.failureCodes).toEqual([
			"recall_miss",
			"status_mismatch",
		]);
	});

	test("answerable wrong candidate with ok status records every independent failure", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				top3: [{ sourceId: "source_b", matchedPointIds: [] }],
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"irrelevant_but_ok",
			"recall_miss",
			"wrong_source",
		]);
	});

	test("expected source without its required point does not satisfy coverage", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				top3: [{ sourceId: "source_a", matchedPointIds: ["point_a"] }],
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"irrelevant_but_ok",
			"recall_miss",
		]);
		expect(evaluated.expectedCoverage).toBe(false);
	});

	test("required point appearing under a wrong source cannot satisfy source-bound coverage", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				top3: [
					{ sourceId: "source_a", matchedPointIds: [] },
					{
						sourceId: "source_b",
						matchedPointIds: ["point_a", "point_b"],
					},
				],
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"irrelevant_but_ok",
			"recall_miss",
			"wrong_source",
		]);
		expect(evaluated.expectedCoverage).toBe(false);
	});

	test("expected coverage does not waive an extra non-allowed source", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				top3: [
					{
						sourceId: "source_a",
						matchedPointIds: ["point_a", "point_b"],
					},
					{ sourceId: "source_b", matchedPointIds: [] },
				],
			}),
		);

		expect(evaluated.failureCodes).toEqual(["wrong_source"]);
		expect(evaluated.expectedCoverage).toBe(true);
	});

	test("an any-point rule accepts one source-bound required point", () => {
		const evaluated = evaluateRecallCase(
			answerableCase({
				requiredAnswerPoints: [
					{
						sourceId: "source_a",
						pointIds: ["point_a", "point_b"],
						match: "any",
					},
				],
			}),
			semanticObservation({
				top3: [{ sourceId: "source_a", matchedPointIds: ["point_b"] }],
			}),
		);

		expect(evaluated.failureCodes).toEqual([]);
		expect(evaluated.expectedCoverage).toBe(true);
	});

	test("unanswerable empty response with empty status passes", () => {
		const evaluated = evaluateRecallCase(
			unanswerableCase(),
			semanticObservation({
				caseId: "abstract_negative_01",
				answerStatus: "empty",
				evidenceSufficiency: "not_applicable",
				top3: [],
			}),
		);

		expect(evaluated.failureCodes).toEqual([]);
		expect(evaluated.expectedCoverage).toBe(true);
	});

	test.each([
		[
			"empty",
			"none",
			["unexpected_recall", "wrong_source"],
		],
		[
			"degraded",
			"evidence",
			[
				"degraded_response",
				"status_mismatch",
				"unexpected_recall",
				"wrong_source",
			],
		],
	] as const)(
		"unanswerable non-empty %s response always records unexpected recall",
		(answerStatus, degradationKind, failureCodes) => {
			const evaluated = evaluateRecallCase(
				unanswerableCase(),
				semanticObservation({
					caseId: "abstract_negative_01",
					answerStatus,
					degradationKind,
					evidenceSufficiency:
						answerStatus === "degraded" ? "insufficient" : "sufficient",
					top3: [{ sourceId: "source_a", matchedPointIds: [] }],
				}),
			);

			expect(evaluated.failureCodes).toEqual([...failureCodes]);
		},
	);

	test("unanswerable empty result with ok status is irrelevant and mismatched", () => {
		const evaluated = evaluateRecallCase(
			unanswerableCase(),
			semanticObservation({
				caseId: "abstract_negative_01",
				top3: [],
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"irrelevant_but_ok",
			"status_mismatch",
		]);
	});

	test("degraded response always records degradation independently of coverage", () => {
		const evaluated = evaluateRecallCase(
			unanswerableCase(),
			semanticObservation({
				caseId: "abstract_negative_01",
				answerStatus: "degraded",
				degradationKind: "evidence",
				evidenceSufficiency: "insufficient",
				top3: [],
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"degraded_response",
			"status_mismatch",
		]);
	});

	test("degraded response without evidence proof is additionally unclassified", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				answerStatus: "degraded",
				degradationKind: "unclassified",
				evidenceSufficiency: "not_applicable",
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"degraded_response",
			"status_mismatch",
			"unclassified_degraded",
		]);
	});

	test("degraded response with no degradation kind is normalized as unclassified", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				answerStatus: "degraded",
				degradationKind: "none",
				evidenceSufficiency: "not_applicable",
			}),
		);

		expect(evaluated.failureCodes).toEqual([
			"degraded_response",
			"status_mismatch",
			"unclassified_degraded",
		]);
		expect(evaluated.observation.degradationKind).toBe("unclassified");
	});

	test.each(["sufficient", "not_applicable"] as const)(
		"evidence degradation with %s evidence is normalized as unclassified",
		(evidenceSufficiency) => {
			const evaluated = evaluateRecallCase(
				answerableCase(),
				semanticObservation({
					answerStatus: "degraded",
					degradationKind: "evidence",
					evidenceSufficiency,
				}),
			);

			expect(evaluated.failureCodes).toContain("unclassified_degraded");
			expect(evaluated.observation.degradationKind).toBe("unclassified");
		},
	);

	test.each(["evidence", "unclassified"] as const)(
		"ok response with %s degradation kind is an execution failure",
		(degradationKind) => {
			const evaluated = evaluateRecallCase(
				answerableCase(),
				semanticObservation({ degradationKind }),
			);

			expect(evaluated.failureCodes).toEqual(["execution_failure"]);
			expect(compareRecallBaseline([evaluated], []).ciVerdict).toBe("no-go");
		},
	);

	test("expected coverage plus insufficient evidence is a false positive", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({ evidenceSufficiency: "insufficient" }),
		);

		expect(evaluated.failureCodes).toEqual([
			"insufficient_false_positive",
		]);
	});

	test("semantic tool or frontdoor mismatch records route mismatch", () => {
		const wrongTool = evaluateRecallCase(
			answerableCase(),
			semanticObservation({ actualTool: "query" }),
		);
		const wrongFrontdoor = evaluateRecallCase(
			answerableCase(),
			semanticObservation({ actualFrontdoorRoute: "deep_recall" }),
		);

		expect(wrongTool.failureCodes).toContain("route_mismatch");
		expect(wrongFrontdoor.failureCodes).toContain("route_mismatch");
	});
});

describe("metrics", () => {
	test("locks exact route, source coverage, case-rate, and insufficiency denominators", () => {
		const routeMatch = evaluateRecallCase(routeQualityCase(), {
			kind: "route_contract",
			caseId: "operational_positive_01",
			actualTool: "next_actions",
		});
		const contentMiss = evaluateRecallCase(
			answerableCase({
				caseId: "content_positive_01",
				category: "content_meta",
				expectedSources: ["source_a", "source_b"],
				allowedSources: ["source_a", "source_b"],
				requiredAnswerPoints: [
					{ sourceId: "source_a", pointIds: ["point_a"], match: "all" },
					{ sourceId: "source_b", pointIds: ["point_b"], match: "all" },
				],
				mustNotSources: ["source_c", "source_d"],
			}),
			semanticObservation({
				caseId: "content_positive_01",
				evidenceSufficiency: "insufficient",
				top3: [
					{ sourceId: "source_a", matchedPointIds: ["point_a"] },
					{ sourceId: "source_c" as const, matchedPointIds: [] },
				],
			}),
		);
		const abstractInsufficient = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				actualFrontdoorRoute: "deep_recall",
				evidenceSufficiency: "insufficient",
			}),
		);
		const contentSufficient = evaluateRecallCase(
			answerableCase({
				caseId: "content_positive_02",
				category: "content_meta",
			}),
			semanticObservation({ caseId: "content_positive_02" }),
		);
		const contentEmpty = evaluateRecallCase(
			unanswerableCase({
				caseId: "content_negative_01",
				category: "content_meta",
			}),
			semanticObservation({
				caseId: "content_negative_01",
				answerStatus: "empty",
				evidenceSufficiency: "not_applicable",
				top3: [],
			}),
		);

		const metrics = aggregateRecallMetrics([
			routeMatch,
			contentMiss,
			abstractInsufficient,
			contentSufficient,
			contentEmpty,
		]);

		expect(metrics.routeAccuracy).toEqual({
			numerator: 4,
			denominator: 5,
			rate: 0.8,
		});
		expect(metrics.routeAccuracyByCategory).toEqual({
			operational_meta: { numerator: 1, denominator: 1, rate: 1 },
			content_meta: { numerator: 3, denominator: 3, rate: 1 },
			abstract_concept: { numerator: 0, denominator: 1, rate: 0 },
		});
		expect(metrics.recallAt3).toEqual({
			numerator: 3,
			denominator: 4,
			rate: 0.75,
		});
		expect(metrics.wrongSourceRate).toEqual({
			numerator: 1,
			denominator: 4,
			rate: 0.25,
		});
		expect(metrics.irrelevantButOkRate).toEqual({
			numerator: 1,
			denominator: 4,
			rate: 0.25,
		});
		expect(metrics.insufficientFalsePositiveRate).toEqual({
			numerator: 1,
			denominator: 2,
			rate: 0.5,
		});
	});

	test("rounds non-terminating metric rates to exactly six decimals", () => {
		const cases = [
			evaluateRecallCase(routeQualityCase(), {
				kind: "route_contract",
				caseId: "operational_positive_01",
				actualTool: "next_actions",
			}),
			evaluateRecallCase(
				routeQualityCase({ caseId: "operational_positive_02" }),
				{
					kind: "route_contract",
					caseId: "operational_positive_02",
					actualTool: "query",
				},
			),
			evaluateRecallCase(
				routeQualityCase({ caseId: "operational_positive_03" }),
				{
					kind: "route_contract",
					caseId: "operational_positive_03",
					actualTool: "query",
				},
			),
		];

		expect(aggregateRecallMetrics(cases).routeAccuracy).toEqual({
			numerator: 1,
			denominator: 3,
			rate: 0.333333,
		});
	});
});

describe("baseline comparison", () => {
	const knownFailure = (): EvaluatedRecallCase =>
		evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				top3: [
					{
						sourceId: "source_b",
						matchedPointIds: ["point_c", "point_b"],
					},
					{ sourceId: "source_c", matchedPointIds: [] },
				],
			}),
		);

	test("exact ranked source, sorted point IDs, statuses, and failures is known", () => {
		const comparison = compareRecallBaseline(
			[knownFailure()],
			[exactKnownFailureBaseline()],
		);

		expect(comparison.cases).toEqual([
			{
				caseId: "abstract_positive_01",
				failureCodes: [
					"irrelevant_but_ok",
					"recall_miss",
					"wrong_source",
				],
				disposition: "known_failure",
			},
		]);
		expect(comparison.qualityStatus).toBe("known_failure");
		expect(comparison.strictVerdict).toBe("no-go");
		expect(comparison.ciVerdict).toBe("go");
		expect(comparison.counts).toEqual({
			knownFailures: 1,
			regressions: 0,
			unexpectedPasses: 0,
		});
		expect(JSON.stringify(comparison)).not.toContain("source_");
		expect(JSON.stringify(comparison)).not.toContain("point_");
	});

	test.each([
		[
			"source order",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				top3: [...entry.top3].reverse(),
			}),
		],
		[
			"point coverage",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				top3: entry.top3.map((item) =>
					item.sourceId === "source_b"
						? { ...item, matchedPointIds: ["point_b" as const] }
						: item,
				),
			}),
		],
		[
			"failure code",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				failureCodes: ["recall_miss", "wrong_source"] as const,
			}),
		],
		[
			"status",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				answerStatus: "empty" as const,
			}),
		],
		[
			"degradation",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				degradationKind: "evidence" as const,
			}),
		],
		[
			"evidence sufficiency",
			(entry: RecallQualityBaselineEntry) => ({
				...entry,
				evidenceSufficiency: "not_applicable" as const,
			}),
		],
	] as const)("%s drift is a regression", (_label, mutate) => {
		const comparison = compareRecallBaseline(
			[knownFailure()],
			[mutate(exactKnownFailureBaseline())],
		);

		expect(comparison.cases[0]!.disposition).toBe("regression");
		expect(comparison.qualityStatus).toBe("regression");
		expect(comparison.strictVerdict).toBe("no-go");
		expect(comparison.ciVerdict).toBe("no-go");
	});

	test("a baseline entry whose case now passes is an unexpected pass", () => {
		const passing = evaluateRecallCase(answerableCase(), semanticObservation());
		const comparison = compareRecallBaseline(
			[passing],
			[exactKnownFailureBaseline()],
		);

		expect(comparison.cases[0]!.disposition).toBe("unexpected_pass");
		expect(comparison.qualityStatus).toBe("regression");
		expect(comparison.strictVerdict).toBe("no-go");
		expect(comparison.ciVerdict).toBe("no-go");
	});

	test("evidence-derived degraded failure remains exactly baselineable", () => {
		const evaluated = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				answerStatus: "degraded",
				degradationKind: "evidence",
				evidenceSufficiency: "insufficient",
			}),
		);
		const baseline: RecallQualityBaselineEntry = {
			caseId: "abstract_positive_01",
			failureCodes: [
				"degraded_response",
				"insufficient_false_positive",
				"status_mismatch",
			],
			answerStatus: "degraded",
			degradationKind: "evidence",
			evidenceSufficiency: "insufficient",
			top3: [
				{
					sourceId: "source_a",
					matchedPointIds: ["point_a", "point_b"],
				},
			],
			followUp: "#337",
		};

		const comparison = compareRecallBaseline([evaluated], [baseline]);
		expect(comparison.cases[0]!.disposition).toBe("known_failure");
		expect(comparison.strictVerdict).toBe("no-go");
		expect(comparison.ciVerdict).toBe("go");
	});

	test("route, unclassified degradation, and gate integrity failures are never accepted", () => {
		const routeMismatch = evaluateRecallCase(routeQualityCase(), {
			kind: "route_contract",
			caseId: "operational_positive_01",
			actualTool: "query",
		});
		const unclassified = evaluateRecallCase(
			answerableCase(),
			semanticObservation({
				answerStatus: "degraded",
				degradationKind: "unclassified",
				evidenceSufficiency: "not_applicable",
			}),
		);
		const passing = evaluateRecallCase(
			answerableCase({ caseId: "abstract_positive_02" }),
			semanticObservation({ caseId: "abstract_positive_02" }),
		);
		const executionFailure: EvaluatedRecallCase = {
			...passing,
			failureCodes: ["execution_failure"],
		};

		for (const evaluated of [
			routeMismatch,
			unclassified,
			executionFailure,
		]) {
			const comparison = compareRecallBaseline([evaluated], []);
			expect(comparison.cases[0]!.disposition).toBe("regression");
			expect(comparison.strictVerdict).toBe("no-go");
			expect(comparison.ciVerdict).toBe("no-go");
		}
	});

	test("no failures and no baseline makes both verdicts go", () => {
		const passing = evaluateRecallCase(answerableCase(), semanticObservation());
		const comparison = compareRecallBaseline([passing], []);

		expect(comparison.cases[0]!.disposition).toBe("pass");
		expect(comparison.qualityStatus).toBe("pass");
		expect(comparison.strictVerdict).toBe("go");
		expect(comparison.ciVerdict).toBe("go");
	});
});

describe("anonymous recall quality matrix (#324)", () => {
  test("clean fixture passes every lane with stable anonymous cases", async () => {
    const report = await runRecallQualityMatrix();
    expect(report.verdict).toBe("go");
    expect(report.cases.map((c) => c.id)).toEqual([...CASE_IDS]);
    expect(report.lanes).toEqual({ retrieval: "pass", router: "pass", evidence: "pass", latency: "pass" });
    expect(report.cases.every((c) => c.passed)).toBe(true);
  });

  test("retrieval metrics distinguish relevant recall, noise, and honest empty", async () => {
    const report = await runRecallQualityMatrix();
    const abstract = report.cases.find((c) => c.id === "abstract_topic")!;
    const empty = report.cases.find((c) => c.id === "honest_empty")!;
    expect(abstract.metrics.recall_at_k).toBe(1);
    expect(abstract.metrics.noise_at_k).toBe(0);
    expect(abstract.metrics.completion).toBe("complete");
    expect(empty.metrics.honest_empty).toBe(true);
    expect(empty.metrics.noise_at_k).toBe(0);
  });

  test("temporal and relationship cases exercise evidence and router lanes", async () => {
    const report = await runRecallQualityMatrix();
    const temporal = report.cases.find((c) => c.id === "temporal_evidence")!;
    const relationship = report.cases.find((c) => c.id === "relationship_route")!;
    expect(temporal.metrics.evidence_coverage).toBe("sufficient");
    expect(relationship.metrics.route_match).toBe(true);
  });

  test.each(["retrieval", "router", "evidence", "latency", "privacy"] as const)(
    "%s fault produces no-go without leaking fixture content",
    async (fault) => {
      const report = await runRecallQualityMatrix({ fault });
      expect(report.verdict).toBe("no-go");
      const serialized = JSON.stringify(report);
      for (const forbidden of ["实体甲", "组织乙", "Project Alpha", "韧性治理", "/Users/", "slug", "query", "title", "path"]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );

  test("latency fault does not misclassify retrieval, router, or evidence", async () => {
    const report = await runRecallQualityMatrix({ fault: "latency" });
    expect(report.lanes).toEqual({ retrieval: "pass", router: "pass", evidence: "pass", latency: "fail" });
  });

  test("report schema is scalar and fixed-enum only", async () => {
    const report = await runRecallQualityMatrix();
    const serialized = JSON.stringify(report);
    for (const forbidden of ["实体甲", "组织乙", "Project Alpha", "韧性治理", "body", "content", "score", "reason_codes"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.duration_ms).toBeLessThan(5_000);
  });
});
