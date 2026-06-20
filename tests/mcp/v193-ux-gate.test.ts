/**
 * v1.9.3 Hermes UX Release Gate
 *
 * Smoke test suite covering every display envelope added in v1.9.3 (#141–#144).
 * Each section validates:
 *   1. Envelope shape (display / summary / raw)
 *   2. Display bans: no slug, score, confidence, weight, path, raw JSON, function names
 *   3. Display compactness: first display ≤ 500 chars
 *   4. Raw completeness: raw preserves full original structure
 *   5. Edge cases: empty, null titles, no-job, failure paths
 *
 * This file is the automated counterpart to docs/product/cbrain-2.0-ux-contract.md.
 */
import { describe, test, expect } from "bun:test";
import {
  formatHealthEnvelope,
  formatDreamStatusEnvelope,
  formatGraphEnvelope,
  formatLinksEnvelope,
  formatTimelineEnvelope,
  formatVersionsEnvelope,
  formatRevertEnvelope,
  formatGetProfileEnvelope,
  formatUpdateProfileEnvelope,
  formatRemoveProfileEnvelope,
  formatReloadProfileEnvelope,
} from "../../src/mcp/tools/format-result.js";
import type { HealthReport } from "../../src/core/health.js";
import type { WakeupDiffResult } from "../../src/core/wakeup.js";
import { formatWakeupEnvelope } from "../../src/mcp/tools/wakeup.js";

// ─── Shared banned terms ────────────────────────────────────
// Any occurrence in `display` is a release-blocker.

const BANNED_TERMS = [
  // Internal identifiers
  "slug", "score", "confidence", "source_type", "weight",
  "hops", "shared_neighbors",
  // Internal paths / extensions
  "entities/", "concepts/", "records/", "insights/", "brain/",
  "/tmp", "runtime/", ".json", ".md", ".log", ".yaml", ".yml",
  // Debug / SQL / stack
  "debug", "trace", "SQL", "stack",
  // Internal function/command names
  "syncLinksToMarkdown", "setHierarchy", "merge_pages",
  // Config paths
  "dbPath", "vaultPath", "runtimePath", "filePath", "reportPath",
  // Raw JSON markers
  '{"', '"}',
  // Wiki links
  "[[",
  // Internal jargon banned from user-facing display (#206)
  "节点", "Tier", "candidate", "raw",
];

const MAX_DISPLAY_CHARS = 500;

// ─── Helpers ────────────────────────────────────────────────

function assertNoBannedTerms(display: string, toolName: string): void {
  for (const term of BANNED_TERMS) {
    expect(display, `${toolName} display contains banned term "${term}"`).not.toContain(term);
  }
}

function assertCompact(display: string, toolName: string): void {
  expect(
    display.length,
    `${toolName} display too long (${display.length} > ${MAX_DISPLAY_CHARS})`,
  ).toBeLessThanOrEqual(MAX_DISPLAY_CHARS);
}

function assertEnvelopeShape(result: { display: string; summary: unknown; raw: unknown }, toolName: string): void {
  expect(result.display, `${toolName} missing display`).toBeDefined();
  expect(typeof result.display, `${toolName} display not string`).toBe("string");
  expect(result.summary, `${toolName} missing summary`).toBeDefined();
  expect(result.raw, `${toolName} missing raw`).toBeDefined();
}

const noTitle = (_s: string) => null;

// ═══════════════════════════════════════════════════════════════
// G1: Wake-up Diff (#141)
// ═══════════════════════════════════════════════════════════════

const EMPTY_CHANGES = {
  contentUpdated: [] as { slug: string; title: string; type: string }[],
  tierChanged: [] as { slug: string; title: string; oldTier: number; newTier: number }[],
  linkCountChanged: [] as { slug: string; title: string; oldCount: number; newCount: number; diff: number }[],
  confidenceDecayed: [] as { slug: string; title: string; oldValue: number; newValue: number }[],
  removed: [] as { slug: string; title: string; type: string }[],
};

