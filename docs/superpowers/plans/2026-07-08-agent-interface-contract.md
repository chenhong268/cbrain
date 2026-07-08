# Agent Interface Contract Implementation Plan — #316

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cbrain_recall` the explicit, tested default Agent front door across the MCP tool layer, skills, and docs; demote `deep_recall` to an advanced escape hatch; mark truly-excluded tools debug-only; add docs-consistency gates that catch future drift at both the registered-description layer and the skills layer.

**Architecture:** Two gates in `bin/check-docs-consistency.ts`: (1) `checkToolDescriptions` scans registered MCP tool descriptions so `deep_recall` cannot be re-positioned as the default at the `tools/list` layer (what Agents actually see); (2) `checkAgentContractTools` scans `skills/*.md` for excluded-as-first-choice and `deep_recall`-as-default drift, matching BOTH backticked and bare tool names and treating `→` as a first-choice cue (with `.md` skill-file targets and agent-allowlisted tools exempt). The agent allowlist is imported from `src/mcp/tool-profiles.ts` (export-only change). `check-docs-consistency.ts` gets an `import.meta.main` guard so it is importable by unit tests. Gate functions + synthetic tests land first (TDD); `checkAgentContractTools` wires into `main()` only after all skills are aligned, so every intermediate commit stays green.

**Tech Stack:** TypeScript (strict), `bun:test`. The gates run under `bun bin/check-docs-consistency.ts` (`bun run check:docs`).

**Spec:** `docs/superpowers/specs/2026-07-08-agent-interface-contract-design.md` (commit 8751009).

---

## Commit Strategy (green at every commit)

- **Task 1:** `import.meta.main` guard + export `AGENT_ALLOWLIST` + `checkAgentContractTools` (token-aware, `→`-aware) + synthetic tests. Do NOT wire `checkAgentContractTools` into `main()`. `check:docs` still passes.
- **Task 2:** rewrite `deep_recall` + `query` registered descriptions to the contract wording + add `checkToolDescriptions` + its synthetic test + wire it into `main()` + regenerate auto-gen docs. Description-aligned, so `check:docs` passes.
- **Tasks 3–5:** rewrite skills + docs to the contract wording. `check:docs` still passes (the skills gate is not wired yet; other checks must still pass — no phantom tools introduced).
- **Task 6:** wire `checkAgentContractTools` into `main()`, run `check:docs` against the now-aligned real skills, then full `bun run lint` + `bun test`.

## File Structure

- `bin/check-docs-consistency.ts` — `import.meta.main` guard; add + export `checkAgentContractTools` and `checkToolDescriptions`; export `CheckResult`; wire checks into `main()` per the schedule above.
- `src/mcp/tool-profiles.ts` — export `AGENT_ALLOWLIST` (export-only, no semantic change).
- `src/mcp/tools/recall.ts` — rewrite the `deep_recall` registered description header (NOT handler logic).
- `src/mcp/tools/search.ts` — rewrite the `query` registered description's natural-language pointer.
- `tests/bin/check-docs-consistency.agent-contract.test.ts` — CREATE. Synthetic-fixture tests for both gate functions.
- `skills/RESOLVER.md`, `skills/recall-resolver.md`, `skills/SKILL.md`, `skills/query.md`, `skills/review.md`, `skills/write.md`, `skills/hermes-cbrain-brief.md` — rewrite to contract wording.
- `README.md`, `docs/mcp-tools.md`, `docs/usage.md`, `docs/install-onboarding.md`, `docs/hermes-integration.md` — align (auto-gen sections regenerated via `--update`).

## Contract Wording Anchor (reuse verbatim across files)

- **`cbrain_recall`** — default natural-language front door. First choice for recall / grounding / find-person / hierarchy / overview / relationship / reasoning.
- **`deep_recall`** — advanced escape hatch. Direct-call only when fine-grained params (`grounded` / `detail` / `limit`) are needed, or `cbrain_recall` cannot express the intent. Not the default/first choice.
- **`query` / `get_chunks` / `expand_entity` / `summarize` / `brain_storm` / `dossier` / `agentic_research` / `get_links`** — debug / internal / fallback, not exposed in the `agent` profile. Mention only in debug sections or explicit fallback context.

---

## Task 1: Gate functions + `import.meta.main` guard + `AGENT_ALLOWLIST` export (TDD)

**Files:**
- Modify: `bin/check-docs-consistency.ts` (guard + `checkAgentContractTools` + export `CheckResult`)
- Modify: `src/mcp/tool-profiles.ts` (export `AGENT_ALLOWLIST`)
- Create: `tests/bin/check-docs-consistency.agent-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/bin/check-docs-consistency.agent-contract.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentContractTools,
  checkToolDescriptions,
  type CheckResult,
} from "../../bin/check-docs-consistency.js";
import { AGENT_ALLOWLIST } from "../../src/mcp/tool-profiles.js";

// Synthetic tool set: agent allowlist + a sample of excluded tools.
const TOOLS = new Set<string>([
  ...AGENT_ALLOWLIST,
  "query", "get_chunks", "expand_entity", "summarize", "brain_storm",
  "dossier", "agentic_research", "get_links", "deep_recall",
  "sync", "health",
]);

let dirs: string[] = [];
function withSkills(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-agent-contract-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
  }
});
function fails(r: CheckResult[]): boolean {
  return r.some((x) => !x.passed);
}

describe("checkAgentContractTools (#316)", () => {
  test("Check 2 backticked: `优先用 `deep_recall`` fails", () => {
    const dir = withSkills({ "a.md": "- 优先用 `deep_recall` 查询\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 backticked: `默认查询工具 `deep_recall`` fails", () => {
    const dir = withSkills({ "a.md": "- `deep_recall` 是默认查询工具\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 BARE: 优先用 deep_recall (no backticks) fails", () => {
    const dir = withSkills({ "a.md": "- 优先用 deep_recall 查询\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 BARE: 默认查询工具 deep_recall fails", () => {
    const dir = withSkills({ "a.md": "- 默认查询工具 deep_recall\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 2 passes: deep_recall framed as advanced/fallback/direct-call only", () => {
    const dir = withSkills({ "a.md": "- deep_recall 是 advanced fallback，仅精细参数时直调\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("Check 2 passes: deep_recall framed as direct-call only escape hatch (bare)", () => {
    const dir = withSkills({ "a.md": "- deep_recall 是 direct-call only 的 escape hatch\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });

  test("Check 1 backticked: 首选 `query` fails", () => {
    const dir = withSkills({ "a.md": "- 首选 `query` 搜索\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 首选 query fails", () => {
    const dir = withSkills({ "a.md": "- 首选 query 搜索\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 默认 summarize fails", () => {
    const dir = withSkills({ "a.md": "- 默认 summarize 出总结\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("Check 1 BARE: 优先 brain_storm fails", () => {
    const dir = withSkills({ "a.md": "- 优先 brain_storm 做推理\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });

  test("arrow cue: 自然语言 → query fails (excluded tool routed)", () => {
    const dir = withSkills({ "a.md": "- 自然语言 → query\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("arrow cue: 总结 → summarize fails", () => {
    const dir = withSkills({ "a.md": "- 总结 → summarize\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(true);
  });
  test("arrow cue: 精确关键词 → query.md [keyword] passes (skill-file target)", () => {
    const dir = withSkills({ "a.md": "- 精确关键词/debug → query.md [keyword]\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("arrow cue: 自然语言 → query.md [cbrain_recall] passes", () => {
    const dir = withSkills({ "a.md": "- 自然语言 → query.md [cbrain_recall]\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });

  test("opt-out comment passes for an excluded first-choice tool", () => {
    const dir = withSkills({ "a.md": "- 优先用 query <!-- docs-consistency:ignore-agent-contract -->\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
  test("clean skills dir passes", () => {
    const dir = withSkills({ "a.md": "- 首选 cbrain_recall\n" });
    expect(fails(checkAgentContractTools(TOOLS, dir))).toBe(false);
  });
});

describe("checkToolDescriptions (#316)", () => {
  const T = (name: string, description: string) => ({ name, description });
  test("deep_recall described as 默认查询工具 fails", () => {
    expect(fails(checkToolDescriptions([T("deep_recall", "【默认查询工具】查找实体…")]))).toBe(true);
  });
  test("deep_recall described as advanced escape hatch passes", () => {
    expect(fails(checkToolDescriptions([T("deep_recall", "【高级 escape hatch】默认前门是 cbrain_recall，仅精细参数时直调…")]))).toBe(false);
  });
  test("query description: 自然语言问题请用 deep_recall (bare) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 deep_recall。")]))).toBe(true);
  });
  test("query description: 自然语言问题请用 `deep_recall` (backtick) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 `deep_recall`。")]))).toBe(true);
  });
  test("query description: 事实回忆 → deep_recall (arrow) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "❌ 不要用于自然语言问题。事实回忆 → deep_recall，全貌 → summarize。")]))).toBe(true);
  });
  test("query description: 全貌 → summarize (arrow to excluded) fails", () => {
    expect(fails(checkToolDescriptions([T("query", "全貌 → summarize。")]))).toBe(true);
  });
  test("query description pointing NL to cbrain_recall passes", () => {
    expect(fails(checkToolDescriptions([T("query", "底层搜索。自然语言问题请用 cbrain_recall。")]))).toBe(false);
  });
  test("query description: arrow to an agent-allowlisted tool passes", () => {
    expect(fails(checkToolDescriptions([T("query", "组织架构 → get_org_tree。")]))).toBe(false);
  });
  test("maintenance pipeline description passes (dream: sync → enrich → health)", () => {
    // `→` in non-query tool descriptions describes a maintenance pipeline, not NL routing.
    expect(fails(checkToolDescriptions([T("dream", "夜间维护：sync → enrich → seal → health → report。")]))).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/bin/check-docs-consistency.agent-contract.test.ts`
Expected: FAIL — the exports do not exist yet; also the unconditional `main()` at the bottom of `check-docs-consistency.ts` will run the real gate on import (this is exactly the contamination HIGH 1 flags).

- [ ] **Step 3: Add the `import.meta.main` guard (HIGH 1)**

In `bin/check-docs-consistency.ts`, replace the trailing unconditional call:

```ts
main();
```

with:

```ts
if (import.meta.main) main();
```

This makes the module safe to import from unit tests (no real-docs gate runs on import, no `process.exitCode` side effect).

- [ ] **Step 4: Export `AGENT_ALLOWLIST`**

In `src/mcp/tool-profiles.ts`, change `const AGENT_ALLOWLIST = [` to `export const AGENT_ALLOWLIST = [`. No other change to that file.

- [ ] **Step 5: Add `checkAgentContractTools` + `checkToolDescriptions` + export `CheckResult`**

In `bin/check-docs-consistency.ts`:

(a) Add the import near the other `../src` imports:

```ts
import { AGENT_ALLOWLIST } from "../src/mcp/tool-profiles.js";
```

(b) Change `interface CheckResult {` to `export interface CheckResult {`.

(c) Add the two check functions near the other `check*` functions (e.g. after `checkSkillsToolRefs`):

```ts
/** #316 — collect every tool reference on a line: backticked `tool` AND bare tool
 *  names. Bare names immediately followed by `.` (e.g. `query.md`) are NOT matched,
 *  so skill-file targets are not mistaken for tool names. */
