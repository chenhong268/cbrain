# Runtime Health Freshness Design (#320)

## Problem

`GET /health` currently proves that an HTTP process answers, but not which CBrain
version it loaded or when that process started. A merged fix can therefore be
mistaken for a deployed fix.

## Design

- Capture one ISO timestamp when `createHttpServer()` creates the runtime.
- Return the existing package `version` and the captured `started_at` from
  `GET /health`, alongside the compatible `ok` and `tools` fields.
- Reuse `src/version.ts`; its existing fallback keeps compiled or incomplete
  installations from crashing.
- Keep the endpoint read-only and intentionally exclude PID, paths, database
  details, profiles, environment values, and secrets.

## Contract

```json
{
  "ok": true,
  "tools": 97,
  "version": "2.0.4",
  "started_at": "2026-07-10T12:00:00.000Z"
}
```

Existing fields retain their meaning. New fields are additive.

## Verification

- Two requests to one runtime return the same valid `started_at`.
- `version` is non-empty.
- The JSON key set contains only the four public fields.
- The endpoint does not mutate storage or create runtime artifacts.

