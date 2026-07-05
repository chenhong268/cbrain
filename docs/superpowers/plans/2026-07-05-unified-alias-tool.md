# Plan: Unified Alias MCP Tool (#288)

## Problem

CBrain is reducing MCP tool routing noise behind compatibility aliases. The
alias operation family currently exposes separate `add_alias` and
`remove_alias` tools. These are the same operation family and can share one
task-oriented tool without breaking existing callers.

## Scope

- Add `alias({ action: "add" | "remove", slug, alias })`.
- Keep `add_alias` and `remove_alias` registered.
- Route old and new names through the same helper functions.
- Add `alias` to the debug profile only.
- Keep the agent profile unchanged.
- Update MCP inventory docs and tool counts.

## Non-goals

- Do not remove or rename compatibility aliases.
- Do not change alias storage, slug resolution, resolver behavior, or merge
  workflow.
- Do not expose a new alias write tool to the agent profile.

## TDD Tasks

1. RED: add tests for inventory, profile exposure, and `alias` action shapes.
2. GREEN: extract alias helpers and register the unified tool.
3. Docs: update generated MCP inventory and tool counts.
4. Verify: targeted MCP/profile tests, docs gate, typecheck, lint, full check.
5. Adversarial review: compatibility aliases, profile boundary, docs count,
   privacy-safe fixtures.