function extractToolRefs(line: string): string[] {
  const tools = new Set<string>();
  for (const m of line.matchAll(/`([a-z_][a-z0-9_]*)`/g)) tools.add(m[1]);
  for (const m of line.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)(?![.\w])/g)) tools.add(m[1]);
  return [...tools];
}

/** #316 — Agent contract gate for skills/*.md.
 *  Check 1: an agent-excluded tool must not be positioned as a first choice.
 *  Check 2: `deep_recall` (in allowlist) is a restricted first-choice tool — it
 *  fails when framed as default/first choice WITHOUT an advanced/fallback cue.
 *  `→` is a first-choice cue, but skill-file targets (`xxx.md`) and agent-allowlisted
 *  tools routed via `→` do not trip the gate (debug branches and the front door stay legal).
 *  Per-line opt-out: <!-- docs-consistency:ignore-agent-contract --> */
const AGENT_CONTRACT_IGNORE = "<!-- docs-consistency:ignore-agent-contract -->";
const FIRST_CHOICE_CUES = /(首选|优先|默认|第一选择|一步搞定|default\s+query\s+tool|→)/;
const DEEP_RECALL_ADVANCED_CUES = /(advanced|fine-grained|fine\s+grained|fallback|direct-call\s+only|direct\s+call\s+only|高级|精细参数|降级|escape\s+hatch)/i;

