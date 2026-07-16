import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runRecallQualityMatrix } from "../../bin/check-recall-quality-matrix.js";
import {
	parseRecallQualityBaseline,
	parseRecallQualityCases,
	parseRecallQualityCorpus,
	SAFE_FIXTURE_TOKENS,
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

const routeCase = (): Record<string, unknown> => ({
	case_id: "operational_positive_01",
	category: "operational_meta",
	kind: "route_contract",
	canonical_input_sha256: "a".repeat(64),
	expected_tool: "next_actions",
	expected_args: { include_raw: false },
	forbidden_tools: ["query", "cbrain_recall", "deep_recall"],
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
		const baseline = parseRecallQualityBaseline(BASELINE_TEXT, cases);

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
		duplicateCase[1]!.case_id = duplicateCase[0]!.case_id;
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

	test("validates baseline exact enums, references, uniqueness, and fixed follow-up", () => {
		const cases = parseCanonicalCases();

		const badFailure = baselineEntry();
		badFailure.failure_codes = ["route_mismatch"];
		expectFixtureError(
			() => parseRecallQualityBaseline(JSON.stringify([badFailure]), cases),
			"invalid_baseline_failure_code",
		);

		const badFollowUp = baselineEntry();
		badFollowUp.follow_up = "#338";
		expectFixtureError(
			() => parseRecallQualityBaseline(JSON.stringify([badFollowUp]), cases),
			"invalid_baseline_follow_up",
		);

		const unknownCase = baselineEntry();
		unknownCase.case_id = "abstract_positive_99";
		expectFixtureError(
			() => parseRecallQualityBaseline(JSON.stringify([unknownCase]), cases),
			"unknown_baseline_case",
		);

		const duplicate = baselineEntry();
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify([duplicate, duplicate]),
					cases,
				),
			"duplicate_baseline_case_id",
		);
	});

	test("baseline root must be an exact JSON array", () => {
		expectFixtureError(
			() =>
				parseRecallQualityBaseline(
					JSON.stringify({ entries: [] }),
					parseCanonicalCases(),
				),
			"baseline_not_array",
		);
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
