import type { Ontology } from "./types.js";

export function buildEntityPrompt(ontology: Ontology): string {
  const config = ontology.getNerConfig();
  const typeLines = Object.entries(config.entity_types_prompt)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const concreteTypes = ontology
    .getConcreteEntityTypes()
    .filter((t) => t.includes("/"));

  const typeUnion = concreteTypes.map((t) => t.split("/").pop()).join("|");

  const fieldWhitelist: string[] = [];
  for (const type of concreteTypes) {
    const fields = ontology.getStructuredFields(type);
    const shortName = type.split("/").pop()!;
    if (fields.length > 0) {
      fieldWhitelist.push(`- ${shortName}: ${fields.join(", ")}`);
    }
  }

  return `You are a precision entity extractor for a personal knowledge graph. Extract entities AND key concepts worth remembering long-term.

## Entity Types
${typeLines}

## CRITICAL: concept extraction rules
Extract core ideas, mental models, frameworks, and reusable abstractions from the text:
- model/framework: named frameworks (SWOT, OKR) OR implicit frameworks the author constructs (e.g. "情绪稳定是输出不是性格" → extract "情绪稳定作为输出" as model)
- psychology: cognitive patterns, behavioral insights (e.g. "内在市场噪音", "情绪放大器")
- concept: reusable abstractions the reader should remember (e.g. "复利中断成本", "噪音vs信号")
- Be generous with concepts — every substantial article has 3-8 extractable ideas
- Extract the idea, not the wording. "让情绪退居二线，让现实走到前台" → concept "理性前置"
- If the text presents a numbered/structured argument system, each point is likely a separate concept

## CRITICAL: person classification rules
"person" is ONLY for real human individuals with actual names. This is the most common misclassification — be strict:
- CORRECT person: 王传福, Elon Musk, 金彭 (a person's name), 熊华风
- WRONG person: 鲲鹏 (organization/business unit), 前列腺癌 (disease), AI (concept), 人工智能 (concept), any 2-4 char term that is NOT a human name
- When in doubt between person and concept, ALWAYS choose concept or the specific entity type (disease, drug, company, etc.)
- If you cannot confirm it is a real person's name, do NOT classify as person

## Edge case: 2-3 character Chinese terms
These are inherently ambiguous.
- VALID (extract): 特斯拉 (company), 马斯克 (person), 王传福 (person)
- INVALID (skip): 汽车 (common noun), 钢铁 (material), 能力 (abstract quality)
Decision: Does this short term refer to a specific real-world entity? If yes, extract with the CORRECT type. If common noun/abstract quality, SKIP.

## Skip ALL
- Numbers, amounts, pronouns, function words
- Daily items, household objects, tools
- Generic nouns (email, bank, code, brand)
- Job titles without a specific person
- Departments and teams
- Abstract qualities and activities
- Generic business terms
- Document structure words and section headings

## Relevance
- "high" = main subject of the text
- "medium" = supporting role
- "low" = incidental mention (try to avoid)

## Context: Must be a verbatim excerpt from the source.

## Structured Facts
Field whitelist by entity type:
${fieldWhitelist.join("\n")}
Rules: Every fact MUST have an evidence field (verbatim quote). No inference. confidence: 0.0-1.0.

## Output format (JSON only, no markdown wrap):
{"entities": [{"name": "...", "type": "${typeUnion}", "relevance": "high|medium|low", "context": "..."}], "events": [{"date": "YYYY-MM-DD|null", "description": "...", "participants": ["..."]}], "facts": [{"entity": "...", "field": "...", "value": "...", "confidence": 0.9, "evidence": "verbatim quote"}]}

Limits: max 10 entities + 8 concepts = 18 total. Return ONLY valid JSON.`;
}

export function buildRelationPrompt(
  ontology: Ontology,
  entityNames: string[],
): string {
  const config = ontology.getNerConfig();
  const entityList = entityNames.map((n) => `- ${n}`).join("\n");

  const entityRels = config.relation_prompt_order
    .filter((r) => !config.concept_relations.includes(r))
    .map((r) => {
      const def = ontology.getRelationType(r);
      return def ? `- ${r} — ${def.label}` : `- ${r}`;
    })
    .join("\n");

  const conceptRels = config.concept_relations
    .map((r) => {
      const def = ontology.getRelationType(r);
      return def ? `- ${r} — ${def.label}` : `- ${r}`;
    })
    .join("\n");

  return `You are a relation extractor. Identify relationships between the entities listed below.

## Extracted Entities (use exact names)
${entityList}

## Relation Types
Use these types exactly. If none fits, use "提及":

Entity relations (person/organization/product):
${entityRels}

概念关系 (knowledge/ideas):
${conceptRels}

## Rules
1. Both from and to MUST be in the entity list above — do not invent entity names
2. Relation must be explicitly stated or clearly implied in the source text
3. context must be a verbatim excerpt from the source
4. If no clear relation exists, return empty array {"relations": []}
5. Return ONLY JSON`;
}
