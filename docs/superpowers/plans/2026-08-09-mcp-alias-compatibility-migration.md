# MCP Alias Compatibility Migration Plan

> Issue: #377
> Date: 2026-08-09
> Scope: compatibility migration only; no alias removal.

## Evidence and decision

- The daily `agent` profile exposes 20 canonical tools and no candidate alias.
- Repository-owned Agent guidance still contains a small number of executable
  candidate-alias references. One tag-management instruction is not callable by
  the daily profile, so it must be explicitly limited to its existing debug/full
  surface instead of granting new permissions.
- Aliases remain a public compatibility surface. Repository evidence cannot
  prove that external clients have migrated, therefore they remain registered.

## Implementation sequence

1. Add a real-MCP, anonymous-fixture test harness that compares each supported
   alias operation with its canonical action on isolated equivalent state.
   Valid calls must have equivalent visible results and persisted state; invalid
   calls must fail closed without writing.
2. Add a small inventory helper for status reporting, then expose additive
   registered/profile counts from `/health` without listing tool names or any
   user data.
3. Correct only executable repository-owned guidance to use an Agent-available
   canonical route or an explicit existing debug/full boundary. Preserve
   historical and negative references.
4. Add focused contract checks for the structured routing fixtures and preserve
   the current 20-tool Agent contract.
5. Regenerate the tool reference, run focused tests and the complete suite,
   then perform an adversarial review before committing.

## Non-goals and rollback

- Do not unregister aliases, change handlers, alter recall/output behavior,
  modify profile permissions, or open real vault/SQLite/LanceDB data.
- No migration or persistent state is introduced. Reverting the isolated commit
  restores the prior documentation and additive health response.
