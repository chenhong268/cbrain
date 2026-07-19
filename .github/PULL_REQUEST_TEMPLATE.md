## Summary

Brief description of what this PR does and why.

## Changes

- Change 1
- Change 2

## Scope and Complexity

- Evidence or issue addressed:
- Smallest solution used:
- Code, interface, state, or behavior deliberately avoided/removed:
- New public surface, persistent state, background work, default, privacy, or
  compatibility change (write `none` or link the approval):
- New abstraction and its two named existing production consumers (or `none`):
- Temporary compatibility: reason, privacy-safe observation, earliest removal
  release/condition, and retirement issue (or `none`):

## Test Plan

- [ ] Full gate passes (`bun run check` — typecheck src + tests + biome lint + bun test)
- [ ] Manual testing performed (describe what you tested)

## Subtraction Review

- [ ] Tests protect external behavior or a reproduced failure, not incidental
      implementation shape.
- [ ] No unrelated cleanup or speculative future-use framework is included.
- [ ] Codex review verdict recorded or linked: `approve`, `simplify`, `split`, or
      `reject`.
