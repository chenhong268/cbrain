import type { LLMProvider } from "../llm/provider.js";
import { getOntology } from "../ontology/loader.js";
import { buildEntityPrompt, buildRelationPrompt } from "../ontology/ner-prompt.js";

// ─── Types ──────────────────────────────────────────────────

export type EntityType =
  | "person" | "company" | "organization" | "location" | "place"
  | "product" | "drug" | "book"
  | "model" | "pharma" | "psychology" | "technology" | "concept";

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

export function getFactFieldWhitelist(): Record<string, string[]> {
  const ontology = getOntology();
  const result: Record<string, string[]> = {};
  for (const type of ontology.getConcreteEntityTypes()) {
    const shortName = type.split("/").pop()!;
    if (!type.includes("/")) continue;
    result[shortName] = ontology.getStructuredFields(type);
  }
  return result;
}

export const FACT_FIELD_WHITELIST: Record<string, string[]> = getFactFieldWhitelist();

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
  facts: StructuredFact[];
  filtered: FilteredEntity[];
}

export interface FilteredEntity {
  name: string;
  reason: string;
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
  // Overly broad tech terms
  "AI", "AI工具", "AI技术", "AI应用",
  // Generic transformation compounds (backup for suffix filter)
  "数字化转型", "智能化转型", "供应链数字化",
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
  if (/^\d+$/.test(name) || /^#\d+$/.test(name) || /^v\d+$/i.test(name) || /@/.test(name)) return null;
  if (/^[a-z][a-z0-9]{10,}$/.test(name) && !/[一-鿿]/.test(name)) return null;
  if (/^[A-Z]{2}$/.test(name) && llmType !== "concept") return null;
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return null;
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return null;
  if (STRUCTURAL_TERMS.has(name)) return null;

  // Suffix pattern: generic compound words (XX化, XX模式, etc.)
  // Skip suffix filter for concrete entity types (person, company, etc.)
  const isConcreteEntity = !!getOntology().getEntityType(`entity/${llmType}`);
  if (!isConcreteEntity && /化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/.test(name)) return null;

  // ── Layer 2: SAFETY NET — clear organizational keywords override LLM ──
  if (/公司|集团|制药|药企|银行|保险|基金$|医院|大学$|学院$|研究所/.test(name)) return "entity";

  // ── Layer 3: TRUST LLM — primary classifier ──
  const ontology = getOntology();
  // Concept types: model, pharma, psychology, technology, concept
  const conceptType = ontology.getEntityType(`concept/${llmType}`);
  if (conceptType) return "concept";
  // Entity types: person, company, organization, location, place, product, drug, book
  const entityType = ontology.getEntityType(`entity/${llmType}`);
  if (entityType) return "entity";
  // Legacy: direct match as concept (e.g. LLM returns "concept")
  if (llmType === "concept") return "concept";
  return null;
}

const MAX_CONCEPTS = 8;
const MAX_TOTAL_ENTITIES = 10;

export interface FilterOutcome {
  kept: ExtractedEntity[];
  filtered: Array<{ entity: ExtractedEntity; reason: string }>;
}

function getFilterReason(name: string, llmType: string): string {
  if (GENERIC_TERMS.has(name)) return "blacklisted";
  if (name.length < 2) return "too_short";
  if (/^\d+$/.test(name) || /^#\d+$/.test(name) || /^v\d+/i.test(name)) return "numeric";
  if (/^[0-9a-f]{6,}$/i.test(name)) return "hash_like";
  if (/^[a-z][a-z0-9-]{6,}$/.test(name) && !/[一-鿿]/.test(name) && llmType !== "concept") return "hash_like";
  if (/^[A-Z]{2}$/.test(name) && llmType !== "concept") return "two_letter_code";
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return "job_title";
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return "date_pattern";
  if (STRUCTURAL_TERMS.has(name)) return "structural_term";
  if (!getOntology().getEntityType(`entity/${llmType}`) && /化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/.test(name)) return "generic_suffix";
  return "unclassified_type";
}

export function filterExtractedEntities(
  entities: ExtractedEntity[],
  opts?: { mode?: "auto" | "manual" }
): FilterOutcome {
  const mode = opts?.mode ?? "manual";
  const filtered: Array<{ entity: ExtractedEntity; reason: string }> = [];

  // Classify: entity / concept / null (filtered)
  const classified = entities
    .map((e) => {
      const cls = classifyEntity(e.name, e.type);
      if (cls === null) {
        filtered.push({ entity: e, reason: getFilterReason(e.name, e.type) });
      }
      return { ...e, class: cls };
    })
    .filter((e) => e.class !== null);

  // Sort by relevance: high > medium > low. Drop low into filtered.
  const ranked = classified.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (order[a.relevance] ?? 2) - (order[b.relevance] ?? 2);
  });

