# Bounded Fallback Skill Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Hermes receives the bounded fallback arguments and honest low-only terminal rule directly from the CBrain skill entrypoint.

**Architecture:** Keep retrieval behavior unchanged. Add the minimum safety-critical policy to `skills/SKILL.md`, and extend the existing docs-consistency contract so the entrypoint cannot silently drift back to an index-only document.

**Tech Stack:** Markdown skill pack, TypeScript, Bun test, existing docs-consistency gate.

## Global Constraints

- Do not change `cbrain_recall`, `deep_recall`, ranking, thresholds, or #337 tests.
- Do not add an LLM call, runtime state, background job, dependency, runner, or public tool field.
- Fallback is at most one `deep_recall({ query, detail: "brief", limit: 3 })` call using the unchanged query.
- When fallback is degraded and all candidates are low quality, lead with insufficient relevant memory and do not enumerate those candidates.
- The final answer does not mention candidate count, `quality`, `degraded`, or incomplete retrieval.
- Do not expose raw, score, slug, routing, trace, or internal field names.
- All fixtures and documentation remain anonymous.

---

### Task 1: Freeze the entrypoint contract with a failing test

**Files:**
- Modify: `tests/bin/check-docs-consistency.agent-contract.test.ts`
- Modify: `bin/check-docs-consistency.ts`

**Interfaces:**
- Consumes: `checkAgentWorkflowContract(skillsDir: string): CheckResult[]`
- Produces: an `agent bounded recall entrypoint` check within the existing checker; no new exported function.

- [ ] **Step 1: Add the desired entrypoint to the valid synthetic fixture and add mutation cases**

```ts
const valid = {
  "SKILL.md": [
    "cbrain_recall 返回 empty / insufficient / degraded 时，最多一次",
    "`deep_recall({ query, detail: \"brief\", limit: 3 })`，保持原查询。",
    "若 fallback degraded 且候选全部 quality=low，先说明没有找到足够相关的记忆，",
    "不要展示或逐条列出这些低相关候选，然后停止。",
    "最终回答不要提及候选数量、quality、degraded 或检索不完整。",
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

Inside `checkAgentWorkflowContract`, read `SKILL.md` from the existing `files` map and require all of:

```ts
const entrypoint = files.get("SKILL.md") ?? "";
const hasTrigger = /empty\s*\/\s*insufficient\s*\/\s*degraded/i.test(entrypoint);
const hasBoundedCall = /(最多一次|at most one)[\s\S]{0,240}deep_recall\s*\(\s*\{[\s\S]{0,160}detail:\s*["']brief["'][\s\S]{0,80}limit:\s*3/i.test(entrypoint);
const hasSameQuery = /(保持原查询|unchanged query|same query)/i.test(entrypoint);
const hasHonestTerminal = /(全部|all)[^\n]{0,80}(quality\s*=\s*low|低相关)[\s\S]{0,240}(没有找到足够相关的记忆|insufficient relevant memory)[\s\S]{0,160}(不要展示|不要逐条列出|do not (?:show|enumerate))/i.test(entrypoint);
const hasQuietTerminal = /最终回答[^\n]{0,40}(不要提及|不得提及)[^\n]{0,80}候选数量[^\n]{0,40}quality[^\n]{0,40}degraded[^\n]{0,40}检索不完整/i.test(entrypoint);
const hasConflict = /(也?可以|可|应当|应该|may|must|should)[^\n]{0,32}(展示|逐条列出|show|enumerate)[^\n]{0,48}(低相关|quality\s*=\s*low)/i.test(entrypoint);
```

If any required condition is false or `hasConflict` is true, return one failed
result named `agent bounded recall entrypoint` with a fixed detail that does not
echo file contents.

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

- `cbrain_recall` 返回 empty / insufficient / degraded 时，保持原查询，最多一次调用 `deep_recall({ query, detail: "brief", limit: 3 })`，然后停止；不要继续改写或串联其他检索。
- 若 fallback degraded 且候选全部 `quality=low`，先说明“没有找到足够相关的记忆”，不要展示或逐条列出这些低相关候选。
- 最终回答不要提及候选数量、quality、degraded 或检索不完整。
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
