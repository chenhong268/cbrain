import { describe, test, expect } from "bun:test";
import { formatHealthEnvelope, formatDreamStatusEnvelope } from "../../src/mcp/tools/format-result.js";
import type { HealthReport } from "../../src/core/health.js";

const BANNED_IN_DISPLAY = [
  "slug", "score", "confidence", "source_type", "weight",
  "hops", "shared_neighbors", "raw", "debug",
  "/tmp", "runtime", ".json", "reportPath",
  "entities/", "concepts/", "records/", "insights/", "brain/",
  "threshold", "latency_ms", "duration_ms",
  "SQL", "stack", "trace",
  "syncLinksToMarkdown", "setHierarchy", "filePath",
  "[[", ".md", ".log",
  // Internal jargon banned from user-facing display (#206)
  "节点", "candidate", "高优先级",
];

function makeHealthReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    timestamp: "2026-06-06T00:00:00Z",
    overallStatus: "pass",
    dimensions: [],
    metrics: {
      totalPages: 100,
      entities: 50,
      concepts: 20,
      events: 10,
      records: 20,
      totalLinks: 200,
      avgMentionsPerPage: 2.5,
      orphans: 0,
      bareStubs: 0,
      conceptsPerSource: 1,
      indexSizeKB: 1024,
      timestamp: "2026-06-06T00:00:00Z",
    },
    ...overrides,
  };
}