export function checkAgentContractTools(tools: Set<string>, skillsDir: string): CheckResult[] {
  const out: CheckResult[] = [];
  if (!existsSync(skillsDir)) {
    return [{ check: "agent-contract tools", passed: true, detail: "no skills/ dir" }];
  }
  const excluded = new Set(tools);
  for (const t of AGENT_ALLOWLIST) excluded.delete(t);

  for (const f of readdirSync(skillsDir).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(skillsDir, f), "utf-8");
    text.split("\n").forEach((line, i) => {
      if (line.includes(AGENT_CONTRACT_IGNORE)) return;
      if (!FIRST_CHOICE_CUES.test(line)) return;
      const refs = extractToolRefs(line);
      // Check 1 — excluded tool as first choice
      for (const r of refs) {
        if (excluded.has(r)) {
          out.push({
            check: `agent-contract @skills/${f}:${i + 1}`,
            passed: false,
            detail: `\`${r}\` 不在 agent profile，不应作首选/默认`,
          });
        }
      }
      // Check 2 — deep_recall restricted first-choice
      if (refs.includes("deep_recall") && !DEEP_RECALL_ADVANCED_CUES.test(line)) {
        out.push({
          check: `agent-contract deep_recall @skills/${f}:${i + 1}`,
          passed: false,
          detail: `deep_recall 是 advanced escape hatch，不应作默认/首选（用 cbrain_recall）；本行缺少 advanced/fallback 上下文`,
        });
      }
    });
  }
  if (out.length === 0) {
    out.push({ check: "agent-contract tools", passed: true, detail: "skills 无 excluded/deep_recall 首选漂移" });
  }
  return out;
}

/** #316 — registered MCP tool descriptions must not re-position deep_recall (or
 *  point any natural-language path to deep_recall / an excluded tool). This is
 *  what Agents see in tools/list, so it is more authoritative than any docs note.
 *  Covers BOTH "请用 tool" and "→ tool" forms, with optional backticks. */
const DEFAULT_CLAIM_RE = /(默认查询工具|默认查询|默认入口|default\s+query\s+tool|默认前门)/i;
const DESC_ADVANCED_CUES = /(advanced|fine-grained|fine\s+grained|fallback|direct-call\s+only|escape\s+hatch|高级|精细参数|降级)/i;
// A routing recommendation inside a description: "→ tool" or "请用 tool" (backticks optional).
const DESC_ROUTING_RE = /(?:→|请用)\s*`?([a-z_][a-z0-9_]*)`?/g;

