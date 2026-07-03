import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACTION_CANDIDATE_TYPES,
  isActionCandidateType,
  assertSafeActionDisplay,
  buildActionCandidatesFromDiscoveries,
  buildActionCandidatesFromHealthPlan,
} from "../../src/core/maintenance/action-candidates.js";
import { ActionCandidateManager } from "../../src/core/maintenance/action-candidates.js";
import { CBrainDB } from "../../src/storage/sqlite.js";
import type { RepairPlan } from "../../src/core/maintenance/health-debt.js";

describe("action candidate core helpers (#267)", () => {
  test("recognizes all action candidate types", () => {
    expect(ACTION_CANDIDATE_TYPES).toEqual([
      "action_review_discovery",
      "action_health_review",
      "action_repair_preview",
    ]);
    expect(isActionCandidateType("action_review_discovery")).toBe(true);
    expect(isActionCandidateType("action_health_review")).toBe(true);
    expect(isActionCandidateType("action_repair_preview")).toBe(true);
    expect(isActionCandidateType("gap")).toBe(false);
  });

  test("display guard rejects internal identifiers and debug terms", () => {
    expect(assertSafeActionDisplay("有一项健康问题需要人工确认。")).toBeUndefined();
    expect(() => assertSafeActionDisplay("score=0.9")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("dedup_key=abc")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("entity/private-a")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("/Users/example/private")).toThrow(/unsafe display/i);
    expect(() => assertSafeActionDisplay("SELECT * FROM pages")).toThrow(/unsafe display/i);
  });
});

describe("buildActionCandidatesFromDiscoveries (#267)", () => {
  test("creates one review candidate for high actionable discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 7,
        type: "similar_entity",
        entities: JSON.stringify(["entity/a", "entity/b"]),
        score: 0.9,
        actionable: "high",
        auto_applicable: 0,
        occurrence_count: 1,
        dedup_key: "similar_entity|entity/a|entity/b",
        metadata: JSON.stringify({ reason_code: "name_exact" }),
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe("action_review_discovery");
    expect(drafts[0].entities).toEqual(["discovery:similar_entity|entity/a|entity/b"]);
    expect(drafts[0].actionable).toBe("high");
    expect(drafts[0].metadata.source_type).toBe("similar_entity");
    expect(drafts[0].evidence[0]).toEqual({
      source: "discovery",
      ref: "discovery:similar_entity|entity/a|entity/b",
      kind: "similar_entity",
    });
    expect(drafts[0].proposedActions[0].type).toBe("review");
    expect(drafts[0].displayTitle).not.toContain("entity/");
    expect(drafts[0].displayReason).not.toContain("score");
  });

  test("creates review candidate for repeated medium discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 8,
        type: "gap",
        entities: JSON.stringify(["entity/a"]),
        score: 0.5,
        actionable: "medium",
        auto_applicable: 0,
        occurrence_count: 3,
        dedup_key: "gap|entity/a",
      },
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].actionable).toBe("medium");
    expect(drafts[0].metadata.occurrence_count).toBe(3);
  });

  test("skips low-signal non-repeated discovery", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 9,
        type: "bridge",
        entities: JSON.stringify(["entity/a", "entity/b"]),
        score: 0.2,
        actionable: "low",
        auto_applicable: 0,
        occurrence_count: 1,
        dedup_key: "bridge|entity/a|entity/b",
      },
    ]);

    expect(drafts).toHaveLength(0);
  });

  test("skips already action candidate rows", () => {
    const drafts = buildActionCandidatesFromDiscoveries([
      {
        id: 10,
        type: "action_review_discovery",
        entities: JSON.stringify(["discovery:x"]),
        score: 1,
        actionable: "high",
        auto_applicable: 0,
        occurrence_count: 3,
        dedup_key: "action_review_discovery|discovery:x",
      },
    ]);

    expect(drafts).toHaveLength(0);
  });
});

function makePlan(actions: RepairPlan["actions"]): RepairPlan {
  return {
    source: "2026-07-03T00:00:00.000Z",
    counts: {
      auto_repairable: actions.filter((a) => a.group === "auto_repairable").length,
      needs_review: actions.filter((a) => a.group === "needs_review").length,
      observe_only: actions.filter((a) => a.group === "observe_only").length,
      blocked: actions.filter((a) => a.group === "blocked").length,
    },
    actions,
  };
}

