# Agent Write and Recall Contract Design (#322)

## Goal

Make the daily Agent use the safe capabilities CBrain already ships instead of
bypassing them or routing operational questions through semantic recall.

## Contract

- New durable content uses `ingest`.
- Existing pages use `put_page` in the default patch mode, after resolving the
  canonical slug when needed.
- A managed CBrain skill never writes the vault through `write_file`.
- Questions about CBrain's current problems, health, pending work, or what to do
  next route to an `operations` branch using `next_actions`; `status` is an
  optional second read only when numeric runtime state is requested.
- Normal `cbrain_recall` may perform at most one bounded keyword fallback when
  the first response is empty/degraded. It then stops and reports insufficient
  evidence rather than chaining tools indefinitely.

## Boundaries

This is a skill/docs contract only. It does not change MCP schemas, search
ranking, database state, profile size, or repair permissions.

## Gate

`check:docs` verifies the canonical create/update routes, the operations branch,
the one-fallback stop rule, and the absence of positive `write_file` guidance.