export function checkToolDescriptions(tools: ToolInfo[]): CheckResult[] {
  const out: CheckResult[] = [];
  const agentAllow = new Set<string>(AGENT_ALLOWLIST);
  for (const t of tools) {
    // deep_recall own default claim
    if (t.name === "deep_recall" && DEFAULT_CLAIM_RE.test(t.description) && !DESC_ADVANCED_CUES.test(t.description)) {
      out.push({ check: "tool description deep_recall", passed: false, detail: "deep_recall 注册描述仍宣称默认入口（改为 advanced/escape hatch）" });
    }
    // query description: must not route natural-language paths to deep_recall / excluded tools.
    // Scoped to `query` ONLY — other tools (e.g. dream `sync → enrich → seal`) legitimately
    // describe maintenance pipelines with `→`, and those tools are not NL front-door alternates.
    if (t.name === "query") {
      for (const m of t.description.matchAll(DESC_ROUTING_RE)) {
        const target = m[1];
        if (!agentAllow.has(target)) {
          out.push({ check: "tool description query", passed: false, detail: `query 描述把路径指向 \`${target}\`（不在 agent profile，应指向 cbrain_recall）` });
        } else if (target === "deep_recall" && !DESC_ADVANCED_CUES.test(t.description)) {
          out.push({ check: "tool description query", passed: false, detail: "query 描述把路径指向 deep_recall，但无 advanced/fallback 上下文（应指向 cbrain_recall）" });
        }
      }
    }
  }
  if (out.length === 0) out.push({ check: "tool descriptions", passed: true, detail: "工具描述已对齐 cbrain_recall 前门" });
  return out;
}
```

Note: `ToolInfo` is already declared at the top of the file (the `{ name, description }` interface used by `getMcpTools`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/bin/check-docs-consistency.agent-contract.test.ts`
Expected: PASS — all tests green (backticked + bare + arrow + opt-out + description checks).

- [ ] **Step 7: Confirm `check:docs` still passes (neither gate wired yet)**

Run: `bun run check:docs 2>&1 | tail -5`
Expected: PASS — the new functions exist but are not called from `main()`, and `import.meta.main` now guards the real run, so importing the module in `check:docs`'s own execution still works while unit-test imports stay clean.

- [ ] **Step 8: Lint**

Run: `bun run lint 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add bin/check-docs-consistency.ts src/mcp/tool-profiles.ts tests/bin/check-docs-consistency.agent-contract.test.ts
git commit -m "feat(docs-gate): agent-contract + tool-description gates, import.meta.main guard (#316)"
```

---

## Task 2: Align `deep_recall` + `query` registered descriptions + wire `checkToolDescriptions`

**Files:**
- Modify: `src/mcp/tools/recall.ts` (the `deep_recall` `description` string, starting ~L24)
- Modify: `src/mcp/tools/search.ts` (the `query` `description` string)
- Modify: `bin/check-docs-consistency.ts` (wire `checkToolDescriptions` into `main()`)
- Regenerate: auto-gen sections of `docs/mcp-tools.md` / `docs/usage.md`

**Rule:** this changes only the Agent-facing contract text in the registered `description`, NOT any handler logic, params, or return shape.

- [ ] **Step 1: Rewrite the `deep_recall` description header**

In `src/mcp/tools/recall.ts`, the `description` field currently begins:

```ts
    description:
      "【默认查询工具】查找人物、公司、概念等实体。默认返回精简视图（200字摘要+基础信息）。" +
      "需要完整上下文（关系、时间线、档案、层级）时传 detail=normal。" +
```

Replace the opening claim with the advanced-escape-hatch framing; keep the rest of the description (grounded mode, params, response template) intact:

```ts
    description:
      "【高级 escape hatch】默认前门是 cbrain_recall（自然语言首选）。" +
      "本工具仅当需要精细参数（grounded/detail/limit）或前门无法表达意图时直调，不是默认首选。" +
      "查找人物、公司、概念等实体。默认返回精简视图（200字摘要+基础信息）。" +
      "需要完整上下文（关系、时间线、档案、层级）时传 detail=normal。" +
```

Leave the subsequent paragraphs (grounded mode, content-recall gate, response template, proactive hints) unchanged.

- [ ] **Step 2: Rewrite the `query` description natural-language routing sentence**

In `src/mcp/tools/search.ts`, the `query` tool `description` currently ends with this sentence:

```
"❌ 不要用于自然语言问题。事实回忆 → deep_recall，全貌 → summarize，找人 → recall_episode，组织架构 → get_org_tree。"
```

Replace that ENTIRE sentence (the whole `事实回忆 → …` arrow-routing list) with a single front-door pointer. Do NOT keep the arrow list: `全貌 → summarize` routes to an excluded tool and `事实回忆 → deep_recall` routes to a restricted tool — both trip `checkToolDescriptions` and both are contract-wrong. Replacement:

```
"❌ 不要用于自然语言问题。自然语言问题请用 cbrain_recall（前门，内部分发）；本工具仅限精确关键词定位/debug。"
```

Keep the earlier part of the description (the debug / 定位 / deep_recall 降级链 framing + strategy docs) intact — only the trailing NL-routing sentence is replaced.

- [ ] **Step 3: Wire `checkToolDescriptions` into `main()`**

In `bin/check-docs-consistency.ts`, in the `const results: CheckResult[] = [...]` array inside `main()`, add (after `...checkSkillsToolRefs(...)`):

```ts
    ...checkToolDescriptions(tools),
```

- [ ] **Step 4: Regenerate auto-gen doc sections**

