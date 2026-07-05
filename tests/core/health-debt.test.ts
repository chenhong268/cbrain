import { describe, test, expect } from "bun:test";
import {
  planRepairs,
  planToMarkdown,
  slugToAnonymousToken,
  type PageSignals,
} from "../../src/core/maintenance/health-debt.js";
import type { HealthReport, HealthDimension, HealthIssue } from "../../src/core/maintenance/health.js";

// ─── Fixtures (anonymous only — entity/entity-a, 实体A, 组织C, records/record-a) ──

function makeIssue(
  dimension: string,
  slug: string,
  description: string,
  overrides: Partial<HealthIssue> = {},
): { dimension: string; issue: HealthIssue } {
  return {
    dimension,
    issue: {
      severity: "medium",
      slug,
      title: slug.split("/").pop() ?? slug,
      description,
      ...overrides,
    },
  };
}

function makeReport(items: Array<{ dimension: string; issue: HealthIssue }>): HealthReport {
  const byDim = new Map<string, HealthIssue[]>();
  for (const { dimension, issue } of items) {
    const list = byDim.get(dimension) ?? [];
    list.push(issue);
    byDim.set(dimension, list);
  }

  const dimensions: HealthDimension[] = [...byDim.entries()].map(([name, issues]) => ({
    name,
    status: issues.length > 0 ? "warn" : ("pass" as const),
    issues,
  }));

  return {
    timestamp: "2026-06-19T00:00:00.000Z",
    overallStatus: "warn",
    dimensions,
    metrics: {
      timestamp: "2026-06-19T00:00:00.000Z",
      totalPages: 100,
      entities: 50,
      concepts: 10,
      events: 0,
      records: 40,
      totalLinks: 200,
      avgMentionsPerPage: 2,
      orphans: 1,
      bareStubs: 1,
      conceptsPerSource: 0.25,
      indexSizeKB: 0,
    },
  };
}

const noSignals = (): undefined => undefined;

