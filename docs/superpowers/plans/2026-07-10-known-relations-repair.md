# Bounded Known Relations Repair Plan (#323)

1. RED: core tests for dry-run, limit, idempotency, current-fact filtering, and
   partial failure.
2. Implement the deterministic scanner/executor around the existing projector.
3. RED/GREEN: add a maintenance-only MCP surface with execute-limit validation
   and scalar-only output.
4. Update generated inventories, run focused/full gates, and adversarially test
   stale plans, single-writer exposure, file failure, privacy, idempotency, and
   candidate-link exclusion.

