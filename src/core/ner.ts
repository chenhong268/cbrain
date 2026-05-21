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

export interface StructuredFact {
  entity: string;
  field: string;
  value: string;
  confidence: number;
  evidence: string;
}

export const FACT_FIELD_WHITELIST: Record<EntityType, string[]> = {
  person: ["birthday", "birthplace", "english_name", "current_title", "organization", "reports_to"],
  company: ["location", "industry", "founded_year"],
  product: ["generic_name", "brand_name"],
  location: [],
  concept: [],
};

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
  facts: StructuredFact[];
}

// ─── Post-extraction classification (safety net) ──────────
// With glm-5-turbo as primary classifier, rules here are a minimal safety net.
// GENERIC_TERMS catches universal noise, company suffixes catch overrides,
// job-title regex catches structured roles. All other classification is
// delegated to the LLM via ENTITY_GUIDELINE and prompted edge rules for
// 2-3 char Chinese ambiguity.

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
  "人工智能", "企业",
  // Leadership / business generic
  "领导力", "沟通", "学习", "思考", "创新", "责任", "成长", "进步", "改变", "发展",
  // Generic qualities
  "资源", "效率", "品牌", "专业",
]);

const STRUCTURAL_TERMS = new Set([
  // Document headings / structural labels
  "组织架构", "人员汇总", "时间线", "概述", "总结", "目录", "备注",
  "摘要", "简介", "附录", "参考资料", "相关链接", "标签", "分类",
  "基本信息", "详细内容", "背景", "目的", "范围", "方法", "结论",
  "数据", "统计", "分析", "对比", "趋势", "报告", "详情",
  // Section headers commonly mis-extracted as entities
  "工作经历", "教育经历", "项目经验", "技能专长", "自我评价",
  "联系方式", "个人简介", "人物简介", "公司简介", "产品介绍",
  "核心业务", "主营业务", "发展历程", "企业愿景", "使命愿景",
]);

type EntityClass = "entity" | "concept" | null;

function classifyEntity(name: string, llmType: string): EntityClass {
  // ── Layer 1: BLACKLIST ──
  if (GENERIC_TERMS.has(name)) return null;
  if (name.length < 2) return null;
  if (/^\d{8,}$/.test(name) || /@/.test(name)) return null;
  if (/^[a-z][a-z0-9]{10,}$/.test(name) && !/[一-鿿]/.test(name)) return null;
  if (/^[A-Z]{2}$/.test(name) && llmType !== "concept") return null;
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return null;
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return null;
  if (STRUCTURAL_TERMS.has(name)) return null;

  // ── Layer 2: SAFETY NET — clear organizational keywords override LLM ──
  if (/公司|集团|制药|药企|银行|保险|基金$|医院|大学$|学院$|研究所/.test(name)) return "entity";

  // ── Layer 3: TRUST LLM — primary classifier ──
  if (llmType === "concept") return "concept";
  if (["person", "company", "product", "location"].includes(llmType)) return "entity";
  return null;
}

const MAX_CONCEPTS = 3;
const MAX_TOTAL_ENTITIES = 8;

function filterEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  // Classify every entity: entity / concept / skip
  const classified = entities
    .map((e) => ({ ...e, class: classifyEntity(e.name, e.type) }))
    .filter((e) => e.class !== null);

  // Sort by relevance: high > medium. Drop low.
  const ranked = classified.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (order[a.relevance] ?? 2) - (order[b.relevance] ?? 2);
  });

  const concepts = ranked.filter((e) => e.class === "concept");
  const nonConcepts = ranked.filter((e) => e.class === "entity");

  const keptConcepts = concepts.slice(0, MAX_CONCEPTS);
  const keptNonConcepts = nonConcepts.slice(0, MAX_TOTAL_ENTITIES - keptConcepts.length);

  // Override LLM type with classified type
  return [...keptNonConcepts, ...keptConcepts].map((e) => ({ ...e, type: e.class! as EntityType }));
}

function filterRelations(
  relations: ExtractedRelation[],
  validEntityNames: Set<string>
): ExtractedRelation[] {
  return relations.filter(
    (r) => validEntityNames.has(r.from) && validEntityNames.has(r.to)
  );
}

// ─── Prompt: Guideline (HOW) — Entity ────────────────────────

