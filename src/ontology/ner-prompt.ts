import type { Ontology } from "./types.js";

export function buildEntityPrompt(ontology: Ontology): string {
  const config = ontology.getNerConfig();
  const typeLines = Object.entries(config.entity_types_prompt)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const concreteTypes = ontology
    .getConcreteEntityTypes()
    .filter((t) => !["record", "insight"].includes(t));

  const fieldWhitelist: string[] = [];
  for (const type of concreteTypes) {
    const fields = ontology.getStructuredFields(type);
    const shortName = type.split("/").pop()!;
    if (fields.length > 0) {
      fieldWhitelist.push(`- ${shortName}: ${fields.join(", ")}`);
    }
  }

  return `You are a precision entity extractor for a personal knowledge graph. Extract entities worth remembering long-term.

## Entity Types
${typeLines}

## Edge case: 2-3 character Chinese terms
These are inherently ambiguous.
- VALID (extract): 特斯拉 (company), 马斯克 (person), 王传福 (person)
- INVALID (skip): 汽车 (common noun), 钢铁 (material), 能力 (abstract quality)
Decision: Does this short term refer to a specific real-world entity? If yes, extract. If common noun/abstract quality, SKIP.

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
{"entities": [{"name": "...", "type": "person|company|organization|location|place|product|drug|book|framework|technology|theory|concept", "relevance": "high|medium|low", "context": "..."}], "events": [{"date": "YYYY-MM-DD|null", "description": "...", "participants": ["..."]}], "facts": [{"entity": "...", "field": "...", "value": "...", "confidence": 0.9, "evidence": "verbatim quote"}]}

Limits: max 8 entities + 3 concepts = 11 total. Return ONLY valid JSON.`;
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
