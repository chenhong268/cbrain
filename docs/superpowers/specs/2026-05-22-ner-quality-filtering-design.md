# NER Quality Filtering Design

> Date: 2026-05-22
> Related Issues: #24 (pure numbers), #26 (over-extraction)

## Problem

NER extracts garbage entities that pollute the knowledge graph:
- Version numbers: `v177`, `v178`
- Pure numbers: `#5`, `6-digit financial codes`
- Generic suffix compounds: `数字化转型`, `智能化转型`, `供应链数字化`
- Overly broad terms: `AI`, `AI工具`, `AI技术`

These create tier-3 island nodes with mention_count=0 and no incoming links.

## Design

### 1. classifyEntity suffix pattern filter

Add a regex filter in Layer 1 (BLACKLIST) to catch generic Chinese compound words by their suffixes:

Pattern: `/化$|型$|式$|制$|主义$|体系$|模式$|战略$|策略$|趋势$|生态$|矩阵$|框架$|架构$/`

**Exception**: If LLM type is `person` or `company`, skip this filter (names won't match these suffixes).

Already-fixed filters (from #24):
- Pure digits: `/^\d+$/`
- Issue references: `/^#\d+$/`
- Version numbers: `/^v\d+$/i`

### 2. filterEntities return value expansion

Change `filterEntities` from returning `ExtractedEntity[]` to returning a structured result:

```ts
interface FilterResult {
  kept: ExtractedEntity[];
  filtered: Array<{ entity: ExtractedEntity; reason: string }>;
}
```

Reason codes: `"blacklisted"`, `"suffix_pattern"`, `"too_short"`, `"low_relevance"`, `"generic_term"`, `"structural_term"`.

### 3. EntityResolver substring dedup (Layer 2c)

Add a new resolution layer after Layer 2b in `entity-resolver.ts`:

**Rules**:
- If the new entity name is a **substring of** an existing entity name → `resolved_to_existing`, `matchedBy: "substring_dedup"`
- If an existing entity name is a **substring of** the new entity name → same result (keep the more specific one)

**Anti-false-positive guards**:
- Substring length ≤ 1 character → no match
- Character length difference < 2 → no match (requires meaningful containment)
- Pure digits and version patterns already filtered at NER stage, won't reach here

**Examples**:
- "AI" vs existing "AI Agents" → dedup (AI ⊂ AI Agents)
- "数字化" vs existing "数字化转型" → dedup
- "Claude" vs existing "Claude Code" → dedup
- "市场" vs existing "市场营销" → dedup (length diff ≥ 2)

### 4. Pipeline and MCP return value

`applyExtraction` in `pipeline.ts` passes filter info through to its return value.

MCP tools (`ingest`, `ingest_dialogue`) include in their NER result:

```ts
ner: {
  // existing fields (entities, relations, events, etc.)
  filtered: Array<{ name: string; reason: string; matchedEntity?: string }>;
}
```

Xiaoai (小爱) broadcasts: "本次过滤 3 个实体：AI（已有 AI Agents）、数字化转型（泛概念后缀）、v177（版本号）"

### 5. GENERIC_TERMS expansion

Add high-frequency garbage terms that slipped through:
- "AI", "AI工具", "AI技术", "AI应用"
- "数字化转型", "智能化转型"

## Files Changed

| File | Change |
|------|--------|
| `src/core/ner.ts` | Suffix regex in `classifyEntity`, `filterEntities` returns `FilterResult`, `ExtractionResult` gains `filtered` field |
| `src/core/entity-resolver.ts` | Layer 2c substring dedup in `resolveSingle` |
| `src/core/pipeline.ts` | `applyExtraction` propagates filter info, `NerPipelineResult` gains `filtered` field |
| `src/mcp/tools/ingest.ts` | Return value includes `ner.filtered` |

## What This Does NOT Do

- No LLM-based semantic dedup (substring matching is sufficient for now)
- No periodic cleanup/dream integration (deferred to issue #28 phase)
- No embedding similarity matching
- No persistent filter log file (only in MCP return value for 小爱 to broadcast)
- No changes to the LLM prompt (`ENTITY_GUIDELINE`)
