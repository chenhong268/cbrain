# Bilingual Intent Routing — Design (Phase 1)

> Issue: [#255](https://github.com/chenhong268/cbrain/issues/255)
> Date: 2026-07-01
> Status: Approved with revisions — design review in conversation; implementation handoff comment `2026-07-01T09:13:54Z`
> Base: `main` @ `9a0c243`
> Execution: isolated worktree, single independent commit, **no push, no issue close**

## Context

CBrain's intent routing lives in three deterministic layers — `frontdoor-router.ts`
(8 coarse routes → next_tool), `query-router.ts` (mode fast/hybrid/agentic + intent,
consults the DB for exact lookup and known entities), and `recall-intent.ts` (#232
temporal/history/former-current detection for evidence completion). They keep default
recall fast and predictable, but the keyword rules are **almost entirely Chinese** and
**over-escalate on weak signals** — `比较` / `review` / `change` / `manager` trigger
agentic routing even when used as ordinary adverbs or verbs (`比较重要的主题A`,
`review the code`, `change manager`).

## Goal

Phase 1: harden bilingual (Chinese / English / mixed) intent routing and fix
over-routing, with **no LLM on the default path**. Behavior is locked by
**negative-first** evals.

## Scope (Phase 1 only)

**In:**
- Expand deterministic CN/EN/mixed routing rules in `frontdoor-router.ts`,
  `query-router.ts`, `recall-intent.ts`.
- Add bilingual + ambiguous routing evals to the existing `tests/core/{frontdoor-router,query-router,recall-intent}.test.ts` and `tests/mcp/frontdoor.test.ts`.

**Out (deferred / forbidden):**
- No LLM intent classifier — not even an empty hook or plumbing. Shadow mode is a separate Phase 2 issue.
- No `hierarchy` intent added to `QueryRouter` (would pull in `agentic/plan.ts`, planner, critic — scope creep). Hierarchy stays a `frontdoor-router` route → `get_org_tree`.
- No recall ranking changes. No MCP/tool-profile changes. No agentic planner/executor rewrite.
- No changes to `skills/*.routing-eval.jsonl` (skill-layer, separate concern, contains existing fixtures).
- No private fixtures / real names / companies / products / vault paths.

## Decisions

| Decision | Choice |
|:--|:--|
| Eval form | `bun:test` matrix in existing `.test.ts`. Not jsonl (jsonl is skill-layer, consumed by `skill-pack.ts`; code-layer routing is pure TS functions). |
| Shared helper | None. Three layers have distinct jobs; a shared keyword helper would couple them for low reuse. Each layer expands in place. |
| LLM shadow | Phase 1 does **nothing** — no hook, no flag, no plumbing. Phase 2 issue. |

## Over-Routing Protection (the core of this design)

The failure mode comment flags is over-routing: weak keywords escalating ordinary
queries to agentic mode. Root cause: the current rules treat any keyword hit as
intent. The fix separates **strong signals** (route alone) from **weak signals**
(route only inside an intent structure).

### Strong vs weak signals

| Intent | Strong signals (route alone) | Weak signals (need structure) |
|:--|:--|:--|
| comparison | `对比 / 区别 / 哪个更 / vs / compare / difference / differ` | `比较` (CN), `compare` as ordinary verb |
| review | `复盘 / 梳理 / 全貌 / summarize / overview / walk me through` | `review` (EN), `总结` as plain "summarize action" |
| timeline / change | `时间线 / 之前…现在 / what changed / 变化 / 进展 / formerly` | `change` (EN) |
| hierarchy | `汇报线 / 组织架构 / 谁管 / 下属 / reports to / direct reports / org chart / reporting line` | `manager` (EN) |

### Weak-signal gating — syntax structure, not entity count

A weak signal routes **only** when it appears in a clear intent structure; otherwise it
is treated as ordinary language (adverb / verb / noun) and the query falls through to
the default route. This is stricter than an entity-count gate, which mis-fires on
`比较重要的实体A和实体B` and `review the code about 实体A and 实体B`.

**Chinese `比较`:**
- Adverb blacklist — if `比较` is immediately followed by a common adjective, it is an
  adverb and **never** routes to comparison:
  `比较(重要|好|像|类似|复杂|大|小|多|少|强|弱|快|慢|新|旧|长|短|高|低|常见|明显|简单|稳定|活跃|特殊|普通|关键|主流|合理|接近)`
- Comparison structure whitelist — `比较` routes to comparison only when it sits in a
  compare structure joining two objects:
  - `比较.{0,15}(和|与|跟)` (e.g. `比较 实体A 和 实体B`)
  - `(和|与|跟).{0,15}比较(一下)?` (e.g. `实体A 和 实体B 比较一下`)
- Otherwise (bare `比较` with neither blacklist nor whitelist hit): treat as adverb,
  do **not** escalate.

**English `review`:** routes to review only inside `review of …`, `walk me through …`,
`give me an overview of …`, or alongside a strong review signal. Bare `review the code`
/ `review the PR` does not escalate.

**English `change`:** routes to timeline only inside `what changed`, `change since …`,
`before/after`, or a strong temporal signal. Bare `change the title` / `change manager`
does not escalate.

**English `manager`:** routes to hierarchy only alongside `reports to / direct reports
/ org chart / reporting line`. Bare `manager` does not escalate.

### Strong signals still short-circuit

When a strong signal is present (`对比 / 区别 / vs / compare / difference / 复盘 / 梳理 /
全貌 / summarize / overview / 汇报线 / 谁管 / 下属 / reports to / org chart / 时间线 /
what changed …`), route directly regardless of weak-signal gating.

## Per-Layer Rule Expansion

### `frontdoor-router.ts` (coarse route → next_tool)

Add English/mixed signals to existing routes; hierarchy stays here as the owner:

- `relationship`: `relationship|connected to|how.*(related|connected)|link between`
- `reasoning.comparison` (strong only): `对比|区别|哪个更|A vs B|vs|compare|difference|differ`. Bare `比较` is **removed** from this signal — the current regex `/对比|比较|哪个更|A vs B/` contains it and would match `比较重要的主题A`.
- `hierarchy`: `reports to|direct reports|org chart|reporting line` alongside existing `组织架构|汇报线|谁管|下属`
- `overview`: `summarize|review of|overview|walk me through` alongside existing `总结|梳理|复盘|全貌`
- `debug_search`: `raw search|keyword search|slug` alongside existing `debug|调试|关键词.*在哪`
- `content_recall` / `grounded_recall` temporal signals: `last time|previously|what changed`

Note: bare `比较` is **removed** from frontdoor's comparison signal so
`比较重要的主题A` no longer hits reasoning. The weak `比较` is governed only by
query-router's syntax gate (adverb blacklist + compare-structure whitelist), which is
**not** DB/entity-count based.

### `query-router.ts` (mode + intent, DB-aware)

Add English strong signals to the existing keyword lists, and apply weak-signal gating:

- `COMPARISON_KEYWORDS`: add `compare|difference|differ` (strong). `比较` is removed
  from the "strong" tier — it is evaluated by the weak-signal gate below.
- `REVIEW_KEYWORDS`: add `summarize|overview` (strong). Bare English `review` gated.
- `RELATIONSHIP_KEYWORDS`: add `relationship|connected`.
- `TEMPORAL_KEYWORDS`: add `last time|previously|what changed` (strong). Bare `change` gated.
- `GAP_KEYWORDS`: bilingual already implicit; add `missing|gap` if needed.
- **`比较` weak-signal gate** (applied before `hasComparison` decides): blacklist
  adverb patterns first; then require comparison structure whitelist. Only then set
  `hasComparison = true`.
- Exact title/slug lookup at `:28-31` stays highest priority, ahead of all intent
  checks. Add bilingual exact-lookup test cases.
- **No `hierarchy` intent is added.**

### `recall-intent.ts` (#232 temporal/history/former-current)

English triggers only; pure-regex, no LLM, no DB:

- `TEMPORAL_RE`: add `last time|previously|before|what changed|changed`
- `HISTORY_RE`: add `why.*(decided|chosen)|what was the reasoning|how was.*decided`
- `FORMER_CURRENT_RE`: add `former|current|previous.{0,8}now`

## Eval Matrix (negative-first, RED)

Eval order: write **negative** cases first (the over-routing regressions), confirm
they fail against current code, then expand rules to pass them, then add positive
bilingual cases. All fixtures anonymous (`实体A / 实体B / 主题A`).

### Negative cases (must NOT over-escalate) — written FIRST

- `比较重要的主题A` → **not** comparison (adverb `比较+重要`)
- `实体A和实体B都比较重要` → **not** comparison (`比较重要` adverb, even with 2 entities)
- `review the code` → **not** review
- `review the code about 实体A and 实体B` → **not** review (bare `review` + ordinary action, even with 2 entities)
- `change the title` → **not** timeline
- `change manager` → **not** timeline, **not** hierarchy
- exact title hit `实体A` (when `实体A` is a known page) → `fast`/`entity_lookup`, regardless of any intent keyword in the rest of the query

### Positive cases (should route) — bilingual

| Intent | Chinese | English | Mixed |
|:--|:--|:--|:--|
| relationship | `实体A和实体B有什么联系` | `how is 实体A connected to 实体B` | `实体A and 实体B relationship` |
| timeline | `当时怎么定` / `后来怎么样` | `what changed since` / `last time 实体A` | `实体A previously …` |
| comparison | `实体A 和 实体B 对比` / `实体A 和 实体B 比较一下` | `compare 实体A 实体B` / `实体A vs 实体B` | `实体A and 实体B difference` |
| review | `复盘 实体A` / `梳理 实体A` | `walk me through 实体A` / `overview of 实体A` | — |
| hierarchy (frontdoor only) | `谁管 实体A` / `实体A 的下属` / `实体A 汇报线` | `实体A reports to 实体B` / `org chart for 实体A` | — |
| debug | `实体A 的 slug 在哪` / `实体A 关键词索引` | `debug 实体A` / `raw search 实体A` | — |

For comparison, the positive Chinese cases must use the **compare structure**
(`对比` / `比较一下` / `区别` / `哪个更`), not bare adverb `比较`.

## Boundary Guarantees

| Concern | Guarantee |
|:--|:--|
| Exact lookup precedence | `query-router` exact title/slug match at `:28-31` stays first; add bilingual tests. |
| Default path | Pure deterministic, zero LLM calls, no shadow hook. |
| Hierarchy ownership | `frontdoor-router` only → `get_org_tree`. `QueryRouter.intent` union unchanged (no `hierarchy`). |
| Recall ranking | Untouched. |
| MCP / tool-profile | Untouched. |
| Agentic planner / executor | Untouched beyond routing tests. |
| Display | Routing internals stay raw-only; display/summary unchanged. |
| skill jsonl | Untouched. |

## Verification

```bash
bun test tests/core/frontdoor-router.test.ts
bun test tests/core/query-router.test.ts
bun test tests/core/recall-intent.test.ts
bun test tests/mcp/frontdoor.test.ts
bun run lint
bun run check
```

Negative cases are written and confirmed RED before rule expansion; full `bun run check`
before handoff.

## Non-goals

No LLM classifier (not even an empty hook). No recall ranking rewrite. No
`hierarchy` intent in `QueryRouter`. No agentic planner expansion beyond routing tests.
No MCP schema breaking changes. No skill jsonl changes. No private fixtures.

## Future (separate issues)

- Phase 2: opt-in LLM intent classifier in shadow mode (record-only, behind explicit
  flag, bounded), only after Phase 1 rules + evals are stable.
- Bilingual expansion of skill-layer `routing-eval.jsonl` (and de-identification of
  existing real-name fixtures) — separate privacy/audit issue.
