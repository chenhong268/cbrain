# Bounded Fallback Skill Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Hermes receives the bounded fallback arguments and honest low-only terminal rule directly from the CBrain skill entrypoint.

**Architecture:** Keep retrieval behavior unchanged. Add the minimum safety-critical policy to `skills/SKILL.md`, and extend the existing docs-consistency contract so the entrypoint cannot silently drift back to an index-only document.

**Tech Stack:** Markdown skill pack, TypeScript, Bun test, existing docs-consistency gate.

## Global Constraints

- Do not change `cbrain_recall`, `deep_recall`, ranking, thresholds, or #337 tests.
- Do not add an LLM call, runtime state, background job, dependency, runner, or public tool field.
- Only healthy ordinary content recall with a first `empty` / `insufficient` result may enter this fallback.
- Fallback is at most one `deep_recall({ query, detail: "brief", limit: 3 })` call using the unchanged query.
- When fallback is degraded and all candidates are low quality, lead with insufficient relevant memory and do not enumerate those candidates.
- In that low-only, otherwise healthy terminal, the final answer does not mention candidate count or `quality`.
- First-call runtime or freshness degradation is reported as an incomplete search and never enters fallback; the frozen F2 fallback may itself be degraded with an all-low candidate set.
- Do not expose raw, score, slug, routing, trace, or internal field names.
- All fixtures and documentation remain anonymous.

---

### Task 1: Freeze the entrypoint contract with a failing test

**Files:**
- Modify: `tests/bin/check-docs-consistency.agent-contract.test.ts`
- Modify: `bin/check-docs-consistency.ts`
- Modify: `skills/RESOLVER.md`

**Interfaces:**
- Consumes: `checkAgentWorkflowContract(skillsDir: string): CheckResult[]`
- Produces: an `agent bounded recall entrypoint` check within the existing checker; no new exported function.

- [ ] **Step 1: Add the desired entrypoint to the valid synthetic fixture and add mutation cases**

```ts
const valid = {
  "SKILL.md": [
    "仅限普通内容回忆：健康运行的 cbrain_recall 返回 empty / insufficient 时，最多一次",
    "`deep_recall({ query, detail: \"brief\", limit: 3 })`，保持原查询。",
    "若 fallback 没有运行时或新鲜度异常，且候选全部 quality=low，先说明没有找到足够相关的记忆，",
    "不要展示或逐条列出这些低相关候选，然后停止。",
    "任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。",
    "若首轮 cbrain_recall 显示运行时或新鲜度 degraded，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。",
  ].join("\n"),
  // existing fixture files remain unchanged
};

test("missing bounded fallback policy in SKILL.md fails", () => {
  const dir = withSkills({ ...valid, "SKILL.md": "# entrypoint only\n" });
  expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
});

test("wrong entrypoint fallback arguments fail", () => {
  const dir = withSkills({ ...valid, "SKILL.md": valid["SKILL.md"].replace("limit: 3", "limit: 5") });
  expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
});

test("entrypoint that permits listing low-only candidates fails", () => {
  const dir = withSkills({
    ...valid,
    "SKILL.md": valid["SKILL.md"].replace("不要展示或逐条列出这些低相关候选", "可以逐条列出这些低相关候选"),
  });
  expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
});

