import { describe, expect, test } from "bun:test";
import { runRecallQualityMatrix } from "../../bin/check-recall-quality-matrix.js";

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