const ENTITY_GUIDELINE = `You are a precision entity extractor for a personal knowledge graph. Extract entities worth remembering long-term — named people, companies, products, locations, and established concepts (theories, methodologies, effects, models). When in doubt, skip it.

## Trust your judgment
For each candidate, determine:

- **entity**: specific named thing (person, company, product, location)
- **concept**: recognized abstract idea with a proper name (e.g. 飞轮效应, 第一性原理, 奥卡姆剃刀, 认知科学)
- **skip**: generic nouns, common qualities, daily items, abstract states

## Edge case: 2-3 character Chinese terms
These are inherently ambiguous — they could be real names or generic nouns.
- VALID (extract): 特斯拉 (company), 马斯克 (person), 比亚迪 (company), 王传福 (person)
- INVALID (skip): 汽车 (common noun), 钢铁 (material), 火箭 (object), 燃料 (substance), 能力 (abstract quality)
Decision: Does this short term refer to a specific real-world entity? If yes, extract. If it is a common noun or abstract quality, SKIP.

## Entity vs concept self-test
"Can I point to a specific real-world instance?"
- YES → entity (or concept if named theory/methodology)
- NO → skip

## Skip ALL
- Numbers, amounts (93亿美元, Q1 2026), pronouns, function words
- Daily items, household objects, tools
- Generic nouns (email, bank, code, brand)
- Job titles (经理, 总监, engineer)
- Departments and teams (品牌团队, sales team)
- Abstract qualities and activities (深度思考, 注意力管理, 时间管理)
- Generic business terms (消费者, 市场策略, 切换成本)
- Bare place names without significance
- Document structure words and section headings (组织架构, 人员汇总, 时间线, 工作经历, 发展历程, etc.)

## Relevance
- "high" = main subject of the text
- "medium" = supporting role
- "low" = incidental mention (try to avoid)

## Context
Must be a verbatim excerpt from the source.

## Concepts
Only extract if the term is a named methodology/theory/framework/effect/law/model with recognized usage. NOT a compound of common words.
- Valid: 飞轮效应, 第一性原理, 奥卡姆剃刀, 达克效应, 幸存者偏差
- Invalid: 深度思考, 注意力管理, 时间管理, 问题分析, 沟通方法, 效率培训

## Events
Include specific dates (YYYY-MM-DD, Q1 2026) or clear time references. Skip vague ("近年来", "recently"). Participants must be named entities.

## Structured Facts
Extract concrete, verifiable facts about entities as key-value pairs. Only extract fields listed below — skip anything not in the whitelist.

Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name

Rules:
- Every fact MUST have an evidence field: a verbatim quote from the source text
- Do NOT infer or fabricate — only extract explicitly stated facts
- Skip vague or uninformative values
- confidence: 0.0-1.0, how certain the fact is based on the evidence

## Output format (JSON only, no markdown wrap):
{"entities": [{"name": "...", "type": "person|company|location|concept|product", "relevance": "high|medium|low", "context": "..."}], "events": [{"date": "YYYY-MM-DD|null", "description": "...", "participants": ["..."]}], "facts": [{"entity": "...", "field": "...", "value": "...", "confidence": 0.9, "evidence": "verbatim quote"}]}

Limits: max 8 entities + 3 concepts = 11 total. Return ONLY valid JSON.`;

// ─── Prompt: Guideline (HOW) — Relation ──────────────────────

const RELATION_GUIDELINE = (entityNames: string[]) => `You are a relation extractor. Identify relationships between the entities listed below, based on the source text.

## Extracted Entities (use exact names)

${entityNames.map(n => `- ${n}`).join("\n")}

## Relation Types

Use these types exactly. If none fits, use "提及":

Entity relations (person/organization/product):
- 认识 — A knows B（人与人）
- 提及 — general reference（默认 fallback）
- 任职 — A works at B（人→组织）
- 创立 — A founded B（人→组织）
- 归属 — A belongs to B（组织→组织）
- 合作 — A partners with B
- 竞争 — A competes with B
- 资本 — A invested in / acquired B
- 制造 — A developed / produced B
- 下属 — A reports to / is subordinate of B（人→人）
- 上级 — A is the superior/manager of B（人→人，下属的反向）
- 参会 — A attended the same event/meeting as B（人→人，事件关联）

Concept relations (knowledge/ideas):
- 关联 — general semantic connection
- 互补 — complementary perspectives/methodologies
- 延伸 — A extends/elaborates on B
- 基础 — A is the theoretical foundation/source of B
- 对比 — A contrasts with / opposes B
- 应用 — A applied to B / B is an instance of A

## Rules
1. Both from and to MUST be in the entity list above — do not invent entity names
2. Relation must be explicitly stated or clearly implied in the source text
3. context must be a verbatim excerpt from the source
4. If no clear relation exists, return empty array {"relations": []}
5. Return ONLY JSON`;

// ─── Helpers ──────────────────────────────────────────────