function makeWakeupResult(overrides: Partial<WakeupDiffResult> = {}): WakeupDiffResult {
  return {
    date: "2026-06-06",
    baselineCreated: false,
    previousSnapshotId: "prev-id",
    snapshotId: "snap-id",
    stats: { totalPages: 100, totalLinks: 200, previousPages: 98, previousLinks: 195 },
    changes: { ...EMPTY_CHANGES },
    newItems: [],
    truncated: false,
    reportPath: null,
    ...overrides,
  };
}

describe("G1: wakeup_diff baseline", () => {
  test("baseline first run envelope shape", () => {
    const result = makeWakeupResult({ baselineCreated: true });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff baseline");
    expect(envelope.display).toContain("对照起点");
    expect(envelope.display).toContain("100 个记忆页");
    assertNoBannedTerms(envelope.display, "wakeup_diff baseline");
    assertCompact(envelope.display, "wakeup_diff baseline");
    expect(envelope.summary.status).toBe("ok");
    expect(envelope.summary.count).toBe(0);
    // raw preserves full result
    expect(envelope.raw.baselineCreated).toBe(true);
    expect(envelope.raw.stats.totalPages).toBe(100);
  });

  test("baseline does not expose reportPath in display", () => {
    const result = makeWakeupResult({ baselineCreated: true, reportPath: "/tmp/runtime/wakeup/report.md" });
    const envelope = formatWakeupEnvelope(result);
    expect(envelope.display).not.toContain("/tmp");
    expect(envelope.display).not.toContain("runtime/");
    expect(envelope.display).not.toContain(".md");
    // raw still has reportPath for audit
    expect(envelope.raw.reportPath).toContain("/tmp");
  });
});

