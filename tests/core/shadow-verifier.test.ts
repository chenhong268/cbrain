import { describe, expect, test } from "bun:test";
import {
  summarizeShadowVerifierObservations,
  verifyDiscoveryCandidate,
  verifyNerExtraction,
  type DiscoveryVerifierInput,
  type NerVerifierInput,
} from "../../src/core/quality/shadow-verifier.js";

function nerInput(over: Partial<NerVerifierInput> = {}): NerVerifierInput {
  return {
    bodyChars: 100,
    entityCount: 1,
    relationCount: 0,
    eventCount: 0,
    factCount: 0,
    entities: [{ name: "实体A", type: "company" }],
    relations: [],
    events: [],
    ...over,
  };
}

describe("verifyNerExtraction", () => {
  test("long body with zero extraction → error ner_zero_from_long_body", () => {
    const obs = verifyNerExtraction(
      nerInput({
        bodyChars: 600,
        entityCount: 0,
        relationCount: 0,
        eventCount: 0,
        factCount: 0,
        entities: [],
      }),
    );
    const e = obs.find((o) => o.code === "ner_zero_from_long_body");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("error");
  });

  test("short body with zero extraction → NOT flagged (below 500 chars)", () => {
    const obs = verifyNerExtraction(
      nerInput({
        bodyChars: 200,
        entityCount: 0,
        entities: [],
      }),
    );
    expect(obs.some((o) => o.code === "ner_zero_from_long_body")).toBe(false);
  });

  test("normal extraction → no warning/error observations", () => {
    const obs = verifyNerExtraction(
      nerInput({
        bodyChars: 400,
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "实体B", type: "person" },
        ],
        relations: [{ from: "实体A", to: "实体B" }],
      }),
    );
    expect(obs.filter((o) => o.severity === "warning" || o.severity === "error")).toEqual([]);
  });

  test("relation endpoint not in entities → warning ner_relation_endpoint_missing", () => {
    const obs = verifyNerExtraction(
      nerInput({
        entities: [{ name: "实体A", type: "company" }],
        relationCount: 1,
        relations: [{ from: "实体A", to: "孤儿C" }],
      }),
    );
    const e = obs.find((o) => o.code === "ner_relation_endpoint_missing");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("warning");
  });

  test("entity count over conservative threshold → warning ner_extraction_unusually_high", () => {
    // bodyChars=2400 → threshold = max(30, floor(2400/80)) = 30; send 31 entities
    const entities = Array.from({ length: 31 }, (_, i) => ({ name: `实体${i}`, type: "concept" }));
    const obs = verifyNerExtraction(
      nerInput({
        bodyChars: 2400,
        entityCount: 31,
        entities,
      }),
    );
    const e = obs.find((o) => o.code === "ner_extraction_unusually_high");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("warning");
  });

  test("6 entities in 500-char body is NOT unusually high (no false positive)", () => {
    // Conservative threshold: max(30, floor(500/80)) = 30. Six is well under.
    const entities = Array.from({ length: 6 }, (_, i) => ({ name: `实体${i}`, type: "company" }));
    const obs = verifyNerExtraction(
      nerInput({
        bodyChars: 500,
        entityCount: 6,
        entities,
      }),
    );
    expect(obs.some((o) => o.code === "ner_extraction_unusually_high")).toBe(false);
  });

  test("same name with conflicting types → warning ner_duplicate_name_conflicting_type", () => {
    const obs = verifyNerExtraction(
      nerInput({
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "实体A", type: "person" },
        ],
      }),
    );
    expect(obs.some((o) => o.code === "ner_duplicate_name_conflicting_type")).toBe(true);
  });

  test("empty entity name → warning ner_invalid_entity_field", () => {
    const obs = verifyNerExtraction(
      nerInput({
        entityCount: 2,
        entities: [
          { name: "实体A", type: "company" },
          { name: "", type: "person" },
        ],
      }),
    );
    expect(obs.some((o) => o.code === "ner_invalid_entity_field")).toBe(true);
  });

  test("event with malformed date → info ner_invalid_event_date", () => {
    const obs = verifyNerExtraction(
      nerInput({
        events: [{ date: "不是日期" }],
        eventCount: 1,
      }),
    );
    const e = obs.find((o) => o.code === "ner_invalid_event_date");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("info");
  });

  test("event with valid YYYY-MM-DD date → NOT flagged", () => {
    const obs = verifyNerExtraction(
      nerInput({
        events: [{ date: "2026-07-03" }],
        eventCount: 1,
      }),
    );
    expect(obs.some((o) => o.code === "ner_invalid_event_date")).toBe(false);
  });
});