Run: `bun bin/check-docs-consistency.ts --update`
Then verify the auto-gen rows updated:
- `docs/mcp-tools.md` `deep_recall` row no longer starts with "【默认查询工具】".
- `docs/mcp-tools.md` `query` row now says "请用 cbrain_recall" instead of "请用 deep_recall".

- [ ] **Step 5: Run the gate tests + `check:docs`**

Run: `bun test tests/bin/check-docs-consistency.agent-contract.test.ts && bun run check:docs`
Expected: PASS — `checkToolDescriptions` is now wired and the descriptions are aligned, so `tool descriptions` shows ✓. (`checkAgentContractTools` is still NOT wired — that is Task 6.)

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/recall.ts src/mcp/tools/search.ts bin/check-docs-consistency.ts docs/mcp-tools.md docs/usage.md
git commit -m "feat(agent-contract): deep_recall/query descriptions → cbrain_recall front door; wire description gate (#316)"
```

---

## Task 3: Skills routing contract — `RESOLVER.md` + `recall-resolver.md`

**Files:**
- Modify: `skills/RESOLVER.md`
- Modify: `skills/recall-resolver.md`

**Rule:** RESOLVER is a skill routing table (intent → skill file). Keep the `query.md` target. The Natural Recall `[deep_recall]` flag becomes `[cbrain_recall]`; `[grounded]` / `[detail=…]` / `[episodic]` / `[provenance]` / `[keyword]` / `[discovery]` are query.md mode params — keep them. Any prose that says "走 deep_recall" as the normal path becomes "走 cbrain_recall"; `deep_recall` survives only where framed as advanced/fallback (with a cue word).

- [ ] **Step 1: Edit `skills/RESOLVER.md`**

Precise edits (line numbers from the current file):

- **L13–17 (Grounded Recall):** keep `→ query.md [grounded]` (mode param).
- **L20–23 (Content Recall):** keep `→ query.md [detail=normal…]`.
- **L31** `不适用：普通内容回忆（"当时怎么设计的"）→ 走 deep_recall` → change `deep_recall` to `cbrain_recall`.
- **L40** `已知人物+共同事件+**问经历/内容**→deep_recall` → `cbrain_recall`.
- **L52–54 (Natural Recall):** change the three `→ query.md [deep_recall]` to `→ query.md [cbrain_recall]`. Update the section heading to: `### Natural Recall（默认路由 — 自然语言问题走 cbrain_recall 前门）`.
- **L104** `不适用：单一实体查找…→ 走 query / deep_recall / recall_episode` → change `deep_recall` to `cbrain_recall`.
- **L105** `不适用：核查确认 → 走 deep_recall(grounded=true)` → `cbrain_recall`.
- **L132** `禁止先跑 deep_recall / query / graph_query 再拼层级` → change `deep_recall` to `cbrain_recall`.
- **L137** stays as-is (keyword/debug context).

After edits: `grep -n 'deep_recall' skills/RESOLVER.md` → ZERO hits.

- [ ] **Step 2: Edit `skills/recall-resolver.md`**

Read the file, then rewrite so that:

- The decision-tree root for 核查确认 / 内容回忆 / 自然语言回忆 routes to `cbrain_recall` as the first choice (not `deep_recall`).
- `deep_recall` is demoted to "advanced — direct-call only for fine-grained params (`grounded`/`detail`/`limit`) or when `cbrain_recall` cannot express the intent". Frame every remaining `deep_recall` mention with an advanced/fallback cue (`advanced` / `fallback` / `精细参数` / `direct-call only` / `降级` / `escape hatch`) so Check 2 passes.
- `summarize` / `dossier` / `brain_storm` / `agentic_research` / `expand_entity` are marked debug/internal/fallback (NOT in the agent allowlist). The existing `query` "底层调试工具" line stays.
- The capability cheatsheet lists `cbrain_recall` as "**默认前门**" and `deep_recall` as "高级 escape hatch".

Concrete anchors to rewrite:
- root `核查确认意图 → deep_recall({ query, grounded: true, ... })` → `cbrain_recall({ query, detail: "brief" })`.
- `内容回忆意图 → deep_recall({ detail: "normal" })` → `cbrain_recall({ query, detail: "normal" })`.
- `关于X的一切 → deep_recall` / `给我一个全景 → summarize` / `结构化档案 → dossier` / `帮我分析 → brain_storm` → reframe: default `cbrain_recall`; the named tools are advanced/debug/internal escapes.
- cheatsheet line that labels `deep_recall` "**最高优先级**" → relabel `cbrain_recall` as the default front door, `deep_recall` as advanced escape hatch.

After edits: every `grep -n 'deep_recall' skills/recall-resolver.md` hit must sit in a line that also matches an advanced/fallback cue.

- [ ] **Step 3: Sanity-run the gate against the two files**

```bash
bun -e 'import { checkAgentContractTools } from "./bin/check-docs-consistency.js"; const t = new Set(["cbrain_recall","deep_recall","recall_episode","ingest","ingest_dialogue","get_page","list_pages","get_pages","put_page","append_page","resolve_slugs","get_org_tree","graph_query","get_timeline","read_discoveries","update_discovery_status","find_similar_entities","merge_entities","next_actions","status","query","get_chunks","expand_entity","summarize","brain_storm","dossier","agentic_research","get_links"]); const r = checkAgentContractTools(t, "./skills"); const hits = r.filter(x=>!x.passed); console.log(hits.length ? hits.filter(h=>/RESOLVER|recall-resolver/.test(h.check)) : "RESOLVER/recall-resolver clean");'
```

