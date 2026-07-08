# Agent Interface Contract Design — #316

> Make `cbrain_recall` the explicit, tested default front door for Agent-facing
> natural-language questions. Low-level tools become debug/fallback/internal.
> Parent roadmap: #228. Builds on #251 (tool profiles) + #309/#315 (attention surface).

## Context

CBrain already has an `agent` profile (#251) and a `cbrain_recall` front door
(`src/mcp/tools/frontdoor.ts`, internally routing grounded_recall / episodic /
hierarchy / overview / relationship / reasoning / debug_search). That is exactly
the "front door → internal dispatch" model #316 wants.

But a 13-file audit found only `skills/hermes-cbrain-brief.md` positions
`cbrain_recall` as the default front door. The other 11 files teach Agents to
call `deep_recall` / `query` / `summarize` / `brain_storm` / `expand_entity` as
the first choice — and `query` / `summarize` / `brain_storm` / `expand_entity` /
`get_chunks` / `dossier` / `agentic_research` / `get_links` are **not in the
agent allowlist at all** (docs teach tools Agents cannot call).

`deep_recall` IS in the agent allowlist, but the contract wants it as the
internal-dispatch target of `cbrain_recall`, not as the Agent's first pick.

## Goal

Make the Agent-facing contract explicit and tested:

- Daily Agent natural-language recall/review/relationship/overview questions
  route through `cbrain_recall`.
- Low-level tools (`query`, `get_chunks`, `expand_entity`, `summarize`,
  `brain_storm`, `dossier`, `agentic_research`) appear only in debug/fallback/
  internal sections.
- `deep_recall` becomes an advanced/precise-parameter escape hatch, not the
  default recommendation.
- A docs-consistency gate catches future drift back to recommending excluded
  tools as first-choice.

## Design Decisions (locked with 宏哥)

1. **`deep_recall`: keep in allowlist, demote in docs.** Do NOT change the
   `agent` allowlist in `src/mcp/tool-profiles.ts` (avoids the non-goal of
   touching profile code). Docs uniformly say: `cbrain_recall` is the default
   front door; `deep_recall` is direct-call only when fine-grained params
   (`grounded` / `detail` / `limit`) are needed or `cbrain_recall` cannot
   express the intent. `skills/hermes-cbrain-brief.md` is the wording template.

2. **docs gate: narrow `checkAgentContractTools`.** Add a new check to
   `bin/check-docs-consistency.ts` that scans `skills/*.md` recommendation
   lines and fails when an agent-excluded tool is positioned as a first choice.
   Debug/fallback sections that explicitly mark a tool as debug-only are allowed.

## Scope

### skills (Agent-facing routing contract — P0)

- `skills/RESOLVER.md` — this is a **skill routing table** (user intent → skill
  file → skill calls MCP tool), NOT an MCP-tool routing table, so the skill-file
  target must stay. Routing entries change from `query.md [deep_recall]` to
  `query.md [cbrain_recall]` — i.e. the intent still routes to the `query.md`
  skill, but that skill's default MCP call becomes `cbrain_recall` (see
  `skills/query.md` below). Keep the debug/keyword → `query` branch (clearly
  marked debug). Do NOT replace the skill-file target with a bare MCP tool name.
- `skills/recall-resolver.md` — decision-tree root + capability cheatsheet:
  `cbrain_recall` default; `deep_recall` demoted to "fine-grained param advanced
  use"; `summarize`/`dossier`/`brain_storm`/`agentic_research` marked debug/internal.
- `skills/SKILL.md` — cheatsheet: each signal's first choice is `cbrain_recall`;
  the `query`+`get_page` chain becomes an anti-pattern.
- `skills/query.md` — Default Behavior adds `cbrain_recall` front door;
  `agentic_research` / synthesis-protocol chain marked internal/fallback.
- `skills/review.md` — prefer `cbrain_recall`; `deep_recall` only for fine-grained
  params; the manual 4-step `query`+`get_page`+`graph`+`timeline` marked debug-only.
- `skills/write.md` — Step 2 Gather routes through `cbrain_recall` first; the
  CLI `query` chain demoted to manual fallback.
- `skills/hermes-cbrain-brief.md` — wording template; minor fix only (the
  `get_links` reference is a boundary case — `get_links` is not in the agent
  allowlist, so reword to fetch link_id via `cbrain_recall` or mark debug).

### docs (alignment)

- `README.md` — §Search Routing table rooted at `cbrain_recall`; `deep_recall`
  demoted; `query`/`summarize`/`brain_storm`/`expand_entity` marked debug.
- `docs/mcp-tools.md` — hand-written §query adds `cbrain_recall`; the
  `deep_recall` description drops the "默认查询工具" wording that conflicts with
  `cbrain_recall`; `get_chunks` marked debug.
- `docs/usage.md` / `docs/install-onboarding.md` — add one line: "Agent
  natural-language goes through `cbrain_recall`; CLI `query` is the manual /
  exact-keyword path." (CLI examples stay — they are user-facing CLI, not Agent
  tool routing.)
- `docs/hermes-integration.md` — add one line that the tool-layer front door is
  `cbrain_recall` (profile layer is already aligned).

### gate + tests

