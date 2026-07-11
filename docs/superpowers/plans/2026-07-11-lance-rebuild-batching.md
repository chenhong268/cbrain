# #325 Implementation Plan

1. Add RED tests for cross-page batch count, deterministic mapping, L1 preservation, progress privacy, and second-batch failure cleanup.
2. Add a reusable sequential bounded embedding helper and progress contract.
3. Replace per-page chunk calls and the unbounded insight call without changing staging/swap logic.
4. Wire privacy-safe progress into the maintenance CLI.
5. Run focused tests, five-point adversarial review, full gate, merge, push, and a real offline rebuild smoke.

