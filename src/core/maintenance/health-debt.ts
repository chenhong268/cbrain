/**
 * Health debt dry-run repair planner.
 *
 * 把 HealthChecker 产出的 HealthReport 转成「分组修复计划」，不执行任何修复、
 * 不删除、不合并、不调用 LLM。纯函数：只读 HealthReport + 可选的信号回调，
 * 返回结构化 RepairPlan 与匿名化的展示文本。
 *
 * 分组（对齐 issue #196 scope）：
 *   - auto_repairable：确定性、可回滚的修复（KR 缺失 / wikilink 缺边 / reports_to 归一化）
 *   - needs_review：语义或结构上模糊、需人判断（矛盾 / 重复 / 缺图边 / 非标准关系 / 高提及孤岛）
 *   - observe_only：合理的稀疏记忆（低提及孤岛、低信号 stub、时效性 / 搜索质量等非确定性信号）
 *   - blocked：需外部前置条件（watcher 暂停 / 系统错误 / 数据不足）
 *
 * 隐私：planToMarkdown 把 slug 替换为匿名 token（实体N / 概念N / 记录N / 条目N），
 * 不泄露原始 slug、title 或 file path。
 */
import type { HealthReport, HealthIssue } from "./health.js";

export type RepairGroup = "auto_repairable" | "needs_review" | "observe_only" | "blocked";

/** auto_repairable 的子类别，对齐 issue scope 2 的三类确定性修复。 */
export type AutoRepairKind =
  | "sync_known_relations" // DB 有边但 Known Relations 区块缺失/stale → syncAffectedSlugs
  | "reindex_wikilinks" // 正文 wikilink 可解析但 links 表无边 → processWikilinks / put_page
  | "normalize_reports_to"; // reports_to 是 title/alias 而非完整 slug → 归一化 + 版本快照

/** 页面信号（由调用方注入，planner 本身不碰 db）。用于细分 stub / island。 */
export interface PageSignals {
  mentionCount?: number;
  aliasCount?: number;
  incomingLinkCount?: number;
  sourceType?: string;
  hasBody?: boolean;
}

/** 信号查询回调：纯读，由 CLI / MCP 注入 db 实现。planner 不持有 db 引用。 */
export type SignalLookup = (slug: string) => PageSignals | undefined;

export interface RepairAction {
  group: RepairGroup;
  /** 源维度名（来自 HealthDimension.name）。 */
  dimension: string;
  severity: HealthIssue["severity"];
  /** 原始 slug（结构化数据，供未来 execute 使用；不出现在匿名化的 display 里）。 */
  slug: string;
  /** 仅 auto_repairable 有子类别。 */
  kind?: AutoRepairKind;
  /** 建议动作（planner 生成，固定文案，不含 slug / path）。 */
  action: string;
  /** 仅 normalize_reports_to：版本快照 / 回滚说明。 */
  rollbackNote?: string;
  /** 用于分类的证据（stub / island 分流时附带）。 */
  signals?: PageSignals;
}

export interface RepairPlan {
  /** 来源报告的 timestamp。 */
  source: string;
  counts: Record<RepairGroup, number>;
  actions: RepairAction[];
}

// ─── 匿名化 ───────────────────────────────────────────────────

/** slug 前缀 → 匿名前缀。用于 display 时抹掉真实身份。 */
function resolveAnonPrefix(slug: string): string {
  if (slug.startsWith("entity/")) return "实体";
  if (slug.startsWith("concept/")) return "概念";
  if (slug.startsWith("record")) return "记录";
  return "条目";
}

/**
 * 把 slug 映射为匿名 token（实体1 / 概念1 / 记录1 / 条目1 ...）。
 * 同一 slug 在同一 mapping 中复用同一 token；编号按前缀类型各自递增。
 * 通过反推 mapping 已有同前缀 token 的最大编号确定下一个序号，避免外部维护计数器。
 */
