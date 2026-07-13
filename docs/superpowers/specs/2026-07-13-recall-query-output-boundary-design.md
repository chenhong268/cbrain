# Recall / Query Structured Output Boundary Design

## Problem

#327 Phase 1 migrated graph and timeline, but the three recall paths Hermes uses most still bypass the structured result boundary. `cbrain_recall` always emits routing plus its full payload, `query` always emits raw search results and diagnostics, and `deep_recall` has its own compact/raw branches instead of the shared serializer. Expanding the rollout without migrating them would leave the highest-volume surfaces on the legacy contract.

This phase reduces default raw exposure and labels vault-derived data. It does not claim that `structuredContent` prevents prompt injection; Hermes currently projects text and structured content into the same model context.

## Scope

- Migrate `cbrain_recall`, `deep_recall`, and `query` when `ctx.outputMode === "structured"`.
- Keep the rollout default `legacy` and preserve every legacy text payload byte-for-byte.
- Add `include_raw?: boolean` to `cbrain_recall` and `query`; legacy ignores it and keeps current behavior.
- Keep `deep_recall`'s #231 compact default and 12,000-character legacy budget unchanged.
- Use the existing `buildToolResult`, `sanitizeStructuredText`, and `redactAudit` sources. No new regex source.
- Register exact output schemas for structured `deep_recall` and `query` only. `cbrain_recall` has multiple route-specific payloads, so this phase returns structured content without pretending that one loose schema is exact.
- Verify real SDK transport and an isolated HTTP `/mcp` canary without changing the live Hermes configuration or process.

## Output Contract

### Legacy mode

All three tools return the exact current JSON text and no `structuredContent`. They do not advertise `outputSchema`. `include_raw` does not change the legacy result.

### Structured common envelope

```ts
{
  schema_version: 1,
  display: string,       // fixed trusted copy in text only
  summary: ToolSummary,  // explicit scalar/enum projection
  data: object,          // vault-derived, sanitized and structurally allowlisted
  audit?: { raw: unknown } // only include_raw=true; credentials/paths removed
}
```

`structuredContent` mirrors `{schema_version, summary, data, audit?}`. Credentials and absolute paths never survive any structured branch. Slugs, scores, source types, routing, reason codes, latency, and debug fields are absent from default data and may appear only in redacted opt-in audit.

### `deep_recall.data`

Normal recall preserves the #231 first-turn value:

```ts
{
  result_summary: string,
  query: string,
  entities: Array<{
    title?: string, type?: string, quality?: string, tier?: number,
    snippet?: string, tags?: string[], expiry_warning?: string, birthday?: string
  }>,
  proactive_hints?: Array<{text: string, why?: string}>,
  related_context?: string
}
```

Grounded recall uses an exact alternate data shape containing `answer`, `confidence`, facts, user thoughts, candidates, conflicts, gaps, and `must_not_claim`. Source slugs stay in audit only.

### `query.data`

```ts
{
  result_count: number,
  results: Array<{snippet?: string}>,
  proactive_hints?: Array<{text: string, why?: string}>
}
```

`query` is a debug/locator tool. In structured mode, a caller that needs the located slug or source must explicitly request `include_raw=true` and read `audit.raw`.

### `cbrain_recall.data`

The frontdoor retains a stable `answer` plus a bounded route-aware semantic projection. Allowed details include entity titles/snippets, grounded claims, hierarchy labels, episode summaries, and agentic result prose. Routing, budgets, trace fields, slugs, scores, IDs, and source metadata are excluded. Because the eight routes do not yet share a stable data union, no `outputSchema` is advertised for this tool in this phase.

## Data Sanitization Boundary

`result-builder.ts` gains a caller-supplied structural key policy. The existing graph/timeline default key policy remains unchanged. New recall/query policies are named exports in a focused recall output module. Recursive strings still flow through the shared `sanitizeStructuredText`; audit still flows through `redactAudit`.

Natural-language instruction-like vault content is retained in `data`. CBrain does not claim regex can distinguish all instructions from data. Normal anonymous titles remain readable.

## Error and Empty Paths

- Empty and grounded-empty responses use the same structured envelope and exact schema as non-empty responses.
- Sanitization failure falls back to bounded empty data and a fixed summary; it must not expose the rejected value or crash a read-only tool.
- Legacy errors and behavior are untouched.
- Output schemas are conditional on structured mode so the SDK never rejects a legacy response for missing `structuredContent`.

## Canary

Start a separate temporary HTTP server on a free loopback port with a temporary vault/SQLite/Lance path and `CBRAIN_OUTPUT_BOUNDARY=structured`. Perform `initialize`, `tools/list`, and `tools/call` for all three tools. Assert default responses contain no raw/audit and the direct tools advertise schemas. Shut down and delete temporary state. Do not restart or edit the live `ai.cbrain.serve` or Hermes profiles.

## Non-goals

- No search/ranking/routing/evidence changes.
- No discovery/action-candidate migration.
- No Hermes host-side change and no default rollout flip.
- No database migration, LLM call, new MCP tool, or profile change.
- No universal route schema for `cbrain_recall` in this phase.

## Acceptance and Adversarial Review

1. Real transport proves legacy byte compatibility and absence of output schemas.
2. Real transport proves structured schemas for `deep_recall` and `query` validate.
3. Default structured responses contain no `raw`, `audit`, slug, score, source type, routing, reason code, latency, credential, or absolute path.
4. `include_raw=true` produces equal text/structured audit, retains useful internal refs, and removes credentials/paths.
5. #231 compact data remains bounded and informative; grounded, empty, normal, and raw branches all pass.
6. Major frontdoor routes retain non-empty semantic data.
7. Independent fixtures cover credential, path, fullwidth internal term, Cc/Cf, slug value, and normal titles.
8. Isolated HTTP canary leaves live processes/configuration unchanged.
9. Full test, lint/docs, diff check, and privacy scan pass.

