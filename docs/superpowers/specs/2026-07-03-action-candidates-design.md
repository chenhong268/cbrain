# Action Candidates for Discovery and Health (#267)

## Context

Discovery and Health already surface useful signals, but they are not yet a good "next action" interface for an Agent or user.

The previous connector-loop direction was too aggressive: automatic GitHub issue creation, notifications, or repairs would cross CBrain's safety boundary. CBrain should instead produce internal, evidence-backed action candidates that Hermes or the user can review and decide on.

This design keeps CBrain quiet by default. It creates reviewable candidates only when explicitly requested, stores them in the existing lifecycle, and never executes external or destructive actions.

## Goal

Generate bounded, deduplicated, evidence-backed action candidates from selected Discovery and Health signals, without executing any action automatically.

Examples:

- review a recurring high-value Discovery;
- inspect a chronic Health issue;
- consider a repair command as a dry-run recommendation;
- prepare a notification draft for Hermes to decide on later.

## Non-goals

- No automatic GitHub issue creation.
- No Telegram or external notification sending.
- No destructive cleanup, merge, repair, delete, or writeback.
- No connector orchestration inside CBrain core.
- No private examples in tests, docs, display text, or fixtures.
- No replacement of existing Discovery or Health output contracts.
- No new LLM planning layer.

## Design Decision

Use the existing `discoveries` lifecycle instead of adding a new `action_candidates` table.

`discoveries` already has the exact lifecycle #267 needs:

- stable `dedup_key`;
- `occurrence_count` and `last_detected_at`;
- `status` values including `pending`, `dismissed`, and `resolved`;
- `seen` semantics that protect dismissed/resolved rows from cleanup resurrection;
- `metadata` and `proposed_actions` for evidence and next-step hints.

Adding a second lifecycle table would duplicate status semantics and increase the risk that dismissed or resolved items reappear as fresh work. Phase 1 should reuse the proven storage model and make the action-candidate surface structurally separate from the normal Discovery digest.

## Candidate Types

Phase 1 stores action candidates as dedicated `discoveries.type` values:

- `action_review_discovery`
- `action_health_review`
- `action_repair_preview`

These types are internal review lanes. They must not appear in the default `read_discoveries` or `run_discovery` digest.

## Architecture

### Pure Candidate Builder

Create `src/core/maintenance/action-candidates.ts`.

Responsibilities:

- Convert selected Discovery rows into `ActionCandidateDraft` records.
- Convert selected Health repair-plan actions into `ActionCandidateDraft` records.
- Produce stable dedup entities and metadata.
- Produce concise display-ready fields without slugs, scores, or debug labels.
- Keep raw evidence references in metadata for audit.

No DB access, no LLM, no network, no file writes.

### Orchestrator

Add an explicit orchestrator method, either as a small `ActionCandidateManager` or a thin method near `DiscoveryManager`.

Responsibilities:

- Load pending Discovery rows when asked.
- Run Health only when explicitly requested.
- Call `planRepairs(report, signalLookup)` for Health-derived candidates.
- Persist drafts via `db.upsertDiscovery(...)`.
- Write proposed actions through `db.updateDiscoveryActions(...)`.
- Return a bounded report.

The orchestrator must never be called by default Dream, default `run_discovery`, or default digest paths.

### MCP Surface

Add explicit tools:

- `run_action_candidates`
- `read_action_candidates`
- `update_action_candidate_status`

`update_action_candidate_status` can reuse `db.updateDiscoveryStatus(...)` internally.

Tool behavior:

- `run_action_candidates` generates candidates only on explicit call.
- `read_action_candidates` returns pending candidates only.
- `update_action_candidate_status` supports `resolved` and `dismissed`; `seen` is acceptable if aligned with existing Discovery status behavior.
- Display is concise and non-technical.
- Raw/debug includes evidence refs and candidate source.

### Default Digest Exclusion

Update `isDigestExcluded(...)` so every `action_*` type is excluded from the normal Discovery digest.

The separate action-candidate surface is the only user-facing route for these rows.

## Data Shape

### Draft

```ts
export type ActionCandidateKind =
  | "review_discovery"
  | "health_review"
  | "repair_preview";

export interface ActionCandidateDraft {
  type: "action_review_discovery" | "action_health_review" | "action_repair_preview";
  entities: string[];
  score: number;
  actionable: "high" | "medium" | "low";
  displayTitle: string;
  displayReason: string;
  suggestedAction: string;
  evidence: Array<{
    source: "discovery" | "health";
    ref: string;
    kind: string;
  }>;
  proposedActions: Array<{
    type: "review" | "dry_run" | "notify_draft";
    target: string;
    reason: string;
  }>;
  metadata: Record<string, unknown>;
}
```

### Storage Mapping

Persist with:

```ts
db.upsertDiscovery(
  draft.type,
  draft.entities,
  draft.score,
  undefined,
  undefined,
  draft.actionable,
  false,
  draft.metadata,
);
```

Then call:

```ts
db.updateDiscoveryActions(id, draft.proposedActions);
```

`auto_applicable` must stay false.