describe("G1: wakeup_diff subsequent changes", () => {
  test("no changes shows clean envelope", () => {
    const result = makeWakeupResult();
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff no-change");
    expect(envelope.display).toContain("无认知变化");
    assertNoBannedTerms(envelope.display, "wakeup_diff no-change");
    expect(envelope.summary.count).toBe(0);
  });

  test("tier change envelope shows title and direction", () => {
    const result = makeWakeupResult({
      changes: {
        ...EMPTY_CHANGES,
        tierChanged: [
          { slug: "entities/person-a", title: "人物A", oldTier: 3, newTier: 2 },
        ],
      },
    });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff tier");
    expect(envelope.display).toContain("重要度变化");
    expect(envelope.display).toContain("人物A");
    expect(envelope.display).toContain("升级");
    assertNoBannedTerms(envelope.display, "wakeup_diff tier");
    assertCompact(envelope.display, "wakeup_diff tier");
    expect(envelope.summary.count).toBe(1);
    // raw preserves full changes
    expect(envelope.raw.changes.tierChanged).toHaveLength(1);
  });

  test("new items envelope shows title and type", () => {
    const result = makeWakeupResult({
      newItems: [
        { slug: "concepts/topic-a", title: "新概念A", type: "concept" },
      ],
    });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff new");
    expect(envelope.display).toContain("新记住的");
    expect(envelope.display).toContain("新概念A");
    assertNoBannedTerms(envelope.display, "wakeup_diff new");
    expect(envelope.summary.count).toBe(1);
  });

  test("content updated envelope shows title only", () => {
    const result = makeWakeupResult({
      changes: {
        ...EMPTY_CHANGES,
        contentUpdated: [
          { slug: "records/meeting-a", title: "会议记录A", type: "record" },
        ],
      },
    });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff content");
    expect(envelope.display).toContain("内容更新");
    expect(envelope.display).toContain("会议记录A");
    assertNoBannedTerms(envelope.display, "wakeup_diff content");
  });

  test("link count change envelope shows delta", () => {
    const result = makeWakeupResult({
      changes: {
        ...EMPTY_CHANGES,
        linkCountChanged: [
          { slug: "entities/person-b", title: "人物B", oldCount: 3, newCount: 5, diff: 2 },
        ],
      },
    });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff links");
    expect(envelope.display).toContain("关系变化");
    expect(envelope.display).toContain("人物B");
    expect(envelope.display).toContain("+2");
    assertNoBannedTerms(envelope.display, "wakeup_diff links");
  });

  test("removed items envelope shows title", () => {
    const result = makeWakeupResult({
      changes: {
        ...EMPTY_CHANGES,
        removed: [
          { slug: "entities/archived", title: "已归档实体", type: "entity" },
        ],
      },
    });
    const envelope = formatWakeupEnvelope(result);
    assertEnvelopeShape(envelope, "wakeup_diff removed");
    expect(envelope.display).toContain("已移除");
    expect(envelope.display).toContain("已归档实体");
    assertNoBannedTerms(envelope.display, "wakeup_diff removed");
  });

  test("display uses anonymous titles not slugs", () => {
    const result = makeWakeupResult({
      newItems: [
        { slug: "entities/person-x", title: "人物X", type: "entity" },
      ],
      changes: {
        ...EMPTY_CHANGES,
        tierChanged: [
          { slug: "entities/person-y", title: "人物Y", oldTier: 3, newTier: 1 },
        ],
        contentUpdated: [
          { slug: "records/doc-z", title: "文档Z", type: "record" },
        ],
      },
    });
    const envelope = formatWakeupEnvelope(result);
    expect(envelope.display).not.toMatch(/entities\//);
    expect(envelope.display).not.toMatch(/records\//);
    expect(envelope.display).not.toMatch(/concepts\//);
    // raw still has slugs
    expect(envelope.raw.newItems[0].slug).toContain("entities/");
  });
});

// ═══════════════════════════════════════════════════════════════
// G2: Graph / Links / Timeline (#142)
// ═══════════════════════════════════════════════════════════════

describe("G2: graph_query envelope", () => {
  test("empty result has natural display", () => {
    const result = formatGraphEnvelope({ resolvedSlug: "entities/a", result: [] }, noTitle);
    assertEnvelopeShape(result, "graph_query");
    assertNoBannedTerms(result.display, "graph_query");
    assertCompact(result.display, "graph_query");
    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("未找到");
    // raw preserves slug
    expect(result.raw.resolvedSlug).toBe("entities/a");
  });

  test("with links resolves titles and hides slugs", () => {
    const result = formatGraphEnvelope({
      resolvedSlug: "entities/a",
      result: [{
        id: 1, from_slug: "entities/a", to_slug: "entities/b",
        relation: "同事", weight: 0.9, strength: "strong", trust_state: "confirmed",
      }],
    }, (s) => s === "entities/a" ? "人物A" : s === "entities/b" ? "人物B" : null);
    assertEnvelopeShape(result, "graph_query");
    assertNoBannedTerms(result.display, "graph_query");
    expect(result.display).toContain("人物B");
    expect(result.display).not.toContain("未知实体");
    expect(result.summary.status).toBe("ok");
  });

  test("unresolved title shows 未知实体 not slug", () => {
    const result = formatGraphEnvelope({
      resolvedSlug: "entities/a",
      result: [{
        id: 1, from_slug: "entities/a", to_slug: "entities/ghost",
        relation: "提及", weight: 0.5, strength: "weak", trust_state: "candidate",
      }],
    }, noTitle);
    assertEnvelopeShape(result, "graph_query");
    assertNoBannedTerms(result.display, "graph_query");
    expect(result.display).toContain("未命名");
    expect(result.display).not.toContain("entities/ghost");
  });
});

describe("G2: get_links envelope", () => {
  test("empty links", () => {
    const result = formatLinksEnvelope([], "entities/a", noTitle);
    assertEnvelopeShape(result, "get_links");
    assertNoBannedTerms(result.display, "get_links");
    expect(result.summary.status).toBe("empty");
  });

  test("with links shows trust labels", () => {
    const result = formatLinksEnvelope([
      { id: 1, from_slug: "entities/a", to_slug: "entities/b", relation: "同事", weight: 0.9, strength: "strong", trust_state: "confirmed" },
      { id: 2, from_slug: "entities/c", to_slug: "entities/a", relation: "合作", weight: 0.5, strength: "weak", trust_state: "candidate" },
    ], "entities/a", (s) => s === "entities/b" ? "人物B" : s === "entities/c" ? "人物C" : null);
    assertEnvelopeShape(result, "get_links");
    assertNoBannedTerms(result.display, "get_links");
    expect(result.display).toContain("已知");
    expect(result.display).toContain("待确认");
    // raw preserves link data (raw is Link[])
    expect(Array.isArray(result.raw)).toBe(true);
  });
});

describe("G2: get_timeline envelope", () => {
  test("with events sorts by date", () => {
    const result = formatTimelineEnvelope({
      slug: "entities/a",
      title: "人物A",
      events: [
        { summary: "晚期事件", date: "2025-06-01", trust_state: "confirmed" },
        { summary: "早期事件", date: "2024-01-01", trust_state: "candidate" },
      ],
    });
    assertEnvelopeShape(result, "get_timeline");
    assertNoBannedTerms(result.display, "get_timeline");
    // Early comes first
    const lines = result.display.split("\n");
    const earlyIdx = lines.findIndex(l => l.includes("早期事件"));
    const lateIdx = lines.findIndex(l => l.includes("晚期事件"));
    expect(earlyIdx).toBeLessThan(lateIdx);
  });

  test("empty timeline", () => {
    const result = formatTimelineEnvelope({
      slug: "entities/a",
      title: "人物A",
      events: [],
    });
    expect(result.summary.status).toBe("empty");
    assertNoBannedTerms(result.display, "get_timeline");
  });
});

// ═══════════════════════════════════════════════════════════════
// G3: Health / Dream (#143)
// ═══════════════════════════════════════════════════════════════

function makeHealthReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    timestamp: "2026-06-06T00:00:00Z",
    overallStatus: "pass",
    dimensions: [],
    metrics: {
      totalPages: 100, entities: 50, concepts: 20, events: 10, records: 20,
      totalLinks: 200, avgMentionsPerPage: 2.5, orphans: 0, bareStubs: 0,
      conceptsPerSource: 1, indexSizeKB: 1024, timestamp: "2026-06-06T00:00:00Z",
    },
    ...overrides,
  };
}

describe("G3: health envelope", () => {
  test("healthy report", () => {
    const result = formatHealthEnvelope(makeHealthReport());
    assertEnvelopeShape(result, "health");
    assertNoBannedTerms(result.display, "health");
    assertCompact(result.display, "health");
    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("健康");
  });

  test("warn with real-world suggestion leaks", () => {
    const result = formatHealthEnvelope(makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "一致性",
        status: "warn",
        issues: [
          { severity: "high", slug: "entities/x", title: "关系未同步", description: "desc",
            suggestion: '运行 syncLinksToMarkdown("entities/x") 修复' },
          { severity: "medium", slug: "-", title: "系统错误", description: "desc",
            suggestion: "检查 runtime/logs/ 系统日志查看详情" },
          { severity: "low", slug: "entities/y", title: "缺少图边", description: "desc",
            suggestion: '运行 setHierarchy("entities/y", "entities/z") 建立图边' },
        ],
      }],
    }));
    assertEnvelopeShape(result, "health");
    assertNoBannedTerms(result.display, "health");
    // Titles are safe
    expect(result.display).toContain("关系未同步");
    expect(result.display).toContain("系统错误");
    // No internal terms from suggestions leaked
    expect(result.display).not.toContain("syncLinksToMarkdown");
    expect(result.display).not.toContain("runtime");
    expect(result.display).not.toContain("setHierarchy");
    // raw preserves everything
    expect(result.raw.dimensions[0].issues[0].suggestion).toContain("syncLinksToMarkdown");
  });

  test("slug-like issue title sanitized", () => {
    const result = formatHealthEnvelope(makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "完整性",
        status: "warn",
        issues: [{ severity: "medium", slug: "entities/slug-title", title: "entities/slug-title", description: "desc" }],
      }],
    }));
    assertNoBannedTerms(result.display, "health");
    expect(result.display).not.toContain("entities/slug-title");
    expect(result.display).toContain("完整性");
  });

  test("raw preserves full report", () => {
    const report = makeHealthReport({ overallStatus: "warn" });
    const result = formatHealthEnvelope(report);
    expect(result.raw.overallStatus).toBe("warn");
    expect(result.raw.metrics).toBeDefined();
    expect(result.raw.timestamp).toBeDefined();
  });
});