export function slugToAnonymousToken(slug: string, mapping: Map<string, string>): string {
  const existing = mapping.get(slug);
  if (existing) return existing;

  const prefix = resolveAnonPrefix(slug);
  let max = 0;
  for (const token of mapping.values()) {
    if (token.startsWith(prefix)) {
      const num = Number.parseInt(token.slice(prefix.length), 10);
      if (!Number.isNaN(num) && num > max) max = num;
    }
  }
  const token = `${prefix}${max + 1}`;
  mapping.set(slug, token);
  return token;
}

// ─── 分类 ─────────────────────────────────────────────────────

const GLOBAL_LABEL = "（全局）";

function whoLabel(slug: string, anon: (s: string) => string): string {
  return slug && slug !== "-" ? anon(slug) : GLOBAL_LABEL;
}

function classify(
  dimension: string,
  issue: HealthIssue,
  lookup: SignalLookup | undefined,
): RepairAction {
  const base = { dimension, severity: issue.severity, slug: issue.slug };

  // ── 结构一致性：3 类 auto_repairable + 1 类 needs_review（缺图边）──
  if (dimension === "结构一致性") {
    if (issue.description.includes("未写入 Known Relations")) {
      return {
        ...base,
        group: "auto_repairable",
        kind: "sync_known_relations",
        action: "重建 Known Relations 区块（syncAffectedSlugs）",
      };
    }
    if (issue.description.includes("links 表无边")) {
      return {
        ...base,
        group: "auto_repairable",
        kind: "reindex_wikilinks",
        action: "重新索引正文 wikilink（processWikilinks / put_page）",
      };
    }
    if (issue.description.includes("不是完整 slug")) {
      return {
        ...base,
        group: "auto_repairable",
        kind: "normalize_reports_to",
        action: "将 reports_to 归一化为完整 slug",
        rollbackNote:
          "归一化时需写版本快照（versions 表）保留旧值，失败可回滚；dry-run 不执行。",
      };
    }
    if (issue.description.includes("缺少对应图边")) {
      return {
        ...base,
        group: "needs_review",
        action: "需 setHierarchy 建立 reports_to 图边（写入操作，dry-run 不执行）",
      };
    }
    return { ...base, group: "needs_review", action: "人工核实结构一致性" };
  }

  // ── 需人判断的语义 / 结构债（不自动改）──
  if (dimension === "矛盾检测") {
    return { ...base, group: "needs_review", action: "人工核实来源信息是否一致（不自动修改）" };
  }
  if (dimension === "标题冲突隔离") {
    return { ...base, group: "needs_review", action: "人工重命名或 merge_pages 合并（不自动合并）" };
  }
  if (dimension === "疑似重复" || dimension === "语义去重") {
    return { ...base, group: "needs_review", action: "人工判断是否同一实体后合并（不自动合并）" };
  }

  // ── 一致性：非标准关系类型 / 缺 type ──
  if (dimension === "一致性") {
    return {
      ...base,
      group: "needs_review",
      action: issue.description.includes("non-standard relation types")
        ? "relation_audit(mode=fix, dry_run=true) 预览迁移"
        : "补充 frontmatter type 字段",
    };
  }

  // ── bare stub：按连接信号分流（绝不自动删除）──
  if (dimension === "完整性") {
    const signals = lookup?.(issue.slug);
    const hasConnection =
      !!signals &&
      ((signals.mentionCount ?? 0) > 0 ||
        (signals.aliasCount ?? 0) > 0 ||
        (signals.incomingLinkCount ?? 0) > 0);
    if (hasConnection) {
      return {
        ...base,
        group: "needs_review",
        action: "有连接信号，考虑 stub-enrich 充实内容（不删除）",
        signals,
      };
    }
    return {
      ...base,
      group: "observe_only",
      action: "稀疏 stub，暂保留观察（dry-run 不删除）",
      signals,
    };
  }

  // ── island：按提及量分流（绝不自动删除）──
  if (dimension === "孤岛检测") {
    const signals = lookup?.(issue.slug);
    if (signals && (signals.mentionCount ?? 0) >= 3) {
      return {
        ...base,
        group: "needs_review",
        action: "高提及但无连接，建议人工补链（不删除）",
        signals,
      };
    }
    return {
      ...base,
      group: "observe_only",
      action: "合理稀疏记忆，暂保留观察（不删除）",
      signals,
    };
  }

  // ── 需外部前置条件 ──
  if (dimension === "批量变更保护") {
    return { ...base, group: "blocked", action: "bulk_resume 恢复 watcher 后重新评估" };
  }
  if (dimension === "系统错误") {
    return { ...base, group: "blocked", action: "检查 runtime/logs 系统日志后重新评估" };
  }
  if (dimension === "数据就绪度") {
    return { ...base, group: "blocked", action: "ingest 更多内容后再评估" };
  }

  // ── 其余非确定性信号（时效性 / 关注度 / 搜索质量 / 原材料质量 / 新增建议）──
  return { ...base, group: "observe_only", action: "非确定性信号，暂保留观察" };
}

