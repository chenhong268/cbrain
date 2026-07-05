# #291 Unified Profile Tool Plan

## Problem

CBrain exposes four profile MCP tools for one coherent profile-management surface. This increases Agent routing burden and works against #281's MCP surface simplification direction.

## Scope

- Add unified `profile(action=get|update|remove|reload)` MCP tool.
- Keep `get_profile`, `update_profile`, `remove_profile`, and `reload_profile` registered as compatibility aliases.
- Reuse existing profile manager calls and formatters; no envelope/storage behavior changes.
- Keep `profile` out of the `agent` profile because it includes write/reload actions.

## Tests

1. RED: MCP inventory includes `profile`.
2. RED: `profile(action=get)` matches the `get_profile` envelope shape.
3. RED: `profile(action=update)` matches the `update_profile` envelope shape.
4. RED: `profile(action=remove)` matches the `remove_profile` envelope shape.
5. RED: `profile(action=reload)` matches the `reload_profile` envelope shape.
6. RED: tool-profile test proves `agent` excludes `profile`.
7. GREEN: docs inventory updates from generated truth.
8. Adversarial review: old aliases still registered, no profile broadening for daily agent, no privacy leak in touched docs/tests, full gate passes.
