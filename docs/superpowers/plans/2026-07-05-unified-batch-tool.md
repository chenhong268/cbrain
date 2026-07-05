# #292 Unified Batch Tool Plan

## Problem

CBrain exposes three batch MCP tools for one coherent bulk-operation family. This increases routing burden and keeps destructive operations spread across multiple names.

## Scope

- Add unified `batch(action=delete_pages|add_links|merge_pages)` MCP tool.
- Keep `batch_delete_pages`, `batch_add_links`, and `batch_merge_pages` registered as compatibility aliases.
- Reuse existing implementation helpers; no behavior or envelope changes.
- Keep `batch` out of the daily `agent` profile and expose it through `maintenance`.

## Tests

1. RED: MCP inventory includes `batch`.
2. RED: `batch(action=delete_pages)` matches preview behavior from `batch_delete_pages`.
3. RED: `batch(action=add_links)` matches execution behavior from `batch_add_links`.
4. RED: `batch(action=merge_pages)` matches preview behavior from `batch_merge_pages`.
5. RED: maintenance includes `batch`; agent excludes it.
6. GREEN: docs inventory updates from generated truth.
7. Adversarial review: old aliases still registered, safety gate unchanged, no daily-agent broadening, full gate passes.