describe("formatHealthEnvelope", () => {
  test("healthy report shows clean status", () => {
    const report = makeHealthReport();
    const result = formatHealthEnvelope(report);

    expect(result.summary.status).toBe("ok");
    expect(result.display).toContain("健康");
    expect(result.display).toContain("无问题");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("warn report with issues shows top issues", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [
        {
          name: "孤岛检测",
          status: "warn",
          issues: [
            { severity: "high", slug: "entities/orphan1", title: "孤立实体：人物A", description: "无任何关系", suggestion: "检查并补充关系" },
            { severity: "medium", slug: "entities/orphan2", title: "孤立实体：人物B", description: "无任何关系" },
            { severity: "low", slug: "entities/orphan3", title: "孤立实体：人物C", description: "无任何关系" },
            { severity: "low", slug: "entities/orphan4", title: "孤立实体：人物D", description: "无任何关系" },
          ],
        },
      ],
    });
    const result = formatHealthEnvelope(report);

    expect(result.summary.status).toBe("degraded");
    expect(result.summary.count).toBe(4);
    expect(result.display).toContain("需注意");
    expect(result.display).toContain("4 个问题");
    // Shows top 3 issues by severity
    expect(result.display).toContain("孤立实体：人物A");
    expect(result.display).toContain("还有 1 个问题");
    // High severity triggers user action warning
    expect(result.display).toContain("紧急");
  });

  test("display has no banned fields even with issues", () => {
    const report = makeHealthReport({
      overallStatus: "fail",
      dimensions: [
        {
          name: "一致性",
          status: "fail",
          issues: [
            { severity: "high", slug: "entities/x", title: "标题冲突", description: "标题重复" },
          ],
        },
      ],
    });
    const result = formatHealthEnvelope(report);

    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
    // No slug exposure
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("slug");
  });

  test("raw preserves full structure", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [
        {
          name: "完整性",
          status: "warn",
          issues: [
            { severity: "medium", slug: "entities/test", title: "Test issue", description: "desc" },
          ],
        },
      ],
    });
    const result = formatHealthEnvelope(report);

    // raw keeps everything
    expect(result.raw.overallStatus).toBe("warn");
    expect(result.raw.dimensions).toHaveLength(1);
    expect(result.raw.metrics).toBeDefined();
    expect(result.raw.timestamp).toBeDefined();
  });

  test("fail status shows problems label", () => {
    const report = makeHealthReport({ overallStatus: "fail" });
    const result = formatHealthEnvelope(report);
    expect(result.display).toContain("有问题");
  });

  test("safe suggestion shown for clean text", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "孤岛检测",
        status: "warn",
        issues: [
          { severity: "high", slug: "entities/x", title: "孤立实体", description: "无关系", suggestion: "补充关系" },
        ],
      }],
    });
    const result = formatHealthEnvelope(report);
    expect(result.display).toContain("补充关系");
  });

  // ─── Real leakage scenario tests ───────────────────────────

  test("suggestion with runtime/logs is stripped from display", () => {
    const report = makeHealthReport({
      overallStatus: "fail",
      dimensions: [{
        name: "系统错误",
        status: "fail",
        issues: [{
          severity: "high",
          slug: "-",
          title: "2 个系统错误",
          description: "最近发现错误",
          suggestion: "检查 runtime/logs/ 系统日志查看详情",
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).toContain("系统错误");
    expect(result.display).not.toContain("runtime");
    expect(result.display).not.toContain("logs/");
    expect(result.display).not.toContain("runtime/");
  });

  test("suggestion with syncLinksToMarkdown and slug is stripped", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "一致性",
        status: "warn",
        issues: [{
          severity: "medium",
          slug: "entities/person-a",
          title: "关系未同步",
          description: "出边未写入",
          suggestion: '运行 syncLinksToMarkdown("entities/person-a") 修复',
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).toContain("关系未同步");
    expect(result.display).not.toContain("syncLinksToMarkdown");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("person-a");
  });

  test("suggestion with setHierarchy and slug is stripped", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "组织结构",
        status: "warn",
        issues: [{
          severity: "high",
          slug: "entities/org-a",
          title: "缺少图边",
          description: "reports_to 缺边",
          suggestion: '运行 setHierarchy("entities/org-a", "entities/org-b") 建立图边',
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).toContain("缺少图边");
    expect(result.display).not.toContain("setHierarchy");
    expect(result.display).not.toContain("entities/");
  });

  test("suggestion with wiki-links and filePath is stripped", () => {
    const report = makeHealthReport({
      overallStatus: "fail",
      dimensions: [{
        name: "标题冲突隔离",
        status: "fail",
        issues: [{
          severity: "high",
          slug: "entities/dup",
          title: "重复标题",
          description: "标题冲突",
          suggestion: '重命名 path/to/file.md 的 title，或用 merge_pages 合并到 entities/existing',
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).toContain("重复标题");
    expect(result.display).not.toContain(".md");
    expect(result.display).not.toContain("filePath");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("merge_pages");
  });

  test("suggestion with [[slug]] wiki-links is stripped", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "语义去重",
        status: "warn",
        issues: [{
          severity: "high",
          slug: "entities/dup-a",
          title: "语义重复",
          description: "Duplicate",
          suggestion: 'Merge into [[entities/dup-b]] or delete duplicate',
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).toContain("语义重复");
    expect(result.display).not.toContain("[[");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("dup-b");
  });

  test("slug-like issue title is replaced with dimension name", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "一致性",
        status: "warn",
        issues: [{
          severity: "medium",
          slug: "entities/person-a",
          // Simulates page.title ?? slug fallback producing a slug
          title: "entities/person-a",
          description: "关系未同步",
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("person-a");
    // Should show dimension-based label instead
    expect(result.display).toContain("一致性问题");
    // raw still has the original title
    expect(result.raw.dimensions[0].issues[0].title).toBe("entities/person-a");
  });
});

describe("formatDreamStatusEnvelope", () => {
  test("pending job shows submitted message", () => {
    const result = formatDreamStatusEnvelope(
      { id: 1, status: "pending", created_at: "2026-06-06T00:00:00Z" },
      {},
    );

    expect(result.display).toContain("已提交");
    expect(result.summary.status).toBe("ok");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("running job shows current stage", () => {
    const result = formatDreamStatusEnvelope(
      { id: 2, status: "running", created_at: "2026-06-06T00:00:00Z" },
      { current_stage: "同步" },
    );

    expect(result.display).toContain("执行中");
    expect(result.display).toContain("同步");
  });

  test("failed job shows failure message", () => {
    const result = formatDreamStatusEnvelope(
      { id: 3, status: "failed", error: "DB locked", created_at: "2026-06-06T00:00:00Z" },
      {},
    );

    expect(result.display).toContain("失败");
    expect(result.summary.status).toBe("error");
  });

  test("completed job with brief uses cleaned brief", () => {
    const brief = "CBrain 日报 2026-06-06\n\n5 个页面更新\n2 个实体升级\n健康: ✅ 0 个问题\n\n⏱ 12.3s";
    const result = formatDreamStatusEnvelope(
      { id: 4, status: "completed", created_at: "2026-06-06T00:00:00Z" },
      { brief },
    );

    expect(result.display).toContain("日报");
    expect(result.display).toContain("页面更新");
    // Timer/duration should be removed
    expect(result.display).not.toContain("⏱");
  });

  test("completed job without brief shows generic message", () => {
    const result = formatDreamStatusEnvelope(
      { id: 5, status: "completed", created_at: "2026-06-06T00:00:00Z" },
      {},
    );

    expect(result.display).toContain("已完成");
  });

  test("raw preserves complete job and progress", () => {
    const job = {
      id: 6,
      status: "completed" as const,
      created_at: "2026-06-06T00:00:00Z",
      started_at: "2026-06-06T00:01:00Z",
      finished_at: "2026-06-06T00:05:00Z",
      error: null,
      result: null,
    };
    const progress = { brief: "test", sync: { synced: 5 } };
    const result = formatDreamStatusEnvelope(job, progress);

    // raw keeps full job + progress
    const rawJob = result.raw.job as typeof job;
    expect(rawJob).toEqual(job);
    expect(result.raw.progress).toEqual(progress);
    expect(rawJob.id).toBe(6);
    expect(rawJob.created_at).toBe("2026-06-06T00:00:00Z");
    expect(rawJob.started_at).toBe("2026-06-06T00:01:00Z");
    expect(rawJob.finished_at).toBe("2026-06-06T00:05:00Z");
  });

  test("raw preserves pending job fields", () => {
    const job = {
      id: 10,
      status: "pending" as const,
      created_at: "2026-06-06T01:00:00Z",
      started_at: null,
      finished_at: null,
      error: null,
      result: null,
    };
    const result = formatDreamStatusEnvelope(job, { queued: true });

    const rawJob = result.raw.job as typeof job;
    expect(rawJob).toEqual(job);
    expect(result.raw.progress).toEqual({ queued: true });
    expect(rawJob.created_at).toBe("2026-06-06T01:00:00Z");
  });

  test("raw preserves failed job with error", () => {
    const job = {
      id: 11,
      status: "failed" as const,
      created_at: "2026-06-06T02:00:00Z",
      started_at: "2026-06-06T02:01:00Z",
      finished_at: "2026-06-06T02:02:00Z",
      error: "DB locked",
      result: null,
    };
    const result = formatDreamStatusEnvelope(job, {});

    const rawJob = result.raw.job as typeof job;
    expect(rawJob).toEqual(job);
    expect(rawJob.error).toBe("DB locked");
  });

  test("display has no banned fields", () => {
    const result = formatDreamStatusEnvelope(
      { id: 7, status: "running", created_at: "2026-06-06T00:00:00Z" },
      { current_stage: "health", duration_ms: 12345 },
    );

    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  // ─── Real DB status "done" tests ──────────────────────────

  test("done job with brief shows cleaned brief (real DB status)", () => {
    const brief = "CBrain 日报 2026-06-06\n\n5 个页面更新\n2 个实体升级\n健康: ✅ 0 个问题\n\n⏱ 12.3s";
    const result = formatDreamStatusEnvelope(
      { id: 20, status: "done", created_at: "2026-06-06T00:00:00Z", started_at: "2026-06-06T00:01:00Z", finished_at: "2026-06-06T00:05:00Z", error: null, result: null },
      { brief },
    );

    expect(result.display).toContain("日报");
    expect(result.display).toContain("页面更新");
    expect(result.display).not.toContain("⏱");
    expect(result.summary.status).toBe("ok");
    // raw preserves full structure
    const rawJob = result.raw.job as Record<string, unknown>;
    expect(rawJob.status).toBe("done");
    expect(rawJob.started_at).toBe("2026-06-06T00:01:00Z");
  });

  test("done job without brief shows generic message (real DB status)", () => {
    const result = formatDreamStatusEnvelope(
      { id: 21, status: "done", created_at: "2026-06-06T00:00:00Z", started_at: "2026-06-06T00:01:00Z", finished_at: "2026-06-06T00:05:00Z", error: null, result: null },
      {},
    );

    expect(result.display).toContain("已完成");
    expect(result.summary.status).toBe("ok");
  });
});
