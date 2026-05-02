import type { LLMProvider } from "../llm/provider.js";

// ─── Types ──────────────────────────────────────────────────

export type EntityType = "person" | "company" | "location" | "concept" | "product";

export type Relevance = "high" | "medium" | "low";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  relevance: Relevance;
  context: string;
}

export interface ExtractedRelation {
  from: string;
  to: string;
  relation: string;
  context: string;
}

export interface ExtractedEvent {
  date: string | null;
  description: string;
  participants: string[];
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
}

// ─── Post-extraction filter ─────────────────────────────────

/** Entities that match these patterns are noise and should not create pages */
function isNoiseEntity(name: string, type: EntityType): boolean {
  // Phone numbers: pure digits >= 8
  if (/^\d{8,}$/.test(name)) return true;
  // Email addresses
  if (/@/.test(name)) return true;
  // WeChat IDs / email usernames: all-lowercase, >10 chars, no CJK
  if (/^[a-z][a-z0-9]{10,}$/.test(name) && !/[一-鿿]/.test(name)) return true;
  // Bare city/province names
  if (type === "location" && /^[一-鿿]{2,3}[市县区]?$/.test(name)) return true;
  // 2-char Chinese abbreviations (CM=区域市场, AD=区域总监) — NOT real entities
  if (/^[A-Z]{2}$/.test(name) && type !== "concept") return true;
  // Job titles
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return true;
  // Department/team names
  if (/团队|部门|小组|中心$/.test(name) && type === "concept") return true;
  // Date patterns
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return true;
  return false;
}

/** Concept names that match these patterns are NOT recognized named concepts */
function isGenericConcept(name: string): boolean {
  // Ends with common activity/quality suffixes — not a named concept
  if (/管理|培训|策略|能力|方法|思维|分析|解决|习惯|练习|锻炼|学习|培训$/.test(name)) return true;
  // Generic compound terms (XX + common noun)
  if (/^(大众|消费者|用户|客户|市场|产品|项目|数据|系统|资源|效率|品牌|服务|方案|问题)/.test(name)) return true;
  return false;
}

const GENERIC_TERMS = new Set([
  // Abstract qualities / emotions
  "现实", "个体", "未来", "痛苦", "梦想", "成功", "失败", "优秀", "勇气", "自由",
  "幸福", "希望", "命运", "真理", "价值", "意义", "智慧", "经验", "能力", "力量",
  "快乐", "焦虑", "爱", "恨", "恐惧", "信任", "尊重",
  // Broad domains
  "历史", "经济", "文化", "教育", "科学", "社会", "政治", "技术", "环境", "市场",
  "艺术", "哲学", "宗教", "法律", "道德",
  // Generic nouns
  "人类", "世界", "问题", "方法", "人", "生活", "时间", "工作", "中国", "美国",
  "公司", "团队", "国家", "政府", "组织", "系统", "数据", "信息", "知识", "机器",
  "人工智能", "历史学家", "企业", "大学生",
  // Leadership / business generic
  "领导力", "沟通", "学习", "思考", "创新", "责任", "成长", "进步", "改变", "发展",
  "经销商", "零售商", "批发商", "供应商", "制造商", "代理商", "客户", "用户",
  // Common objects / daily items
  "邮件", "银行", "咖啡", "代码", "方案", "警察", "保险丝", "柠檬汁",
  "金属屑", "轴承", "润滑油", "监控录像", "微信", "瓷制茶壶", "肌肉", "播客",
  // Generic qualities / activities
  "资源", "大脑", "效率", "品牌", "消费者", "电商", "专业", "共享单车",
  "学习能力", "沟通能力", "个人习惯", "项目经验", "通勤时间",
  "身体锻炼", "英语学习", "上班焦虑", "职业选择", "时间管理",
  "投资策略", "职业发展方向", "深度思考",
  "关键项目", "注意力管理", "问题分析", "问题解决",
  "因果链", "切换成本", "组合式创新", "效率培训",
  // Roles / occupations
  "公务员", "销售人员", "客服人员", "市场营销人员", "客服", "管理员",
  // Generic business constructs
  "业务目标", "成本结构", "全球销售额", "核心运营利润", "新兴增长市场",
  "广告效果", "品牌投放", "品类新客", "营销投放", "大数据能力",
  "决策效率", "超能员工",
]);

const MAX_CONCEPTS = 3;
const MAX_TOTAL_ENTITIES = 8;

function filterEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const valid = entities.filter((e) => {
    if (GENERIC_TERMS.has(e.name) || e.name.length < 2 || isNoiseEntity(e.name, e.type)) return false;
    if (e.type === "concept" && isGenericConcept(e.name)) return false;
    return true;
  });

  // Prioritize high-relevance, then medium. Drop low.
  const ranked = valid.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (order[a.relevance] ?? 2) - (order[b.relevance] ?? 2);
  });

  const concepts = ranked.filter((e) => e.type === "concept");
  const nonConcepts = ranked.filter((e) => e.type !== "concept");

  const keptConcepts = concepts.slice(0, MAX_CONCEPTS);
  const keptNonConcepts = nonConcepts.slice(0, MAX_TOTAL_ENTITIES - keptConcepts.length);

  return [...keptNonConcepts, ...keptConcepts];
}

function filterRelations(
  relations: ExtractedRelation[],
  validEntityNames: Set<string>
): ExtractedRelation[] {
  return relations.filter(
    (r) => validEntityNames.has(r.from) && validEntityNames.has(r.to)
  );
}

// ─── Prompt: Schema (WHAT) ───────────────────────────────────

const ENTITY_SCHEMA = `{
  "entities": [{ "name": "实体名", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文片段" }],
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }]
}`;

const RELATION_SCHEMA = `{
  "relations": [{ "from": "实体名A", "to": "实体名B", "relation": "关系类型", "context": "原文依据" }]
}`;

