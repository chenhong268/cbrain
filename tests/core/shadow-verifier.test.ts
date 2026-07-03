import { describe, expect, test } from "bun:test";
import {
  summarizeShadowVerifierObservations,
  verifyNerExtraction,
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
