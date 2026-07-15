import { describe, test, expect } from "bun:test";
import { formatHealthEnvelope, formatDreamStatusEnvelope } from "../../src/mcp/tools/format-result.js";
import type { HealthReport } from "../../src/core/maintenance/health.js";
import type { PageSignals } from "../../src/core/maintenance/health-debt.js";

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

  test("warn report with observe-only issues summarizes by count", () => {
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
    expect(result.display).toContain("4 条信号");
    // observe-only 折叠成 count，不 dump 具体标题
    expect(result.display).toContain("观察项");
    expect(result.display).not.toContain("人物A");
    expect(result.display).not.toContain("紧急");
    expect(result.display).not.toContain("还有 1 个问题");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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
      reportPaths: {
        summary: "/anonymous/REPORT-PATH-SECRET/summary.md",
        actions: "/anonymous/REPORT-PATH-SECRET/actions.md",
        detail: "/anonymous/REPORT-PATH-SECRET/detail.json",
      },
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

    // The MCP-compatible projection keeps the report, except operator-local paths.
    expect(result.raw.overallStatus).toBe("warn");
    expect(result.raw.dimensions).toHaveLength(1);
    expect(result.raw.metrics).toBeDefined();
    expect(result.raw.timestamp).toBeDefined();
    expect("reportPaths" in result.raw).toBe(false);
    expect(JSON.stringify(result)).not.toContain("REPORT-PATH-SECRET");
  });

  test("path-free raw projection preserves delta in clean and actionable branches", () => {
    const delta = {
      previousTimestamp: "2026-06-05T00:00:00Z",
      dimensions: [],
      totalNew: 0,
      totalResolved: 1,
      totalChronic: 0,
    };
    const reportPaths = {
      summary: "/anonymous/REPORT-PATH-SECRET/summary.md",
      actions: "/anonymous/REPORT-PATH-SECRET/actions.md",
      detail: "/anonymous/REPORT-PATH-SECRET/detail.json",
    };

    for (const report of [
      makeHealthReport({ delta, reportPaths }),
      makeHealthReport({
        overallStatus: "warn",
        delta,
        reportPaths,
        dimensions: [{
          name: "文件系统卫生",
          status: "warn",
          issues: [{
            severity: "medium",
            slug: "-",
            code: "filesystem_hygiene.review_required",
            title: "1 个错位条目需要人工核对",
            description: "受信任根目录旁发现 1 个可识别条目。",
          }],
        }],
      }),
    ]) {
      const result = formatHealthEnvelope(report);
      expect(result.raw.timestamp).toBe(report.timestamp);
      expect(result.raw.overallStatus).toBe(report.overallStatus);
      expect(result.raw.dimensions).toEqual(report.dimensions);
      expect(result.raw.metrics).toEqual(report.metrics);
      expect(result.raw.delta).toEqual(delta);
      expect("reportPaths" in result.raw).toBe(false);
      expect(JSON.stringify(result)).not.toContain("REPORT-PATH-SECRET");
    }
  });

  test("fail status shows problems label", () => {
    const report = makeHealthReport({ overallStatus: "fail" });
    const result = formatHealthEnvelope(report);
    expect(result.display).toContain("有问题");
  });

  test("observe-only issue suggestion not dumped into display", () => {
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
    // observe-only 不 dump 具体建议
    expect(result.display).not.toContain("补充关系");
    expect(result.display).not.toContain("entities/x");
    expect(result.display).toContain("观察项");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // 系统错误 → blocked group，display 只说「阻塞项」
    expect(result.display).toContain("阻塞项");
    expect(result.display).not.toContain("系统错误");
    expect(result.display).not.toContain("runtime");
    expect(result.display).not.toContain("logs/");
    expect(result.display).not.toContain("runtime/");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // 一致性 → needs_review，display 只说「需人工确认」
    expect(result.display).toContain("需人工确认");
    expect(result.display).not.toContain("关系未同步");
    expect(result.display).not.toContain("syncLinksToMarkdown");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("person-a");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // 组织结构不在 planner 已知 dimension → observe_only
    expect(result.display).toContain("观察项");
    expect(result.display).not.toContain("缺少图边");
    expect(result.display).not.toContain("setHierarchy");
    expect(result.display).not.toContain("entities/");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // 标题冲突隔离 → needs_review
    expect(result.display).toContain("需人工确认");
    expect(result.display).not.toContain("重复标题");
    expect(result.display).not.toContain(".md");
    expect(result.display).not.toContain("filePath");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("merge_pages");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // 语义去重 → needs_review
    expect(result.display).toContain("需人工确认");
    expect(result.display).not.toContain("语义重复");
    expect(result.display).not.toContain("[[");
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("dup-b");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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

    // needs_review 折叠，slug-like title 不进 display
    expect(result.display).not.toContain("entities/");
    expect(result.display).not.toContain("person-a");
    expect(result.display).toContain("需人工确认");
    // raw 仍保留原始 title
    expect(result.raw.dimensions[0].issues[0].title).toBe("entities/person-a");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  // ─── #306 attention summary ───────────────────────────────

  test("large report shows top actions + observe count, not every issue", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [
        {
          name: "系统错误",
          status: "fail",
          issues: [{
            severity: "high", slug: "-", title: "1 个系统错误",
            description: "最近发现错误", suggestion: "检查 runtime/logs/ 详情",
          }],
        },
        {
          name: "结构一致性",
          status: "warn",
          issues: [{
            severity: "medium", slug: "entities/kr-missing",
            title: "Known Relations 缺失",
            description: "未写入 Known Relations projection drift",
            suggestion: '运行 syncAffectedSlugs("entities/kr-missing")',
          }],
        },
        {
          name: "搜索质量",
          status: "warn",
          issues: Array.from({ length: 1000 }, (_, i) => ({
            severity: "low" as const,
            slug: "entities/observe-item-i",
            title: `观察项 ${i}`,
            description: "非确定性信号",
          })),
        },
      ],
    });
    const result = formatHealthEnvelope(report);

    // AC#9: display 只说 top actions + observe count，不列每个 issue
    expect(result.display).toContain("阻塞项");
    expect(result.display).toContain("可安全修复项");
    expect(result.display).toContain("1000");
    expect(result.display).toContain("观察项");
    // 不 dump 具体观察项标题
    expect(result.display).not.toContain("观察项 0");
    expect(result.display).not.toContain("观察项 999");
    // AC#1: 不说 1000 urgent
    expect(result.display).not.toContain("紧急");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
    // raw 完整保留
    expect(result.raw.dimensions[2].issues).toHaveLength(1000);
  });

  test("only-observe-only report does not produce urgent message", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "搜索质量",
        status: "warn",
        issues: Array.from({ length: 5 }, () => ({
          severity: "medium" as const,
          slug: "entities/observe",
          title: "搜索质量观察",
          description: "非确定性信号",
        })),
      }],
    });
    const result = formatHealthEnvelope(report);

    // AC#10: 纯 observe-only 不产 urgent/action-required
    expect(result.display).not.toContain("优先处理");
    expect(result.display).not.toContain("紧急");
    expect(result.display).not.toContain("阻塞");
    expect(result.display).not.toContain("可安全修复");
    expect(result.display).toContain("观察项");
    expect(result.display).toContain("5");
  });

  test("#308 high-signal bare stub is promoted to review when signal lookup is provided", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "完整性",
        status: "warn",
        issues: [{
          severity: "low",
          slug: "entity/entity-a",
          title: "Bare entity/person stub with minimal content",
          description: "内容过薄",
        }],
      }],
    });
    const signalLookup = (slug: string): PageSignals | undefined =>
      slug === "entity/entity-a" ? { mentionCount: 3, incomingLinkCount: 0 } : undefined;

    const result = formatHealthEnvelope(report, signalLookup);

    expect(result.display).toContain("需人工确认");
    expect(result.display).not.toContain("观察项");
    expect(result.display).not.toContain("entity/entity-a");
    expect(result.display).not.toContain("Bare entity");
    expect(result.summary.next_steps).toContain("逐项人工核实");
  });

  test("#308 same bare stub remains observe-only without signal lookup", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "完整性",
        status: "warn",
        issues: [{
          severity: "low",
          slug: "entity/entity-a",
          title: "Bare entity/person stub with minimal content",
          description: "内容过薄",
        }],
      }],
    });

    const result = formatHealthEnvelope(report);

    expect(result.display).not.toContain("需人工确认");
    expect(result.display).toContain("观察项");
    expect(result.summary.next_steps).toContain("无需处理，保持观察");
  });

  test("priority: blocked appears before observe-only crowd", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [
        {
          name: "搜索质量",
          status: "warn",
          issues: Array.from({ length: 50 }, () => ({
            severity: "medium" as const, slug: "entities/o",
            title: "观察", description: "非确定性信号",
          })),
        },
        {
          name: "批量变更保护",
          status: "fail",
          issues: [{
            severity: "high", slug: "-", title: "watcher 暂停",
            description: "bulk pending", suggestion: "bulk_resume 恢复",
          }],
        },
      ],
    });
    const result = formatHealthEnvelope(report);

    // AC#3: blocked 排在 observe-only 前面
    const blockedIdx = result.display.indexOf("阻塞项");
    const observeIdx = result.display.indexOf("观察项");
    expect(blockedIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeLessThan(observeIdx);
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
  });

  test("auto_repairable suggestion with slug does not leak into display", () => {
    const report = makeHealthReport({
      overallStatus: "warn",
      dimensions: [{
        name: "结构一致性",
        status: "warn",
        issues: [{
          severity: "medium", slug: "entities/leak",
          title: "Known Relations 缺失",
          description: "未写入 Known Relations projection drift",
          suggestion: '运行 syncAffectedSlugs("entities/leak") 修复',
        }],
      }],
    });
    const result = formatHealthEnvelope(report);

    // AC#7: 即使 suggestion 含 slug/function，display 不 leak
    expect(result.display).toContain("可安全修复项");
    expect(result.display).not.toContain("entities/leak");
    expect(result.display).not.toContain("leak");
    expect(result.display).not.toContain("syncAffectedSlugs");
    expect(result.display).not.toContain("Known Relations");
    for (const term of BANNED_IN_DISPLAY) {
      expect(result.display).not.toContain(term);
    }
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
