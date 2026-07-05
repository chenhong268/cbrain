# Plan: Unified Timeline MCP Tool (#287)

## Problem

CBrain is reducing MCP tool routing noise behind compatibility aliases. The
timeline operation family currently exposes separate `get_timeline` and
`add_timeline_entry` tools. Agents should eventually be able to use one
task-oriented timeline tool without breaking existing callers.

## Scope

- Add `timeline({ action: "get" | "add", ... })`.
- Keep `get_timeline` and `add_timeline_entry` registered.
- Route old and new names through the same helper functions.
- Add `timeline` to the debug profile only.
- Keep the agent profile unchanged: it continues to expose `get_timeline`, not
  the unified write-capable `timeline` tool.
- Update MCP inventory docs and tool counts.

## Non-goals

- Do not remove or rename compatibility aliases.
- Do not change timeline storage, indexing, provenance, trust state, or recall
  behavior.
- Do not expose a new write-capable timeline tool to the agent profile.
- Do not merge timeline with recall tools.

## TDD Tasks

1. RED: add tests for inventory, profile exposure, and `timeline` action shapes.
2. GREEN: extract timeline helpers and register the unified tool.
3. Docs: update generated MCP inventory and tool counts.
4. Verify: targeted MCP/profile tests, docs gate, typecheck, lint, full check.
5. Adversarial review: compatibility aliases, profile boundary, docs count,
   privacy-safe fixtures.

