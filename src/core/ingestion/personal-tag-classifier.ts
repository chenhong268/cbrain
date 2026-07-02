/**
 * Deterministic personal-tag classifier for the ingest write path.
 *
 * Returns true when content is clearly personal long-term memory and no
 * veto fires. Pure: no LLM, no DB, no file IO. Source-agnostic.
 * Conflict or uncertainty → false (fail closed).
 *
 * Gate order (first decisive gate wins):
 *   Gate 0 — routing/control marker in tags → false (defensive)
 *   Gate 1 — guardrail term (work/research/technical) → false (overrides positive)
 *   Gate 2 — positive signal (possessive pref/habit OR strong life domain) → true
 *   Gate 3 — fail closed → false
 *
 * The bare word 个人 / "personal" is intentionally NOT a positive signal,
 * so business/technical text containing it does not get tagged.
 */

export interface PersonalTagInput {
  title?: string;
  content: string;
  tags?: string[];
}

// Gate 2 — possessive preference / habit (first-person)
const POSSESSIVE_CN = /我(?:的)?(?:偏好|习惯|喜好|口味|风格)|我喜欢|我爱|我偏好|我习惯|我一般|我通常|我总是/;
const POSSESSIVE_EN = /\bmy (?:preference|habit|taste|style)\b|\bi (?:prefer|like|love|always|usually)\b/i;

// Gate 2 — strong life signals (first-person NOT required)
const LIFE_CN = /健康|看病|体检|失眠|焦虑|抑郁|运动|跑步|健身|锻炼|节食|过敏|家人|父母|妈妈|爸爸|孩子|儿子|女儿|老婆|妻子|丈夫|老公|兄弟|姐妹|朋友|作息|周末|假期|休假|旅行|旅游|爱好|兴趣|读书|阅读|电影|音乐|游戏|烹饪|做饭|宠物|生活|日常|反思|感悟|心情|情绪|日记/;
const LIFE_EN = /\b(health|workout|fitness|insomnia|allergy|family|parent|mother|mom|dad|father|kids?|children|spouse|wife|husband|brother|sister|sibling|friend|routine|hobby|interest|reading|movie|music|travel|pets?|lifestyle|reflection|journal)\b/i;

// Gate 1 — guardrail (veto, overrides any positive signal). Conflict wins.
const GUARDRAIL_CN = /文章|论文|研究|报告|行业|资讯|调研|新闻|白皮书|技术|架构|代码|系统|模块|组件|服务|接口|实现|重构|部署|运维|巡检|线上|开发|工程|项目|产品|需求|迭代|版本|功能|工作|团队|会议|职责|岗位|职位|汇报|业务|公司|组织|部门|客户|合作/;
const GUARDRAIL_EN = /\b(article|paper|research|report|industry|news|whitepaper|technical|architecture|code|system|module|component|service|api|implementation|refactor|deploy|deployment|maintenance|infra(?:structure)?|project|product|requirement|version|release|okr|kpi|business|org(?:anization)?|department|stakeholder|issue|pr|pull request|commit|merge|ticket|review|bug|feature)\b/i;

// Gate 0 — routing/control markers from signal-router destinations (defensive veto)
const ROUTING_MARKERS = new Set(["agent_profile", "action_loop", "no_store"]);

export function classifyPersonalTag(input: PersonalTagInput): boolean {
  // Gate 0 — routing/control markers
  const tags = input.tags ?? [];
  if (tags.some(t => ROUTING_MARKERS.has(t))) return false;

  const text = `${input.title ?? ""}\n${input.content ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  // Gate 1 — guardrail veto
  if (GUARDRAIL_CN.test(text) || GUARDRAIL_EN.test(text)) return false;

  // Gate 2 — positive
  if (POSSESSIVE_CN.test(text) || POSSESSIVE_EN.test(text) || LIFE_CN.test(text) || LIFE_EN.test(text)) {
    return true;
  }
  // Gate 3 — fail closed
  return false;
}
