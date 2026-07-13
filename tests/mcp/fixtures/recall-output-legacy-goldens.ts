// Captured from main@284af8a with an empty anonymous brain and Date.now() fixed
// to 1000. These full-text goldens lock whitespace, key order, and nesting.

export const LEGACY_QUERY_GOLDEN = JSON.stringify({
  display: "没有找到相关内容。",
  summary: {
    status: "empty",
    count: 0,
    truncated: false,
    message: "没有找到相关内容",
    next_steps: ["尝试换关键词", "用 deep_recall 代替 query"],
  },
  raw: {
    results: [],
    degraded: true,
    latency_ms: 0,
    search_meta: {
      strategy: "smart-hybrid",
      latency_ms: 0,
      degraded: true,
      reason_codes: ["fts_empty"],
    },
  },
  results: [],
  degraded: true,
  latency_ms: 0,
}, null, 2);

export const LEGACY_DEEP_RECALL_GOLDEN = JSON.stringify({
  display: "暂时没找到和「主题A」相关的记忆。",
  summary: {
    status: "empty",
    count: 0,
    truncated: false,
    message: "暂时没找到相关记忆",
    next_steps: ["尝试换个关键词", "用 deep_recall 换一种搜索策略"],
  },
  result_summary: "暂时没找到相关记忆",
  query: "主题A",
  entities: [],
}, null, 2);

export const LEGACY_FRONTDOOR_GOLDEN = JSON.stringify({
  display: "关于「主题A之前讨论过吗」，暂时还没找到明确的依据。",
  summary: {
    status: "empty",
    count: 0,
    truncated: false,
    message: "0 条依据、0 处待确认、0 处不一致、0 处待补充",
  },
  raw: {
    query: "主题A之前讨论过吗",
    grounded_answer: {
      query: "主题A之前讨论过吗",
      answer: "目前没有足够的记录来回答这个问题。",
      confidence: "low",
      facts: [],
      user_thoughts: [],
      candidates: [],
      conflicts: [],
      gaps: [],
      sources: [],
      must_not_claim: [],
    },
    routing: {
      chosen_route: "grounded_recall",
      confidence: 0.8,
      matched_signals: ["verification"],
      rejected_routes: [
        "debug_search",
        "episodic_recall",
        "hierarchy",
        "content_recall",
        "relationship",
        "reasoning",
        "overview",
      ],
      next_tool: "deep_recall",
      latency_ms: 0,
    },
  },
}, null, 2);