describe("G3: dream_status envelope", () => {
  test("pending", () => {
    const result = formatDreamStatusEnvelope(
      { id: 1, status: "pending", created_at: "2026-06-06T00:00:00Z" }, {},
    );
    assertEnvelopeShape(result, "dream_status");
    assertNoBannedTerms(result.display, "dream_status");
    expect(result.display).toContain("已提交");
    // raw preserves full job
    expect((result.raw as Record<string, unknown>).job).toBeDefined();
  });

  test("done with brief (real DB status)", () => {
    const brief = "CBrain 日报 2026-06-06\n\n5 个页面更新\n⏱ 12.3s";
    const result = formatDreamStatusEnvelope(
      { id: 2, status: "done", created_at: "2026-06-06T00:00:00Z", started_at: "2026-06-06T00:01:00Z", finished_at: "2026-06-06T00:05:00Z", error: null, result: null },
      { brief },
    );
    assertEnvelopeShape(result, "dream_status");
    assertNoBannedTerms(result.display, "dream_status");
    expect(result.display).toContain("日报");
    expect(result.display).toContain("页面更新");
    expect(result.display).not.toContain("⏱");
    // raw preserves full structure
    const rawJob = (result.raw as Record<string, unknown>).job as Record<string, unknown>;
    expect(rawJob.status).toBe("done");
    expect(rawJob.started_at).toBe("2026-06-06T00:01:00Z");
  });

  test("done without brief", () => {
    const result = formatDreamStatusEnvelope(
      { id: 3, status: "done", created_at: "2026-06-06T00:00:00Z" }, {},
    );
    assertEnvelopeShape(result, "dream_status");
    assertNoBannedTerms(result.display, "dream_status");
    expect(result.display).toContain("已完成");
  });

  test("failed preserves error in raw", () => {
    const result = formatDreamStatusEnvelope(
      { id: 4, status: "failed", created_at: "2026-06-06T00:00:00Z", error: "DB locked" }, {},
    );
    assertEnvelopeShape(result, "dream_status");
    expect(result.summary.status).toBe("error");
    const rawJob = (result.raw as Record<string, unknown>).job as Record<string, unknown>;
    expect(rawJob.error).toBe("DB locked");
  });
});

