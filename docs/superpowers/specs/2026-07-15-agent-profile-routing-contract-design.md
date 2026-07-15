# Agent Profile Routing Contract Design

**Issue:** #343

**Status:** Approved for implementation by the user instruction to complete #343 independently.

## 1. Problem

The canonical Hermes skill pack can name an MCP tool as the Agent-facing
`expected_tool` even when that tool is absent from the daily `agent` profile.
The concrete release-gate failure is `keyword_debug -> query`: the fixture is
green, but a real Hermes session cannot discover or call `query`.

The same missing cross-layer check currently permits two additional drifts:
Agent-facing overview cases name `summarize`, and one discovery case names
`run_discovery`; neither tool is exposed by the daily profile. A fix limited to
the single `query` row would leave the contract structurally broken.

## 2. Evidence and root cause

- `skills/agent-facing.routing-eval.jsonl` is the Agent-facing routing source.
- `src/mcp/tool-profiles.ts` is the runtime exposure source.
- `attachMcpTools` filters registration before MCP `tools/list` discovery.
- `cbrain_recall` already classifies explicit debug/keyword-location language as
  `debug_search` and executes the search internally.
- No gate currently joins the fixture's `expected_tool` values to the actual
  daily profile discovery surface.

Root cause: routing truth and exposure truth are independently tested, but no
test proves that an Agent-facing route is executable in its runtime profile.

## 3. Decision

Keep `query` excluded from the daily `agent` profile. Route explicit
Agent-facing keyword/debug requests through `cbrain_recall`, whose existing
internal `debug_search` path provides the behavior without exposing the
low-level tool.

Apply the same front-door rule to overview cases: Agent-facing summaries use
`cbrain_recall`, whose existing overview route performs the internal summary.

Daily Agents may read existing discoveries through `read_discoveries`; they do
not run `run_discovery`. Canonical instructions must not claim that a daily
Agent executed discovery. An explicit run request requires a `full` session
(`maintenance` does not expose this tool). The daily Agent must return a bounded
profile-boundary response and must not call `read_discoveries` as though reading
old results had executed a new detection run.

### 3.1 Rejected alternatives

1. **Add `query` to `AGENT_ALLOWLIST`.** Rejected because it expands the daily
   low-level surface, exposes a second search entry, conflicts with the bounded
   20-tool contract, and adds no capability missing from `cbrain_recall`.
2. **Create a conditional agent-debug profile.** Rejected because profile
   selection is session-scoped, not intent-scoped. Hermes would need a second
   connection or reconnect for one request, adding state and deployment cost.
3. **Patch only the `keyword_debug` fixture.** Rejected because `summarize` and
   `run_discovery` would remain impossible expected tools and the missing
   cross-layer invariant would remain undetected.

## 4. Canonical routing contract

For the daily `agent` profile:

| Intent | Agent-facing tool | Runtime behavior |
|---|---|---|
| natural recall / grounded / overview | `cbrain_recall` | existing internal front-door route |
| explicit keyword/debug location | `cbrain_recall` | existing internal `debug_search` route |
| operational attention | `next_actions` | existing operational front door |
| read discoveries | `read_discoveries` | read-only persisted digest |
| run discovery detection | no tool call | `requires_full_profile`; never claim execution |

`query` remains discoverable in `debug` and `full` profiles only. `summarize`
and `run_discovery` remain outside the daily profile. No allowlist entry changes.

## 5. Cross-layer gate

Add a deterministic checker to `bin/check-docs-consistency.ts`:

1. Read only `skills/agent-facing.routing-eval.jsonl`.
2. Fail if the file is absent or a non-empty line is invalid JSON.
3. Accept exactly two row shapes:
   - executable: `expected_tool` is a non-empty string present in
     `AGENT_ALLOWLIST`;
   - profile boundary: `expected_tool` is `null`,
     `expected_outcome` is exactly `requires_full_profile`,
     `required_profile` is exactly `full`, and `forbidden_tools` contains both
     `run_discovery` and `read_discoveries`.
4. Reject every other missing/null/non-string `expected_tool` shape.
5. Validate tools in `required_sequence` against `AGENT_ALLOWLIST` as well.
6. Report row numbers and tool names/outcome codes only; never echo fixture
   input text.
7. Aggregate all unavailable tools in a stable, sorted diagnostic.

This gate is structural. It does not infer routing from prose and does not add a
second tool inventory. Existing allowlist-vs-registration tests remain the
source that proves every allowlisted name is a real registered MCP tool.

## 6. Real discovery smoke