/**
 * 把 HealthReport 转成分组修复计划。纯函数，不读不写 db，不修改 report。
 * signalLookup 可选：提供时用于细分 stub / island，不提供时按保守默认归类。
 */
export function planRepairs(report: HealthReport, signalLookup?: SignalLookup): RepairPlan {
  const actions: RepairAction[] = [];
  for (const dim of report.dimensions) {
    for (const issue of dim.issues) {
      actions.push(classify(dim.name, issue, signalLookup));
    }
  }

  const counts: Record<RepairGroup, number> = {
    auto_repairable: 0,
    needs_review: 0,
    observe_only: 0,
    blocked: 0,
  };
  for (const a of actions) counts[a.group]++;

  return { source: report.timestamp, counts, actions };
}

// ─── 展示（匿名化）────────────────────────────────────────────

const GROUP_ORDER: RepairGroup[] = ["auto_repairable", "needs_review", "observe_only", "blocked"];

const GROUP_TITLE: Record<RepairGroup, string> = {
  auto_repairable: "🔧 可自动修复（dry-run，未执行）· auto_repairable",
  needs_review: "👁 需人工审核 · needs_review",
  observe_only: "👀 暂观察（合理稀疏，不删除）· observe_only",
  blocked: "⛔ 需前置条件 · blocked",
};

function formatSignals(signals: PageSignals): string {
  const parts: string[] = [];
  if (signals.mentionCount !== undefined) parts.push(`提及 ${signals.mentionCount}`);
  if (signals.incomingLinkCount !== undefined) parts.push(`入边 ${signals.incomingLinkCount}`);
  if (signals.aliasCount !== undefined) parts.push(`别名 ${signals.aliasCount}`);
  return parts.join("，");
}

/**
 * 把 RepairPlan 渲染成匿名化的 Markdown（供分享 / 公开）。所有 slug 替换为匿名 token，
 * 不含原始 slug、title 或 file path。要拿含真实 slug 的结构化数据，直接用 RepairPlan。
 */
export function planToMarkdown(plan: RepairPlan): string {
  const mapping = new Map<string, string>();
  const anon = (slug: string): string => slugToAnonymousToken(slug, mapping);

  const lines: string[] = [];
  lines.push("# 健康债务修复计划（dry-run）");
  lines.push("");
  lines.push(`来源报告: ${plan.source.slice(0, 10)}  合计 ${plan.actions.length} 项`);
  lines.push(
    `可自动修复 ${plan.counts.auto_repairable} · 需审核 ${plan.counts.needs_review} · 观察 ${plan.counts.observe_only} · 阻塞 ${plan.counts.blocked}`,
  );
  lines.push("");

  for (const group of GROUP_ORDER) {
    const items = plan.actions.filter((a) => a.group === group);
    if (items.length === 0) continue;
    lines.push(`## ${GROUP_TITLE[group]}`);
    lines.push("");
    for (const a of items) {
      const head = `- ${whoLabel(a.slug, anon)} — ${a.action}`;
      const tail = a.kind ? ` [${a.kind}]` : "";
      lines.push(head + tail);
      if (a.rollbackNote) lines.push(`  - 回滚: ${a.rollbackNote}`);
      if (a.signals) {
        const sig = formatSignals(a.signals);
        if (sig) lines.push(`  - 信号: ${sig}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
