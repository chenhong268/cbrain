# Actionable `next_actions` Design

**Status:** Approved for implementation

**Date:** 2026-07-20
**Parent contract:** `docs/superpowers/specs/2026-07-20-existing-capability-experience-optimization-design.md` §10.2

## 1. Problem

`next_actions` currently groups discovery-backed review candidates by discovery
type, but every group uses the same copy:

- title: a discovery is worth reviewing;
- reason: confirm whether action is needed;
- suggestion: open the corresponding discovery and decide what to do.

This becomes unusable after aggregation. A group may represent dozens of
different discoveries while the default response intentionally exposes neither
their internal references nor private entity identifiers. The user therefore
receives a recommendation with no executable next step.

The defect is in CBrain's generated display copy, not in Hermes. A captured live
tool envelope contained the same generic copy that Hermes reported.

## 2. Goal

Make each discovery-backed `next_actions` group understandable and actionable
without exposing private/internal identifiers, performing an operation, or
duplicating the discovery digest.

Success means a user can understand:

1. what class of information needs attention;
2. why it needs attention;
3. the safe next conversational action;
4. that no data changes before confirmation.

## 3. Design Decision

Generate deterministic, discovery-type-aware display copy in the existing action
candidate boundary. Do not add a tool, public response field, data model, status,
LLM call, or migration.

The same display resolver is used by:

- newly generated discovery action-candidate drafts; and
- persisted `action_review_discovery` rows reconstructed for read-only consumers.

This read-side regeneration prevents legacy persisted generic copy from surviving
the fix. Health-backed candidates continue to use their existing health display
copy unchanged.

## 4. Display Contract

For a live discovery row, the resolver consumes only:

- discovery type; and
- whether the signal has occurred at least three times.

When a generated candidate is persisted, its source recurrence is copied into a
dedicated integer metadata field, `source_occurrence_count`. On reconstruction,
only that field may establish recurrence. It must be a finite integer greater
than or equal to one; a missing or invalid field fails closed to the single-signal
reason. The persisted action candidate row's own `occurrence_count` is never used
for this purpose because it measures candidate-generation runs, not source-signal
recurrence. Existing generic legacy rows therefore use the honest single-signal
reason until regenerated with the dedicated field.

It must not consume or interpolate entity names, slugs, paths, raw suggestions,
scores, metadata bodies, evidence references, or credentials.

The following types receive fixed copy and have a working `next_actions` detail
handoff:

| Discovery type | User-facing category | Safe next conversational action |
| --- | --- | --- |
| `bridge` | potential relationships | offer to show at most three current high-priority relationship clues and their evidence, then ask whether to link or ignore |
| `trend` | attention changes | offer to show at most three current high-priority changes and their recent-record evidence, then ask whether to update or ignore |
| `gap` | incomplete memories | offer to show at most three current high-priority incomplete items, then ask which one to describe or connect |
| `contradiction` | conflicting information | offer to show at most three current high-priority conflicts and their sources, then ask which supported version to retain |
| `knowledge_map_isolation` | isolated memories | offer to show at most three current high-priority isolated items, then ask whether to add a supported relationship or leave them unchanged |
| `knowledge_map_bridge` | cross-domain connections | offer to show at most three current high-priority connections and their evidence, then ask whether to preserve or strengthen them |

The wording may be polished during implementation, but every suggestion must:

- name a bounded next step of at most three items;
- state the verification step;
- state the decision alternatives;
- explicitly stop after displaying the review evidence and ask for user
  confirmation before any write-capable operation;
- avoid claiming that CBrain has already modified anything.

Each supported category has an existing detail handoff:
`read_discoveries({ typeFilter: <type>, limit: 3, debug: false })`. “Current
high-priority” deliberately matches that tool's pending-row ordering; the copy
must not say “latest”. The handoff is read-only and occurs only after the user
accepts the offer. If it returns no cards, the Agent reports that the group no
longer has visible details and stops without proposing a write.

An unknown future discovery type has no guaranteed public detail handoff and is
therefore silent in `next_actions`. Both direct discovery drafts and persisted
discovery action candidates with an unsupported `source_type` are excluded. This
is the parent contract's “silence when safe public information is insufficient”
branch, not a new public status.

`similar_entity` retains its existing action-candidate generation and receives
safe fixed copy there, but follows the silence branch specifically in
`next_actions`. Although the discovery MCP schema accepts an explicit type filter,
the shared digest currently excludes the type before rendering, so it does not yet
provide the promised read-only handoff. Repairing that independent discovery
surface is outside this issue; `next_actions` must not advertise an action the
current detail path cannot complete or regress the existing duplicate-governance
candidate lane.