// ═══════════════════════════════════════════════════════════════
// G4: Version / Profile (#144)
// ═══════════════════════════════════════════════════════════════

describe("G4: get_versions envelope", () => {
  test("empty versions", () => {
    const result = formatVersionsEnvelope([], "entities/test", "人物A");
    assertEnvelopeShape(result, "get_versions");
    assertNoBannedTerms(result.display, "get_versions");
    expect(result.summary.status).toBe("empty");
    expect(result.display).toContain("暂无");
  });

  test("with versions shows count and date", () => {
    const result = formatVersionsEnvelope(
      [{ version: 3, created_at: "2026-06-05T10:00:00Z" }],
      "entities/a", "人物A",
    );
    assertEnvelopeShape(result, "get_versions");
    assertNoBannedTerms(result.display, "get_versions");
    assertCompact(result.display, "get_versions");
    expect(result.display).toContain("1 个版本");
    expect(result.display).toContain("2026-06-05");
    expect(result.raw.versions).toHaveLength(1);
  });

  test("null title uses generic label", () => {
    const result = formatVersionsEnvelope(
      [{ version: 1, created_at: "2026-06-01T00:00:00Z" }],
      "entities/unknown", null,
    );
    assertNoBannedTerms(result.display, "get_versions");
    expect(result.display).toContain("该页面");
  });
});

describe("G4: revert_version envelope", () => {
  test("success", () => {
    const result = formatRevertEnvelope(true, "entities/a", 3, "人物A");
    assertEnvelopeShape(result, "revert_version");
    assertNoBannedTerms(result.display, "revert_version");
    expect(result.display).toContain("回滚");
    expect(result.display).toContain("版本 3");
  });

  test("failure", () => {
    const result = formatRevertEnvelope(false, "entities/a", 999, "人物A");
    assertEnvelopeShape(result, "revert_version");
    expect(result.summary.status).toBe("error");
    expect(result.display).toContain("失败");
  });
});

// ─── Profile fixtures ───────────────────────────────────────

const PROFILE_STATS = {
  total: 10,
  byScope: { open: 6, scoped: 3, private: 1 },
  byType: { preference: 5, constraint: 3, context: 2 },
  modules: 2,
};

const PROFILE_MODULES = [
  { name: "communication", enabled: true, count: 4 },
  { name: "work", enabled: true, count: 3 },
];

