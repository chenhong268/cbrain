import type {
  BridgeCandidate,
  CommunitySummary,
  KnowledgeMapAnalysis,
  KnowledgeMapNode,
} from "./knowledge-map-types.js";

/** Options for the Knowledge Map report builder. */
export interface KnowledgeMapReportOptions {
  /** Opt-in raw/debug appendix. Default Markdown never includes internals. */
  includeDebug?: boolean;
}

/** Result of building a user-facing Knowledge Map report. */
export interface KnowledgeMapReport {
  /** User-facing Markdown (default: no slugs/source_type/weights/debug). */
  markdown: string;
  /** One-sentence product-facing summary. */
  summary: string;
  /** Raw analysis — only present when includeDebug is set. */
  raw?: KnowledgeMapAnalysis;
}

// ─── Deterministic maturity thresholds ───────────────────────────────────
// A community is "mature" when it is large enough, dense enough, and has
// enough internal connections. Pure heuristic; tuned for readable wording.
const MATURITY_MIN_SIZE = 3;
const MATURITY_MIN_INTERNAL_EDGES = 3;
const MATURITY_MIN_DENSITY = 0.4;
const CORE_TITLES_CAP = 5;

/**
 * #241 — Turn a KnowledgeMapAnalysis into a deterministic, user-facing Markdown
 * report (domains, maturity, bridges, isolates/weak nodes, suggested actions).
 *
 * Default output is product-facing only: it shows human titles, never slugs,
 * and never leaks internal terms (source_type, confidence, raw weight,
 * modularity, debug scores). A raw/debug appendix is appended only when
 * { includeDebug: true }, strictly additively (default Markdown is a prefix).
 */
export function buildKnowledgeMapReport(
  analysis: KnowledgeMapAnalysis,
  options?: KnowledgeMapReportOptions,
): KnowledgeMapReport {
  const includeDebug = options?.includeDebug === true;
  const summary = renderSummary(analysis);
  const base = renderBase(analysis, summary);
  const markdown = includeDebug ? `${base}\n\n${renderDebugAppendix(analysis)}` : base;
  return {
    markdown,
    summary,
    ...(includeDebug ? { raw: analysis } : {}),
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────

function renderSummary(a: KnowledgeMapAnalysis): string {
  const nodeCount = a.health.nodeCount;
  const domainCount = a.communities.length;
  if (nodeCount === 0) return "你的知识图谱目前是空的——还没有可分析的条目。";
  if (domainCount === 0) return `你的知识图谱目前有 ${nodeCount} 个条目，但还没有形成明显的领域结构。`;
  return `你的知识图谱目前有 ${domainCount} 个主要领域，共 ${nodeCount} 个条目。`;
}

// ─── Base Markdown (all default sections) ─────────────────────────────────

function renderBase(a: KnowledgeMapAnalysis, summary: string): string {
  return [
    "# 知识图谱报告",
    "",
    summary,
    "",
    "## 主要领域",
    renderDomains(a),
    "",
    "## 领域成熟度",
    renderMaturity(a),
    "",
    "## 桥接节点",
    renderBridges(a.bridgeCandidates),
    "",
    "## 孤立与弱连接条目",
    renderIsolatesAndWeak(a),
    "",
    "## 建议的下一步",
    renderNextActions(a),
  ].join("\n");
}

/** Stable 1-based domain label from a deterministic id order. */
function domainLabel(index: number): string {
  return `领域 ${index + 1}`;
}

function renderDomains(a: KnowledgeMapAnalysis): string {
  const communities = orderCommunities(a.communities);
  if (communities.length === 0) return "暂未识别出明显的领域。";
  return communities
    .map((c, i) => {
      const titles = uniqueTitles(c.topCoreNodes);
      const core = titles.length > 0 ? `\n核心条目：${titles.slice(0, CORE_TITLES_CAP).join("、")}` : "";
      return `### ${domainLabel(i)}（${c.size} 项）${core}`;
    })
    .join("\n\n");
}

function renderMaturity(a: KnowledgeMapAnalysis): string {
  const communities = orderCommunities(a.communities);
  if (communities.length === 0) return "暂无可评估的领域。";
  return communities
    .map((c, i) => {
      const mature = isMature(c);
      return mature
        ? `- **${domainLabel(i)}** 看起来比较成熟——条目之间有较多可信的内部关联。`
        : `- **${domainLabel(i)}** 还比较稀疏——条目之间的关联较少，可以考虑补充。`;
    })
    .join("\n");
}

function renderBridges(bridges: BridgeCandidate[]): string {
  if (bridges.length === 0) return "暂未发现连接多个领域的桥接节点。";
  const titles = uniqueTitles(bridges);
  return titles.map((t) => `- ${t} 连接了多个领域，可能值得反思。`).join("\n");
}

function renderIsolatesAndWeak(a: KnowledgeMapAnalysis): string {
  const isolates = uniqueTitles(a.highMentionIsolates);
  const weak = uniqueTitles(a.weaklyConnectedNodes);
  if (isolates.length === 0 && weak.length === 0) return "暂无孤立或弱连接的条目。";
  const parts: string[] = [];
  if (isolates.length > 0) {
    parts.push("以下条目被频繁提及但尚未关联到其他条目，可以考虑建立关联或清理：");
    parts.push(...isolates.map((t) => `- ${t}`));
  }
  if (weak.length > 0) {
    parts.push("以下条目只有单条关联，可能需要补充上下文：");
    parts.push(...weak.map((t) => `- ${t}`));
  }
  return parts.join("\n");
}

function renderNextActions(a: KnowledgeMapAnalysis): string {
  const actions: string[] = [];
  if (a.highMentionIsolates.length > 0) {
    actions.push("- 为孤立的高提及条目建立关联，或清理过时记录。");
  }
  if (a.bridgeCandidates.length > 0) {
    actions.push("- 桥接节点值得回顾——它们可能指向需要更新的关联。");
  }
  if (a.communities.some((c) => !isMature(c))) {
    actions.push("- 稀疏领域可以补充更多条目或关联，让结构更清晰。");
  }
  if (a.health.nodeCount > 0 && a.communities.length === 0) {
    actions.push("- 增加条目之间的关联，帮助形成领域结构。");
  }
  if (actions.length === 0) {
    actions.push("- 暂无明显的待办——图谱结构看起来比较均衡。");
  }
  return actions.join("\n");
}

// ─── Debug appendix (opt-in) ─────────────────────────────────────────────

function renderDebugAppendix(a: KnowledgeMapAnalysis): string {
  return ["---", "", "## 调试附录（含内部数据）", "", "```json", JSON.stringify(a, null, 2), "```"].join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function orderCommunities(communities: CommunitySummary[]): CommunitySummary[] {
  return [...communities].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function isMature(c: CommunitySummary): boolean {
  return (
    c.size >= MATURITY_MIN_SIZE &&
    c.internalEdgeCount >= MATURITY_MIN_INTERNAL_EDGES &&
    c.density >= MATURITY_MIN_DENSITY
  );
}

/** Human titles (de-duplicated, empties dropped) from nodes or bridge candidates. */
function uniqueTitles(items: Array<KnowledgeMapNode | BridgeCandidate>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const title = it.title.trim();
    if (title.length === 0 || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}
