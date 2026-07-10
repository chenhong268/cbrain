# Runtime Health Freshness Implementation Plan (#320)

1. Add a focused HTTP health test that fails against the current response.
2. Capture runtime start time once in `createHttpServer()` and expose it with
   the existing safe version constant.
3. Run focused tests, typecheck, lint, and the full check gate.
4. Adversarially verify compatibility, timestamp stability, fallback behavior,
   privacy, and read-only behavior.

