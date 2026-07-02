# Bilingual Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden CN/EN/mixed intent routing in frontdoor-router / query-router / recall-intent and fix `比较`-style over-routing, with negative-first evals and zero LLM on the default path.

**Architecture:** Pure-regex rule expansion per layer. Chinese weak signal `比较` gets a syntax gate (adverb blacklist + compare-structure whitelist); English adds only **strong** signals (no weak `review/change/manager` keywords), so bilingual over-routing is prevented without DB/entity-count checks. Hierarchy stays frontdoor-only.

**Tech Stack:** Bun, TypeScript (strict), `bun:test`.

**Commit constraint:** Single independent commit at the end (Task 6), mirroring #236. No push, no issue close. All tasks accumulate changes in the worktree.

**Spec:** `docs/superpowers/specs/2026-07-01-bilingual-intent-routing-design.md`

---

## File Structure

- **Modify:** `src/core/retrieval/frontdoor-router.ts` — remove bare `比较` from reasoning.comparison; add English strong signals to relationship/comparison/hierarchy/overview/debug.
- **Modify:** `src/core/retrieval/query-router.ts` — replace `比较` keyword with a syntax gate; add English strong signals to COMPARISON/REVIEW/RELATIONSHIP/TEMPORAL. No `hierarchy` intent.
- **Modify:** `src/core/retrieval/recall-intent.ts` — add English temporal/history/former-current regex.
- **Modify:** `tests/core/frontdoor-router.test.ts`, `tests/core/query-router.test.ts`, `tests/core/recall-intent.test.ts`, `tests/mcp/frontdoor.test.ts` — negative-first bilingual eval matrix.

Privacy: sentinels only (`实体A / 实体B / 主题A`). No real names/companies/products/paths.

---

## Task 1: frontdoor — remove bare `比较` (over-routing fix) + negative eval

**Files:**
- Modify: `src/core/retrieval/frontdoor-router.ts` (reasoning.comparison signal, line ~78)
- Modify: `tests/core/frontdoor-router.test.ts`

- [ ] **Step 1: Write the failing negative test**

Append to `tests/core/frontdoor-router.test.ts` (inside the existing `describe`):

```ts
  // ── #255 over-routing: bare 比较 (adverb) must NOT escalate ──
  test("比较 + adjective (adverb) does NOT route to reasoning/comparison", () => {
    for (const q of ["比较重要的主题A", "实体A和实体B都比较重要", "比较类似的主题"]) {
      const decision = classifyFrontdoorQuery(q);
      expect(decision.chosen_route, `${q} must not be reasoning`).not.toBe("reasoning");
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/core/frontdoor-router.test.ts`
Expected: FAIL — `比较重要的主题A` currently hits reasoning because `/对比|比较|哪个更|A\s*vs\s*B|vs\./` contains bare `比较`.

- [ ] **Step 3: Remove bare `比较` from the comparison signal**

In `src/core/retrieval/frontdoor-router.ts`, the `reasoning` rule (line ~73-80) currently has:

```ts
  {
    route: "reasoning",
    nextTool: "agentic_research",
    signals: [
      ["judgement", /帮我判断|怎么看|是否合理|有无风险|盲区|优缺点/iu],
      ["comparison", /对比|比较|哪个更|A\s*vs\s*B|vs\./iu],
    ],
  },
```

Replace the `comparison` line so it no longer matches bare `比较`:

```ts
      ["comparison", /对比|区别|哪个更|A\s*vs\s*B|vs\.|compare|difference|differ/iu],
```

