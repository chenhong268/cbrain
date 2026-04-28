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

const SYSTEM_PROMPT = `You are a precision entity/relation/event extractor for Chinese and English text. Extract from both languages equally well.

## Output Schema (strict JSON)
{
  "entities": [{ "name": "实体名", "type": "person|company|location|concept|product", "context": "原文片段" }],
  "relations": [{ "from": "实体A", "to": "实体B", "relation": "RELATION_TYPE", "context": "原文依据" }],
  "events": [{ "date": "YYYY-MM-DD or null", "description": "事件描述", "participants": ["参与人/组织"] }]
}

## Entity Extraction Rules

### DO extract:
- Named people with full names — Chinese (张三, 李明) and English (John Smith, Dr. Chen) — NOT generic roles
- Named organizations/companies — Chinese (鲲鹏医院, 红杉资本) and English (Novartis, FDA, Goldman Sachs) — NOT generic orgs
- Named products/projects — Chinese (灵境系统) and English (Cosentyx, iPhone, ChatGPT)
- Drug/pharmaceutical names (Fabhalta, Rhapsido, Kisqali, Entresto) — type: "product"
- Medical/regulatory bodies (FDA, EMA, CHMP, NMPA) — type: "company"
- Named locations — Chinese (北京) and English (Basel, Switzerland, Silicon Valley)
- Financial/business terms used as proper entities (NYSE: NVS, S&P 500)
- Numbers with clear entity identity (Q1 2026, Phase III, FY2025)

### Concept extraction (type: "concept"):
Extract as concept if ANY of:
1. Named methodology, theory, or intellectual framework (第一性原理, PDCA, Six Sigma)
2. Benchmark, evaluation metric, or standard dataset (MMLU, C-Eval, BLEU)
3. Well-known technical term or architectural pattern (RAG, LoRA, transformer, LLM)
4. Abbreviation or acronym that is a proper noun (GPU, API, GPT, IgAN, HS, CKM)
5. Medical/pharmaceutical terms (IgA nephropathy, hidradenitis suppurativa, CKM syndrome)
6. Financial metrics as concepts (net sales, core operating income, free cash flow, cc growth, USD growth)
7. Business terms with specific meaning (M&A, acquisition, licensing deal, regulatory approval)

DO NOT extract as concepts:
- Common abstract nouns (现实, 个体, 未来, leadership, innovation, growth)
- General qualities (领导力, 沟通, efficiency, quality)
- Ordinary categories (历史, 经济, market, industry)
- Generic financial terms (revenue, profit, cost — unless part of a named metric like "core operating income")

### Max limits per extraction:
- entities (person/company/product/location): <= 12
- concepts: <= 5
- Total entities: <= 15
If the text mentions many entities, keep only the most important ones.

### Skip entirely:
- Generic nouns that could appear in any text (人类, 社会, 世界, 问题, method, data, report)
- Emotions and states (快乐, 焦虑, growth as abstract concept)
- Adjectives used as nouns (优秀的人, leaders unless named)
- Common financial terms without entity identity (million, billion, percent, quarter)

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
