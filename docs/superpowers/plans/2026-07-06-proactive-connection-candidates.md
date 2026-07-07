# proactive_connection Candidates — Implementation Plan

**Issue:** #310 (parent #235)
**Branch:** `feat/310-proactive-connection`
**Spec:** `docs/superpowers/specs/2026-07-06-proactive-connection-candidates-design.md`

## Goal

Add the Phase 0 `proactive_connection` candidate lane — quiet, opt-in, deterministic, evidence-backed — reusing the discoveries lifecycle. See the design spec for the why and the display-vs-raw-refs boundary; this document captures the how.

## Architecture

Pure detector `detectProactiveConnections` (graph + co-occurrence + timeline math) + thin producer `produceProactiveConnectionCandidates` (emit rule + verifier + upsert). Open-string discovery type. No schema migration. No dream scheduling. Embedding similarity never used.

## File structure

- `src/core/maintenance/proactive-connection.ts` — detector + producer + types (`TimelineEventRef`, candidate with bounded evidence refs)
- `src/core/maintenance/discovery-digest.ts` — `shouldFilterDiscovery` proactive→null + `formatDigestCard` case + `safeTitle` guard
- `src/core/maintenance/action-candidates.ts` — `QUIET_DISCOVERY_TYPES` skip (G3)
- `src/mcp/tools/discoveries.ts` — run_discovery types enum + `wantsProactive` branch + G2 digest filter; read_discoveries typeFilter enum
- `tests/core/maintenance/proactive-connection.test.ts` — detector + producer + evidence refs + lifecycle + structural isolation
- `tests/core/discovery-digest.test.ts` — proactive card + hostile title + slug fallback
- `tests/mcp/proactive-connection.test.ts` — run/read explicit + default quiet + e2e hostile title

## Key decisions (locked)

1. Open-string type, NOT in `DiscoveryType` union (mirrors `knowledge_map_*` / `action_*`).
2. Independent producer, NOT in `DiscoveryManager.runDiscovery` if-ladder.
3. No dream scheduling in Phase 0 (default-OFF, on-demand only).
4. Embedding similarity never used.
5. Emit rule in producer (detector stays a pure scoring function).
6. Verifier before every upsert (NOT the knowledge-map gap that skips it).
7. `isDigestExcluded` NOT extended (would hide explicit read); quiet via G1/G2/G3.
8. Evidence refs bounded top-3; query text never stored (opaque session ids only).

## Implementation tasks (all complete)

1. Detector skeleton + helpers (`clamp01`, `pairKey`, `buildLocalAdjacency`)
2. Signal A (shared current-fact neighbors, unlinked)
3. Signal B (co-occurrence, bounded opaque session refs)
4. Signal C (timeline proximity, latest-event refs per side)
5. Emit rule + bounded cap
6. Producer (upsert + verifier + `metadata.evidence`)
7. `formatDigestCard` case + `shouldFilterDiscovery`
8. `QUIET_DISCOVERY_TYPES` skip (G3)
9. `run_discovery` wiring (G2)
10. `read_discoveries` typeFilter
11. Adversarial structural tests (F4/F5)
12. Display safety: `safeTitle` (F3/secrecy fix)
13. Evidence refs rework (reviewer HIGH 1)

## Verification

- `bun run typecheck` ✅
- `bun run lint` ✅ (416 files clean)
- `bun run check` ✅ 3364 pass / 0 fail across 220 files (after HIGH 1 rework: rerun)
- Adversarial audit: F1/F2/F4/F5 pass; F3 + secrecy found → fixed via `safeTitle`.

## Reviewer findings (this iteration)

- **HIGH 1** — candidates were not auditable (counts only). Fixed: `metadata.evidence` now carries bounded concrete refs (shared-neighbor slugs, timeline event ids, opaque session ids); query text never stored.
- **HIGH 2** — spec/plan artifacts missing at the agreed paths. Fixed: this file + the design spec.
- **LOW** — stray `node_modules` symlink in the worktree. Fixed before delivery.

## Commit history

`git log feat/310-proactive-connection` — see branch.