(`比较` removed; `区别` and English strong signals added. Weak `比较` is handled by query-router's syntax gate; frontdoor stays conservative — a `比较 A 和 B` query falls to default content_recall here, which is safe.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/frontdoor-router.test.ts`
Expected: PASS (existing cases still pass — none of them rely on bare `比较` — plus the new negative case).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 2: query-router — `比较` syntax gate + negative eval

**Files:**
- Modify: `src/core/retrieval/query-router.ts` (COMPARISON_KEYWORDS + route + classifyComplexIntent)
- Modify: `tests/core/query-router.test.ts`

- [ ] **Step 1: Write the failing negative tests**

Append to `tests/core/query-router.test.ts` (inside the `describe("QueryRouter")` block, before its closing `});`):

```ts
  // ── #255 over-routing: 比较 adverb must NOT escalate, even with 2 entities ──
  test("比较 + adjective (adverb) does NOT escalate to comparison", () => {
    for (const q of ["比较重要的主题A", "实体A和实体B都比较重要", "比较类似的主题"]) {
      const r = router.route(q);
      expect(r.intent, `${q} must not be comparison`).not.toBe("comparison");
    }
  });

  test("比较 in compare-structure DOES escalate", () => {
    const r = router.route("比较 实体A 和 实体B");
    expect(r.intent).toBe("comparison");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/core/query-router.test.ts`
Expected: FAIL — `比较重要的主题A` currently matches `比较` in `COMPARISON_KEYWORDS` → comparison.

- [ ] **Step 3: Add the `比较` syntax gate and rewire comparison detection**

In `src/core/retrieval/query-router.ts`:

(a) Replace the COMPARISON_KEYWORDS line (line ~14):

```ts
const COMPARISON_KEYWORDS = ["对比", "区别", "哪个好", "哪个更", "vs", "VS", "compare", "difference", "differ"];
```

(`比较` removed; English strong signals added.)

(b) Add the gate helpers just below the keyword declarations (after GAP_KEYWORDS, ~line 16):

```ts
// #255 — 比较 weak signal: adverb (比较+adj) never escalates; compare-structure does.
const COMPARISON_ADVERB_RE = /比较(重要|好|像|类似|复杂|大|小|多|少|强|弱|快|慢|新|旧|长|短|高|低|常见|明显|简单|稳定|活跃|特殊|普通|关键|主流|合理|接近)/;
const COMPARISON_STRUCTURE_RE = /比较[\s\S]{0,15}(和|与|跟)|(和|与|跟)[\s\S]{0,15}比较(一下)?/;

function isComparisonIntent(query: string): boolean {
  if (COMPARISON_KEYWORDS.some((kw) => query.includes(kw))) return true;
  if (query.includes("比较")) {
    if (COMPARISON_ADVERB_RE.test(query)) return false;
    return COMPARISON_STRUCTURE_RE.test(query);
  }
  return false;
}
```

(c) In `route()`, replace the line `const hasComparison = COMPARISON_KEYWORDS.some((kw) => trimmed.includes(kw));` with:

```ts
    const hasComparison = isComparisonIntent(trimmed);
```

(d) In `classifyComplexIntent()` (line ~81), replace its first line `if (COMPARISON_KEYWORDS.some((kw) => query.includes(kw))) return "comparison";` with:

```ts
  if (isComparisonIntent(query)) return "comparison";
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/query-router.test.ts`
Expected: PASS — `比较重要的主题A` / `实体A和实体B都比较重要` no longer comparison; `比较 实体A 和 实体B` still comparison via structure whitelist; existing `实体A 对比 实体B 的区别` still comparison via strong signal.

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 3: frontdoor — bilingual positive signals + eval

**Files:**
- Modify: `src/core/retrieval/frontdoor-router.ts` (ROUTE_RULES signals)
- Modify: `tests/core/frontdoor-router.test.ts`

- [ ] **Step 1: Write the failing bilingual positive tests**

Append to `tests/core/frontdoor-router.test.ts`:

```ts
  // ── #255 bilingual positive signals ──
  test("English relationship → relationship route", () => {
    const d = classifyFrontdoorQuery("how is 实体A connected to 实体B");
    expect(d.chosen_route).toBe("relationship");
  });
  test("English hierarchy → hierarchy route", () => {
    for (const q of ["实体A reports to 实体B", "org chart for 实体A"]) {
      const d = classifyFrontdoorQuery(q);
      expect(d.chosen_route, `${q}`).toBe("hierarchy");
    }
  });
  test("English overview → overview route", () => {
    for (const q of ["walk me through 实体A", "overview of 实体A"]) {
      const d = classifyFrontdoorQuery(q);
      expect(d.chosen_route, `${q}`).toBe("overview");
    }
  });
  test("English comparison strong → reasoning route", () => {
    const d = classifyFrontdoorQuery("compare 实体A and 实体B, what's the difference");
    expect(d.chosen_route).toBe("reasoning");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/core/frontdoor-router.test.ts`
Expected: FAIL — English queries don't match the Chinese-only signals.

- [ ] **Step 3: Add English signals to ROUTE_RULES**

In `src/core/retrieval/frontdoor-router.ts`, update the signals (keep all existing Chinese signals, add English alternatives):

- `relationship` rule — add to its signals array:
  ```ts
      ["relationship_en", /relationship|connected to|how.*(related|connected)|link between/iu],
  ```
- `reasoning.comparison` signal — already updated in Task 1 (now includes `compare|difference|differ`).
- `hierarchy` rule — add:
  ```ts
      ["hierarchy_en", /reports to|direct reports|org chart|reporting line/iu],
  ```
- `overview` rule — add:
  ```ts
      ["overview_en", /summarize|review of|overview|walk me through/iu],
  ```

(Insert each as an additional `["name", /re/iu]` entry in the corresponding rule's `signals` array. Do not remove any existing signal.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/frontdoor-router.test.ts`
Expected: PASS (all bilingual positive + prior negative).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 4: query-router — bilingual strong signals + English negative regression

**Files:**
- Modify: `src/core/retrieval/query-router.ts` (REVIEW/RELATIONSHIP/TEMPORAL keyword lists)
- Modify: `tests/core/query-router.test.ts`

- [ ] **Step 1: Write the failing bilingual positive tests + English negative regression**

Append to `tests/core/query-router.test.ts`:

```ts
  // ── #255 bilingual positive (English strong signals) ──
  test("English comparison strong → agentic/comparison", () => {
    const r = router.route("实体A compare 实体B difference");
    expect(r.intent).toBe("comparison");
  });
  test("English relationship → agentic/relationship", () => {
    const r = router.route("实体A and 实体B relationship");
    expect(r.intent).toBe("relationship");
  });
  test("English timeline strong → timeline", () => {
    const r = router.route("实体A what changed since last time");
    expect(r.intent).toBe("timeline");
  });

  // ── #255 English negative regression: weak words must NOT escalate ──
  test("bare English review/change/manager do NOT escalate", () => {
    for (const q of ["review the code", "review the code about 实体A and 实体B", "change the title", "change manager"]) {
      const r = router.route(q);
      expect(r.mode, `${q} must not be agentic`).not.toBe("agentic");
    }
  });
```

- [ ] **Step 2: Run to verify failure (positive) and pass (negative)**

Run: `bun test tests/core/query-router.test.ts`
Expected: the three English positive cases FAIL (no English keywords yet). The English negative regression cases PASS already (no weak English keywords exist, so they fall through to keyword/hybrid).

- [ ] **Step 3: Add English strong signals (no weak English keywords)**

In `src/core/retrieval/query-router.ts`, expand the keyword arrays (add English strong only; do NOT add bare `review`/`change`/`manager`):

```ts
const TEMPORAL_KEYWORDS = ["最近", "什么时候", "上次", "下次", "上周", "这周", "时间线", "last time", "previously", "what changed"];
const RELATIONSHIP_KEYWORDS = ["关系", "联系", "之间", "关联", "relationship", "connected"];
const REVIEW_KEYWORDS = ["复盘", "总结", "回顾", "变化", "进展", "summarize", "overview"];
```

(COMPARISON_KEYWORDS already updated in Task 2. `变化/进展` stay in REVIEW — preserves existing behavior; the `change manager` negative case is protected because bare English `change`/`manager` are never added.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/query-router.test.ts`
Expected: PASS — English positives route via strong signals; `review the code` / `change manager` still do not escalate (no weak English keyword to match).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 5: recall-intent — bilingual temporal/history/former-current

**Files:**
- Modify: `src/core/retrieval/recall-intent.ts` (TEMPORAL_RE / HISTORY_RE / FORMER_CURRENT_RE)
- Modify: `tests/core/recall-intent.test.ts`

- [ ] **Step 1: Write the failing bilingual tests**

Append to `tests/core/recall-intent.test.ts` (inside `describe("detectTemporalIntent (#232)")`):

```ts
  test("#255 English temporal markers", () => {
    for (const q of ["实体A last time", "what changed for 实体A", "实体A previously"]) {
      const i = detectTemporalIntent(q);
      expect(i.temporal, `${q} should be temporal`).toBe(true);
    }
  });

  test("#255 English history markers", () => {
    for (const q of ["why was this decided for 实体A", "what was the reasoning for 实体A"]) {
      const i = detectTemporalIntent(q);
      expect(i.history, `${q} should be history`).toBe(true);
    }
  });

  test("#255 English former/current markers", () => {
    const i = detectTemporalIntent("实体A former and current");
    expect(i.formerCurrent).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/core/recall-intent.test.ts`
Expected: FAIL — English markers don't match the Chinese-only regex.

- [ ] **Step 3: Add English alternatives to the regexes**

In `src/core/retrieval/recall-intent.ts`, update the three regexes (append English alternatives inside the existing groups):

```ts
const TEMPORAL_RE = /(之前|上次|下次|上周|这周|最近|后来|曾经|以前|当时|原来|时间线|什么时候|变化|进展|动态|last time|previously|before|what changed|changed)/;
const HISTORY_RE = /(为什么这么定|当时.*(怎么设计|为什么选|怎么定|怎么做|怎么说)|之前.*(怎么设计|为什么选|具体怎么说|为什么这么定)|原来怎么说|怎么设计的|why.*(decided|chosen)|what was the reasoning|how was.*decided)/;
const FORMER_CURRENT_RE = /(前任|现任|原任|之前.{0,8}现在|原来.{0,8}现在|former|current|previous.{0,8}now)/;
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/core/recall-intent.test.ts`
Expected: PASS (English + existing Chinese).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 6: exact-title priority (bilingual) + MCP + full gate + single commit

**Files:**
- Modify: `tests/core/query-router.test.ts` (exact-title bilingual priority case)
- Verify (no edit unless a regression surfaces): `tests/mcp/frontdoor.test.ts`

- [ ] **Step 1: Add exact-title-over-intent bilingual test**

Append to `tests/core/query-router.test.ts`:

```ts
  // ── #255 exact title precedence over intent keywords (bilingual) ──
  test("exact English title with intent word still → fast/entity_lookup", () => {
    insertPage(db, "concepts/overview-alpha", "Overview Alpha");
    const r = router.route("Overview Alpha");
    expect(r.mode).toBe("fast");
    expect(r.intent).toBe("entity_lookup");
  });
```

- [ ] **Step 2: Run the focused gates**

Run:
```bash
bun test tests/core/frontdoor-router.test.ts
bun test tests/core/query-router.test.ts
bun test tests/core/recall-intent.test.ts
bun test tests/mcp/frontdoor.test.ts
bun run lint
```
Expected: all PASS, lint clean. `tests/mcp/frontdoor.test.ts` is run to confirm the MCP layer (which calls the same routing code) did not regress — do NOT add new MCP cases; core-layer coverage is sufficient.

- [ ] **Step 3: Run full check + verify boundaries**

Run: `bun run check`
Expected: PASS (lint + full `bun test`). Capture any pre-existing unrelated failure and report it; do not bundle unrelated fixes.

Verify untouched:
```bash
git diff main -- src/core/recall.ts src/core/retrieval/search.ts src/mcp/tools/ src/agentic/
```
Expected: empty (no recall ranking, MCP tool-profile, or agentic planner changes).

- [ ] **Step 4: Privacy scan**

Run: `git diff main` — confirm no real names/companies/products/paths/emails. Only sentinels (`实体A/实体B/主题A`) and generic domain words.

- [ ] **Step 5: Single independent commit**

```bash
git add src/core/retrieval/frontdoor-router.ts src/core/retrieval/query-router.ts src/core/retrieval/recall-intent.ts \
        tests/core/frontdoor-router.test.ts tests/core/query-router.test.ts \
        tests/core/recall-intent.test.ts
git commit -m "feat(recall): #255 phase 1 deterministic bilingual intent routing" -m "CN/EN/mixed rule expansion across frontdoor-router / query-router / recall-intent. Over-routing fix: bare 比较 removed from frontdoor comparison and gated in query-router by syntax (adverb blacklist + compare-structure whitelist; not entity-count based). English adds strong signals only (no weak review/change/manager keywords) so review the code / change manager never escalate. Hierarchy stays frontdoor→get_org_tree; no QueryRouter.hierarchy intent. No LLM, no empty hook. Negative-first bilingual evals. Anonymous fixtures only." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

Do NOT push. Do NOT close the issue. Report commit hash + gate results.

---

## Verification Summary (acceptance ↔ task)

| #255 acceptance | Task |
|:--|:--|
| bilingual routing evals (relationship/timeline/comparison/review/hierarchy/debug) | Tasks 3, 4, 5 |
| ambiguous phrases fail to safer/default route | Tasks 1, 2 (`比较` adverb), Task 4 (English weak) |
| exact entity/title lookup precedence | Task 6 |
| default path deterministic, no LLM | all tasks (no LLM anywhere) |
| existing frontdoor/recall/query-router tests pass | every task's Step 4 |
| no recall ranking / MCP / agentic changes | Task 6 Step 3 boundary check |

## Non-goals enforced

No LLM classifier (no empty hook either). No `hierarchy` intent in `QueryRouter`. No recall ranking change. No MCP/tool-profile change. No agentic planner rewrite. No skill jsonl change. No private fixtures.