Expected: `RESOLVER/recall-resolver clean` (other skill files may still fail until Task 4 — expected).

- [ ] **Step 4: Commit**

```bash
git add skills/RESOLVER.md skills/recall-resolver.md
git commit -m "docs(agent-contract): route RESOLVER + recall-resolver through cbrain_recall front door (#316)"
```

---

## Task 4: Skills rest — `SKILL.md` / `query.md` / `review.md` / `write.md` / `hermes-cbrain-brief.md` / `feature-index.md`

**Files:**
- Modify: `skills/SKILL.md`, `skills/query.md`, `skills/review.md`, `skills/write.md`, `skills/hermes-cbrain-brief.md`, `skills/feature-index.md`

**Rule:** each skill's default behavior routes through `cbrain_recall`; `deep_recall` only as advanced/fallback (with cue); `query`/`get_page` chains become debug-only anti-patterns.

- [ ] **Step 1: `skills/SKILL.md`**

- **L22** `讨论过吗/有结论吗 | … | deep_recall(grounded: true)` → key tool `cbrain_recall(detail:"brief")`.
- **L23** `当时怎么设计的 | … | deep_recall(detail:"normal")` → `cbrain_recall(detail:"normal")`.
- **L26** `总结一下 X | … | query + 综合分析` → key tool `cbrain_recall` (overview internal); `query` must NOT appear as the first-choice tool.
- **L27** `A 和 B 什么关系 | … | graph_query` → `cbrain_recall` (relationship internal).
- **L38** `禁止 query + get_page 链式调用做核查 — 用 deep_recall(grounded: true) 一步到位` → `… — 用 cbrain_recall(detail:"brief") 一步到位`.

After edits: `grep -n 'deep_recall' skills/SKILL.md` → ZERO hits.

- [ ] **Step 2: `skills/query.md`**

- Default Behavior (~L11–16): change "优先使用 `deep_recall`，不是 query" → "默认走 `cbrain_recall` 前门（内部按 intent 分发）；仅在需要精细参数（grounded/detail/limit）或前门无法表达时直调 `deep_recall`（advanced escape hatch）".
- Synthesis Protocol (~L263–271) + `[agentic_research]` branch (~L67–74): mark internal/fallback; default path is `cbrain_recall`; the manual `query`+`get_page` chain is debug-only.
- CLI Search Strategies examples stay; add one line: "Agent 自然语言走 `cbrain_recall`；CLI `query` 是手动/精确关键词路径".

After edits: every remaining `deep_recall` line carries an advanced/fallback cue.

- [ ] **Step 3: `skills/review.md`**

- "⚡ 优先用 `deep_recall`（一步搞定）" (~L19–24) → "⚡ 优先用 `cbrain_recall`（前门，内部 overview/relationship 分发）".
- Reframe `deep_recall` (~L19) as advanced fallback for fine-grained params.
- Manual 4-step `cbrain query`+`show`+`graph-query`+`timeline` (~L26–32) → mark "debug-only fallback，仅前门不可用时".
- Anti-pattern (~L76–83) → reframe with `cbrain_recall` as the one-step default.

- [ ] **Step 4: `skills/write.md`**

- Step 2 Gather (~L30–38): first action → "`cbrain_recall({ query: <topic>, detail: "normal" })` 先行；CLI `query`+`show`+`graph-query`+`timeline` 是手动 fallback".
- Step 5 `cbrain ingest` (~L68–70) — keep.

- [ ] **Step 5: `skills/hermes-cbrain-brief.md`**

- §1 (L7–13): unchanged (template).
- §4 (L30): reframe `get_links` — it is NOT in the agent allowlist; "无 target 时先用 `cbrain_recall` 取相关 link/timeline id；`get_links` 是 debug 工具".
- §6 (L38–43): every `→ deep_recall` / `→ deep_recall(grounded:true)` → `→ cbrain_recall`. Specifically L38 `query+get_page+get_links+get_timeline 连调 → deep_recall` → `→ cbrain_recall`; L40 `核查用 agentic_research → deep_recall(grounded:true)` → `→ cbrain_recall(detail:"brief")`.

After edits: every `grep -n 'deep_recall' skills/hermes-cbrain-brief.md` hit is in a line with an advanced/fallback cue, or removed.

- [ ] **Step 6: `skills/feature-index.md`**

Rewrite the scenario→tool map so `cbrain_recall` is the default front door; low-level tools appear only as debug/fallback. Concrete anchors:

- **L10** `**工具**：deep_recall(query, detail='normal')` → `**工具**：cbrain_recall(query, detail:"normal")`.
- **L16** `graph_query(mode='traverse', depth=2) → 或直接 deep_recall 看关联部分` → `cbrain_recall`（关系内部分发）；keep `graph_query` only as a debug mention.
- **L21** `**工具**：summarize(slug, depth=1)` → `cbrain_recall`（overview 内部分发）；mark `summarize` debug/internal.
- **L26** `**工具**：dossier(slug)` → `cbrain_recall`；mark `dossier` debug/internal.
- **L31** `**工具**：brain_storm(query)` → `cbrain_recall`（reasoning 内部分发）；mark `brain_storm` debug/internal.
- **L36** `**工具**：query(query, limit=10)` → `cbrain_recall`；mark `query` debug（精确关键词定位）.
- **L41** `**工具**：expand_entity(slug)` → keep `expand_entity` but mark debug/fallback（单实体展开，非首轮）；default path `cbrain_recall`.
- **L101** `单一实体查找→deep_recall；简单搜索→query；找人→recall_episode；核查→deep_recall(grounded)` → all `→ cbrain_recall`（CBrain 内部分发）.
- **L107–113** 速查表 `deep_recall/summarize/dossier/brain_storm` columns → `cbrain_recall` 默认；低层工具列标 debug.
- **L117–122** 反模式 `→ deep_recall` / `→ summarize` / `→ query/deep_recall` / `→ deep_recall` → `→ cbrain_recall`.

After edits: `grep -n 'deep_recall' skills/feature-index.md` → ZERO hits (or only in lines with an advanced cue). Every remaining `summarize` / `brain_storm` / `dossier` / `expand_entity` / `query` hit must be in a debug/fallback-marked line, not a default `**工具**：` recommendation.

- [ ] **Step 7: Sanity-run the gate against all skills**

```bash
bun -e 'import { checkAgentContractTools } from "./bin/check-docs-consistency.js"; const t = new Set(["cbrain_recall","deep_recall","recall_episode","ingest","ingest_dialogue","get_page","list_pages","get_pages","put_page","append_page","resolve_slugs","get_org_tree","graph_query","get_timeline","read_discoveries","update_discovery_status","find_similar_entities","merge_entities","next_actions","status","query","get_chunks","expand_entity","summarize","brain_storm","dossier","agentic_research","get_links"]); console.log(checkAgentContractTools(t, "./skills").filter(x=>!x.passed))'
```

Expected: `[]` (zero failures). Fix any named line before committing.

- [ ] **Step 8: Commit**

```bash
git add skills/SKILL.md skills/query.md skills/review.md skills/write.md skills/hermes-cbrain-brief.md skills/feature-index.md
git commit -m "docs(agent-contract): align SKILL/query/review/write/brief/feature-index to cbrain_recall front door (#316)"
```

---

## Task 5: Docs alignment — `README.md` / `docs/mcp-tools.md` / `docs/usage.md` / `docs/install-onboarding.md` / `docs/hermes-integration.md`

**Files:** the five docs. Auto-gen sections regenerated via `--update`; only hand-written prose is edited directly.

**Rule:** docs are NOT scanned by `checkAgentContractTools` (only `skills/*.md` are). Still align them.

- [ ] **Step 1: `README.md`**

- §Search Routing table (~L265–282): re-root at `cbrain_recall`. Each intent (recall / understanding / what-is / overview / relationship / analysis / quick-search) lists `cbrain_recall` first. `deep_recall` only as "advanced — fine-grained params". `query` / `summarize` / `brain_storm` / `expand_entity` marked debug.
- MCP Tools Core table (~L371): `query` row keeps "底层关键词搜索" framing; no row calls `deep_recall` the natural-language default.

- [ ] **Step 2: `docs/mcp-tools.md`**

- Hand-written §query (~L24–37): lead with "`cbrain_recall` 是自然语言前门；`deep_recall` 是高级 escape hatch（精细参数）"; `query` debug-only.
- The `deep_recall` auto-gen row (~L331) is already fixed by Task 2's description rewrite + `--update`. Verify it no longer says "【默认查询工具】".
- `get_chunks` (~L301): add "（debug profile）".

- [ ] **Step 3: `docs/usage.md`**

- "深入了解一个主题" (~L180–186) and "了解关系" (~L188–196): add one line each — "Agent 自然语言走 `cbrain_recall`；下面 `cbrain query`/`graph-query`/`timeline` 是手动 CLI 路径". CLI examples stay.

- [ ] **Step 4: `docs/install-onboarding.md`**

- Daily-use table (~L419–424): keep CLI `query`; add one line "以上是 CLI 手动操作；Agent 自然语言提问默认走 `cbrain_recall` 工具".

- [ ] **Step 5: `docs/hermes-integration.md`**

- Daily Agent MCP config section: add "工具层前门是 `cbrain_recall` — Agent 自然语言提问首选它，由 CBrain 内部分发；低层工具只在 debug/fallback". Profile topology unchanged.

- [ ] **Step 6: Verify existing checks pass**

Run: `bun run check:docs 2>&1 | tail -10`
Expected: PASS — `checkAgentContractTools` still not wired; `checkToolDescriptions` ✓; `checkToolReferences` / `checkCommands` / `checkCounts` / auto-gen ✓.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/mcp-tools.md docs/usage.md docs/install-onboarding.md docs/hermes-integration.md
git commit -m "docs(agent-contract): align README/mcp-tools/usage/install/hermes to cbrain_recall front door (#316)"
```

---

## Task 6: Wire `checkAgentContractTools` into `main()` + full verification

**Files:** `bin/check-docs-consistency.ts`.

- [ ] **Step 1: Wire the skills gate into `main()`**

In the `const results: CheckResult[] = [...]` array, add (after `...checkToolDescriptions(tools)`):

```ts
    ...checkAgentContractTools(new Set(tools.map((t) => t.name)), join(PROJECT_DIR, "skills")),
