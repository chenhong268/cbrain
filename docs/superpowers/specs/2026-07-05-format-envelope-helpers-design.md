# Format Envelope Helpers Design

## Problem

`src/mcp/tools/format-result.ts` repeats the same envelope construction pattern in many branches:

- build `display`
- build a `ToolSummary`
- attach `raw`

The repeated shape increases drift risk. This issue is a narrow refactor for #277 Slice 3. It must not change MCP response contracts.

## User-visible contract

No user-visible output should change. For migrated formatter branches:

- `display` text stays identical.
- `summary` fields stay identical.
- `raw` stays the original payload.
- `sanitizeDisplay` remains the single display sanitizer.

## Approach

Add internal helper functions next to the existing `toolEnvelope`:

- `makeSummary(status, count, message, options?)`
- `okEnvelope(raw, display, count, message, options?)`
- `emptyEnvelope(raw, display, message, options?)`
- `errorEnvelope(raw, display, message, options?)`

Then migrate only low-risk branches that already use the standard `ToolSummary` shape:

- `formatGetPageEnvelope`
- `formatVersionsEnvelope`
- `formatRevertEnvelope`
- `formatRemoveProfileEnvelope`

This keeps the patch bounded and avoids rewriting complex formatters such as recall, health, discovery, or dream status in the first slice.

## Non-goals

- No public MCP tool schema changes.
- No display wording changes.
- No raw payload changes.
- No large module split.
- No handler changes.
- No full formatter rewrite.

## Tests

Use existing formatter coverage as the primary contract test:

- `tests/mcp/v193-ux-gate.test.ts`
- `tests/mcp/version-profile-envelope.test.ts`
- `tests/mcp/graph-timeline-envelope.test.ts`

Add focused unit coverage for helper behavior if needed, but prefer not to lock internal helpers unless an edge is otherwise untested.

## Adversarial checks

Before delivery:

1. Compare migrated branch outputs against existing expected tests.
2. Verify display text still goes through `sanitizeDisplay` where it did before.
3. Verify no raw field is dropped or renamed.
4. Verify no private fixture content or path is added.
