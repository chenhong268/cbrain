# Unified Job Tool Plan (#290)

## Problem

MCP exposes five job queue tools for one conceptual maintenance surface. This increases routing surface for maintenance clients. The fix is a compatibility-preserving `job` tool with explicit `action`, while retaining every existing `job_*` tool name.

## Scope

- Add `job({ action: "submit" | "list" | "status" | "cancel" | "retry", ... })`.
- Reuse the existing `job_*` implementation paths.
- Keep `job_submit`, `job_list`, `job_status`, `job_cancel`, and `job_retry` registered.
- Add `job` to the maintenance profile only.
- Do not expose `job` to the agent profile.
- Update docs inventory and counts.

## Non-goals

- Do not remove legacy tool names.
- Do not change JobQueue semantics.
- Do not add new async job behavior.
- Do not change response shapes.

## Verification

1. RED: focused tests fail before `job` exists.
2. GREEN: focused MCP/profile tests pass.
3. Docs consistency passes with updated tool count.
4. Full `bun run check` passes before merge/push.
5. Adversarial review checks old names remain, `job` stays out of agent profile, and tests/docs use anonymous placeholders.