```

- [ ] **Step 2: Run `check:docs` against real skills**

Run: `bun run check:docs 2>&1 | tail -15`
Expected: PASS — `agent-contract tools` ✓. If any `agent-contract` line fails, return to Task 3/4 and fix the named skill line (do NOT silence with opt-out unless genuinely a debug mention).

- [ ] **Step 3: Run the gate unit tests**

Run: `bun test tests/bin/check-docs-consistency.agent-contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Full lint + test**

Run: `bun run check 2>&1 | tail -15`
Expected: PASS — lint green, full suite green. Existing profile tests still pass.

- [ ] **Step 5: Non-goal guards**

Run: `git diff main -- src/mcp/tool-profiles.ts src/mcp/tools/recall.ts src/mcp/tools/search.ts`
Expected:
- `tool-profiles.ts`: only the `export` keyword added before `const AGENT_ALLOWLIST`.
- `recall.ts`: only the `deep_recall` `description` opening rewritten; handler logic unchanged.
- `search.ts`: only the `query` description natural-language pointer rewritten.

- [ ] **Step 6: Commit**

```bash
git add bin/check-docs-consistency.ts
git commit -m "feat(docs-gate): wire agent-contract check into check:docs (#316)"
```

- [ ] **Step 7: Do NOT push, do NOT close #316.** Leave the branch for Codex review.

---

## Self-Review

**Spec coverage:**
- cbrain_recall default front door → Tasks 2 (description), 3, 4 (incl. feature-index), 5.
- deep_recall demoted → Tasks 2 (description + `checkToolDescriptions`), 3, 4 + `checkAgentContractTools` Check 2.
- excluded tools debug-only → Tasks 3, 4, 5 + Check 1.
- `AGENT_ALLOWLIST` single source of truth → Task 1 export, used by both gates + tests.
- regression gates catch drift → Task 1 `checkToolDescriptions` + `checkAgentContractTools`; Task 2 wires description gate; Task 6 wires skills gate.
- 5 spec-mandated test cases → Task 1 Step 1 covers all 5 (`优先用 deep_recall` fail backticked AND bare, `默认查询工具 deep_recall` fail, advanced/fallback pass, excluded-as-first-choice fail via `query`/`summarize`/`brain_storm`, opt-out pass) + the arrow-cue pass/fail rules + description checks.
- no allowlist code change (non-goal) → Task 6 Step 5 verifies export-only diff.
- RESOLVER skill/tool layering → Task 3 keeps `query.md` target, changes `[deep_recall]`→`[cbrain_recall]`; arrow test `自然语言 → query.md [cbrain_recall] passes` proves the gate preserves skill-file routing.

**Review-fix coverage:**
- HIGH 1 round 1 (`import.meta.main`) → Task 1 Step 3.
- HIGH 2 round 1 (registered `deep_recall` description) → Task 2 Steps 1–2 + `checkToolDescriptions` gate + test.
- MEDIUM round 1 (bare tool names) → `extractToolRefs` matches backticked AND bare (Task 1 Step 5); bare-name tests in Task 1 Step 1.
- MEDIUM round 1 (`→` cue rules) → `FIRST_CHOICE_CUES` includes `→`; `extractToolRefs` skips `xxx.md`; 4 arrow tests in Task 1 Step 1 encode the fail/pass rules.
- HIGH 1 round 2 (`skills/feature-index.md` missing) → Task 4 Step 6 (added to Files + a full rewrite step; the gate scans every `skills/*.md` so feature-index cannot be skipped).
- HIGH 2 round 2 (`checkToolDescriptions` too narrow) → `DESC_ROUTING_RE` matches `→ tool` AND `请用 tool` with optional backticks; tests cover bare/backtick/arrow forms and `全貌 → summarize`.
- HIGH 1 round 3 (gate would flag maintenance pipelines) → routing-description check scoped to `query` ONLY; `deep_recall` checked only for its own default claim; `dream sync → enrich → seal → health` passes (test added). Other tools' `→` flow descriptions are legitimate pipelines, not NL routing.
- HIGH 2 round 3 (Task 2 left `全貌 → summarize` behind) → Task 2 Step 2 now replaces the ENTIRE NL-routing sentence in `query`'s description (not just the `deep_recall` token), so no residual excluded/restricted-tool routing remains.

**Placeholder scan:** gate code + tests are complete with real regexes and real strings. Docs/skills tasks name exact anchors (file:line) + the contract wording; where wording is flexible, the rule is explicit ("every remaining `deep_recall` line must carry an advanced/fallback cue") and verified by the grep + gate sanity steps. No "TBD".

**Type consistency:** `checkAgentContractTools(tools: Set<string>, skillsDir: string): CheckResult[]` and `checkToolDescriptions(tools: ToolInfo[]): CheckResult[]` — same signatures in implementation, tests, and `main()` wiring. `CheckResult` + `ToolInfo` exported/declared once. `AGENT_ALLOWLIST` exported from `tool-profiles.ts`, imported by both the gate and the test.