describe("planRepairs — auto_repairable classification", () => {
  test("Known Relations 缺失 → auto_repairable / sync_known_relations", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "有 1 条出边未写入 Known Relations 区块", {
        severity: "medium",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.auto_repairable).toBe(1);
    const action = plan.actions[0];
    expect(action.group).toBe("auto_repairable");
    expect(action.kind).toBe("sync_known_relations");
    expect(action.slug).toBe("entity/entity-a");
    expect(action.action.length).toBeGreaterThan(0);
  });

  test("Known Relations projection drift → auto_repairable / sync_known_relations", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "Known Relations projection drift: Markdown projection differs from SQLite graph", {
        severity: "medium",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.auto_repairable).toBe(1);
    const action = plan.actions[0];
    expect(action.group).toBe("auto_repairable");
    expect(action.kind).toBe("sync_known_relations");
    expect(action.slug).toBe("entity/entity-a");
  });

  test("正文 wikilink 缺 links 边 → auto_repairable / reindex_wikilinks", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-b", "正文提及 [[实体B]] 但 links 表无边", {
        severity: "low",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.auto_repairable).toBe(1);
    expect(plan.actions[0].kind).toBe("reindex_wikilinks");
  });

  test("reports_to 使用非完整 slug → auto_repairable / normalize_reports_to + 回滚说明", () => {
    const report = makeReport([
      makeIssue(
        "结构一致性",
        "entity/entity-c",
        'reports_to 值 "实体D" 不是完整 slug（应为 entity/xxx 格式）',
        { severity: "high" },
      ),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.auto_repairable).toBe(1);
    const action = plan.actions[0];
    expect(action.kind).toBe("normalize_reports_to");
    expect(action.rollbackNote).toBeDefined();
    expect(action.rollbackNote!.length).toBeGreaterThan(0);
    // Issue AC: version/rollback notes
    const note = action.rollbackNote!;
    expect(note.includes("版本") || note.toLowerCase().includes("version")).toBe(true);
    expect(note.includes("回滚") || note.toLowerCase().includes("rollback")).toBe(true);
  });

  test("reports_to 缺对应图边 → needs_review（建边是写入，dry-run 不执行）", () => {
    const report = makeReport([
      makeIssue(
        "结构一致性",
        "entity/entity-d",
        "reports_to=entity/entity-e 缺少对应图边",
        { severity: "high" },
      ),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(1);
    expect(plan.counts.auto_repairable).toBe(0);
    expect(plan.actions[0].group).toBe("needs_review");
    expect(plan.actions[0].kind).toBeUndefined();
  });
});

describe("planRepairs — stubs & islands not auto-deleted", () => {
  test("bare stub 无连接信号 → observe_only", () => {
    const report = makeReport([
      makeIssue("完整性", "entity/entity-a", "Bare entity/person stub with minimal content", {
        severity: "low",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.observe_only).toBe(1);
    expect(plan.counts.auto_repairable).toBe(0);
    expect(plan.actions[0].group).toBe("observe_only");
  });

  test("bare stub 有提及信号 → needs_review（值得充实但不确定）", () => {
    const report = makeReport([
      makeIssue("完整性", "entity/entity-b", "Bare entity/company stub with minimal content", {
        severity: "low",
      }),
    ]);
    const lookup = (slug: string): PageSignals | undefined =>
      slug === "entity/entity-b" ? { mentionCount: 3, incomingLinkCount: 0 } : undefined;
    const plan = planRepairs(report, lookup);
    expect(plan.counts.needs_review).toBe(1);
    expect(plan.counts.observe_only).toBe(0);
    expect(plan.actions[0].signals?.mentionCount).toBe(3);
  });

  test("bare stub 有入边信号 → needs_review", () => {
    const report = makeReport([
      makeIssue("完整性", "entity/entity-c", "Bare entity/person stub with minimal content"),
    ]);
    const lookup = (): PageSignals => ({ mentionCount: 0, incomingLinkCount: 2 });
    const plan = planRepairs(report, lookup);
    expect(plan.counts.needs_review).toBe(1);
  });

  test("island 低提及 → observe_only", () => {
    const report = makeReport([
      makeIssue("孤岛检测", "entity/entity-a", "Disconnected entity/person — no links in or out", {
        severity: "medium",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.observe_only).toBe(1);
    expect(plan.counts.auto_repairable).toBe(0);
  });

  test("island 高提及但无连接 → needs_review", () => {
    const report = makeReport([
      makeIssue("孤岛检测", "entity/entity-b", "Disconnected entity/person — no links in or out"),
    ]);
    const lookup = (): PageSignals => ({ mentionCount: 5 });
    const plan = planRepairs(report, lookup);
    expect(plan.counts.needs_review).toBe(1);
  });
});

describe("planRepairs — needs_review semantic debt", () => {
  test("矛盾检测 → needs_review", () => {
    const report = makeReport([
      makeIssue(
        "矛盾检测",
        "entity/entity-a",
        "来自不同来源的信息存在矛盾：records/record-a vs records/record-b",
      ),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(1);
  });

  test("标题冲突隔离 → needs_review", () => {
    const report = makeReport([
      makeIssue("标题冲突隔离", "records/record-a", '标题 "实体A" 冲突', { severity: "high" }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(1);
  });

  test("疑似重复 / 语义去重 → needs_review（不自动合并）", () => {
    const report = makeReport([
      makeIssue("疑似重复", "entity/entity-a", "Potential duplicate — same base slug"),
      makeIssue("语义去重", "entity/entity-b", "Duplicate of [[实体A]]"),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(2);
    expect(plan.counts.auto_repairable).toBe(0);
  });

  test("一致性 — 非标准关系类型 → needs_review", () => {
    const report = makeReport([
      makeIssue("一致性", "-", "Found 2 non-standard relation types: bogus, weird"),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(1);
  });

  test("一致性 — 缺 type 字段 → needs_review", () => {
    const report = makeReport([
      makeIssue("一致性", "entity/entity-a", "Missing type in frontmatter", { severity: "high" }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.needs_review).toBe(1);
  });
});

describe("planRepairs — blocked (needs precondition)", () => {
  test("批量变更暂停 → blocked", () => {
    const report = makeReport([
      makeIssue("批量变更保护", "", "watcher 因检测到 60 个文件变更（阈值 50）已暂停同步", {
        title: "批量变更暂停",
      }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.blocked).toBe(1);
  });

  test("系统错误 → blocked", () => {
    const report = makeReport([
      makeIssue("系统错误", "-", "最近 7 天发现 3 个错误", { severity: "high" }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.blocked).toBe(1);
  });

  test("数据就绪度不足 → blocked", () => {
    const report = makeReport([
      makeIssue("数据就绪度", "-", "Only 5 pages indexed", { severity: "high" }),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.blocked).toBe(1);
  });
});

describe("planRepairs — observe_only (valid sparse / non-deterministic)", () => {
  test("时效性过期 → observe_only", () => {
    const report = makeReport([
      makeIssue("时效性", "records/record-a", "内容已过期 (expires_at: 2025-01-01)"),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.observe_only).toBe(1);
  });

  test("搜索质量降级 → observe_only", () => {
    const report = makeReport([
      makeIssue("搜索质量", "-", "30% 搜索降级率"),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.observe_only).toBe(1);
  });
});

describe("planRepairs — counts & structure", () => {
  test("counts 累加正确（混合各组）", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "有 1 条出边未写入 Known Relations 区块"),
      makeIssue("结构一致性", "entity/entity-b", 'reports_to 值 "实体C" 不是完整 slug'),
      makeIssue("完整性", "entity/entity-c", "Bare entity/person stub with minimal content"),
      makeIssue("矛盾检测", "entity/entity-d", "来自不同来源的信息存在矛盾"),
      makeIssue("批量变更保护", "", "watcher 因检测到 60 个文件变更已暂停", { title: "批量变更暂停" }),
      makeIssue("时效性", "records/record-a", "内容已过期"),
    ]);
    const plan = planRepairs(report, noSignals);
    expect(plan.counts.auto_repairable).toBe(2);
    expect(plan.counts.observe_only).toBe(2);
    expect(plan.counts.needs_review).toBe(1);
    expect(plan.counts.blocked).toBe(1);
    const total = plan.counts.auto_repairable + plan.counts.needs_review + plan.counts.observe_only + plan.counts.blocked;
    expect(total).toBe(plan.actions.length);
  });

  test("空报告 → 全零 counts", () => {
    const plan = planRepairs(makeReport([]), noSignals);
    expect(plan.counts.auto_repairable).toBe(0);
    expect(plan.counts.needs_review).toBe(0);
    expect(plan.counts.observe_only).toBe(0);
    expect(plan.counts.blocked).toBe(0);
    expect(plan.actions).toEqual([]);
  });

  test("source 记录报告时间戳", () => {
    const report = makeReport([]);
    report.timestamp = "2026-06-19T12:00:00.000Z";
    const plan = planRepairs(report, noSignals);
    expect(plan.source).toBe("2026-06-19T12:00:00.000Z");
  });

  test("纯函数：不修改输入 report", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "有 1 条出边未写入 Known Relations 区块"),
    ]);
    const before = JSON.parse(JSON.stringify(report));
    planRepairs(report, noSignals);
    expect(JSON.parse(JSON.stringify(report))).toEqual(before);
  });
});

describe("planToMarkdown — privacy & display", () => {
  test("不泄露原始 slug / file path", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "有 1 条出边未写入 Known Relations 区块"),
      makeIssue("完整性", "entity/entity-b", "Bare entity/person stub with minimal content"),
      makeIssue("矛盾检测", "entity/entity-c", "来自不同来源的信息存在矛盾"),
    ]);
    const plan = planRepairs(report, noSignals);
    const md = planToMarkdown(plan);

    // Issue AC: no raw file paths or slug paths in display
    expect(md).not.toContain("entity/entity-a");
    expect(md).not.toContain("entity/entity-b");
    expect(md).not.toContain("entity/entity-c");
    expect(md).not.toContain(".md");
  });

  test("含分组小标题与匿名标识", () => {
    const report = makeReport([
      makeIssue("结构一致性", "entity/entity-a", "有 1 条出边未写入 Known Relations 区块"),
    ]);
    const plan = planRepairs(report, noSignals);
    const md = planToMarkdown(plan);
    expect(md).toContain("auto_repairable");
    expect(md).toContain("实体");
  });

  test("空计划也能渲染", () => {
    const md = planToMarkdown(planRepairs(makeReport([]), noSignals));
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });
});

describe("slugToAnonymousToken", () => {
  test("entity/ 前缀 → 实体N", () => {
    const m = new Map<string, string>();
    expect(slugToAnonymousToken("entity/entity-a", m)).toBe("实体1");
    expect(slugToAnonymousToken("entity/entity-b", m)).toBe("实体2");
    // 同 slug 复用同一 token
    expect(slugToAnonymousToken("entity/entity-a", m)).toBe("实体1");
  });

  test("concept/ 前缀 → 概念N，独立编号", () => {
    const m = new Map<string, string>();
    expect(slugToAnonymousToken("concept/concept-c", m)).toBe("概念1");
  });

  test("records/ 前缀 → 记录N", () => {
    const m = new Map<string, string>();
    expect(slugToAnonymousToken("records/record-r", m)).toBe("记录1");
  });

  test("其他/无前缀 → 条目N", () => {
    const m = new Map<string, string>();
    expect(slugToAnonymousToken("-", m)).toBe("条目1");
    expect(slugToAnonymousToken("insights/insight-i", m)).toBe("条目2");
  });

  test("token 不含原始 slug 片段", () => {
    const m = new Map<string, string>();
    const token = slugToAnonymousToken("entity/private-token-a", m);
    expect(token).not.toContain("private");
    expect(token).not.toContain("token");
  });
});
