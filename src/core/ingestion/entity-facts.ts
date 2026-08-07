import type { LLMProvider } from "../../llm/provider.js";
import type { PageManager } from "../page.js";
import { getFactFieldWhitelist } from "./ner.js";

export const ENTITY_FACTS_TIMEOUT_MS = 60_000;

export class EntityFactsTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`entity facts extraction timed out after ${timeoutMs}ms`);
    this.name = "EntityFactsTimeoutError";
  }
}

const ENTITY_FACTS_PROMPT = `You are a structured fact extractor. Given an entity's page content, extract concrete, verifiable facts as key-value pairs.

## Field whitelist by entity type:
- person: birthday, birthplace, english_name, current_title, organization, reports_to
- company: location, industry, founded_year
- product: generic_name, brand_name

## Rules:
- Every fact MUST have an evidence field (verbatim quote from source)
- Do NOT infer or fabricate — only extract explicitly stated facts
- Skip fields not in the whitelist
- confidence: 0.0-1.0

## Output (JSON only):
{"facts": [{"field": "field name", "value": "value", "confidence": 0.9, "evidence": "verbatim quote"}]}

Return ONLY valid JSON.`;

interface RawFact {
  field: string;
  value: string;
  confidence: number;
  evidence: string;
}

export async function extractEntityFacts(input: {
  pages: PageManager;
  llm: LLMProvider;
  slug: string;
  title: string;
  type: string;
  body: string;
  timeoutMs?: number;
}): Promise<{ appliedCount: number }> {
  const page = input.pages.getBySlug(input.slug);
  if (!page) return { appliedCount: 0 };

  const timeoutMs = input.timeoutMs ?? ENTITY_FACTS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EntityFactsTimeoutError(timeoutMs)), timeoutMs);
  });

  let raw: string;
  try {
    raw = await Promise.race([
      input.llm.chat([
        { role: "system", content: ENTITY_FACTS_PROMPT },
        { role: "user", content: `Entity: ${input.title}\nType: ${input.type}\n\nContent:\n${input.body.slice(0, 3000)}` },
      ]),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let facts: RawFact[];
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
    const parsed = JSON.parse(cleaned);
    facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
      .filter((fact: Record<string, unknown>) => fact.field && fact.value && fact.evidence);
  } catch {
    return { appliedCount: 0 };
  }

  const shortType = input.type.split("/").pop() ?? input.type;
  const allowedFields = getFactFieldWhitelist()[shortType] ?? [];
  // Re-read after the LLM wait. A concurrent trusted/manual update must win over
  // the stale frontmatter snapshot captured before extraction started.
  const currentPage = input.pages.getBySlug(input.slug);
  if (!currentPage) return { appliedCount: 0 };
  const pageData = currentPage.frontmatter ?? {};
  const extra: Record<string, string> = {};

  for (const fact of facts) {
    if (!allowedFields.includes(fact.field)) continue;
    const current = pageData[fact.field];
    if (current !== undefined && current !== null && current !== "") continue;
    extra[fact.field] = String(fact.value);
    if (fact.field === "organization") {
      const existingSource = pageData.organization_source;
      if (existingSource !== "manual" && existingSource !== "agent") {
        extra.organization_source = "ner";
      }
    }
  }

  const appliedCount = Object.keys(extra).length;
  if (appliedCount > 0) input.pages.update(input.slug, { extra });
  return { appliedCount };
}