describe("buildActionCandidatesFromHealthPlan (#267)", () => {
  test("creates health review candidate for needs_review action", () => {
    const drafts = buildActionCandidatesFromHealthPlan(makePlan([{
      group: "needs_review",
      dimension: "结构一致性",
      severity: "high",
      slug: "entity/a",
      action: "人工核实结构一致性",
    }]));

    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe("action_health_review");
    expect(drafts[0].entities).toEqual(["health:结构一致性:needs_review:entity/a"]);
    expect(drafts[0].actionable).toBe("high");
    expect(drafts[0].metadata.dimension).toBe("结构一致性");
    expect(drafts[0].metadata.repair_group).toBe("needs_review");
    expect(drafts[0].displayTitle).not.toContain("entity/");
  });

  test("creates repair preview candidate for auto_repairable action", () => {
    const drafts = buildActionCandidatesFromHealthPlan(makePlan([{
      group: "auto_repairable",
      kind: "normalize_reports_to",
      dimension: "结构一致性",
      severity: "medium",
      slug: "entity/a",
      action: "将 reports_to 归一化为完整 slug",
      rollbackNote: "归一化时需写版本快照。",
    }]));

    expect(drafts).toHaveLength(1);
    expect(drafts[0].type).toBe("action_repair_preview");
    expect(drafts[0].actionable).toBe("medium");
    expect(drafts[0].proposedActions[0]).toEqual({
      type: "dry_run",
      target: "health:结构一致性:normalize_reports_to:entity/a",
      reason: "预览这项修复，不自动执行。",
    });
  });

  test("skips observe_only health actions in phase 1", () => {
    const drafts = buildActionCandidatesFromHealthPlan(makePlan([{
      group: "observe_only",
      dimension: "完整性",
      severity: "low",
      slug: "concept/a",
      action: "稀疏 stub，暂保留观察（dry-run 不删除）",
    }]));

    expect(drafts).toHaveLength(0);
  });

  test("uses global stable ref for non-page health action", () => {
    const drafts = buildActionCandidatesFromHealthPlan(makePlan([{
      group: "blocked",
      dimension: "系统错误",
      severity: "high",
      slug: "-",
      action: "检查 runtime/logs 系统日志后重新评估",
    }]));

    expect(drafts).toHaveLength(1);
    expect(drafts[0].entities).toEqual(["health:系统错误:blocked:global"]);
  });
});

describe("ActionCandidateManager persistence (#267)", () => {
  const testDir = "/tmp/cbrain-test-action-candidates";
  const dbPath = join(testDir, "test.sqlite");
  let db: CBrainDB;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new CBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  test("persists one candidate and stores proposed actions", () => {
    const mgr = new ActionCandidateManager(db);
    const draft = buildActionCandidatesFromDiscoveries([{
      id: 1,
      type: "similar_entity",
      entities: JSON.stringify(["entity/a", "entity/b"]),
      score: 0.9,
      actionable: "high",
      auto_applicable: 0,
      occurrence_count: 1,
      dedup_key: "similar_entity|entity/a|entity/b",
    }])[0];

    const report = mgr.persistDrafts([draft]);

    expect(report.total).toBe(1);
    expect(report.inserted).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.byType.action_review_discovery).toBe(1);
    const rows = db.getDiscoveriesByType("action_review_discovery", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].auto_applicable).toBe(0);
    expect(rows[0].proposed_actions).toContain("review");
  });

  test("rerun does not duplicate and increments occurrence count", () => {
    const mgr = new ActionCandidateManager(db);
    const draft = buildActionCandidatesFromDiscoveries([{
      id: 1,
      type: "similar_entity",
      entities: JSON.stringify(["entity/a", "entity/b"]),
      score: 0.9,
      actionable: "high",
      auto_applicable: 0,
      occurrence_count: 1,
      dedup_key: "similar_entity|entity/a|entity/b",
    }])[0];

    mgr.persistDrafts([draft]);
    const second = mgr.persistDrafts([draft]);

    expect(second.total).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    const row = db.getDiscoveriesByType("action_review_discovery", 10)[0];
    const full = db.getDiscoveryById(row.id)!;
    expect(full.occurrence_count).toBe(2);
  });

  test("dismissed candidate is not visible as pending after rerun", () => {
    const mgr = new ActionCandidateManager(db);
    const draft = buildActionCandidatesFromDiscoveries([{
      id: 1,
      type: "similar_entity",
      entities: JSON.stringify(["entity/a", "entity/b"]),
      score: 0.9,
      actionable: "high",
      auto_applicable: 0,
      occurrence_count: 1,
      dedup_key: "similar_entity|entity/a|entity/b",
    }])[0];

    mgr.persistDrafts([draft]);
    const row = db.getDiscoveriesByType("action_review_discovery", 10)[0];
    db.updateDiscoveryStatus(row.id, "dismissed");
    mgr.persistDrafts([draft]);

    expect(db.getDiscoveriesByType("action_review_discovery", 10)).toHaveLength(0);
    const full = db.getDiscoveryById(row.id)!;
    expect(full.status).toBe("dismissed");
    expect(full.occurrence_count).toBe(2);
  });
});