Add an anonymous in-memory MCP protocol test using the real `createServer`,
`InMemoryTransport`, and MCP `Client` with `toolProfile: "agent"` and structured
output enabled.

The test must prove:

- every Agent-facing `expected_tool` is returned by real `tools/list`;
- `query`, `summarize`, and `run_discovery` are not returned;
- `cbrain_recall`, `next_actions`, and `read_discoveries` are returned;
- the fixture has executable cases for natural, operational, and
  `keyword_debug` intents;
- the debug fixture expects `cbrain_recall`, not `query`.
- the explicit discovery-run fixture has no tool call and requires `full`;
- real `Client.callTool()` calls for anonymous keyword-debug and overview
  inputs execute through `cbrain_recall` without MCP errors;
- with `include_raw` omitted/false in structured mode, neither call returns
  `raw`, `routing`, `next_tool`, or low-level result fields.

Fixtures use only anonymous tokens such as `主题A` and no vault body content.

## 7. Canonical skill alignment

Update the managed skill pack so daily instructions consistently say:

- explicit keyword/debug -> `cbrain_recall` internal debug route;
- direct `query` requires an explicitly selected debug/full profile;
- overview -> `cbrain_recall`, not direct `summarize`;
- daily discovery is read-only; `run_discovery` requires `full`; an explicit
  run request produces a profile-boundary response with no substitute tool call.

`skills/query.md` remains a skill document name and can still carry the
`[keyword]` branch. The branch's MCP call changes to `cbrain_recall`; the file
name is not a tool name.

`skills/recall.routing-eval.jsonl` is a lower-level/debug evaluation set and is
not the Agent-facing contract. This issue does not rewrite that historical
suite; the new invariant is deliberately scoped to
`agent-facing.routing-eval.jsonl`.

## 8. Tests

TDD order:

1. Add checker unit tests that fail for `query`, invalid JSON, malformed
   no-tool outcomes, and unavailable `required_sequence` entries; pass for
   allowlisted tools and the exact `requires_full_profile` shape.
2. Run them red before implementing the checker.
3. Implement the checker and wire it into `check:docs`.
4. Add the real MCP discovery/call smoke; observe it fail against the old
   fixture and verify structured output hides routing/raw data.
5. Align fixture, resolver pilot assertions, and skill prose.
6. Run focused tests, `check:docs`, resolver pilot contract sections, lint, and
   full `bun run check`.

The existing resolver pilot has an unrelated baseline privacy false positive
against #342's anonymous numeric parser fixture. #343 must not alter that test
or report the whole pilot as green unless the baseline issue is separately
fixed.

## 9. Privacy and compatibility

- No real names, organizations, paths, vault contents, email addresses, or
  credentials in fixtures, diagnostics, docs, or PR text.
- The gate prints only line numbers and tool identifiers.
- No tool handler, router, output envelope, structured boundary, ranking, or
  database behavior changes.
- `FrontdoorRoutingDecision.next_tool` remains an internal dispatch/audit label,
  not an Agent action contract. Structured daily output hides it. Legacy mode
  continues to expose its compatibility envelope; skill policy already forbids
  rendering or treating `raw.routing` as a callable tool. #343 adds no new raw
  field and does not migrate legacy output.
- No profile expands and no existing tool is removed from `debug` or `full`.

## 10. Non-goals

- Changing recall ranking or search strategy.
- Exposing raw/debug fields by default.
- Adding `query`, `summarize`, `run_discovery`, or other maintenance/debug tools
  to the daily profile.
- Changing profile selection or introducing per-request dynamic profiles.
- Modifying the TypeScript front-door router or MCP handlers.
- Fixing the unrelated resolver-pilot numeric privacy false positive.
- Improving overview relevance or its currently coarse relation/timeline
  counts. #343 verifies that the route executes and respects the output
  boundary; semantic overview quality is a separate retrieval issue.

## 11. Acceptance

- Every Agent-facing `expected_tool` is discoverable in a real daily-profile
  MCP handshake, or the row uses the single explicit
  `requires_full_profile` no-tool outcome.
- Natural, operational, and explicit debug fixtures each have one executable
  route.
- Explicit discovery execution is not impersonated by a read-only call.
- A fixture targeting any daily-invisible tool fails the new gate.
- `query` remains excluded from daily discovery and available in debug/full.
- Anonymous debug and overview calls succeed over the real MCP protocol, and
  structured default responses contain no routing/raw data.
- Existing privacy and structured-output tests remain green.
- Focused tests, docs consistency, lint, and full check pass.
