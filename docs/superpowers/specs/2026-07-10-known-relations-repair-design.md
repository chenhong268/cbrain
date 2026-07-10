# Bounded Known Relations Repair Design (#323)

## Problem

Health can identify deterministic Markdown projection drift, but operators lack
a bounded execution path. Full-vault writeback is too disruptive for an iCloud
vault, so the debt remains.

## Design

- Add a maintenance-only `repair_known_relations` MCP tool.
- Default is dry-run. `execute=true` requires an explicitly supplied `limit`
  between 1 and 100.
- Scan pages read-only, build expected projection from current SQLite links, and
  select drifted slugs deterministically by slug order.
- Recheck each selected page immediately before write, call the existing
  `PageManager.syncLinksToMarkdown`, then verify drift is gone.
- Continue after per-page failure. No fact/link/trust-state changes occur.
- Return scalar counts only: scanned, candidates, selected, repaired, skipped,
  failed, remaining. Display/log output contains no title, slug, or path.

## Safety

The tool is exposed only in the maintenance profile and runs inside the single
HTTP writer. There is no standalone concurrent-writing CLI. Dry-run performs no
file or database write. Candidate/rejected/superseded links remain excluded by
the existing projector.

