export type FrontdoorRoute =
  | "grounded_recall"
  | "content_recall"
  | "episodic_recall"
  | "hierarchy"
  | "overview"
  | "relationship"
  | "reasoning"
  | "debug_search";

export interface FrontdoorRoutingDecision {
  chosen_route: FrontdoorRoute;
  confidence: number;
  matched_signals: string[];
  rejected_routes: FrontdoorRoute[];
  next_tool: string;
}

interface RouteRule {
  route: FrontdoorRoute;
  nextTool: string;
  signals: Array<[string, RegExp]>;
}

const ROUTE_RULES: RouteRule[] = [
  {
    route: "debug_search",
    nextTool: "query",
    signals: [
      ["debug", /\bdebug\b|调试|诊断/iu],
      ["keyword_location", /关键词.*(在哪|出现|索引)|搜索结果|原始搜索|查.*slug|raw search|keyword search/iu],
    ],
  },
  {
    route: "episodic_recall",
    nextTool: "recall_episode",
    signals: [
      ["forgot_name", /想不起名字|不记得名字|叫什么来着|那个人是谁|那个.*是谁/iu],
      ["met_person", /见过谁|认识谁|遇到.*谁|活动.*人|一起.*的人/iu],
    ],
  },
  {
    route: "hierarchy",
    nextTool: "get_org_tree",
    signals: [
      ["org_tree", /组织架构|汇报线|架构图|层级/iu],
      ["manager_or_report", /上级|下属|汇报给|向.*汇报|谁管|管理.*谁/iu],
      ["hierarchy_en", /reports to|direct reports|org chart|reporting line/iu],
    ],
  },
  {
    route: "grounded_recall",
    nextTool: "deep_recall",
    signals: [
      ["verification", /讨论过吗|聊过吗|有记录吗|有依据吗|是不是真的|是否真实|是否准确/iu],
      ["evidence_gap", /有没有遗漏|有什么遗漏|矛盾吗|冲突吗|为什么这么定|上次怎么定/iu],
    ],
  },
  {
    route: "content_recall",
    nextTool: "deep_recall",
    signals: [
      ["prior_design", /当时.*(怎么设计|为什么选|怎么定|怎么做)|之前.*(怎么设计|为什么选|具体怎么说)/iu],
      ["specific_content", /具体方案|具体内容|原来怎么说|当时怎么说|怎么设计的/iu],
    ],
  },
  {
    route: "relationship",
    nextTool: "agentic_research",
    signals: [
      ["relationship", /什么关系|什么联系|有什么联系|有关系吗|之间.*关系|之间.*联系/iu],
      ["relationship_en", /relationship|connected to|how.*(related|connected)|link between/iu],
    ],
  },
  {
    route: "reasoning",
    nextTool: "agentic_research",
    signals: [
      ["judgement", /帮我判断|怎么看|是否合理|有无风险|盲区|优缺点/iu],
      ["comparison", /对比|区别|哪个更|\bvs\b|compare|difference|differ/iu],
    ],
  },
  {
    route: "overview",
    nextTool: "summarize",
    signals: [
      ["overview", /总结|梳理|复盘|全面了解|概览|全貌/iu],
      ["topic_map", /有哪些关键|生态|脉络|整体情况/iu],
      ["overview_en", /summarize|review of|overview|walk me through/iu],
    ],
  },
];

const DEFAULT_ROUTE: FrontdoorRoutingDecision = {
  chosen_route: "content_recall",
  confidence: 0.55,
  matched_signals: ["default_content_recall"],
  rejected_routes: [],
  next_tool: "deep_recall",
};

export function classifyFrontdoorQuery(query: string): FrontdoorRoutingDecision {
  const normalized = query.trim();
  if (!normalized) {
    return {
      chosen_route: "debug_search",
      confidence: 0.4,
      matched_signals: ["empty_query"],
      rejected_routes: ROUTE_RULES.map((r) => r.route).filter((r) => r !== "debug_search"),
      next_tool: "query",
    };
  }

  const hits = ROUTE_RULES.map((rule, index) => {
    const matched = rule.signals.filter(([, re]) => re.test(normalized)).map(([name]) => name);
    return { rule, matched, index };
  }).filter((hit) => hit.matched.length > 0);

  if (hits.length === 0) {
    return { ...DEFAULT_ROUTE, rejected_routes: ROUTE_RULES.map((r) => r.route).filter((r) => r !== DEFAULT_ROUTE.chosen_route) };
  }

  hits.sort((a, b) => b.matched.length - a.matched.length || a.index - b.index);
  const best = hits[0];
  const rejected = ROUTE_RULES.map((r) => r.route).filter((r) => r !== best.rule.route);
  const confidence = Math.min(0.65 + best.matched.length * 0.15, 0.95);

  return {
    chosen_route: best.rule.route,
    confidence,
    matched_signals: best.matched,
    rejected_routes: rejected,
    next_tool: best.rule.nextTool,
  };
}