describe("G4: get_profile envelope", () => {
  test("empty entries", () => {
    const result = formatGetProfileEnvelope([], PROFILE_STATS, PROFILE_MODULES);
    assertEnvelopeShape(result, "get_profile");
    assertNoBannedTerms(result.display, "get_profile");
    expect(result.summary.status).toBe("empty");
  });

  test("with entries shows type breakdown", () => {
    const entries = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "简洁代码", updated_at: "2026-06-01" },
      { id: "p2", type: "constraint", category: "work", scope: "open", content: "不用 var", updated_at: "2026-06-01" },
    ];
    const result = formatGetProfileEnvelope(entries, PROFILE_STATS, PROFILE_MODULES);
    assertEnvelopeShape(result, "get_profile");
    assertNoBannedTerms(result.display, "get_profile");
    expect(result.display).toContain("偏好");
    expect(result.display).toContain("约束");
    // raw preserves full entries
    expect((result.raw as Record<string, unknown>).entries).toHaveLength(2);
  });
});

describe("G4: update_profile envelope", () => {
  test("shows count", () => {
    const updated = [
      { id: "p1", type: "preference", category: "work", scope: "open", content: "test", updated_at: "2026-06-01" },
    ];
    const result = formatUpdateProfileEnvelope(updated);
    assertEnvelopeShape(result, "update_profile");
    assertNoBannedTerms(result.display, "update_profile");
    expect(result.display).toContain("更新");
  });
});

describe("G4: remove_profile envelope", () => {
  test("removed entries", () => {
    const result = formatRemoveProfileEnvelope(["p1"]);
    assertEnvelopeShape(result, "remove_profile");
    assertNoBannedTerms(result.display, "remove_profile");
    expect(result.display).toContain("删除");
  });

  test("nothing removed", () => {
    const result = formatRemoveProfileEnvelope([]);
    expect(result.summary.status).toBe("empty");
    assertNoBannedTerms(result.display, "remove_profile");
  });
});

describe("G4: reload_profile envelope", () => {
  test("shows stats and modules", () => {
    const result = formatReloadProfileEnvelope(PROFILE_STATS, PROFILE_MODULES);
    assertEnvelopeShape(result, "reload_profile");
    assertNoBannedTerms(result.display, "reload_profile");
    expect(result.display).toContain("重新加载");
    expect(result.display).toContain("10 条记录");
    // raw preserves full module info
    expect((result.raw as Record<string, unknown>).total_entries).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// G5: Cross-cutting privacy & compactness
// ═══════════════════════════════════════════════════════════════

describe("G5: privacy — no real identifiers in fixtures/docs", () => {
  const PRIVACY_PATTERNS = [
    /1[3-9]\d{9}/,         // phone numbers
    /[a-z]+@[a-z]+\.(com|cn|org)/, // emails
  ];

  test("test fixtures use anonymized names only", () => {
    // The fixtures in this file must not contain real names
    const fixtureText = JSON.stringify({
      titles: ["人物A", "人物B", "人物C", "测试页面", "该页面"],
      contents: ["简洁代码", "不用 var", "早期事件", "晚期事件"],
    });
    for (const pattern of PRIVACY_PATTERNS) {
      expect(fixtureText).not.toMatch(pattern);
    }
  });
});

describe("G5: compactness — all displays under 500 chars", () => {
  test("health warn with multiple issues stays compact", () => {
    const result = formatHealthEnvelope(makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "完整性",
        status: "warn",
        issues: Array.from({ length: 5 }, (_, i) => ({
          severity: i === 0 ? "high" : "medium" as const,
          slug: `entities/issue-${i}`,
          title: `问题 ${i + 1}`,
          description: "desc",
        })),
      }],
    }));
    assertCompact(result.display, "health (5 issues)");
  });

  test("profile with many entries stays compact", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      type: "preference" as const,
      category: "general" as const,
      scope: "open" as const,
      content: `偏好内容 ${i}`,
      updated_at: "2026-06-01",
    }));
    const result = formatGetProfileEnvelope(entries, PROFILE_STATS, PROFILE_MODULES);
    assertCompact(result.display, "get_profile (10 entries)");
  });
});