// ─── Prompt: Guideline (HOW) — Entity ────────────────────────

const ENTITY_GUIDELINE = `You are a precision entity extractor for a personal knowledge graph. Extract ONLY entities worth remembering long-term. When in doubt, skip it.

Quality over quantity. 30 precise nodes > 300 noisy ones.

DO extract:
- Named people (specific individuals with real context)
- Named companies and organizations
- Named products (specific names, not categories)
- Established methodologies, theories, effects, laws, models (must have proper names — e.g. "飞轮效应", "第一性原理", "奥卡姆剃刀")

Skip ALL:
- Numbers/amounts (93亿美元, Q1 2026), pronouns, function words
- Daily items (coffee, tools, household objects)
- Generic nouns (email, bank, code, police, brand)
- Job titles (经理, 总监, engineer, manager)
- Departments/teams (品牌团队, sales team)
- Abstract qualities/activities (深度思考, 注意力管理, 时间管理, learning)
- Generic business terms (消费者, 市场策略, 切换成本)
- Bare place names without significance
- Vague "concepts" that are common words repackaged (问题解决, 沟通方法)

Relevance: "high"=main subject, "medium"=supporting role, "low"=incidental (skip).
Context must be a verbatim excerpt from source.

Concept rule (STRICT): only extract if ALL: (1) has proper name (2) recognized methodology/theory/framework/effect/law/model (3) established literature (4) NOT compound of common words.
Valid: 飞轮效应, 第一性原理, 奥卡姆剃刀, 达克效应, 幸存者偏差
Invalid: 深度思考, 注意力管理, 时间管理, 问题分析, 沟通方法, 效率培训

Event rule: specific dates (YYYY-MM-DD, Q1 2026) or clear time references. Include regulatory/financial events. Skip vague ("近年来", "recently"). Participants must be named entities.

## Output format (MUST follow exactly — concepts go INSIDE entities array with type="concept"):

{"entities": [{"name": "名称", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文引用"}], "events": [{"date": "YYYY-MM-DD或null", "description": "事件描述", "participants": ["参与实体名"]}]}

Limits: max 8 regular entities + 3 concepts = 11 total entities. Return ONLY valid JSON, no markdown wrap.`;

// ─── Prompt: Guideline (HOW) — Relation ──────────────────────

const RELATION_GUIDELINE = (entityNames: string[]) => `You are a relation extractor. Identify relationships between the entities listed below, based on the source text.

## Extracted Entities (use exact names)

${entityNames.map(n => `- ${n}`).join("\n")}

## Relation Types

Use these types only. If none fits, use "mentions":
- 任职于 — A works at B
- 认识 — A knows B
- 投资了 — A invested in B
- 创立了 — A founded B
- 收购了 — A acquired B
- 合作伙伴 — A partners with B
- 竞争对手 — A competes with B
- 子公司 — A is subsidiary of B
- 发布了 — A announced B
- mentions — general reference

## Rules
1. Both from and to MUST be in the entity list above — do not invent entity names
2. Relation must be explicitly stated or clearly implied in the source text
3. context must be a verbatim excerpt from the source
4. If no clear relation exists, return empty array {"relations": []}
5. Return ONLY JSON`;

// ─── Prompt (legacy, replaced by two-stage) ───────────────────

// ─── NER Engine ─────────────────────────────────────────────

export class NerEngine {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  async extract(text: string): Promise<ExtractionResult> {
    if (!text.trim()) {
      return { entities: [], relations: [], events: [] };
    }

    const truncated = text.length > 3000 ? text.slice(0, 3000) + "…" : text;

    // Stage 1: Extract entities + events
    const stage1 = await this.llm.chat([
      { role: "system", content: ENTITY_GUIDELINE },
      { role: "user", content: truncated },
    ]);
    const { entities, events } = this.parseEntityResponse(stage1);
    const filtered = filterEntities(entities);
    if (filtered.length === 0) {
      return { entities: [], relations: [], events };
    }

    // Stage 2: Extract relations — feed extracted entity names as context
    const entityNames = filtered.map(e => e.name);
    const stage2 = await this.llm.chat([
      { role: "system", content: RELATION_GUIDELINE(entityNames) },
      { role: "user", content: truncated },
    ]);
    const relations = this.parseRelationResponse(stage2, new Set(entityNames));

    return { entities: filtered, relations, events };
  }

  private parseEntityResponse(raw: string): { entities: ExtractedEntity[]; events: ExtractedEvent[] } {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);

      // Main entities array (with type field)
      const entities: ExtractedEntity[] = (Array.isArray(parsed.entities) ? parsed.entities : []).map(
        (e: Record<string, unknown>) => ({ ...e, relevance: e.relevance ?? "medium", type: e.type ?? "entity" })
      );

      // Handle LLM outputting concepts as separate array — merge into entities
      if (Array.isArray(parsed.concepts)) {
        for (const c of parsed.concepts as Record<string, unknown>[]) {
          if (c.name && typeof c.name === "string") {
            entities.push({ name: c.name, type: "concept", relevance: (c.relevance as Relevance) ?? "medium", context: (c.context as string) ?? "" });
          }
        }
      }

      return {
        entities,
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (e) {
      console.error("[ner] stage1 JSON 解析失败", e);
      return { entities: [], events: [] };
    }
  }

  private parseRelationResponse(raw: string, validNames: Set<string>): ExtractedRelation[] {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      const relations: ExtractedRelation[] = Array.isArray(parsed.relations) ? parsed.relations : [];
      return relations.filter(r => validNames.has(r.from) && validNames.has(r.to));
    } catch (e) {
      console.error("[ner] stage2 JSON 解析失败", e);
      return [];
    }
  }
}