describe("summarizeShadowVerifierObservations", () => {
  test("aggregates counts and reason codes, picks worst severity", () => {
    const summary = summarizeShadowVerifierObservations("ner", [
      { surface: "ner", code: "ner_zero_from_long_body", severity: "error" },
      { surface: "ner", code: "ner_invalid_event_date", severity: "info" },
      { surface: "ner", code: "ner_zero_from_long_body", severity: "error" },
    ]);
    expect(summary.counts).toEqual({ info: 1, warning: 0, error: 2 });
    expect(summary.reasonCounts).toEqual({ ner_zero_from_long_body: 2, ner_invalid_event_date: 1 });
    expect(summary.worst).toBe("error");
    expect(summary.checks).toBe(6);
    expect(summary.surface).toBe("ner");
  });

  test("empty observations → worst 'none', zeroed counts", () => {
    const summary = summarizeShadowVerifierObservations("ner", []);
    expect(summary.counts).toEqual({ info: 0, warning: 0, error: 0 });
    expect(summary.worst).toBe("none");
    expect(summary.reasonCounts).toEqual({});
  });
});

function discInput(over: Partial<DiscoveryVerifierInput> = {}): DiscoveryVerifierInput {
  return {
    type: "bridge",
    actionable: "medium",
    score: 0.5,
    autoApplicable: false,
    hasEvidence: false,
    hasProposedActions: false,
    displayTexts: [],
    ...over,
  };
}

describe("verifyDiscoveryCandidate", () => {
  test("high actionable with no evidence and no proposed actions → error", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        type: "contradiction",
        actionable: "high",
        score: 0.9,
        hasEvidence: false,
        hasProposedActions: false,
      }),
    );
    const e = obs.find((o) => o.code === "discovery_high_actionable_no_evidence");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("error");
  });

  test("high actionable WITH evidence → NOT flagged", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        actionable: "high",
        hasEvidence: true,
        hasProposedActions: false,
      }),
    );
    expect(obs.some((o) => o.code === "discovery_high_actionable_no_evidence")).toBe(false);
  });

  test("auto_applicable on action_ type → error", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        type: "action_review_discovery",
        autoApplicable: true,
      }),
    );
    const e = obs.find((o) => o.code === "discovery_auto_applicable_on_review_type");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("error");
  });

  test("score out of [0,1] → warning", () => {
    const obs = verifyDiscoveryCandidate(discInput({ score: 1.5 }));
    expect(obs.some((o) => o.code === "discovery_score_out_of_range")).toBe(true);
  });

  test("unknown actionable value → warning", () => {
    const obs = verifyDiscoveryCandidate(discInput({ actionable: "urgent" }));
    expect(obs.some((o) => o.code === "discovery_score_out_of_range")).toBe(true);
  });

  test("action_ type with all-empty display texts → warning discovery_display_missing_fields", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        type: "action_health_review",
        displayTexts: ["", "  ", ""],
      }),
    );
    expect(obs.some((o) => o.code === "discovery_display_missing_fields")).toBe(true);
  });

  test("display text containing /Users/ path → warning discovery_display_private_raw", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        type: "action_review_discovery",
        displayTexts: ["正常标题", "详情见 /Users/secret/note.md"],
      }),
    );
    const e = obs.find((o) => o.code === "discovery_display_private_raw");
    expect(e).toBeDefined();
    expect(e!.severity).toBe("warning");
  });

  test("metadata-style internal refs in displayTexts are NOT flagged when not user-visible", () => {
    // displayTexts is empty → nothing to scan; internal entity/ refs live elsewhere.
    const obs = verifyDiscoveryCandidate(discInput({ displayTexts: [] }));
    expect(obs.some((o) => o.code === "discovery_display_private_raw")).toBe(false);
  });

  test("normal discovery draft → no warning/error observations", () => {
    const obs = verifyDiscoveryCandidate(
      discInput({
        type: "action_review_discovery",
        actionable: "high",
        score: 0.8,
        hasEvidence: true,
        hasProposedActions: true,
        displayTexts: ["有一条发现值得复核", "建议人工确认", "打开对应发现确认"],
      }),
    );
    expect(obs.filter((o) => o.severity === "warning" || o.severity === "error")).toEqual([]);
  });

  test("summary carries discovery type and check count 5", () => {
    const obs = verifyDiscoveryCandidate(discInput({ type: "similar_entity", score: 2 }));
    const summary = summarizeShadowVerifierObservations("discovery", obs, "similar_entity");
    expect(summary.surface).toBe("discovery");
    expect(summary.type).toBe("similar_entity");
    expect(summary.checks).toBe(5);
    expect(summary.worst).toBe("warning");
  });
});
