# #325 LanceDB Rebuild Batching

## Problem

The full rebuild performs one sequential `embedBatch` call per page. Recovery time therefore scales with page count rather than the embedding provider's bounded request capacity.

## Design

- Preserve the SQLite source order `(page_slug, chunk_index)` and flatten chunk rows across pages.
- Process chunks in fixed outer batches of 256. Providers may apply their own smaller transport shards.
- Validate every provider response has exactly one result per input before adding it to staging data.
- Preserve all L0 and L1 rows, staging verification, atomic swap, backup, and rollback behavior.
- Add a fail-open progress callback containing only fixed phase names and scalar counters.
- Apply the same bounded helper to active insights so no rebuild phase submits an unbounded outer batch.

## Privacy

Progress exposes only `phase`, `processed`, `total`, `batch`, and `batches`; never slug, title, content, vectors, paths, or provider errors.

## Non-goals

- No concurrent writer, schema, provider, ranking, or live-index changes.
- No parallel network fan-out; batches remain sequential and bounded.