function chunkBySentences(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const segments = text.split(/(?<=[。！？.!?\n])\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (segments.length === 0) return [text.slice(0, maxSize)];

  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    if (seg.length > maxSize) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < seg.length; i += maxSize) {
        chunks.push(seg.slice(i, i + maxSize));
      }
      continue;
    }
    if (current.length + seg.length > maxSize && current.length > 0) {
      chunks.push(current);
      current = seg;
    } else {
      current = current ? current + seg : seg;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function mergeEntities(chunks: ExtractedEntity[][]): ExtractedEntity[] {
  const seen = new Set<string>();
  const merged: ExtractedEntity[] = [];
  for (const chunk of chunks) {
    for (const e of chunk) {
      if (!seen.has(e.name)) {
        seen.add(e.name);
        merged.push(e);
      }
    }
  }
  return merged;
}

function mergeEvents(chunks: ExtractedEvent[][]): ExtractedEvent[] {
  const seen = new Set<string>();
  const merged: ExtractedEvent[] = [];
  for (const chunk of chunks) {
    for (const ev of chunk) {
      const key = `${ev.date ?? ""}|${ev.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(ev);
      }
    }
  }
  return merged;
}

function mergeFacts(chunks: StructuredFact[][]): StructuredFact[] {
  const best = new Map<string, StructuredFact>();
  for (const chunk of chunks) {
    for (const f of chunk) {
      const key = `${f.entity}|${f.field}`;
      const existing = best.get(key);
      if (!existing || f.confidence > existing.confidence) {
        best.set(key, f);
      }
    }
  }
  return [...best.values()];
}

// ─── NER Engine ─────────────────────────────────────────────

export class NerEngine {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  async extract(text: string): Promise<ExtractionResult> {
    if (!text.trim()) {
      return { entities: [], relations: [], events: [], facts: [] };
    }

    const CHUNK_SIZE = 2500;

    const chunks = chunkBySentences(text, CHUNK_SIZE);

    let allEntities: ExtractedEntity[];
    let allEvents: ExtractedEvent[];
    let allFacts: StructuredFact[];

    if (chunks.length === 1) {
      // Short text fast path — single chunk, no parallelism overhead
      const { entities, events, facts } = await this.llm.chat([
        { role: "system", content: ENTITY_GUIDELINE },
        { role: "user", content: chunks[0] },
      ]).then(raw => this.parseEntityResponse(raw));
      allEntities = entities;
      allEvents = events;
      allFacts = facts;
    } else {
      // Multi-chunk: batch parallel extraction
      const allEntityChunks: ExtractedEntity[][] = [];
      const allEventChunks: ExtractedEvent[][] = [];
      const allFactChunks: StructuredFact[][] = [];
      const CONCURRENCY = 5;

      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(chunk =>
            this.llm.chat([
              { role: "system", content: ENTITY_GUIDELINE },
              { role: "user", content: chunk },
            ]).then(raw => this.parseEntityResponse(raw))
          )
        );
        for (const { entities, events, facts } of results) {
          allEntityChunks.push(entities);
          allEventChunks.push(events);
          allFactChunks.push(facts);
        }
      }
      allEntities = mergeEntities(allEntityChunks);
      allEvents = mergeEvents(allEventChunks);
      allFacts = mergeFacts(allFactChunks);
    }

    const filtered = filterEntities(allEntities);
    if (filtered.length === 0) {
      return { entities: [], relations: [], events: allEvents, facts: [] };
    }

    // Stage 2: Extract relations — feed extracted entity names as context
    const entityNames = filtered.map(e => e.name);
    const stage2Text = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    const stage2 = await this.llm.chat([
      { role: "system", content: RELATION_GUIDELINE(entityNames) },
      { role: "user", content: stage2Text },
    ]);
    const relations = this.parseRelationResponse(stage2, new Set(entityNames));

    return { entities: filtered, relations, events: allEvents, facts: allFacts };
  }

  private parseEntityResponse(raw: string): { entities: ExtractedEntity[]; events: ExtractedEvent[]; facts: StructuredFact[] } {
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

      const facts: StructuredFact[] = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .filter((f: Record<string, unknown>) => f.entity && f.field && f.value && f.evidence)
        .map((f: Record<string, unknown>) => ({
          entity: String(f.entity),
          field: String(f.field),
          value: String(f.value),
          confidence: typeof f.confidence === "number" ? f.confidence : 0.5,
          evidence: String(f.evidence),
        }));

      return {
        entities,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        facts,
      };
    } catch (e) {
      console.error("[ner] stage1 JSON 解析失败", e);
      return { entities: [], events: [], facts: [] };
    }
  }

  private parseRelationResponse(raw: string, validNames: Set<string>): ExtractedRelation[] {
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      const parsed = JSON.parse(cleaned);
      const relations: ExtractedRelation[] = Array.isArray(parsed.relations) ? parsed.relations : [];
      return relations.filter(r => r.relation && validNames.has(r.from) && validNames.has(r.to));
    } catch (e) {
      console.error("[ner] stage2 JSON 解析失败", e);
      return [];
    }
  }
}