  // Low relevance → filtered
  for (const e of ranked) {
    if (e.relevance === "low") {
      filtered.push({ entity: e, reason: "low_relevance" });
    }
  }

  let rankedNonLow = ranked.filter((e) => e.relevance !== "low");

  // Auto mode: medium relevance → filtered
  if (mode === "auto") {
    for (const e of rankedNonLow) {
      if (e.relevance === "medium") {
        filtered.push({ entity: e, reason: "auto_medium_skipped" });
      }
    }
    rankedNonLow = rankedNonLow.filter((e) => e.relevance !== "medium");
  }

  const concepts = rankedNonLow.filter((e) => e.class === "concept");
  const nonConcepts = rankedNonLow.filter((e) => e.class === "entity");

  const keptConcepts = concepts.slice(0, MAX_CONCEPTS);
  const keptNonConcepts = nonConcepts.slice(0, MAX_TOTAL_ENTITIES - keptConcepts.length);

  // Cap overflow → filtered
  for (const e of concepts.slice(MAX_CONCEPTS)) {
    filtered.push({ entity: e, reason: "concept_cap" });
  }
  for (const e of nonConcepts.slice(MAX_TOTAL_ENTITIES - keptConcepts.length)) {
    filtered.push({ entity: e, reason: "entity_cap" });
  }

  const kept = [...keptNonConcepts, ...keptConcepts].map((e) => ({ ...e, class: e.class! as EntityType }));
  return { kept, filtered };
}

export function filterRelations(
  relations: ExtractedRelation[],
  validEntityNames: Set<string>
): ExtractedRelation[] {
  return relations.filter(
    (r) => validEntityNames.has(r.from) && validEntityNames.has(r.to)
  );
}

// ─── Prompt: Guideline (HOW) — Entity ────────────────────────
// Now dynamically generated from ontology via buildEntityPrompt()

// ─── Prompt: Guideline (HOW) — Relation ──────────────────────
// Now dynamically generated from ontology via buildRelationPrompt()

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

  get provider(): LLMProvider {
    return this.llm;
  }

  async extract(text: string): Promise<ExtractionResult> {
    if (!text.trim()) {
      return { entities: [], relations: [], events: [], facts: [], filtered: [] };
    }

    const CHUNK_SIZE = 2500;

    const chunks = chunkBySentences(text, CHUNK_SIZE);

    let allEntities: ExtractedEntity[];
    let allEvents: ExtractedEvent[];
    let allFacts: StructuredFact[];

    const entityPrompt = buildEntityPrompt(getOntology());

    if (chunks.length === 1) {
      // Short text fast path — single chunk, no parallelism overhead
      const { entities, events, facts } = await this.llm.chat([
        { role: "system", content: entityPrompt },
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
              { role: "system", content: entityPrompt },
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

    const { kept: filtered, filtered: filteredOut } = filterExtractedEntities(allEntities);
    const nerFiltered = filteredOut.map(f => ({ name: f.entity.name, reason: f.reason }));
    if (filtered.length === 0) {
      return { entities: [], relations: [], events: allEvents, facts: [], filtered: nerFiltered };
    }

    // Stage 2: Extract relations — feed extracted entity names as context
    const entityNames = filtered.map(e => e.name);
    const stage2Text = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
    const stage2 = await this.llm.chat([
      { role: "system", content: buildRelationPrompt(getOntology(), entityNames) },
      { role: "user", content: stage2Text },
    ]);
    const relations = this.parseRelationResponse(stage2, new Set(entityNames));

    return { entities: filtered, relations, events: allEvents, facts: allFacts, filtered: nerFiltered };
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
