# Deferred Entity Enrichment Implementation Plan (#321)

1. RED: add ingest tests proving deferred entity writes do not call LLM and
   enqueue `kind=entity_facts`; lock sync/off behavior.
2. Extract the current entity-facts implementation into a shared helper without
   changing sync behavior.
3. Route deferred entity writes into the existing deduplicated backfill queue.
4. RED: add processor tests for entity-facts success, retryable provider failure,
   and terminal missing-source/malformed-job outcomes.
5. Extend `runNerBackfillStage` and Dream/CLI wiring; keep legacy jobs unchanged.
6. Run focused and full gates, then adversarially review duplicate jobs, restart
   recovery, source loss, privacy, trusted-field preservation, and single-writer
   behavior.

