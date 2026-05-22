# NER Quality Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce garbage entities by adding suffix pattern filtering, substring dedup, and transparent filter logging.

**Architecture:** Two-stage filtering: (1) NER-side classifyEntity gets a suffix regex to block generic compound words; (2) EntityResolver gets a new Layer 2c that checks substring containment against existing entity titles. Filter results propagate to MCP return values for 小爱 to broadcast.

**Tech Stack:** TypeScript, Bun test runner, SQLite

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/ner.ts` | NER extraction, classifyEntity blacklist, filterEntities |
| `src/core/entity-resolver.ts` | Multi-layer entity resolution including new substring dedup |
| `src/core/pipeline.ts` | NER pipeline orchestration, NerPipelineResult type |
| `src/storage/sqlite.ts` | DB access layer — new `getAllEntityTitles()` method |
| `src/mcp/tools/ingest.ts` | MCP tool return value — no code change, existing JSON.stringify covers it |
| `tests/core/ner-parallel.test.ts` | NER filtering tests |
| `tests/core/entity-resolver.test.ts` | Resolver substring dedup tests |

---

### Task 1: Add suffix pattern filter to classifyEntity

**Files:**
- Modify: `src/core/ner.ts:91-109`
- Test: `tests/core/ner-parallel.test.ts`

- [ ] **Step 1: Write the failing test**

Add at the end of the `describe("NerEngine parallelization", ...)` block in `tests/core/ner-parallel.test.ts`:

```ts
describe("classifyEntity suffix filtering", () => {
  test("blocks XX化 suffix entities", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"数字化转型","type":"concept","relevance":"high","context":"讨论了数字化转型"},{"name":"特斯拉","type":"company","relevance":"high","context":"特斯拉是电动车公司"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论了数字化转型，特斯拉是电动车公司。");
    expect(result.entities.map(e => e.name)).not.toContain("数字化转型");
    expect(result.entities.map(e => e.name)).toContain("特斯拉");
  });

  test("blocks XX模式 suffix", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"商业模式","type":"concept","relevance":"medium","context":"讨论商业模式"},{"name":"马斯克","type":"person","relevance":"high","context":"马斯克发言"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论商业模式，马斯克发言。");
    expect(result.entities.map(e => e.name)).not.toContain("商业模式");
    expect(result.entities.map(e => e.name)).toContain("马斯克");
  });

  test("preserves person/company even if suffix matches", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"招商银行","type":"company","relevance":"high","context":"招商银行是股份制银行"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("招商银行是股份制银行。");
    expect(result.entities.map(e => e.name)).toContain("招商银行");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "classifyEntity suffix filtering"`
Expected: FAIL — "数字化转型" and "商业模式" are not being filtered

- [ ] **Step 3: Write minimal implementation**

In `src/core/ner.ts`, add the suffix pattern to `classifyEntity` after the `STRUCTURAL_TERMS` check (line 100), before Layer 2:

```ts
  // Suffix pattern filter: generic compound words (XX化, XX模式, etc.)
  // Exception: person and company types are never blocked by this rule
  if (!["person", "company"].includes(llmType) && /化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/.test(name)) return null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "classifyEntity suffix filtering"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ner.ts tests/core/ner-parallel.test.ts
git commit -m "feat(ner): add suffix pattern filter for generic compound words (XX化/XX模式/XX战略)"
```

---

### Task 2: Expand GENERIC_TERMS with high-frequency garbage

**Files:**
- Modify: `src/core/ner.ts:54-72` (GENERIC_TERMS set)
- Test: `tests/core/ner-parallel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("blocks AI generic terms", async () => {
  const llm = createMockLLM([
    '{"entities":[{"name":"AI","type":"concept","relevance":"medium","context":"讨论AI技术"},{"name":"AI工具","type":"product","relevance":"low","context":"使用AI工具"},{"name":"Claude","type":"product","relevance":"high","context":"Claude是AI助手"}],"events":[]}',
    '{"relations":[]}',
  ]);
  const ner = new NerEngine(llm);
  const result = await ner.extract("讨论AI技术，使用AI工具，Claude是AI助手。");
  expect(result.entities.map(e => e.name)).not.toContain("AI");
  expect(result.entities.map(e => e.name)).not.toContain("AI工具");
  expect(result.entities.map(e => e.name)).toContain("Claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "blocks AI generic terms"`
Expected: FAIL

- [ ] **Step 3: Add terms to GENERIC_TERMS**

In `src/core/ner.ts`, add to the `GENERIC_TERMS` set (after "人工智能", "企业"):

```ts
  // Overly broad tech terms
  "AI", "AI工具", "AI技术", "AI应用",
  // Generic transformation compounds (backup for suffix filter)
  "数字化转型", "智能化转型", "供应链数字化",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "blocks AI generic terms"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ner.ts tests/core/ner-parallel.test.ts
git commit -m "feat(ner): expand GENERIC_TERMS with AI and digital transformation garbage"
```

---

### Task 3: Change filterEntities to return FilterResult with filtered list

**Files:**
- Modify: `src/core/ner.ts:30-36` (new type), `src/core/ner.ts:114-134` (filterEntities)
- Test: `tests/core/ner-parallel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("filterEntities FilterResult", () => {
  test("extraction result includes filtered entities with reasons", async () => {
    const llm = createMockLLM([
      '{"entities":[{"name":"AI","type":"concept","relevance":"medium","context":"讨论AI"},{"name":"马斯克","type":"person","relevance":"high","context":"马斯克是CEO"},{"name":"数字化转型","type":"concept","relevance":"medium","context":"数字化转型很重要"}],"events":[]}',
      '{"relations":[]}',
    ]);
    const ner = new NerEngine(llm);
    const result = await ner.extract("讨论AI，马斯克是CEO，数字化转型很重要。");
    expect(result.entities.map(e => e.name)).toEqual(["马斯克"]);
    expect(result.filtered.length).toBe(2);
    const filteredNames = result.filtered.map(f => f.name);
    expect(filteredNames).toContain("AI");
    expect(filteredNames).toContain("数字化转型");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "filterEntities FilterResult"`
Expected: FAIL — `result.filtered` does not exist

- [ ] **Step 3: Write minimal implementation**

In `src/core/ner.ts`, add the new type after `ExtractionResult`:

```ts
export interface FilteredEntity {
  name: string;
  reason: string;
}
```

Modify `ExtractionResult` to include `filtered`:

```ts
export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  events: ExtractedEvent[];
  facts: StructuredFact[];
  filtered: FilteredEntity[];
}
```

Rewrite `filterEntities` to return a `FilterResult`:

```ts
interface FilterResult {
  kept: ExtractedEntity[];
  filtered: Array<{ entity: ExtractedEntity; reason: string }>;
}

function classifyWithReason(name: string, llmType: string): EntityClass & { reason?: string } {
  if (GENERIC_TERMS.has(name)) return null as unknown as EntityClass & { reason?: string };
  if (name.length < 2) return null as unknown as EntityClass & { reason?: string };
  if (/^\d+$/.test(name) || /^#\d+$/.test(name) || /^v\d+$/i.test(name) || /@/.test(name)) return null as unknown as EntityClass & { reason?: string };
  if (/^[a-z][a-z0-9]{10,}$/.test(name) && !/[一-鿿]/.test(name)) return null as unknown as EntityClass & { reason?: string };
  if (/^[A-Z]{2}$/.test(name) && llmType !== "concept") return null as unknown as EntityClass & { reason?: string };
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return null as unknown as EntityClass & { reason?: string };
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return null as unknown as EntityClass & { reason?: string };
  if (STRUCTURAL_TERMS.has(name)) return null as unknown as EntityClass & { reason?: string };
  if (!["person", "company"].includes(llmType) && /化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/.test(name)) return null as unknown as EntityClass & { reason?: string };
  if (/公司|集团|制药|药企|银行|保险|基金$|医院|大学$|学院$|研究所/.test(name)) return "entity" as EntityClass & { reason?: string };
  if (llmType === "concept") return "concept" as EntityClass & { reason?: string };
  if (["person", "company", "product", "location"].includes(llmType)) return "entity" as EntityClass & { reason?: string };
  return null as unknown as EntityClass & { reason?: string };
}
```

Wait — the above approach is messy. Better: keep `classifyEntity` unchanged, and add a separate `classifyReason` function, or just track the reason inside `filterEntities` directly.

Actually, the cleanest approach: modify `filterEntities` to call `classifyEntity` and record reasons inline:

```ts
function filterEntities(entities: ExtractedEntity[]): FilterResult {
  const kept: ExtractedEntity[] = [];
  const filtered: Array<{ entity: ExtractedEntity; reason: string }> = [];

  for (const e of entities) {
    const cls = classifyEntity(e.name, e.type);
    if (cls === null) {
      const reason = getFilterReason(e.name, e.type);
      filtered.push({ entity: e, reason });
      continue;
    }
    // Will be capped below
  }

  // Classify + rank (existing logic, but on kept entities)
  const classified = entities
    .filter(e => !filtered.some(f => f.entity.name === e.name))
    .map(e => ({ ...e, class: classifyEntity(e.name, e.type)! }));

  const ranked = classified.sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (order[a.relevance] ?? 2) - (order[b.relevance] ?? 2);
  });

  // Also add low-relevance entities to filtered
  const lowRel = ranked.filter(e => e.relevance === "low");
  for (const e of lowRel) {
    filtered.push({ entity: e, reason: "low_relevance" });
  }

  const rankedNonLow = ranked.filter(e => e.relevance !== "low");
  const concepts = rankedNonLow.filter(e => e.class === "concept");
  const nonConcepts = rankedNonLow.filter(e => e.class === "entity");
  const keptConcepts = concepts.slice(0, MAX_CONCEPTS);
  const keptNonConcepts = nonConcepts.slice(0, MAX_TOTAL_ENTITIES - keptConcepts.length);

  // Cap overflow
  const overflowConcepts = concepts.slice(MAX_CONCEPTS);
  for (const e of overflowConcepts) filtered.push({ entity: e, reason: "concept_cap" });
  const overflowNonConcepts = nonConcepts.slice(MAX_TOTAL_ENTITIES - keptConcepts.length);
  for (const e of overflowNonConcepts) filtered.push({ entity: e, reason: "entity_cap" });

  kept.push(...keptNonConcepts, ...keptConcepts);
  return {
    kept: kept.map(e => ({ ...e, type: e.class! as EntityType })),
    filtered,
  };
}

function getFilterReason(name: string, llmType: string): string {
  if (GENERIC_TERMS.has(name)) return "blacklisted";
  if (name.length < 2) return "too_short";
  if (/^\d+$/.test(name) || /^#\d+$/.test(name) || /^v\d+$/i.test(name)) return "numeric";
  if (/^[a-z][a-z0-9]{10,}$/.test(name) && !/[一-鿿]/.test(name)) return "hash_like";
  if (/^[A-Z]{2}$/.test(name) && llmType !== "concept") return "two_letter_code";
  if (/经理|总监|代表|主管|专员|主任|总裁|负责人|工程师|顾问|人员|管理员|作家/.test(name)) return "job_title";
  if (/\d{4}[年.\-/]\d{1,2}[月日]?/.test(name)) return "date_pattern";
  if (STRUCTURAL_TERMS.has(name)) return "structural_term";
  if (!["person", "company"].includes(llmType) && /化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/.test(name)) return "generic_suffix";
  return "unclassified_type";
}
```

Then update `NerEngine.extract()` to use `FilterResult` and populate `ExtractionResult.filtered`:

In the `extract` method, replace:
```ts
const filtered = filterEntities(allEntities);
```
with:
```ts
const { kept: filtered, filtered: filteredOut } = filterEntities(allEntities);
```

And add `filtered` to the return values. The empty result case:
```ts
if (filtered.length === 0) {
  return { entities: [], relations: [], events: allEvents, facts: [], filtered: filteredOut.map(f => ({ name: f.entity.name, reason: f.reason })) };
}
```

And the final return:
```ts
return { entities: filtered, relations, events: allEvents, facts: allFacts, filtered: filteredOut.map(f => ({ name: f.entity.name, reason: f.reason })) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts --filter "filterEntities FilterResult"`
Expected: PASS

- [ ] **Step 5: Run all existing tests to verify no regression**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/ner-parallel.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/ner.ts tests/core/ner-parallel.test.ts
git commit -m "feat(ner): filterEntities returns FilterResult with filtered entities and reasons"
```

---

### Task 4: Add getAllEntityTitles to CBrainDB

**Files:**
- Modify: `src/storage/sqlite.ts` (add method after `getEntityType`)
- Test: `tests/core/entity-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/entity-resolver.test.ts`:

```ts
describe("getAllEntityTitles", () => {
  test("returns all entity and concept titles", () => {
    seedEntity("张三", "entity", "entity/zhangsan");
    seedEntity("AI Agents", "concept", "concept/ai-agents");
    db.upsertPage({ slug: "record/note1", type: "record", title: "Some Note", filePath: "record/note1.md", contentHash: "abc" });

    const titles = db.getAllEntityTitles();
    expect(titles).toContain("张三");
    expect(titles).toContain("AI Agents");
    expect(titles).not.toContain("Some Note");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts --filter "getAllEntityTitles"`
Expected: FAIL — method does not exist

- [ ] **Step 3: Write minimal implementation**

In `src/storage/sqlite.ts`, add after the `getEntityType` method (after line 1466):

```ts
getAllEntityTitles(): string[] {
  const rows = this.prepare(
    "SELECT title FROM pages WHERE type IN ('entity', 'concept')"
  ).all() as Array<{ title: string }>;
  return rows.map(r => r.title);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts --filter "getAllEntityTitles"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite.ts tests/core/entity-resolver.test.ts
git commit -m "feat(db): add getAllEntityTitles for substring dedup lookups"
```

---

### Task 5: Add Layer 2c substring dedup to EntityResolver

**Files:**
- Modify: `src/core/entity-resolver.ts:136-141` (between Layer 2b and "no match")
- Test: `tests/core/entity-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/core/entity-resolver.test.ts`:

```ts
// ─── Layer 2c: Substring dedup ────────────────────────────

describe("substring dedup", () => {
  test("new entity is substring of existing → resolved_to_existing", () => {
    seedEntity("AI Agents", "entity", "entity/ai-agents");

    const result = resolver.resolveSingle(candidate("AI"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.matchedBy).toBe("substring_dedup");
    expect(result.slug).toBe("entity/ai-agents");
    expect(result.score).toBe(0.7);
  });

  test("existing entity is substring of new entity → resolved_to_existing", () => {
    seedEntity("Claude", "entity", "entity/claude");

    const result = resolver.resolveSingle(candidate("Claude Code"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.matchedBy).toBe("substring_dedup");
    expect(result.slug).toBe("entity/claude");
  });

  test("length diff < 2 → no substring match", () => {
    seedEntity("市场营销", "entity", "entity/marketing");

    const result = resolver.resolveSingle(candidate("市场策略"));
    expect(result.action).toBe("stub_created");
  });

  test("substring length ≤ 1 → no match", () => {
    seedEntity("C++", "entity", "entity/cpp");

    const result = resolver.resolveSingle(candidate("C"));
    expect(result.action).toBe("stub_created");
  });

  test("exact substring: 数字化 → 数字化转型", () => {
    seedEntity("数字化转型", "entity", "entity/digital-transformation");

    const result = resolver.resolveSingle(candidate("数字化"));
    expect(result.action).toBe("resolved_to_existing");
    expect(result.matchedBy).toBe("substring_dedup");
    expect(result.slug).toBe("entity/digital-transformation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts --filter "substring dedup"`
Expected: FAIL — all resolve to `stub_created`

- [ ] **Step 3: Write minimal implementation**

In `src/core/entity-resolver.ts`, add a helper function after the existing helpers:

```ts
function findSubstringMatch(name: string, db: CBrainDB): { slug: string; title: string } | null {
  const allTitles = db.getAllEntityTitles();
  for (const existing of allTitles) {
    // Guard: substring length must be > 1, and length diff must be >= 2
    if (existing.includes(name) && name.length > 1 && existing.length - name.length >= 2) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
    if (name.includes(existing) && existing.length > 1 && name.length - existing.length >= 2) {
      const slug = db.getEntitySlugByTitle(existing);
      if (slug) return { slug, title: existing };
    }
  }
  return null;
}
```

Then in `resolveSingle`, add Layer 2c between the parenthetical block and the "no match" fallback (before line 139):

```ts
    // Layer 2c: substring dedup
    const subMatch = findSubstringMatch(name, this.db);
    if (subMatch) {
      if (checkTypeGate(this.db, subMatch.slug, entityType)) {
        return { slug: subMatch.slug, action: "resolved_to_existing", score: 0.7, matchedBy: "substring_dedup" };
      }
      return { slug: subMatch.slug, action: "duplicate_candidate", score: 0.7, matchedBy: "substring_dedup" };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts --filter "substring dedup"`
Expected: PASS

- [ ] **Step 5: Run all resolver tests to verify no regression**

Run: `cd /Users/chenhong/Projects/cbrain && bun test tests/core/entity-resolver.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/entity-resolver.ts src/storage/sqlite.ts tests/core/entity-resolver.test.ts
git commit -m "feat(resolver): add Layer 2c substring dedup to prevent generic entity duplicates"
```

---

### Task 6: Propagate filtered entities through pipeline to MCP return value

**Files:**
- Modify: `src/core/pipeline.ts:32-44` (NerPipelineResult type), `src/core/pipeline.ts:321-333` (return value)
- Test: check existing tests pass

- [ ] **Step 1: Update NerPipelineResult type**

In `src/core/pipeline.ts`, add `filtered` field to `NerPipelineResult`:

```ts
export interface NerPipelineResult {
  entities: number;
  relations: number;
  events: number;
  factsWritten: number;
  stubsCreated: string[];
  lowRelevanceSkipped: number;
  filtered: Array<{ name: string; reason: string; matchedEntity?: string }>;
  details: {
    entities: Array<{ name: string; type: string; relevance: string }>;
    relations: Array<{ from: string; to: string; relation: string }>;
    events: Array<{ date: string | null; description: string }>;
  };
}
```

- [ ] **Step 2: Propagate filter info in applyExtraction return value**

In `applyExtraction`, after the `filtered: filteredOut.map(...)` logic from Task 3, the `processNer` method receives the `ExtractionResult` which now includes `filtered`. Wire it through.

In `applyExtraction`, before the final `return {` statement, add the NER-side filtered entities:

```ts
    // Collect filter info from extraction result
    const nerFiltered = (extraction as ExtractionResult & { filtered?: Array<{ name: string; reason: string }> }).filtered ?? [];
```

And add `filtered: nerFiltered` to the return object:

```ts
    return {
      entities: extraction.entities.length,
      relations: extraction.relations.length,
      events: extraction.events.length,
      factsWritten,
      stubsCreated: [...stubsCreated],
      lowRelevanceSkipped,
      filtered: nerFiltered,
      details: {
        entities: extraction.entities.map(e => ({ name: e.name, type: e.type, relevance: e.relevance })),
        relations: writtenRelations,
        events: extraction.events.map(e => ({ date: e.date, description: e.description })),
      },
    };
```

The MCP tool (`ingest.ts`) already does `JSON.stringify(result, null, 2)` so `filtered` will appear in the response automatically — no code change needed there.

- [ ] **Step 3: Run all tests**

Run: `cd /Users/chenhong/Projects/cbrain && bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/pipeline.ts
git commit -m "feat(pipeline): propagate filtered entities to MCP return value for transparency"
```

---

### Task 7: Run full test suite and verify

- [ ] **Step 1: Run all tests**

Run: `cd /Users/chenhong/Projects/cbrain && bun test`
Expected: ALL PASS, 0 failures

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/chenhong/Projects/cbrain && bunx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address test/type issues from NER quality filtering"
```