Repeated and single-occurrence variants may use different fixed reasons. The
existing grouped evidence count remains the only quantity shown by
`next_actions`.

## 5. Data Flow

1. Existing discovery rows enter `buildActionCandidatesFromDiscoveries`.
2. Known action-candidate types use the shared display resolver; unknown types are
   skipped without affecting existing known candidate lanes.
3. The resolver derives fixed copy from `row.type` and the source row's
   `occurrence_count`, and persists the latter as `source_occurrence_count`.
4. New drafts persist that copy through the existing action-candidate path.
5. `persistedCandidateRowToDraft` applies the same resolver when the source is a
   supported discovery, overriding legacy persisted prose and using only validated
   `source_occurrence_count` for recurrence.
6. `next_actions` admits only the six types with a working read-only detail
   handoff; this filters both direct and persisted drafts without changing the
   action-candidate lane.
7. `buildAttentionQueue` continues to group, rank, apply freshness rules, and cap
   output exactly as today.
8. `next_actions` continues to render group counts and metadata-only `items[]`.

No read path writes to SQLite or the vault.

## 6. Compatibility and Safety

- Public JSON shape is unchanged.
- Existing discovery grouping, ranking, freshness, and top-three cap are unchanged.
- Existing `read_discoveries` remains the detail surface; its cards are not copied
  into `next_actions`.
- Persisted health display metadata remains validated and rendered as today.
- Persisted discovery display metadata is treated as untrusted and is not echoed.
- All new display strings pass `assertSafeActionDisplay`.
- No suggestion authorizes or chains into a write. The follow-up detail read ends
  by asking for explicit confirmation.
- Default output remains free of entity identifiers, slugs, paths, scores, raw
  evidence, and debug fields.
- `include_raw=true` remains an explicit audit boundary and is not expanded. Its
  existing top-level keys and `NextAction` item keys are locked by tests. Existing
  `sourceRefs` remain audit-only; raw suggestions, source metadata bodies, and
  private display titles must not create new fields or enter the fixed
  title/reason/suggestion fields.

## 7. Tests

Use TDD and synthetic identifiers only.

Core tests must prove:

1. each supported discovery type receives a distinct, bounded action;
2. repeated signals get an honest repeated-signal reason;
3. three candidate-generation runs for one source occurrence still use the
   single-signal reason, while a validated `source_occurrence_count` of three uses
   the repeated-signal reason;
4. unknown action-candidate types are silent without suppressing known governance
   candidates;
5. no raw suggestion or metadata text reaches generated display copy;
6. persisted legacy generic or hostile discovery copy is replaced by the shared
   resolver;
7. persisted health copy retains its current validation/fallback behavior.

MCP tests must prove:

1. a mixed discovery queue no longer repeats the old generic title and suggestion;
2. grouped counts, top-three cap, public `items[]` shape, and summary remain stable;
3. default display contains a bounded next step and confirmation language;
4. for every detail-supported type, accepting the suggestion can be fulfilled by
   `read_discoveries({ typeFilter, limit: 3, debug: false })`; an empty detail
   result produces a stop-without-write outcome;
5. direct and persisted `similar_entity` candidates remain available to their
   existing governance lane but stay silent in `next_actions`;
6. the full default envelope rejects private titles, singular/plural and nested
   slug forms, POSIX and Windows paths, raw suggestions, credential sentinels, and
   Unicode control characters for both fresh and persisted legacy rows;
7. `include_raw=true` preserves the exact existing raw key sets and does not copy
   hostile metadata into display fields or new audit fields;
8. default and `include_raw=true` calls remain read-only.

Run focused tests, documentation checks, lint/type checks, the full suite,
`git diff --check`, and the repository privacy scan before completion.

## 8. Non-goals

- No discovery ranking or detection changes.
- No automatic review, linking, merging, updating, dismissing, or status changes.
- No entity titles or discovery cards in `next_actions`.
- No automatic Hermes tool chaining; the detail handoff runs only after the user
  accepts the displayed offer.
- No new user preference, configuration flag, telemetry system, or migration.
- No refactor outside the action-candidate display boundary, the `next_actions`
  admission boundary, and their tests.

## 9. Rollback

Revert the implementation commit. The change has no schema, persisted-state, or
deployment migration dependency; legacy stored rows remain readable by the prior
code.
