# LLM-assisted Entity Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM semantic matching to EntityResolver so Chinese abbreviations like "南药"→"南京医药集团股份有限公司" are automatically recognized as the same entity, preventing duplicate entity creation.

**Architecture:** Add an async `semanticResolve()` method to `EntityResolver`. After rule-based `resolveAll()` identifies `stub_created` candidates, `semanticResolve()` batches them into a single LLM call that compares against existing entity names. Matched candidates get their resolution upgraded from `stub_created` to `alias_added`, and an alias is written to the DB. No changes to sync resolution path — LLM layer is strictly additive and opt-in.

**Tech Stack:** TypeScript, Bun test runner, existing LLMProvider interface

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/ingestion/entity-resolver.ts` | Modify | Add `llm` to constructor, add `semanticResolve()` method, add `buildSemanticPrompt()` helper |
| `tests/core/entity-resolver.test.ts` | Modify | Add tests for semantic resolution with mock LLM |
| `src/core/ingestion/pipeline.ts` | Modify | Pass `nerEngine.llm` to EntityResolver, call `semanticResolve` after `resolveAll` |
| `src/core/ingestion/dialogue.ts` | Modify | Pass `llm` to EntityResolver, call `semanticResolve` after `resolveAll` |

---

### Task 1: Test — semantic resolve detects abbreviation match

**Files:**
- Modify: `tests/core/entity-resolver.test.ts`

- [ ] **Step 1: Add mock LLM provider and semantic resolve test**

Add at the end of `tests/core/entity-resolver.test.ts`, inside the outer `describe("EntityResolver", ...)` block:

```typescript
import type { LLMProvider } from "../../src/llm/provider.js";

// ─── Mock LLM ──────────────────────────────────────────────

function createMockLlm(response: string): LLMProvider {
  return {
    name: "mock",
    chat: async () => response,
  };
}

// ─── Layer 3: LLM semantic resolution ────────────────────

