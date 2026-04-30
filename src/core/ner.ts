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
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问/.test(name)) return true;
  // Date patterns
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return true;
  return false;
}

const GENERIC_TERMS = new Set([
  "现实", "个体", "未来", "痛苦", "梦想", "成功", "失败", "优秀", "勇气", "自由",
  "幸福", "希望", "命运", "真理", "价值", "意义", "智慧", "经验", "能力", "力量",
  "领导力", "沟通", "学习", "思考", "创新", "责任", "成长", "进步", "改变", "发展",
  "历史", "经济", "文化", "教育", "科学", "社会", "政治", "技术", "环境", "市场",
  "艺术", "哲学", "宗教", "法律", "道德",
  "人类", "世界", "问题", "方法", "人", "生活", "时间", "工作", "中国", "美国",
  "公司", "团队", "国家", "政府", "组织", "系统", "数据", "信息", "知识", "机器",
  "人工智能", "历史学家",
  "快乐", "焦虑", "爱", "恨", "恐惧", "信任", "尊重",
  // Business generic terms
  "经销商", "零售商", "批发商", "供应商", "制造商", "代理商", "客户", "用户",
  // Common objects / daily items (too trivial to be knowledge nodes)
  "邮件", "银行", "咖啡", "代码", "方案", "警察", "保险丝", "柠檬汁",
  "金属屑", "轴承", "润滑油", "监控录像", "微信",
  // Generic qualities / activities
  "资源", "大脑", "效率", "品牌", "消费者", "电商", "专业",
  "学习能力", "沟通能力", "个人习惯", "项目经验", "通勤时间",
  "身体锻炼", "英语学习", "上班焦虑", "职业选择", "时间管理",
  "投资策略", "职业发展方向", "深度思考",
  "关键项目", "注意力管理", "问题分析", "问题解决",
  "因果链", "切换成本", "组合式创新", "效率培训",
]);

const MAX_CONCEPTS = 5;
const MAX_TOTAL_ENTITIES = 12;

function filterResult(result: ExtractionResult): ExtractionResult {
  const validEntities = result.entities.filter(
    (e) => !GENERIC_TERMS.has(e.name) && e.name.length >= 2 && !isNoiseEntity(e.name, e.type)
  );

  const concepts = validEntities.filter((e) => e.type === "concept");
  const nonConcepts = validEntities.filter((e) => e.type !== "concept");

  const keptConcepts = concepts.slice(0, MAX_CONCEPTS);
  const keptNonConcepts = nonConcepts.slice(0, MAX_TOTAL_ENTITIES - keptConcepts.length);

  const entities = [...keptNonConcepts, ...keptConcepts];
  const entityNames = new Set(entities.map((e) => e.name));

  const relations = result.relations.filter(
    (r) => entityNames.has(r.from) && entityNames.has(r.to)
  );

  return { entities, relations, events: result.events };
}

// ─── Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a broad entity extractor for a knowledge graph. Your job is to cast a wide net — find as many potential entities, concepts, and named things as possible. A downstream filter system will decide which ones to keep.

## Extraction Rule

Better to extract too many than too few. When in doubt, extract it. The downstream system handles deduplication, noise filtering, and quality decisions.

DO extract:
- Named people, companies, products, locations
- Methodologies, frameworks, theories, effects, biases, phenomena
- Anything that looks like a named entity or defined concept

Skip ONLY obvious noise:
- Pure numbers/amounts (93亿美元, Q1 2026)
- Truly generic words that are never proper nouns (的, 了, 是, 在)
- Pronouns and common verbs

## Output Schema (strict JSON)
{
  "entities": [{ "name": "实体名", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "原文片段" }],
  "relations": [{ "from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据" }],
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }]
}

## Relevance Scoring (CRITICAL — score every entity)

"high" — Core to understanding this text. The main subject, key actors, primary organizations. Remove this entity and the text's meaning changes materially.
"medium" — Supporting role. Mentioned with meaningful context, contributes to the narrative, but not the main subject.
"low" — Incidental mention. Passing reference, background color, one-off name drop. The text is fully understandable without this entity.

Scoring examples:
- Drug approval article: the drug name = "high", the FDA = "high", a competitor drug mentioned once = "low"
- Company profile: the company = "high", its CEO = "high", a client mentioned once = "medium", the city of a branch office = "low"
- Methodology article: the method name = "high", the original paper author = "medium", an example scenario = "low"

DO NOT extract entities that would be scored "low" AND are common/generic. If it's low relevance AND a generic term (政府部门, 医院名称, 常见地名), skip it entirely.

## Limits
- Max 12 entities + 5 concepts (15 total)
- Prefer high/medium relevance. Low relevance + generic term = skip

## Relation Types

Use Chinese types for Chinese relations, English types for English relations. If none fits, use "mentions":
- 任职于 / works_at: A works at B
- 认识 / knows: A knows B
- 投资了 / invested_in: A invested in B
- 创立了 / founded: A founded B
- 收购了 / acquired: A acquired B
- 合作 / partnered_with: A partners with B
- 竞争对手 / competitor: A competes with B
- 子公司 / subsidiary_of: A is subsidiary of B
- 批准了 / approved: A approved B (e.g. FDA approved a drug)
- 发布了 / announced: A announced B (e.g. company announced results)
- mentions: general reference

## Event Rules
- Extract events with specific dates (YYYY-MM-DD, Q1 2026, 2024) or clear time references
- Include regulatory events (FDA approval, CHMP opinion, NMPA filing)
- Include financial events (earnings release, acquisition close, investment round)
- Skip vague statements ("近年来", "over the years", "recently")
- participants must be named entities from the text
- description can be in Chinese or English, matching the source

## General Rules
1. Only extract information explicitly stated in the text — no inference
2. Deduplicate: same person/company appears only once
3. context must be a verbatim excerpt from the source text
4. Return empty arrays for fields with nothing to extract
5. Return ONLY JSON, no explanation`;

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

    const response = await this.llm.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: truncated },
    ]);

    return filterResult(this.parseResponse(response));
  }

  private parseResponse(raw: string): ExtractionResult {
    const empty: ExtractionResult = { entities: [], relations: [], events: [] };

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);

      const entities = Array.isArray(parsed.entities)
        ? parsed.entities.map((e: Record<string, unknown>) => ({
            ...e,
            relevance: e.relevance ?? "medium",
          }))
        : [];

      return {
        entities,
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return empty;
    }
  }
}
