import type { LLMProvider } from "../llm/provider.js";

// ─── Types ──────────────────────────────────────────────────

export type EntityType = "person" | "company" | "location" | "concept" | "product";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
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
  // Phone numbers: pure digits ≥8
  if (/^\d{8,}$/.test(name)) return true;
  // Email addresses
  if (/@/.test(name)) return true;
  // WeChat IDs: pure alphanumeric without CJK, ≥4 chars (but not Chinese names)
  if (/^[a-zA-Z][a-zA-Z0-9]{3,}$/.test(name) && !/[一-鿿]/.test(name)) return true;
  // Bare city/province names: 1-3 chars, single location word
  if (type === "location" && /^[一-鿿]{2,3}[市县区]?$/.test(name)) return true;
  // Abbreviations: all-uppercase <6 chars
  if (/^[A-Z]{2,3}$/.test(name)) return true;
  // Job titles: contains job-related keywords
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问/.test(name)) return true;
  // Date patterns
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return true;
  return false;
}

const GENERIC_TERMS = new Set([
  // Common abstract nouns
  "现实", "个体", "未来", "痛苦", "梦想", "成功", "失败", "优秀", "勇气", "自由",
  "幸福", "希望", "命运", "真理", "价值", "意义", "智慧", "经验", "能力", "力量",
  // General qualities
  "领导力", "沟通", "学习", "思考", "创新", "责任", "成长", "进步", "改变", "发展",
  // Ordinary categories
  "历史", "经济", "文化", "教育", "科学", "社会", "政治", "技术", "环境", "市场",
  "艺术", "哲学", "宗教", "法律", "道德",
  // Ultra-generic
  "人类", "世界", "问题", "方法", "人", "生活", "时间", "工作", "中国", "美国",
  "公司", "团队", "国家", "政府", "组织", "系统", "数据", "信息", "知识", "机器",
  "人工智能", "历史学家",
  // Emotions/states
  "快乐", "焦虑", "爱", "恨", "恐惧", "信任", "尊重",
]);

const MAX_CONCEPTS = 3;
const MAX_TOTAL_ENTITIES = 8;

function filterResult(result: ExtractionResult): ExtractionResult {
  const validEntities = result.entities.filter(
    (e) => !GENERIC_TERMS.has(e.name) && e.name.length >= 2 && !isNoiseEntity(e.name, e.type)
  );

  // Count concepts vs non-concepts
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

const SYSTEM_PROMPT = `You are a precision entity/relation/event extractor for Chinese text.

## Output Schema (strict JSON)
{
  "entities": [{ "name": "实体名", "type": "person|company|location|concept|product", "context": "原文片段" }],
  "relations": [{ "from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据" }],
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }]
}

## Entity Extraction Rules

### DO extract:
- Named people with full names (张三, 李明) — NOT generic roles (经理, 历史学家, 优秀的人)
- Named organizations/companies (鲲鹏医院, 红杉资本) — NOT generic orgs (公司, 团队)
- Named products/projects with clear identity (iPhone, 阿波罗计划) — NOT generic products
- Named locations (北京, 中关村) — NOT generic places (城市, 办公室)

### Concept extraction — STRICT criteria (type: "concept"):
ONLY extract concepts that meet ALL of these conditions:
1. Has a clear, specific definition or framework in the text
2. Is a named methodology, theory, or intellectual framework (e.g. 第一性原理, PDCA循环, 奥卡姆剃刀)
3. Would warrant its own encyclopedia entry

DO NOT extract as concepts:
- Common abstract nouns: 现实, 个体, 未来, 痛苦, 梦想, 成功, 失败, 优秀, 勇气, 自由, 幸福
- General qualities: 领导力, 沟通, 学习, 思考, 创新, 责任
- Ordinary categories: 历史, 经济, 文化, 教育, 科学
- Text themes or topics that lack a specific framework definition

### Max limits per extraction:
- entities (person/company/product/location): ≤ 8
- concepts: ≤ 3
- Total entities: ≤ 10
If the text mentions many entities, keep only the most important ones.

### Skip entirely:
- Generic nouns that could appear in any text (人类, 社会, 世界, 问题, 方法)
- Emotions and states (快乐, 焦虑, 成长, 进步)
- Adjectives used as nouns (优秀的人 → skip, 管理者 → skip unless named)

## Relation Types (Chinese ONLY)

Use these standard Chinese types. If none fits, use "其他":
- 任职于: A在B工作
- 认识: A认识B
- 投资了: A投资了B
- 创立了: A创立了B
- 参加了: A参加了B
- 提及: A提及B
- 竞争对手: A与B竞争
- 合作伙伴: A与B合作
- 子公司: A是B的子公司
- 成员: A是B的成员
- 指导: A指导B
- 创建者: B创建了A
- 影响: A影响B

DO NOT use English relation types.

## Event Rules
- Only extract events with specific time references or clear factual claims
- Skip vague statements ("近年来", "一直以来")
- participants must be named entities from the text

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

    // Truncate to ~3000 chars to stay within token limits
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

      return {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return empty;
    }
  }
}