## Dedup Keys

Because `upsertDiscovery` derives the dedup key from `type + sorted entities`, each candidate must use stable pseudo-entities.

Rules:

- Discovery-derived candidates: `["discovery:<id-or-dedup-key>"]`.
- Health page-scoped candidates: `["health:<dimension>:<kind>:<slug>"]`.
- Health global candidates: `["health:<dimension>:<kind>:global"]`.

If a stable discovery `dedup_key` is available, prefer it over row ID. Row IDs are stable enough for persisted rows, but dedup key is more semantically correct.

## Selection Rules

### Discovery Inputs

Use only pending discoveries.

Generate action candidates for:

- `actionable === "high"`;
- repeated findings with `occurrence_count >= 3`;
- existing `proposed_actions` that are not auto-applicable;
- high-value types such as `similar_entity`, `knowledge_map_isolation`, `knowledge_map_bridge`, and `contradiction`.

Do not generate candidates for low-signal default bridge/trend rows unless recurrence or actionability crosses the threshold.

### Health Inputs

Use `planRepairs(report, signalLookup)`.

Generate action candidates for:

- `blocked`;
- `needs_review`;
- selected `auto_repairable` as `action_repair_preview`.

Do not generate candidates for routine `observe_only` items unless they are chronic and high impact. Phase 1 may skip `observe_only` entirely.

## Display Contract

Display text must be natural and non-technical:

- Good: `有一项健康问题反复出现，建议先人工确认后再处理。`
- Good: `有一组发现多次出现，值得复核是否需要行动。`
- Bad: `dedup_key=...`
- Bad: `score=0.91`
- Bad: `sqlite row ...`

Raw/debug may include:

- source type;
- discovery ID or dedup key;
- health dimension;
- repair group/kind;
- evidence refs;
- proposed action objects.

Display must not include raw slugs, local paths, scores, SQL, stack traces, or private names.

## Quiet-by-default Rule

The following must not happen during generation:

- network requests;
- GitHub API calls;
- Telegram or notification calls;
- repair command execution;
- delete/merge/writeback;
- LLM calls.

Candidate generation is internal DB lifecycle work only.

## Files

Expected changes:

- Create `src/core/maintenance/action-candidates.ts`.
- Modify `src/core/maintenance/discovery-digest.ts` to exclude `action_*` types.
- Modify or add an explicit manager/orchestrator near `src/core/maintenance/discovery.ts`.
- Modify `src/mcp/tools/discoveries.ts` or add a focused MCP tool file for action candidates.
- Add tests under `tests/core/` and `tests/mcp/`.

No schema migration is expected in Phase 1.

## Tests

Use anonymous fixtures only.

Core tests:

- High-value Discovery row creates one pending `action_review_discovery`.
- Repeated Discovery row creates one pending candidate and increments occurrence on rerun.
- Dismissed action candidate does not reappear as pending on rerun.
- Health `needs_review` action creates `action_health_review`.
- Health `auto_repairable` action creates `action_repair_preview` with `auto_applicable=false`.
- `observe_only` health actions are skipped in Phase 1.
- Candidate display fields do not contain slugs, scores, paths, SQL, or debug terms.
- Metadata retains evidence refs.

MCP tests:

- `run_action_candidates` persists bounded candidates.
- `read_action_candidates` returns pending candidates only.
- `update_action_candidate_status` dismisses/resolves candidates and they disappear from pending reads.
- Existing `read_discoveries` output remains backward compatible and excludes `action_*`.
- No external network function is invoked; tests should use spies or absence of connector imports where practical.

Regression tests:

- Existing Discovery lifecycle tests still pass.
- Existing Health debt planner tests still pass.
- Existing tool profile tests still pass.

## Acceptance Criteria Mapping

- Repeated high-value anonymous Discovery/Health signal creates one pending action candidate.
  - Covered by Discovery recurrence and Health planner tests.
- Re-running does not duplicate or resurrect dismissed candidates.
  - Covered by `upsertDiscovery` recurrence tests on `action_*` rows.
- Candidate display is concise and non-technical; raw/debug contains evidence references.
  - Covered by display leak tests and raw evidence assertions.
- No external network action occurs during candidate generation.
  - Covered by architecture and MCP/core tests.
- Existing Discovery and Health outputs remain backward compatible.
  - Covered by existing digest and health tests plus explicit exclusion tests.

## Adversarial Review Checklist

Before merge, attack the implementation with these checks:

1. **Lifecycle duplication risk**: ensure no new status table or parallel lifecycle was added without need.
2. **Auto-action risk**: ensure no GitHub, Telegram, repair, delete, merge, writeback, or LLM call happens in generation.
3. **Digest pollution risk**: ensure action candidates do not appear in default `read_discoveries` or `run_discovery`.
4. **Resurrection risk**: dismiss or resolve a candidate, rerun generation, and verify it does not return as pending.
5. **Privacy risk**: display must not leak real slugs, titles from private fixtures, local paths, scores, SQL, or debug labels.
6. **Over-broad Health risk**: ensure low-value `observe_only` health debt does not flood the candidate surface.