test("safe entrypoint decoy followed by conflicting low-only guidance fails", () => {
  const dir = withSkills({
    ...valid,
    "SKILL.md": `${valid["SKILL.md"]}\n也可以逐条列出这些低相关候选，并解释候选数量。\n`,
  });
  expect(fails(checkAgentWorkflowContract(dir))).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts
```

Expected: the new mutation tests fail because `checkAgentWorkflowContract` does not inspect `SKILL.md`.

- [ ] **Step 3: Add the minimum structural check**

Inside `checkAgentWorkflowContract`, read `SKILL.md`, `query.md`, and
`RESOLVER.md` from the existing `files` map. Require each named heading exactly
once, extract it up to the next heading, normalize CRLF only, and compare the
complete short body against the canonical contract. Do not grow a synonym regex
list: any duplicate section or additional, missing, or changed instruction inside
a safety section fails closed.

The checker also enforces section ownership: fallback execution terms in
`SKILL.md` may occur only inside its authoritative block, and the existing
ordinary-content references outside `query.md`'s authoritative block are an exact
closed inventory. This rejects a safe decoy followed by contradictory guidance
under a different heading without attempting general natural-language analysis.

```ts
exactSectionBody(entrypoint, "### Bounded recall fallback") === expectedEntrypointFallback;
exactSectionBody(query, "### Bounded content-recall fallback") === expectedQueryFallback;
```

Also compare the complete `### Debug / Keyword Lookup（daily MCP 仍走
cbrain_recall）` body, including these two lines, so the startup router cannot send
a first-call degraded result into the F2 path:

```md
- 普通内容回忆：健康的 cbrain_recall empty/insufficient → query.md [bounded-fallback]
- 首轮 cbrain_recall runtime/freshness degraded → 停止并说明检索未完整执行，不进入 fallback
```

Return fixed failure details that do not echo file contents. Mutation coverage
includes wrong `query` value, wrong `limit`, first-call degraded in the trigger,
plain “列出” permission, ambiguous degraded-as-empty guidance, and resolver drift.

- [ ] **Step 4: Run the focused test and verify the implementation check passes against synthetic fixtures**

Run the same focused command. Expected at this intermediate point: mutation tests pass, while the repository-wide docs gate still fails because canonical `SKILL.md` has not yet been updated.

### Task 2: Put the safety rule in the injected skill entrypoint

**Files:**
- Modify: `skills/SKILL.md`
- Test: `tests/bin/check-docs-consistency.agent-contract.test.ts`

**Interfaces:**
- Consumes: the Task 1 entrypoint checker.
- Produces: direct Hermes instructions for the existing fallback path.

- [ ] **Step 1: Add one compact subsection after the answer rules**

```md
### Bounded recall fallback

- 仅限普通内容回忆：健康运行的 `cbrain_recall` 返回 empty / insufficient 时，保持原查询，最多一次调用 `deep_recall({ query, detail: "brief", limit: 3 })`，然后停止；不要继续改写或串联其他检索。
- 若 fallback 没有运行时或新鲜度异常，且候选全部 `quality=low`，先说明“没有找到足够相关的记忆”，不要展示或逐条列出这些低相关候选。
- 任何 bounded fallback 的最终回答都不要提及候选本身、候选数量或质量；有足够相关证据时正常回答用户问题，证据不足时只说明没有找到足够相关的记忆。
- 若首轮 `cbrain_recall` 显示运行时或新鲜度 degraded，说明本次检索未完整执行，不要宣称没有相关记忆，不调用 fallback，然后停止。
```

- [ ] **Step 2: Run focused and canonical docs gates**

```bash
bun test tests/bin/check-docs-consistency.agent-contract.test.ts
bun run check:docs
```

Expected: both commands pass with zero failures.

- [ ] **Step 3: Re-run the frozen anonymous Hermes journey three times**

Use the exact case, fixture/config/skill digests, model/provider, tool allowlist, and output boundary from the reproduction receipt. Expected on every repetition:

```text
cbrain_recall -> empty/0
deep_recall(detail="brief", limit=3) -> degraded/3, all low
Hermes -> leads with insufficient relevant memory; enumerates none; no internal fields; no third CBrain call
```

Record the fixed skill digest and outcomes in the reproduction receipt. If any repetition fails, do not broaden the patch; revise only the entrypoint wording and repeat the focused TDD cycle.

- [ ] **Step 4: Run protected controls and full verification**

```bash
bun test tests/bin/recall-quality-matrix.test.ts
bun run check
git diff --check
```

Expected: all existing #337 recall-quality cases and the full repository gate pass with zero failures.

- [ ] **Step 5: Commit the bounded slice**

```bash
git add bin/check-docs-consistency.ts tests/bin/check-docs-consistency.agent-contract.test.ts skills/SKILL.md docs/superpowers/specs/2026-07-20-existing-capability-experience-optimization-design.md docs/superpowers/reports/2026-07-20-bounded-fallback-anonymous-reproduction.md docs/superpowers/plans/2026-07-20-bounded-fallback-skill-honesty.md
git commit -m "fix: keep bounded fallback honest"
```