describe("semantic resolution", () => {
  test("abbreviation match: 南药 → 南京医药集团股份有限公司", async () => {
    seedEntity("南京医药集团股份有限公司", "entity", "entity/nanjing-pharma");

    const mockLlm = createMockLlm(
      JSON.stringify({
        matches: [
          { candidate: "南药", entity: "南京医药集团股份有限公司", confidence: 0.9 },
        ],
      })
    );

    const resolver = new EntityResolver(db, mockLlm);
    const results = resolver.resolveAll([candidate("南药", "company")]);
    expect(results.get("南药")?.action).toBe("stub_created");

    await resolver.semanticResolve(results, [candidate("南药", "company")]);

    const resolved = results.get("南药")!;
    expect(resolved.action).toBe("alias_added");
    expect(resolved.slug).toBe("entity/nanjing-pharma");
    expect(resolved.matchedBy).toBe("llm_semantic");
    expect(resolved.aliasAdded).toBe("南药");

    // Verify alias persisted in DB
    expect(db.getSlugByAlias("南药")).toBe("entity/nanjing-pharma");
  });

  test("no match → stays stub_created", async () => {
    seedEntity("南京医药集团股份有限公司", "entity", "entity/nanjing-pharma");

    const mockLlm = createMockLlm(JSON.stringify({ matches: [] }));

    const resolver = new EntityResolver(db, mockLlm);
    const results = resolver.resolveAll([candidate("全新公司", "company")]);

    await resolver.semanticResolve(results, [candidate("全新公司", "company")]);

    expect(results.get("全新公司")?.action).toBe("stub_created");
  });

  test("no LLM → semantic resolve is no-op", async () => {
    const resolver = new EntityResolver(db);
    const results = resolver.resolveAll([candidate("南药", "company")]);

    await resolver.semanticResolve(results, [candidate("南药", "company")]);

    expect(results.get("南药")?.action).toBe("stub_created");
  });

  test("already resolved entities are not sent to LLM", async () => {
    seedEntity("张三", "entity", "entity/zhangsan");

    let capturedPrompt = "";
    const mockLlm: LLMProvider = {
      name: "mock",
      chat: async (msgs) => {
        capturedPrompt = msgs[1].content;
        return JSON.stringify({ matches: [] });
      },
    };

    const resolver = new EntityResolver(db, mockLlm);
    const results = resolver.resolveAll([
      candidate("张三"),     // exact match, should NOT go to LLM
      candidate("南药", "company"),  // stub, should go to LLM
    ]);

    await resolver.semanticResolve(results, [
      candidate("张三"),
      candidate("南药", "company"),
    ]);

    // Only 南药 should appear in the prompt, not 张三
    expect(capturedPrompt).toContain("南药");
    expect(capturedPrompt).not.toContain("张三");
  });

  test("LLM returns invalid JSON → graceful fallback to stub_created", async () => {
    seedEntity("南京医药集团股份有限公司", "entity", "entity/nanjing-pharma");

    const mockLlm = createMockLlm("not valid json {{{");

    const resolver = new EntityResolver(db, mockLlm);
    const results = resolver.resolveAll([candidate("南药", "company")]);

    await resolver.semanticResolve(results, [candidate("南药", "company")]);

    expect(results.get("南药")?.action).toBe("stub_created");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts`
Expected: FAIL — `semanticResolve` does not exist on `EntityResolver`

---

### Task 2: Implement — semanticResolve method

**Files:**
- Modify: `src/core/ingestion/entity-resolver.ts`

- [ ] **Step 1: Add LLMProvider import and constructor parameter**

In `src/core/ingestion/entity-resolver.ts`, add import at top:

```typescript
import type { LLMProvider } from "../llm/provider.js";
```

Change constructor:

```typescript
export class EntityResolver {
  constructor(private db: CBrainDB, private llm?: LLMProvider) {}
```

- [ ] **Step 2: Add SEMANTIC_MATCH_PROMPT and semanticResolve method**

Add before the `// ─── Helpers ───` section at the bottom of the file:

```typescript
// ─── Layer 3: LLM semantic resolution ──────────────────────

const SEMANTIC_MATCH_PROMPT = (
  candidates: Array<{ name: string; type: string }>,
  existingEntities: Array<{ title: string; type: string }>
) => `You are an entity resolution assistant for a Chinese knowledge graph.
Given new entity candidates and existing entities, determine if any candidate is an alternative name of an existing entity.

## Rules
- Chinese abbreviation patterns: taking key characters (南药→南京医药, 京东→京东集团)
- Full name vs short name (南京医药集团股份有限公司→南京医药)
- Subsidiary abbreviations (招行→招商银行)
- English-Chinese variants are NOT the same unless obviously equivalent
- When uncertain, return no match

## New Candidates
${candidates.map(c => `- ${c.name} (${c.type})`).join("\n")}

## Existing Entities
${existingEntities.map(e => `- ${e.title} (${e.type})`).join("\n")}

## Output
Return JSON only, no markdown:
{"matches": [{"candidate": "exact candidate name", "entity": "exact existing entity title", "confidence": 0.9}]}
If no matches, return: {"matches": []}`;

interface SemanticMatch {
  candidate: string;
  entity: string;
  confidence: number;
}

interface SemanticResponse {
  matches: SemanticMatch[];
}

// ─── Helpers ──────────────────────────────────────────────────
```

Then add the `semanticResolve` method to the `EntityResolver` class, after `resolveSingle`:

```typescript
  /**
   * Layer 3: LLM-assisted semantic resolution for stub_created candidates.
   * Batches all unmatched candidates into a single LLM call.
   * Mutates the resolutionMap in-place.
   */
  async semanticResolve(
    resolutionMap: Map<string, ResolutionResult>,
    candidates: EntityCandidate[]
  ): Promise<void> {
    if (!this.llm) return;

    // Collect only stub_created candidates
    const unmatched: Array<{ name: string; type: string }> = [];
    for (const c of candidates) {
      const result = resolutionMap.get(c.name);
      if (result?.action === "stub_created") {
        unmatched.push({ name: c.name, type: c.type });
      }
    }
    if (unmatched.length === 0) return;

    // Get existing entities from DB
    const allTitles = this.db.getAllEntityTitles();
    const existingEntities = allTitles.map(title => {
      const slug = this.db.getEntitySlugByTitle(title) ?? "";
      const type = this.db.getEntityType(slug) ?? "entity";
      return { title, type };
    });
    if (existingEntities.length === 0) return;

    // Call LLM
    const prompt = SEMANTIC_MATCH_PROMPT(unmatched, existingEntities);
    let response: SemanticResponse;
    try {
      const raw = await this.llm.chat([
        { role: "system", content: "Return valid JSON only. No markdown wrapping." },
        { role: "user", content: prompt },
      ]);
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
      response = JSON.parse(cleaned) as SemanticResponse;
    } catch {
      // LLM failure → graceful fallback, keep stub_created
      return;
    }

    if (!Array.isArray(response.matches)) return;

    // Apply matches
    for (const match of response.matches) {
      if (match.confidence < 0.7) continue;

      const candidateResult = resolutionMap.get(match.candidate);
      if (!candidateResult || candidateResult.action !== "stub_created") continue;

      const entitySlug = this.db.getEntitySlugByTitle(match.entity);
      if (!entitySlug) continue;

      // Upgrade resolution from stub_created → alias_added
      this.db.addAliasWithSource(entitySlug, match.candidate, "llm-semantic");
      resolutionMap.set(match.candidate, {
        slug: entitySlug,
        action: "alias_added",
        score: match.confidence,
        matchedBy: "llm_semantic",
        aliasAdded: match.candidate,
      });
    }
  }
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts`
Expected: ALL PASS

---

### Task 3: Wire into pipeline.ts

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`

- [ ] **Step 1: Extract LLM from nerEngine and pass to EntityResolver**

In `src/core/ingestion/pipeline.ts`, change the `applyExtraction` method. Find the line:

```typescript
    const resolver = new EntityResolver(this.db);
```

Replace with:

```typescript
    const resolver = new EntityResolver(this.db, this.nerEngine?.["llm" as keyof typeof this.nerEngine] as import("../llm/provider.js").LLMProvider | undefined);
```

Wait — `NerEngine` has a private `llm` field. We need to expose it. Let me check.

Actually, looking at the NerEngine class:

```typescript
export class NerEngine {
  private llm: LLMProvider;
  constructor(llm: LLMProvider) {
    this.llm = llm;
  }
```

The `llm` is private. We have two options:
1. Add a getter to NerEngine
2. Pass LLM separately through pipeline constructor

Option 1 is cleaner. Let me add a getter.

**In `src/core/ingestion/ner.ts`**, add a getter after the constructor:

```typescript
export class NerEngine {
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  get provider(): LLMProvider {
    return this.llm;
  }
```

**In `src/core/ingestion/pipeline.ts`**, change `applyExtraction`:

Find:
```typescript
    const resolver = new EntityResolver(this.db);
    const candidates = extraction.entities
```

Replace with:
```typescript
    const resolver = new EntityResolver(this.db, this.nerEngine?.provider);
    const candidates = extraction.entities
```

Then find (right after the `resolveAll` call):

```typescript
    const resolutionMap = resolver.resolveAll(candidates);

    for (const entity of extraction.entities) {
```

Replace with:
```typescript
    const resolutionMap = resolver.resolveAll(candidates);
    await resolver.semanticResolve(resolutionMap, candidates);

    for (const entity of extraction.entities) {
```

Note: `applyExtraction` is already called from the async `processNer`, so adding `await` is fine. But we need to make `applyExtraction` async. Find:

```typescript
  private applyExtraction(
```

Change to:

```typescript
  private async applyExtraction(
```

And the return type stays `Promise<NerPipelineResult>` since it already returns `NerPipelineResult` (not a promise), but the caller uses `await`. Actually, let me check — the caller does:

```typescript
return this.applyExtraction(fromSlug, extraction, skipDatelessEvents);
```

Since we're adding `await` inside `applyExtraction`, we need to make it async. Change signature to:

```typescript
  private async applyExtraction(
    fromSlug: string,
    extraction: ExtractionResult,
    skipDatelessEvents: boolean
  ): Promise<NerPipelineResult> {
```

- [ ] **Step 2: Run existing tests to check nothing broke**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/`
Expected: ALL PASS

---

### Task 4: Wire into dialogue.ts

**Files:**
- Modify: `src/core/ingestion/dialogue.ts`

- [ ] **Step 1: Pass LLM to EntityResolver and call semanticResolve**

In `src/core/ingestion/dialogue.ts`, the `DialogueManager` constructor receives `llm: LLMProvider`. Find:

```typescript
    // Step 2: Resolve kept entities through EntityResolver
    const resolver = new EntityResolver(this.db);
    const candidates = kept.map(e => ({ name: e.name, type: e.type, relevance: e.relevance }));
    const resolutionMap = resolver.resolveAll(candidates);
```

Replace with:

```typescript
    // Step 2: Resolve kept entities through EntityResolver
    const resolver = new EntityResolver(this.db, this.llm);
    const candidates = kept.map(e => ({ name: e.name, type: e.type, relevance: e.relevance }));
    const resolutionMap = resolver.resolveAll(candidates);
    await resolver.semanticResolve(resolutionMap, candidates);
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/dialogue.test.ts`
Expected: ALL PASS

---

### Task 5: Commit

- [ ] **Step 1: Stage and commit**

```bash
cd /Users/chenhong/Projects/cbrain
git add src/core/ingestion/entity-resolver.ts src/core/ingestion/ner.ts src/core/ingestion/pipeline.ts src/core/ingestion/dialogue.ts tests/core/entity-resolver.test.ts
git commit -m "feat: add LLM semantic entity resolution for Chinese abbreviations

EntityResolver gains an async semanticResolve() layer that uses LLM
to detect abbreviation/alias relationships (e.g. 南药→南京医药集团)
that rule-based matching cannot catch. Only triggers for stub_created
candidates after all rule layers fail. Falls back gracefully on LLM
errors."
```

---

## Self-Review

### Spec coverage
- [x] "南药" → "南京医药集团股份有限公司" abbreviation detection → Task 1+2
- [x] Graceful fallback when LLM fails → Task 1 (test), Task 2 (try/catch)
- [x] No performance regression (sync path unchanged) → Task 2 (LLM only for stub_created)
- [x] Pipeline integration → Task 3
- [x] Dialogue integration → Task 4
- [x] Alias persistence in DB → Task 1 (test verifies getSlugByAlias)

### Placeholder scan
- No TBD, TODO, or placeholder patterns found
- All code blocks contain complete implementations
- All test assertions are specific

### Type consistency
- `EntityCandidate` type used consistently (name, type, relevance)
- `ResolutionResult` interface unchanged — `alias_added` action reused with `matchedBy: "llm_semantic"`
- `LLMProvider` interface imported from same path in all files
- Constructor signature change (`llm?` param) is backward-compatible
