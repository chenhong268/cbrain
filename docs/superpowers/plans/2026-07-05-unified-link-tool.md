# Unified Link Tool Plan (#289)

## Problem

MCP exposes `get_links`, `add_link`, and `remove_link` as separate tool names for one conceptual link operation group. This increases Agent routing surface. The fix is a compatibility-preserving `link` tool with explicit `action`, while retaining every existing tool name.

## Scope

- Add `link({ action: "list" | "add" | "remove", ... })`.
- Reuse the existing get/add/remove implementation paths.
- Keep `get_links`, `add_link`, and `remove_link` registered.
- Add `link` to the debug profile only; do not add it to the agent profile.
- Update docs inventory and counts.

## Non-goals

- Do not remove legacy tool names.
- Do not change `graph_query`.
- Do not change link persistence, relation normalization, sync warning behavior, or response shapes.
- Do not add new graph features.

## Verification

1. RED: focused tests fail before `link` exists.
2. GREEN: focused MCP/profile tests pass.
3. Docs consistency passes with updated tool count.
4. Full `bun run check` passes before merge/push.
5. Adversarial review checks old names remain, `link` stays out of agent profile, and tests/docs use anonymous placeholders.