- `bin/check-docs-consistency.ts` — add `checkAgentContractTools` (see below).
- Import the agent allowlist from `src/mcp/tool-profiles.ts` as the single
  source of truth (export `AGENT_ALLOWLIST` or add a typed getter — this is an
  export-only change, not an allowlist semantic change).
- Add focused tests for the new gate (a small tests file or extend the existing
  docs-consistency test if one exists).

## `deep_recall` Contract Wording (anchor, reused across files)

- **`cbrain_recall`** — CBrain's natural-language front door. The Agent's first
  choice for user questions. recall / grounding / find-person / hierarchy /
  overview / relationship / reasoning all route here; CBrain dispatches internally.
- **`deep_recall`** — advanced use only. Direct-call when fine-grained params
  (`grounded` / `detail` / `limit`) are needed or `cbrain_recall` cannot express
  the intent. Not the regular first choice. Although `deep_recall` is in the
  agent allowlist, the docs gate treats it as a **restricted first-choice tool**:
  positioning it as the default/first choice fails Check 2 (see Gate Design).
- **`query` / `get_chunks` / `expand_entity` / `summarize` / `brain_storm` /
  `dossier` / `agentic_research` / `get_links`** — debug / internal / fallback
  tools, not exposed in the `agent` profile. Mentioned only in debug sections or
  explicit fallback context.

## Gate Design: `checkAgentContractTools`

Logic (precise regex finalized in the plan, based on actual file wording):

- Truth source: `AGENT_ALLOWLIST` from `src/mcp/tool-profiles.ts` + the full
  registered tool list already computed by `getMcpTools()`.
- `EXCLUDED = registeredTools - AGENT_ALLOWLIST` (this is `query`, `get_chunks`,
  `expand_entity`, `summarize`, `brain_storm`, `dossier`, `agentic_research`,
  `get_links`, plus maintenance/debug tools).
- Scan only `skills/*.md` (the Agent-facing contract surface). `docs/*.md` debug
  sections are NOT scanned (avoids false positives where debug tools are
  legitimately mentioned).
- **Check 1 — excluded-as-first-choice:** a line FAILS when it positions an
  `EXCLUDED` tool as a first choice — cue `首选` / `优先` / `默认` / `第一` / `→`
  next to a backticked excluded tool name.
- **Check 2 — `deep_recall` restricted first-choice (#316 review fix):**
  `deep_recall` IS in the allowlist, so Check 1 cannot catch it. But the contract
  says `deep_recall` is an advanced escape hatch, NOT the default. So Check 2
  FAILS any line that positions `deep_recall` as the default/first choice — cues
  `默认` / `首选` / `优先` / `一步搞定` / `default query tool` (and English
  equivalents). It PASSES lines that frame `deep_recall` as `advanced` /
  `fine-grained params` / `fallback` / `direct-call only`. Without Check 2, docs
  could silently slip back to "优先用 deep_recall" and the gate would not fire.
- Per-line opt-out (both checks): `<!-- docs-consistency:ignore-agent-contract -->`.

## Gate Test Cases (required in the plan)

The plan MUST include tests asserting:

- A skill line like `优先用 deep_recall` / `默认查询工具 deep_recall` → gate FAILS (Check 2 — `deep_recall` restricted first-choice).
- A skill line framing `deep_recall` as `advanced` / `fallback` / `direct-call only` → gate PASSES.
- A skill line recommending `query` / `summarize` / `brain_storm` as a first choice → gate FAILS (Check 1 — excluded-as-first-choice).
- A `<!-- docs-consistency:ignore-agent-contract -->` opt-out line → gate PASSES.
- `RESOLVER.md` form `query.md [cbrain_recall]` → gate PASSES (skill-file target preserved, not a bare MCP tool name).

## Non-goals

- Do not delete or rename MCP tools.
- Do not change tool handlers or search ranking.
- Do not change the `agent` / `maintenance` / `debug` / `full` allowlists in code
  (`deep_recall` stays in `agent`).
- Do not redesign `cbrain_recall` routing (`frontdoor.ts` untouched).

## Acceptance Criteria (from #316 issue body)

- Agent-facing docs say `cbrain_recall` is the default natural-language front door.
- Low-level tools described as debug/fallback/internal, not the first-line route.
- `agent` profile docs match the actual allowlist and do not advertise
  unavailable tools as normal Agent tools.
- A regression check (`checkAgentContractTools`) fails if Agent-facing docs drift
  back to recommending excluded low-level tools as first choice.
- Existing MCP profile tests still pass.
- No real user/vault names in tests or docs examples.

## Verification

- `bun run check:docs`
- `bun run lint` (the gate is TypeScript)
- `bun test` (existing profile tests + new gate tests)

## Commit Strategy

One worktree / one PR, phased commits:

1. spec doc (this file)
2. skills routing contract (`RESOLVER.md` + `recall-resolver.md`)
3. skills rest (`SKILL.md` / `query.md` / `review.md` / `write.md` / `hermes-cbrain-brief.md`)
4. docs (`README.md` / `mcp-tools.md` / `usage.md` / `install-onboarding.md` / `hermes-integration.md`)
5. gate (`bin/check-docs-consistency.ts` + `AGENT_ALLOWLIST` export in `tool-profiles.ts`)
6. gate tests + full verification
